import {
  allDocuments, deleteAutoHighlights, deletePages, pagesOf, updateDocument,
} from './store.js';

export type OcrProgress = {
  currentPage: number;
  totalPages: number;
  queuePosition?: number;
};

/**
 * Progress for a batch of documents, derived from their pages.
 *
 * Counting finished pages rather than keeping a separate counter means the
 * number is always what the pipeline is actually doing, and a page that has run
 * out of retries counts as finished -- so progress reaches the end instead of
 * stalling one short of it.
 */
export async function getOcrProgress(documentIds: string[]) {
  const progress = new Map<string, OcrProgress | null>();
  if (!documentIds.length) return progress;

  // Documents with no pages yet have not been opened, so they are reported by
  // their position in the queue -- which tells the operator the server is alive
  // and what it is waiting for.
  const waiting = allDocuments()
    .filter((document) => (document.ocrStatus === 'PENDING' || document.ocrStatus === 'PROCESSING')
      && pagesOf(document.id).length === 0)
    .map((document) => document.id);

  for (const documentId of documentIds) {
    const pages = pagesOf(documentId);
    if (pages.length) {
      const done = pages.filter((page) => page.status === 'COMPLETE' || page.status === 'FAILED').length;
      progress.set(documentId, done >= pages.length
        ? null
        : { currentPage: done, totalPages: pages.length });
      continue;
    }
    const position = waiting.indexOf(documentId);
    progress.set(documentId, position === -1
      ? null
      : { currentPage: 0, totalPages: 0, queuePosition: position + 1 });
  }
  return progress;
}

/**
 * Puts a document back at the start of the pipeline.
 *
 * Its pages are removed rather than reset, because a re-run may be switching to
 * Force-OCR and must not keep text-layer results the new mode would reject.
 * The worker notices a document with no pages and prepares it again.
 */
export async function requeueDocument(documentId: string, ocrMode: string) {
  deletePages(documentId);
  deleteAutoHighlights(documentId);
  updateDocument(documentId, {
    ocrStatus: 'PENDING',
    ocrError: null,
    ocrMode,
    pageCount: null,
    preparedAt: null,
  });
}
