import { mkdir } from 'node:fs/promises';
import { config, describeRuntime, isSpacesDriver } from './config.js';
import { prisma } from './db.js';
import { checkOcrEngine, shutdownOcrEngine } from './ocrEngine.js';
import { checkRenderer } from './render.js';
import {
  backfillPages, claimPages, reconcileDocumentStatuses, refreshDocumentStatus, releasePages,
  releaseStalePages,
  type ClaimedPage,
} from './pageQueue.js';
import { normalizeForSearch } from './normalize.js';
import { documentCache, handlePageFailure, prepareDocument, processPage } from './pipeline.js';
import { storage } from './storage.js';

/**
 * The page worker.
 *
 * Runs in its own Render service in production, so recognition never competes
 * with HTTP traffic for the CPU, and runs inside the API process during local
 * development so `npm run dev` stays one command. Several instances can run at
 * once without coordinating: the queue hands each page to exactly one of them.
 */

type WorkerState = {
  running: boolean;
  controller: AbortController;
  inFlight: Set<string>;
  loop?: Promise<void>;
};

const state: WorkerState = {
  running: false,
  controller: new AbortController(),
  inFlight: new Set(),
};

/**
 * Opens documents that have not been read yet.
 *
 * Preparation is the step that decides, page by page, whether the PDF's own
 * text layer can be used or whether the page has to be recognised. It is cheap
 * -- a fraction of a second per page -- and for these documents it resolves the
 * large majority of pages outright, so it is what actually makes an upload
 * usable.
 */
async function prepareNewDocuments(signal: AbortSignal) {
  const staleBefore = new Date(Date.now() - config.prepareStaleMs);
  const pending = await prisma.document.findMany({
    where: {
      queueNamespace: config.queueNamespace,
      preparedAt: null,
      OR: [
        { ocrStatus: 'PENDING' },
        // A deploy or OOM kill can stop after PROCESSING is written but before
        // the first page row. Recover that otherwise-permanent stranded state.
        { ocrStatus: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: config.prepareBatchSize,
  });
  let claimed = 0;
  for (const document of pending) {
    if (signal.aborted) return 0;
    // Several workers can see the same candidate. Only the one whose guarded
    // update succeeds owns this preparation attempt.
    const ownership = await prisma.document.updateMany({
      where: {
        id: document.id,
        queueNamespace: config.queueNamespace,
        preparedAt: null,
        OR: [
          { ocrStatus: 'PENDING' },
          { ocrStatus: 'PROCESSING', updatedAt: { lt: staleBefore } },
        ],
      },
      data: { ocrStatus: 'PROCESSING', ocrError: null },
    });
    if (!ownership.count) continue;
    claimed += 1;
    await prepareDocument(document.id, signal);
  }
  return claimed;
}

/** Runs `ocrConcurrency` pages at a time over one claimed batch. */
async function runPages(pages: ClaimedPage[], signal: AbortSignal) {
  let next = 0;
  const runner = async () => {
    while (next < pages.length && !signal.aborted) {
      const page = pages[next++]!;
      state.inFlight.add(page.id);
      try {
        await processPage(page, signal);
        await refreshDocumentStatus(page.documentId);
      } catch (error) {
        if (signal.aborted) {
          // A shutdown is not a page failure: the lock is given back below and
          // the attempt refunded, so another worker picks the page up intact.
          break;
        }
        const { exhausted, message } = await handlePageFailure(page, error);
        console.error(
          `[ocr] page ${page.pageNumber} of ${page.documentId} failed (attempt ${page.attempts}${exhausted ? ', giving up' : ''}): ${message}`,
        );
      } finally {
        state.inFlight.delete(page.id);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(config.ocrConcurrency, pages.length)) },
    runner,
  ));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads documents' text layers, continuously and independently of recognition.
 *
 * These were one loop until it became clear what that cost: a pass prepared a
 * handful of documents, then blocked on recognising their image-only pages
 * before looking at any more. Recognition is minutes per page on a small
 * instance, so an upload of a dozen files spent most of its life with most of
 * those files not yet opened -- reported as PROCESSING with no pages at all --
 * while the text that would have answered the user's search in seconds sat
 * unread behind a handful of scanned pages.
 *
 * Splitting them means the cheap, high-yield work is never queued behind the
 * expensive, rare work. The two share a CPU, but preparation is short per
 * document and interleaves; recognition simply finishes a little later, which
 * is the right thing to trade.
 */
async function prepareLoop(signal: AbortSignal) {
  while (state.running && !signal.aborted) {
    try {
      const prepared = await prepareNewDocuments(signal);
      if (prepared > 0) {
        console.log(`[ocr] prepared ${prepared} document${prepared === 1 ? '' : 's'}`);
        continue;
      }
    } catch (error) {
      console.error('[ocr] preparation pass failed:', error);
    }
    await sleep(config.queuePollIntervalMs);
  }
}

/** Claims and recognises the pages that no text layer could answer. */
async function recognitionLoop(signal: AbortSignal) {
  while (state.running && !signal.aborted) {
    try {
      const pages = await claimPages(config.pageClaimSize);
      if (pages.length) {
        const started = Date.now();
        await runPages(pages, signal);
        if (!signal.aborted) {
          const seconds = (Date.now() - started) / 1000;
          console.log(`[ocr] recognised ${pages.length} page${pages.length === 1 ? '' : 's'} in ${seconds.toFixed(1)}s (${(seconds / pages.length).toFixed(1)}s/page)`);
        }
        continue;
      }
    } catch (error) {
      console.error('[ocr] recognition pass failed:', error);
    }
    await sleep(config.queuePollIntervalMs);
  }
}

/**
 * Housekeeping: recovering pages from workers that vanished, and upgrading rows
 * the previous pipeline wrote. Both are slow-moving and neither may hold up the
 * two loops above, so they get their own.
 */
async function maintenanceLoop(signal: AbortSignal) {
  while (state.running && !signal.aborted) {
    try {
      const recovered = await releaseStalePages();
      if (recovered) console.log(`[ocr] recovered ${recovered} abandoned page(s)`);
      // A document whose last page finished while its worker was dying never
      // had its status refreshed, and would otherwise stay PROCESSING forever.
      const reconciled = await reconcileDocumentStatuses();
      if (reconciled) console.log(`[ocr] finished ${reconciled} document(s) whose pages were already done`);
      const upgraded = await backfillPages(normalizeForSearch);
      if (upgraded) {
        console.log(`[ocr] upgraded ${upgraded} stored page(s)`);
        continue;
      }
    } catch (error) {
      console.error('[ocr] maintenance pass failed:', error);
    }
    await sleep(60_000);
  }
}

export function startOcrWorker() {
  if (state.running) return;
  state.running = true;
  state.controller = new AbortController();
  console.log(
    `[ocr] worker started: ${config.ocrConcurrency} recognition slot(s), `
    + `${config.renderConcurrency} renderer(s), claiming ${config.pageClaimSize} page(s) at a time`,
  );
  const { signal } = state.controller;
  // Preparation, recognition and housekeeping run independently, so none of
  // them can be held up behind another.
  state.loop = Promise.all([
    prepareLoop(signal),
    recognitionLoop(signal),
    maintenanceLoop(signal),
  ]).then(() => undefined);
}

/**
 * Stops the worker and hands back whatever it was holding.
 *
 * Render allows a grace period on shutdown, which is spent returning the
 * claimed pages rather than finishing them: another worker, or this one after
 * the deploy, will pick them up with their attempt count untouched.
 */
export async function stopOcrWorker() {
  if (!state.running) return;
  state.running = false;
  state.controller.abort();
  await state.loop?.catch(() => undefined);
  await releasePages([...state.inFlight]).catch(() => undefined);
  state.inFlight.clear();
  await documentCache.clear().catch(() => undefined);
  await shutdownOcrEngine();
}

export async function ensureWorkerDirectories() {
  await Promise.all([
    mkdir(config.tempDir, { recursive: true }),
    mkdir(config.storageDir, { recursive: true }),
  ]);
}

/** Entry point for the standalone worker service. */
export async function runWorkerService() {
  console.log(describeRuntime('worker'));

  // A standalone worker never receives an upload, so a local storage directory
  // of its own is empty by definition: every PDF it is asked for was written by
  // the API, in a different container, onto a disk this process cannot see.
  // Checked here rather than only in the production guard because the give-away
  // symptom -- every page failing with "the stored PDF is missing" -- says
  // nothing about the setting that caused it, and because a worker deployed
  // outside the Dockerfile has no NODE_ENV for that guard to key on.
  if (!isSpacesDriver(config.storageDriver)) {
    throw new Error(
      `The OCR worker cannot run with STORAGE_DRIVER='${config.storageDriver}'. It reads PDFs that the `
      + 'API stored, and a local directory is not shared between the two services. Set '
      + 'STORAGE_DRIVER=spaces on this service, along with DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, '
      + 'DO_SPACES_REGION, DO_SPACES_KEY and DO_SPACES_SECRET -- the same values the API uses.',
    );
  }

  await ensureWorkerDirectories();
  const storageStatus = await storage.check();
  if (!storageStatus.ok) {
    throw new Error(`Storage is not reachable (${storageStatus.driver}): ${storageStatus.detail}`);
  }

  // The recogniser and the rasteriser are installed by the Dockerfile. A worker
  // deployed on a plain Node runtime has neither, and would otherwise take
  // pages off the queue only to fail every one of them.
  const [engine, renderer] = await Promise.all([checkOcrEngine(), checkRenderer()]);
  if (!engine.ok) throw new Error(`The OCR engine is not usable on this service: ${engine.detail}`);
  if (!renderer.ok) throw new Error(`The PDF renderer is not usable on this service: ${renderer.detail}`);
  console.log(`[boot] engine=${engine.detail} renderer=${renderer.detail}`);

  startOcrWorker();

  const shutdown = async () => {
    console.log('[ocr] shutting down');
    await stopOcrWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
