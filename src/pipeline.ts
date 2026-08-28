import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { config } from './config.js';
import { prisma } from './db.js';
import { lineToWords, ocrPool } from './ocrEngine.js';
import { normalizeForSearch } from './normalize.js';
import { openPdf, type ExtractedPage, type PdfHandle } from './pdfText.js';
import { jpegDimensions, renderDpiForPage, renderPageImage } from './render.js';
import { hasLegacyEncoding } from './reportText.js';
import { storage } from './storage.js';
import { completePage, failPage, refreshDocumentStatus, type ClaimedPage } from './pageQueue.js';
import { compactWords } from './words.js';
import type { OcrWord } from './types.js';

const MIN_USABLE_CHARACTERS = 35;
const MIN_USABLE_WORDS = 6;
const PAGE_DB_CHUNK = 25;

/**
 * Decides whether a page's own text layer can be used instead of reading a
 * picture of it.
 *
 * This is by far the cheapest branch in the pipeline -- about 0.1 s a page
 * against several seconds to rasterise and recognise one -- so it is worth
 * being careful about. The checks reject text that is present but unusable: a
 * broken character map, private-use glyphs, or mojibake that would otherwise go
 * into the search index and the Excel report as nonsense.
 *
 * Legacy Azerbaijani font encodings are deliberately no longer rejected. They
 * look like mojibake but are a complete, correctly positioned text layer drawn
 * with a non-Unicode font, and `pdfText` now decodes them -- so the pages that
 * used to be the most expensive in the batch have become the cheapest.
 */
export function embeddedTextIsUsable(page: ExtractedPage) {
  const compactText = page.text.replace(/\s/g, '');
  if (compactText.length < MIN_USABLE_CHARACTERS || page.words.length < MIN_USABLE_WORDS) return false;
  // Decorative private-use glyphs have already been stripped. What matters is
  // how many there were: a couple of bullets is a normal text layer, while a
  // page that is mostly undecodable glyphs has a broken character map and is
  // better recognised from the raster.
  if ((page.unreadableRatio ?? 0) > 0.02) return false;
  // A page whose text layer was decoded out of a legacy font is real Unicode
  // now, so it must not be rejected for still containing the accented letters
  // that decoding produced. Only text that was never recognised as an encoding
  // is checked, where tripping this test means genuine mojibake.
  if (!page.textRepaired && hasLegacyEncoding(compactText)) return false;
  const mojibakeSequences = compactText.match(/(?:Ã.|Â.|Ä.|Å.)/g)?.length ?? 0;
  if (mojibakeSequences >= 2 && mojibakeSequences * 2 >= compactText.length * 0.08) return false;
  const validWords = page.words.filter((word) =>
    word.text.trim()
    && word.x >= 0 && word.y >= 0
    && word.width > 0 && word.height > 0
    && word.x + word.width <= 1.01
    && word.y + word.height <= 1.01);
  const searchableCharacters = [...compactText].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  return validWords.length / page.words.length >= 0.9
    && searchableCharacters / compactText.length >= 0.65;
}

/**
 * Creates the page rows for a newly uploaded document.
 *
 * Every page that can be served from the text layer is written finished in this
 * same pass, so a born-digital PDF is searchable seconds after upload and never
 * reaches the recognition queue at all. Only pages that genuinely need a
 * picture read are left PENDING for the workers to claim.
 */
export async function prepareDocument(documentId: string, signal: AbortSignal) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) return;

  const workDir = await mkdtemp(path.join(config.tempDir, `prep-${documentId}-`));
  let pdf: PdfHandle | undefined;
  try {
    await prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'PROCESSING', ocrError: null },
    });
    const pdfPath = await storage.materialize(document.storageKey, workDir);
    if (signal.aborted) return;
    pdf = await openPdf(pdfPath);
    const forceOcr = document.ocrMode === 'FORCE_OCR';

    await prisma.document.update({ where: { id: documentId }, data: { pageCount: pdf.pageCount } });
    // A re-run replaces whatever the previous attempt left behind.
    await prisma.ocrPage.deleteMany({ where: { documentId } });

    // Pages are written as they are read, a chunk at a time, and dropped.
    //
    // Holding the whole document first was the single largest memory cost in
    // the service: a broadsheet page carries about five thousand word boxes, so
    // an eight-page issue peaked near 600 MB before anything was stored, and a
    // hundred-page PDF had no chance at all. On a 2 GB container that collided
    // with the recognition daemons and left the process swapping -- which shows
    // up as pages taking minutes each, with no obvious culprit, even for
    // documents that never reach the recogniser.
    //
    // Chunking still costs one statement per twenty-five pages rather than one
    // per page, which is what matters over a pooled Neon connection.
    let chunk: Prisma.OcrPageCreateManyInput[] = [];
    const flush = async () => {
      if (!chunk.length) return;
      await prisma.ocrPage.createMany({ data: chunk });
      chunk = [];
    };

    for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber += 1) {
      if (signal.aborted) return;
      const page = await pdf.readPage(pageNumber, { withText: !forceOcr });
      const usable = !forceOcr && embeddedTextIsUsable(page);
      chunk.push({
        documentId,
        pageNumber,
        width: page.width,
        height: page.height,
        source: usable ? 'pdf-text' : 'pending',
        text: usable ? page.text : '',
        searchText: usable ? normalizeForSearch(page.text) : '',
        words: (usable ? compactWords(page.words) : []) as unknown as Prisma.InputJsonValue,
        status: usable ? 'COMPLETE' : 'PENDING',
      });
      if (chunk.length >= PAGE_DB_CHUNK) await flush();
    }
    await flush();
    await refreshDocumentStatus(documentId);
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : 'Unknown failure while opening the document';
    await prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'FAILED', ocrError: message.slice(0, 1000) },
    }).catch(() => undefined);
  } finally {
    await pdf?.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Admission control for rasterisation.
 *
 * Poppler competes with the recogniser for the same cores, and a page image is
 * held in memory while it is written, so the two stages are overlapped but not
 * allowed to run at full width at the same time. Without this a worker starts
 * one `pdftoppm` per recognition slot at the moment a batch is claimed, which
 * on a small container is exactly when it can least afford them.
 */
function createSemaphore(size: number) {
  let free = size;
  const waiting: Array<() => void> = [];
  return {
    async acquire() {
      if (free > 0) { free -= 1; return; }
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    },
  };
}

const renderSlots = createSemaphore(config.renderConcurrency);

type CachedDocument = { localPath: string; pdf: PdfHandle };

/**
 * Keeps recently used PDFs on local disk.
 *
 * Pages are independent jobs, so without this a worker would download and
 * re-parse the same 8 MB PDF once per page of it. Entries are reference counted
 * and evicted oldest-first, which bounds the temp directory whatever shape the
 * batch happens to have.
 */
class DocumentCache {
  private entries = new Map<string, {
    dir: string;
    document: Promise<CachedDocument>;
    users: number;
    usedAt: number;
  }>();

  async acquire(storageKey: string): Promise<CachedDocument> {
    const existing = this.entries.get(storageKey);
    if (existing) {
      existing.users += 1;
      existing.usedAt = Date.now();
      return existing.document;
    }
    const dir = await mkdtemp(path.join(config.tempDir, 'doc-'));
    const document = (async () => {
      const localPath = await storage.materialize(storageKey, dir);
      return { localPath, pdf: await openPdf(localPath) };
    })();
    this.entries.set(storageKey, { dir, document, users: 1, usedAt: Date.now() });
    // A failed download must not leave a poisoned entry behind for later pages.
    document.catch(async () => {
      this.entries.delete(storageKey);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });
    return document;
  }

  release(storageKey: string) {
    const entry = this.entries.get(storageKey);
    if (!entry) return;
    entry.users -= 1;
    entry.usedAt = Date.now();
    void this.evict();
  }

  private async evict() {
    const idle = [...this.entries].filter(([, entry]) => entry.users <= 0);
    const overflow = idle.length - config.documentCacheEntries;
    if (overflow <= 0) return;
    const oldest = idle.sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, overflow);
    for (const [key, entry] of oldest) {
      this.entries.delete(key);
      await this.dispose(entry);
    }
  }

  private async dispose(entry: { dir: string; document: Promise<CachedDocument> }) {
    await entry.document.then(({ pdf }) => pdf.close()).catch(() => undefined);
    await rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async clear() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) await this.dispose(entry);
  }
}

export const documentCache = new DocumentCache();

/**
 * Reads one page: rasterise, recognise, store.
 *
 * The rendered image is deleted as soon as the recogniser has finished with it,
 * so a long document never accumulates page images on disk, and the result is
 * written straight away rather than being held until its siblings finish --
 * which is what makes a partly-processed batch usable.
 */
export async function processPage(page: ClaimedPage, signal: AbortSignal) {
  const workDir = await mkdtemp(path.join(config.tempDir, `page-${page.documentId}-`));
  let imagePath: string | undefined;
  try {
    const { localPath, pdf } = await documentCache.acquire(page.storageKey);
    try {
      // Only the page box is needed: the text layer was already considered
      // when this page was queued, and it lost.
      const geometry = await pdf.readPage(page.pageNumber, { withText: false });
      const dpi = renderDpiForPage(geometry);
      await renderSlots.acquire();
      try {
        imagePath = await renderPageImage(
          localPath,
          page.pageNumber,
          path.join(workDir, `page-${page.pageNumber}`),
          dpi,
          signal,
        );
      } finally {
        renderSlots.release();
      }
      const { width: imageWidth, height: imageHeight } = await jpegDimensions(imagePath);
      // The detector downsamples internally, so asking it for more than the
      // raster actually holds would only cost time.
      const maxSide = Math.min(config.ocrDetectionMaxSide, Math.max(imageWidth, imageHeight));
      const lines = await ocrPool().run(imagePath, maxSide, signal);

      const words: OcrWord[] = lines.flatMap((line, index) => lineToWords(line, page.pageNumber, index));
      const text = lines.map((line) => line.text).join('\n');

      await completePage(page.id, {
        width: geometry.width,
        height: geometry.height,
        source: 'ppocr-v5',
        text,
        searchText: normalizeForSearch(text),
        words: compactWords(words) as unknown as Prisma.InputJsonValue,
      });
    } finally {
      documentCache.release(page.storageKey);
    }
  } finally {
    if (imagePath) await rm(imagePath, { force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function handlePageFailure(page: ClaimedPage, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown page failure';
  const exhausted = await failPage(page.id, page.attempts, message);
  await refreshDocumentStatus(page.documentId);
  return { exhausted, message };
}
