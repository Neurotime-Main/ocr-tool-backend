import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { OcrWord } from './types.js';

/**
 * The whole application state, held in this process's memory.
 *
 * This replaces the Postgres database the service used to keep. What that
 * database bought was durability and sharing: a batch survived a deploy, and a
 * second worker process could pull from the same queue. Neither is provided
 * here, deliberately -- a restart starts from an empty workspace, and there is
 * exactly one process.
 *
 * What is kept is the shape of the data, because the pipeline is built around
 * it: a document owns pages, a page is the unit the queue hands out, and
 * highlights hang off a document. Every function below is synchronous; the
 * `async` signatures that remain in the callers are there because their own
 * work is asynchronous, not because reading a Map is.
 *
 * Two consequences worth knowing before changing anything here:
 *
 *  - Rows are handed out by reference, not copied. A caller that mutates a
 *    returned object mutates the store. The update helpers exist so that does
 *    not have to happen by accident.
 *  - Nothing evicts itself on a timer. Growth is bounded by document count
 *    alone (`OCR_MAX_RETAINED_DOCUMENTS`), because a page's word boxes are the
 *    bulk of the memory and they arrive per document.
 */

export type OcrStatus = 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
export type PageStatus = 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
export type HighlightSource = 'AUTO' | 'MANUAL';

export type DocumentRow = {
  id: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  size: number;
  pageCount: number | null;
  ocrStatus: OcrStatus;
  ocrLanguage: string;
  ocrMode: string;
  /** Set only once every page has been enumerated. The queue ignores a document until then. */
  preparedAt: Date | null;
  ocrError: string | null;
  /**
   * True once the uploaded PDF has been deleted because the document was
   * published. The recognised text and the highlights are still here; only the
   * file is gone, so the viewer has to say so rather than fail.
   */
  sourceRemoved: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PageRow = {
  id: string;
  documentId: string;
  pageNumber: number;
  width: number;
  height: number;
  source: string;
  text: string;
  searchText: string;
  words: OcrWord[];
  status: PageStatus;
  attempts: number;
  error: string | null;
  lockedBy: string | null;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HighlightRow = {
  id: string;
  documentId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  source: HighlightSource;
  keyword: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Insertion order is upload order, which is the order the queue works in. */
const documents = new Map<string, DocumentRow>();
const pagesByDocument = new Map<string, PageRow[]>();
const pageIndex = new Map<string, PageRow>();
const highlightsByDocument = new Map<string, HighlightRow[]>();

// --- documents ------------------------------------------------------------

export function createDocument(input: {
  originalName: string;
  storageKey: string;
  size: number;
  ocrLanguage: string;
  ocrMode: string;
  mimeType?: string;
}): DocumentRow {
  const now = new Date();
  const document: DocumentRow = {
    id: randomUUID(),
    originalName: input.originalName,
    storageKey: input.storageKey,
    mimeType: input.mimeType ?? 'application/pdf',
    size: input.size,
    pageCount: null,
    ocrStatus: 'PENDING',
    ocrLanguage: input.ocrLanguage,
    ocrMode: input.ocrMode,
    preparedAt: null,
    ocrError: null,
    sourceRemoved: false,
    createdAt: now,
    updatedAt: now,
  };
  documents.set(document.id, document);
  return document;
}

export function getDocument(id: string): DocumentRow | undefined {
  return documents.get(id);
}

export function getDocuments(ids: string[]): DocumentRow[] {
  return ids.flatMap((id) => {
    const document = documents.get(id);
    return document ? [document] : [];
  });
}

/** Every document, oldest upload first. */
export function allDocuments(): DocumentRow[] {
  return [...documents.values()];
}

export function updateDocument(id: string, patch: Partial<Omit<DocumentRow, 'id' | 'createdAt'>>) {
  const document = documents.get(id);
  if (!document) return undefined;
  Object.assign(document, patch, { updatedAt: new Date() });
  return document;
}

/** Removes documents with their pages and highlights, and reports what went. */
export function deleteDocuments(ids: string[]): DocumentRow[] {
  const removed: DocumentRow[] = [];
  for (const id of ids) {
    const document = documents.get(id);
    if (!document) continue;
    for (const page of pagesByDocument.get(id) ?? []) pageIndex.delete(page.id);
    pagesByDocument.delete(id);
    highlightsByDocument.delete(id);
    documents.delete(id);
    removed.push(document);
  }
  return removed;
}

/**
 * Drops the oldest finished documents once the workspace is over its cap.
 *
 * Without a database this is the only thing standing between a long-running
 * process and an unbounded heap: a broadsheet page carries a few thousand word
 * boxes, so a few hundred documents is real memory. Only settled documents are
 * candidates -- evicting one that is still being read would strand its worker
 * mid-page -- so a workspace kept entirely busy can exceed the cap rather than
 * throw work away.
 *
 * The caller deletes the returned documents' stored PDFs; the store has no
 * business touching the disk.
 */
export function evictOverflow(): DocumentRow[] {
  const overflow = documents.size - config.maxRetainedDocuments;
  if (overflow <= 0) return [];
  const evictable: string[] = [];
  for (const document of documents.values()) {
    if (evictable.length >= overflow) break;
    if (document.ocrStatus !== 'COMPLETE' && document.ocrStatus !== 'FAILED') continue;
    const busy = (pagesByDocument.get(document.id) ?? [])
      .some((page) => page.status === 'PROCESSING');
    if (busy) continue;
    evictable.push(document.id);
  }
  return deleteDocuments(evictable);
}

// --- pages ----------------------------------------------------------------

export type NewPage = Omit<PageRow,
  'id' | 'documentId' | 'createdAt' | 'updatedAt' | 'attempts' | 'error' | 'lockedBy' | 'startedAt'>;

/**
 * Adds pages to a document, keeping the ones already there.
 *
 * Preparation appends a chunk at a time as it reads the PDF, so a long document
 * reports real progress while it is being opened instead of sitting at zero
 * until the last page is parsed.
 */
export function appendPages(documentId: string, rows: NewPage[]) {
  const now = new Date();
  const existing = pagesByDocument.get(documentId) ?? [];
  const added = rows.map((row) => {
    const page: PageRow = {
      ...row,
      id: randomUUID(),
      documentId,
      attempts: 0,
      error: null,
      lockedBy: null,
      startedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    pageIndex.set(page.id, page);
    return page;
  });
  pagesByDocument.set(documentId, [...existing, ...added]);
  return added;
}

export function replacePages(documentId: string, rows: NewPage[]) {
  deletePages(documentId);
  return appendPages(documentId, rows);
}

export function deletePages(documentId: string) {
  for (const page of pagesByDocument.get(documentId) ?? []) pageIndex.delete(page.id);
  pagesByDocument.delete(documentId);
}

/** A document's pages in page order. */
export function pagesOf(documentId: string): PageRow[] {
  return pagesByDocument.get(documentId) ?? [];
}

export function getPage(pageId: string): PageRow | undefined {
  return pageIndex.get(pageId);
}

export function updatePage(pageId: string, patch: Partial<Omit<PageRow, 'id' | 'documentId' | 'createdAt'>>) {
  const page = pageIndex.get(pageId);
  // A cancelled document takes its pages with it while one of them is being
  // read. That is a normal outcome, so a missing page is not an error here.
  if (!page) return undefined;
  Object.assign(page, patch, { updatedAt: new Date() });
  return page;
}

/**
 * Every page in the workspace, document by document in upload order.
 *
 * The queue and the health report both walk the whole set; at the scale this
 * process holds, that is cheaper than maintaining status indexes that have to
 * be kept correct on every transition.
 */
export function* allPages(): Generator<{ document: DocumentRow; page: PageRow }> {
  for (const document of documents.values()) {
    for (const page of pagesByDocument.get(document.id) ?? []) yield { document, page };
  }
}

// --- highlights -----------------------------------------------------------

export function highlightsOf(documentId: string): HighlightRow[] {
  return highlightsByDocument.get(documentId) ?? [];
}

type HighlightInputRow = {
  id?: string;
  documentId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  source: HighlightSource;
  keyword?: string | null;
  note?: string | null;
};

function toHighlightRow(input: HighlightInputRow, createdAt: Date): HighlightRow {
  return {
    id: input.id ?? randomUUID(),
    documentId: input.documentId,
    pageNumber: input.pageNumber,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    color: input.color,
    opacity: input.opacity,
    source: input.source,
    keyword: input.keyword ?? null,
    note: input.note ?? null,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Swaps a document's automatic highlights for a fresh set, keeping manual ones.
 *
 * A search re-runs over a document that may already carry hand-drawn marks, and
 * those are the operator's work -- they survive every re-search.
 */
export function replaceAutoHighlights(documentId: string, rows: HighlightInputRow[]) {
  const now = new Date();
  const manual = highlightsOf(documentId).filter((highlight) => highlight.source === 'MANUAL');
  const next = [...manual, ...rows.map((row) => toHighlightRow(row, now))]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  highlightsByDocument.set(documentId, next);
  return next;
}

/** Replaces every highlight on a document, for an operator's explicit save. */
export function replaceAllHighlights(documentId: string, rows: HighlightInputRow[]) {
  const now = new Date();
  const next = rows.map((row) => toHighlightRow(row, now));
  highlightsByDocument.set(documentId, next);
  return next;
}

export function deleteAutoHighlights(documentId: string) {
  const kept = highlightsOf(documentId).filter((highlight) => highlight.source !== 'AUTO');
  highlightsByDocument.set(documentId, kept);
}

// --- reporting ------------------------------------------------------------

export function storeStats() {
  let pages = 0;
  let highlights = 0;
  for (const list of pagesByDocument.values()) pages += list.length;
  for (const list of highlightsByDocument.values()) highlights += list.length;
  return { documents: documents.size, pages, highlights };
}

/** Empties the workspace. Used by tests and by a clean shutdown. */
export function resetStore() {
  documents.clear();
  pagesByDocument.clear();
  pageIndex.clear();
  highlightsByDocument.clear();
}
