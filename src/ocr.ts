import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { config } from './config.js';
import { prisma } from './db.js';
import { extractPdfPages, type ExtractedPage } from './pdfText.js';
import { storage } from './storage.js';
import { hasLegacyAzeriFontEncoding } from './reportText.js';
import type { OcrWord } from './types.js';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const require = createRequire(import.meta.url);
// Compressed copies of the official models, used only where the deployment does
// not ship its own tessdata directory. They are expanded once into the temp
// directory, because the native binary reads plain .traineddata files.
const bundledLanguageFiles: Record<string, string> = {
  eng: require.resolve('@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'),
  aze: require.resolve('@tesseract.js-data/aze/4.0.0/aze.traineddata.gz'),
};

// Page segmentation modes. The OSD variants also detect page orientation and
// rotate the raster before recognition, which is the job `rotateAuto` did on
// the previous engine. They need osd.traineddata next to the language models,
// so the plain modes are used wherever it is absent.
const PSM_AUTO_OSD = '1';
const PSM_AUTO = '3';
const PSM_SPARSE_OSD = '12';
const PSM_SPARSE = '11';
/**
 * Recognition and rasterisation are done by two binaries the Dockerfile
 * installs. When one is absent Node reports a bare `spawn <name> ENOENT`,
 * which is stored verbatim as the page status and tells the user nothing they
 * can act on -- so it is translated here into the command that installs it.
 */
const MISSING_BINARY_HELP: Record<string, string> = {
  tesseract: "The OCR engine is not installed on this machine. Install it with 'sudo apt-get install -y tesseract-ocr' (macOS: 'brew install tesseract'), then restart the API. A container gets it from the Dockerfile.",
  pdftoppm: "The PDF page renderer (Poppler) is not installed on this machine. Install it with 'sudo apt-get install -y poppler-utils' (macOS: 'brew install poppler'), then restart the API. A container gets it from the Dockerfile.",
};

function describeToolFailure(tool: string, error: unknown) {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') return error;
  return new Error(MISSING_BINARY_HELP[tool] ?? `The '${tool}' binary is not on PATH.`);
}

const MIN_USABLE_CHARACTERS = 35;
const MIN_USABLE_WORDS = 6;
const PAGE_DB_CHUNK = 25;

export class OcrCancelledError extends Error {
  constructor() {
    super('OCR was cancelled.');
    this.name = 'OcrCancelledError';
  }
}

export const isCancellation = (error: unknown) => error instanceof OcrCancelledError;

type Progress = { currentPage: number; totalPages: number };
const ocrProgress = new Map<string, Progress>();

/**
 * A counting semaphore. Both recognition and rasterisation are CPU bound, so
 * the pipeline runs a fixed number of each rather than letting every page of
 * every queued document start at once. Waiting is abortable, so cancelling a
 * document does not have to wait for a slot held by an unrelated batch.
 */
function createSemaphore(size: number) {
  let free = size;
  const waiting: Array<{ wake: () => void; taken: boolean }> = [];
  return {
    async acquire(signal?: AbortSignal) {
      if (signal?.aborted) throw new OcrCancelledError();
      if (free > 0) { free -= 1; return; }
      const entry = { wake: () => undefined as void, taken: false };
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          if (entry.taken) return;
          entry.taken = true;
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new OcrCancelledError());
        };
        entry.wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(entry);
      });
    },
    release() {
      // Waiters that gave up are skipped, so their slot is not lost.
      let next = waiting.shift();
      while (next?.taken) next = waiting.shift();
      if (!next) { free += 1; return; }
      next.taken = true;
      next.wake();
    },
  };
}

// Recognition runs as a short-lived `tesseract` process per pass. The native
// binary reads a page several times faster than the WASM build it replaces and
// holds a fraction of the memory, so the pool is sized by CPU rather than by
// how many language models fit in the heap.
const recognitionSlots = createSemaphore(config.ocrConcurrency);
const renderSlots = createSemaphore(config.renderConcurrency);
// Admission control for whole pages, shared by every document. Without it a
// batch could rasterise hundreds of pages that then sit on disk waiting for a
// recognition slot; with it, only a handful of rendered images exist at once.
const pageSlots = createSemaphore(config.ocrConcurrency + config.renderConcurrency);

/**
 * Runs one recognition pass over a rendered page. Tesseract writes its own
 * layout-aware text and the word boxes from a single pass, so asking for both
 * costs nothing on top of the TSV.
 */
async function runTesseract(
  imagePath: string,
  outputBase: string,
  language: string,
  pageSegmentationMode: string,
  dpi: number,
  signal: AbortSignal,
) {
  const tessdataDir = await languageDataPath(language);
  throwIfCancelled(signal);
  let stderr = '';
  try {
    ({ stderr } = await execFileAsync('tesseract', [
      imagePath, outputBase,
      '-l', language,
      // Explicit, because TESSDATA_PREFIX has meant both this directory and its
      // parent across Tesseract versions.
      '--tessdata-dir', tessdataDir,
      // LSTM only, matching the engine the previous worker was built with.
      '--oem', '1',
      '--psm', pageSegmentationMode,
      '--dpi', String(dpi),
      '-c', 'preserve_interword_spaces=1',
      // The word boxes and the text are requested as parameters rather than as
      // the `tsv` and `txt` config files that would normally select them.
      // Naming a config file makes Tesseract look for it under the tessdata
      // directory, which here holds only the models, and a config it cannot
      // open is skipped with a message on stderr and an exit code of 0 -- so
      // the run would appear to succeed while writing no TSV at all.
      '-c', 'tessedit_create_tsv=1',
      '-c', 'tessedit_create_txt=1',
    ], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        TESSDATA_PREFIX: tessdataDir,
        // Tesseract's OpenMP threading scales poorly and would have every page
        // in the batch fight for the same cores. Pages are already run in
        // parallel by the recognition semaphore, so each process stays
        // single-threaded and the semaphore alone decides how busy the CPU is.
        OMP_THREAD_LIMIT: '1',
      },
    }));
  } catch (error) {
    // `execFile` reports an aborted child as a generic failure; the caller
    // needs to see it as a cancellation so the batch is not marked failed.
    if (signal.aborted) throw new OcrCancelledError();
    throw describeToolFailure('tesseract', error);
  }

  try {
    const [tsv, text] = await Promise.all([
      // Tesseract exits 0 even when it could not apply what it was asked for,
      // so a missing TSV is the first place that failure becomes visible. Its
      // own diagnostics are carried into the message, because the page status
      // is all an operator gets to see.
      readFile(`${outputBase}.tsv`, 'utf8').catch(() => {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join('; ');
        throw new Error(`Tesseract wrote no TSV for this page${detail ? `: ${detail}` : '.'}`);
      }),
      readFile(`${outputBase}.txt`, 'utf8').catch(() => ''),
    ]);
    return { tsv, text };
  } finally {
    await Promise.all([
      rm(`${outputBase}.tsv`, { force: true }).catch(() => undefined),
      rm(`${outputBase}.txt`, { force: true }).catch(() => undefined),
    ]);
  }
}

// The binary cannot appear or vanish while the process runs, so the answer is
// resolved once and reused by every later health poll.
let ocrEngineCheck: Promise<{ ok: boolean; detail: string }> | undefined;

/**
 * Confirms the recognition engine is installed and reports its version. The
 * health endpoint gates a Render deploy, so an image built without the binary
 * fails that deploy instead of failing silently on every upload.
 */
export function checkOcrEngine() {
  ocrEngineCheck ??= execFileAsync('tesseract', ['--version'], { timeout: 10_000 })
    .then(({ stdout, stderr }) => ({
      ok: true,
      detail: (stdout || stderr).split(/\r?\n/)[0]?.trim() || 'tesseract',
    }))
    .catch((error: unknown) => ({
      ok: false,
      detail: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? MISSING_BINARY_HELP.tesseract!
        : (error as Error).message,
    }));
  return ocrEngineCheck;
}

export function getOcrProgress(documentId: string) {
  const activeProgress = ocrProgress.get(documentId);
  if (activeProgress) return activeProgress;

  // A pending item has not started reading pages yet, but its position still
  // tells the user that the server is alive and what it is waiting for.
  const queueIndex = queuedDocumentIds.indexOf(documentId);
  return queueIndex === -1
    ? null
    : { currentPage: 0, totalPages: 0, queuePosition: queueIndex + 1 };
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new OcrCancelledError();
}

async function mapWithConcurrency<T, Result>(items: T[], concurrency: number, operation: (item: T) => Promise<Result>) {
  const results: Result[] = new Array(items.length);
  let nextIndex = 0;
  let failure: unknown;
  const runner = async () => {
    // One failed or cancelled page stops the rest of the document from
    // starting new work, instead of reading pages whose results are discarded.
    while (nextIndex < items.length && failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index]!);
      } catch (error) {
        failure ??= error ?? new Error('Page processing failed.');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner));
  if (failure !== undefined) throw failure;
  return results;
}

/** Reads width and height from the PNG header without loading the raster. */
async function pngDimensions(imagePath: string) {
  const handle = await open(imagePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24 || header.toString('ascii', 1, 4) !== 'PNG') {
      throw new Error('Rendered page is not a valid PNG image.');
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

function parseTsv(tsv: string, pageNumber: number, imageWidth: number, imageHeight: number): OcrWord[] {
  return tsv
    .split(/\r?\n/)
    .slice(1)
    .map<OcrWord | null>((line, index) => {
      const columns = line.split('\t');
      if (columns.length < 12 || columns[0] !== '5') return null;
      const text = columns.slice(11).join('\t').trim();
      if (!text) return null;
      const left = Number(columns[6]);
      const top = Number(columns[7]);
      const width = Number(columns[8]);
      const height = Number(columns[9]);
      const confidence = Number(columns[10]);
      if (![left, top, width, height, confidence].every(Number.isFinite)) return null;
      return {
        id: `p${pageNumber}-ocr-${index}`,
        text,
        confidence,
        x: left / imageWidth,
        y: top / imageHeight,
        width: width / imageWidth,
        height: height / imageHeight,
        blockId: `p${pageNumber}-ocr-${columns[2]}`,
        lineId: `p${pageNumber}-ocr-${columns[2]}-${columns[3]}-${columns[4]}`,
      };
    })
    .filter((word): word is OcrWord => word !== null);
}

// Several pages can start at the same time, and they would otherwise expand
// the same language file over each other while another process reads it.
const languageDataCopies = new Map<string, Promise<void>>();

function expandLanguageData(code: string, destination: string) {
  const existing = languageDataCopies.get(code);
  if (existing) return existing;
  const source = bundledLanguageFiles[code];
  if (!source) throw new Error(`No bundled Tesseract data is available for '${code}'. Configure TESSDATA_PATH.`);
  const target = path.join(destination, `${code}.traineddata`);
  // Expanded under a temporary name and renamed into place, so a page that
  // starts while the model is still being written never reads half a file.
  const expand = access(target)
    .catch(async () => {
      const pending = `${target}.${process.pid}.partial`;
      await writeFile(pending, await gunzipAsync(await readFile(source)));
      await rename(pending, target);
    })
    .catch((error: unknown) => {
      languageDataCopies.delete(code);
      throw error;
    });
  languageDataCopies.set(code, expand);
  return expand;
}

async function languageDataPath(language: string) {
  if (config.tessdataPath) return config.tessdataPath;
  const destination = path.join(config.tempDir, 'tessdata');
  await mkdir(destination, { recursive: true });
  await Promise.all(language.split('+').map((code) => expandLanguageData(code, destination)));
  return destination;
}

// Orientation detection is a separate model. An image built from the Dockerfile
// ships it next to the language models; the bundled fallback data does not, so
// the answer is resolved once and the plain layouts are used without it.
const orientationDataChecks = new Map<string, Promise<boolean>>();

function orientationDataAvailable(language: string) {
  const existing = orientationDataChecks.get(language);
  if (existing) return existing;
  const check = languageDataPath(language)
    .then((directory) => access(path.join(directory, 'osd.traineddata')).then(() => true, () => false))
    .catch(() => false);
  orientationDataChecks.set(language, check);
  return check;
}

function embeddedTextIsUsable(page: ExtractedPage) {
  const compactText = page.text.replace(/\s/g, '');
  if (compactText.length < MIN_USABLE_CHARACTERS || page.words.length < MIN_USABLE_WORDS) return false;
  // Some PDFs contain an apparently selectable, but broken, character map.
  // OCR is more reliable than exporting private-use glyphs or replacement
  // symbols into the search index and Excel report.
  if (/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(compactText)) return false;
  if (hasLegacyAzeriFontEncoding(compactText)) return false;
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

function recognitionScore(words: OcrWord[]) {
  return words.reduce((score, word) => score + Math.max(0, word.confidence) * Math.max(1, word.text.length), 0);
}

async function recognizePage(
  imagePath: string,
  outputBase: string,
  language: string,
  pageNumber: number,
  imageWidth: number,
  imageHeight: number,
  renderDpi: number,
  preferSparseLayout: boolean,
  signal: AbortSignal,
) {
  const withOrientation = await orientationDataAvailable(language);
  const run = async (layout: 'auto' | 'sparse') => {
    const mode = layout === 'auto'
      ? (withOrientation ? PSM_AUTO_OSD : PSM_AUTO)
      : (withOrientation ? PSM_SPARSE_OSD : PSM_SPARSE);
    const result = await runTesseract(imagePath, `${outputBase}-${layout}`, language, mode, renderDpi, signal);
    return {
      text: result.text.trim(),
      words: parseTsv(result.tsv, pageNumber, imageWidth, imageHeight),
      layout,
    };
  };

  const automatic = await run('auto');
  const averageConfidence = automatic.words.length
    ? automatic.words.reduce((sum, word) => sum + word.confidence, 0) / automatic.words.length
    : 0;
  // The sparse-text pass doubles the cost of a page, so it only runs when the
  // automatic layout produced a weak result: few words, or low confidence.
  // Force-OCR mode is deliberately more demanding before it accepts a page,
  // because it is chosen for forms, stamps, columns, and scattered text.
  const minimumWords = preferSparseLayout ? 12 : 6;
  const minimumConfidence = preferSparseLayout ? 72 : 62;
  if (automatic.words.length >= minimumWords && averageConfidence >= minimumConfidence) return automatic;

  const sparse = await run('sparse');
  return recognitionScore(sparse.words) > recognitionScore(automatic.words) ? sparse : automatic;
}

/**
 * Very large page boxes would rasterise into images several times bigger than
 * a 300 DPI A4 scan. Tesseract normalises text lines internally, so the extra
 * pixels cost seconds per page without adding readable detail.
 */
function renderDpiForPage(page: ExtractedPage) {
  const squareInches = (page.width / 72) * (page.height / 72);
  if (!Number.isFinite(squareInches) || squareInches <= 0) return config.renderDpi;
  const budgetDpi = Math.floor(Math.sqrt(config.maxRenderPixels / squareInches));
  return Math.max(config.minRenderDpi, Math.min(config.renderDpi, budgetDpi));
}

async function renderPage(pdfPath: string, pageNumber: number, outputBase: string, dpi: number, signal: AbortSignal) {
  await renderSlots.acquire(signal);
  try {
    throwIfCancelled(signal);
    await execFileAsync('pdftoppm', [
      '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
      '-r', String(dpi), '-gray', '-png', pdfPath, outputBase,
    ], { maxBuffer: 20 * 1024 * 1024, signal });
  } catch (error) {
    // `execFile` reports an aborted child as a generic failure; the caller
    // needs to see it as a cancellation so the batch is not marked failed.
    if (signal.aborted) throw new OcrCancelledError();
    throw describeToolFailure('pdftoppm', error);
  } finally {
    renderSlots.release();
  }
  return `${outputBase}.png`;
}

type ProcessedPage = ExtractedPage & { source: string };

async function readPage(
  page: ExtractedPage,
  document: { id: string; ocrLanguage: string; ocrMode: string },
  pdfPath: string,
  workDir: string,
  signal: AbortSignal,
): Promise<ProcessedPage> {
  const forceOcr = document.ocrMode === 'FORCE_OCR';
  if (!forceOcr && embeddedTextIsUsable(page)) return { ...page, source: 'pdf-text' };

  await pageSlots.acquire(signal);
  const dpi = renderDpiForPage(page);
  let imagePath: string;
  try {
    imagePath = await renderPage(pdfPath, page.pageNumber, path.join(workDir, `page-${page.pageNumber}`), dpi, signal);
  } catch (error) {
    pageSlots.release();
    throw error;
  }
  try {
    const dimensions = await pngDimensions(imagePath);
    await recognitionSlots.acquire(signal);
    try {
      const result = await recognizePage(
        imagePath, path.join(workDir, `page-${page.pageNumber}`), document.ocrLanguage, page.pageNumber,
        dimensions.width, dimensions.height, dpi, forceOcr, signal,
      );
      return {
        ...page,
        words: result.words,
        text: result.text || result.words.map((word) => word.text).join(' '),
        source: result.layout === 'auto' ? 'tesseract-auto' : 'tesseract-sparse',
      };
    } finally {
      recognitionSlots.release();
    }
  } finally {
    // Rendered pages are large; releasing each one keeps a long PDF from
    // filling the temp directory while later pages are still being read.
    await rm(imagePath, { force: true }).catch(() => undefined);
    pageSlots.release();
  }
}

async function storeProcessedPages(documentId: string, pages: ProcessedPage[]) {
  const pageRows = pages.map((page) => ({
    documentId,
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    source: page.source,
    text: page.text,
    words: page.words,
  }));
  // `createMany` replaces one round trip per page. Over a pooled Neon
  // connection that is the difference between one statement and hundreds.
  const inserts = [];
  for (let index = 0; index < pageRows.length; index += PAGE_DB_CHUNK) {
    inserts.push(prisma.ocrPage.createMany({ data: pageRows.slice(index, index + PAGE_DB_CHUNK) }));
  }
  await prisma.$transaction([
    prisma.ocrPage.deleteMany({ where: { documentId } }),
    prisma.highlight.deleteMany({ where: { documentId, source: 'AUTO' } }),
    ...inserts,
    prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'COMPLETE', pageCount: pages.length, ocrError: null },
    }),
  ]);
}

export async function processDocument(documentId: string, signal: AbortSignal) {
  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  throwIfCancelled(signal);
  await prisma.document.update({
    where: { id: documentId },
    data: { ocrStatus: 'PROCESSING', ocrError: null },
  });

  const workDir = await mkdtemp(path.join(config.tempDir, `ocr-${documentId}-`));

  try {
    const pdfPath = await storage.materialize(document.storageKey, workDir);
    throwIfCancelled(signal);
    // Force-OCR ignores embedded text, so only page geometry is extracted.
    const extractedPages = await extractPdfPages(pdfPath, { withText: document.ocrMode !== 'FORCE_OCR' });
    throwIfCancelled(signal);

    let completedPages = 0;
    ocrProgress.set(documentId, { currentPage: 0, totalPages: extractedPages.length });
    await prisma.document.update({ where: { id: documentId }, data: { pageCount: extractedPages.length } });

    // Pages of one document are read in parallel and share the recognition
    // slots with every other document, so a single 40-page PDF now uses the
    // whole machine instead of one core.
    const processedPages = await mapWithConcurrency(
      extractedPages,
      config.ocrConcurrency + config.renderConcurrency,
      async (page) => {
        const processed = await readPage(page, document, pdfPath, workDir, signal);
        completedPages += 1;
        ocrProgress.set(documentId, { currentPage: completedPages, totalPages: extractedPages.length });
        return processed;
      },
    );

    throwIfCancelled(signal);
    await storeProcessedPages(documentId, processedPages);
  } catch (error) {
    const cancelled = isCancellation(error) || signal.aborted;
    const message = cancelled
      ? 'Cancelled before the document finished.'
      : error instanceof Error ? error.message : 'Unknown OCR failure';
    // A cancelled document is deleted by the caller. The status is still
    // written so the row can never stay stuck on PROCESSING if that fails.
    await prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'FAILED', ocrError: message.slice(0, 1000) },
    }).catch(() => undefined);
    throw cancelled ? new OcrCancelledError() : error;
  } finally {
    ocrProgress.delete(documentId);
    await rm(workDir, { recursive: true, force: true });
  }
}

const queuedDocumentIds: string[] = [];
const queuedSet = new Set<string>();
type ActiveJob = { controller: AbortController; settled: Promise<unknown> };
const activeJobs = new Map<string, ActiveJob>();

function drainOcrQueue() {
  while (activeJobs.size < config.documentConcurrency && queuedDocumentIds.length) {
    const documentId = queuedDocumentIds.shift()!;
    queuedSet.delete(documentId);
    const controller = new AbortController();
    const settled = processDocument(documentId, controller.signal)
      .catch((error) => {
        if (!isCancellation(error)) console.error('OCR failed', documentId, error);
      })
      .finally(() => {
        activeJobs.delete(documentId);
        drainOcrQueue();
      });
    activeJobs.set(documentId, { controller, settled });
  }
}

export function enqueueDocumentProcessing(documentId: string) {
  if (queuedSet.has(documentId) || activeJobs.has(documentId)) return;
  queuedSet.add(documentId);
  queuedDocumentIds.push(documentId);
  drainOcrQueue();
}

/**
 * Stops a queued or running document and resolves once its job has fully
 * settled, so the caller can delete its rows and file without racing a write.
 */
export async function cancelDocumentProcessing(documentId: string) {
  if (queuedSet.delete(documentId)) {
    const queueIndex = queuedDocumentIds.indexOf(documentId);
    if (queueIndex !== -1) queuedDocumentIds.splice(queueIndex, 1);
  }
  const active = activeJobs.get(documentId);
  if (!active) return;
  active.controller.abort();
  await active.settled.catch(() => undefined);
}

export async function resumeQueuedOcrJobs() {
  // A Render deploy or local server restart interrupts in-memory workers. Put
  // their documents back into the queue so they cannot remain stuck forever.
  const unfinished = await prisma.document.findMany({
    where: { ocrStatus: { in: ['PENDING', 'PROCESSING'] } },
    select: { id: true },
    // Give the just-uploaded batch priority after a deployment/restart. Older
    // interrupted work remains recoverable, but should not make a new upload
    // look frozen behind it.
    orderBy: { createdAt: 'desc' },
  });
  if (!unfinished.length) return;
  await prisma.document.updateMany({
    where: { id: { in: unfinished.map((document) => document.id) } },
    data: { ocrStatus: 'PENDING', ocrError: null },
  });
  unfinished.forEach((document) => enqueueDocumentProcessing(document.id));
}

export async function ensureOcrDirectories() {
  await Promise.all([
    mkdir(config.tempDir, { recursive: true }),
    mkdir(config.storageDir, { recursive: true }),
  ]);
}

/**
 * Recognition runs in child processes that exit with the page, and they are
 * killed with the server, so there is no worker pool left to free. Kept as the
 * shutdown hook the server already calls.
 */
export async function shutdownOcrWorkers() {}
