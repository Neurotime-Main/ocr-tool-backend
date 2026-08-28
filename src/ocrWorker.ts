import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { prisma } from './db.js';
import { shutdownOcrEngine } from './ocrEngine.js';
import {
  backfillPages, claimPages, refreshDocumentStatus, releasePages, releaseStalePages,
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
 * Documents whose pages have not been enumerated yet.
 *
 * Preparation is the one step that is still per document: it opens the PDF,
 * reads the text layer, and decides page by page what needs recognising. It is
 * cheap and mostly I/O, so it is done inline rather than given its own queue.
 */
async function prepareNewDocuments(signal: AbortSignal) {
  const pending = await prisma.document.findMany({
    where: { ocrStatus: { in: ['PENDING'] }, pages: { none: {} } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  for (const document of pending) {
    if (signal.aborted) return;
    await prepareDocument(document.id, signal);
  }
  return pending.length;
}

/** Runs `limit` promises at a time over the claimed pages. */
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

async function tick(signal: AbortSignal) {
  await prepareNewDocuments(signal);
  if (signal.aborted) return 0;

  const pages = await claimPages(config.pageClaimSize);
  if (!pages.length) return 0;

  console.log(`[ocr] claimed ${pages.length} page${pages.length === 1 ? '' : 's'}`);
  const started = Date.now();
  await runPages(pages, signal);
  if (!signal.aborted) {
    const seconds = (Date.now() - started) / 1000;
    console.log(`[ocr] finished ${pages.length} page${pages.length === 1 ? '' : 's'} in ${seconds.toFixed(1)}s (${(seconds / pages.length).toFixed(2)}s/page)`);
  }
  return pages.length;
}

let sinceStaleSweep = 0;

async function loop() {
  const { signal } = state.controller;
  while (state.running && !signal.aborted) {
    try {
      // Recovering abandoned locks is cheap but pointless to do every pass, so
      // it runs roughly once a minute.
      sinceStaleSweep += config.queuePollIntervalMs;
      if (sinceStaleSweep >= 60_000) {
        sinceStaleSweep = 0;
        const recovered = await releaseStalePages();
        if (recovered) console.log(`[ocr] returned ${recovered} abandoned page(s) to the queue`);
      }

      const processed = await tick(signal);
      // Chips away at pages left over from the previous pipeline. It runs only
      // when the queue is otherwise idle, so it never delays a batch.
      if (processed === 0 && !signal.aborted) {
        const filled = await backfillPages(normalizeForSearch);
        if (filled) {
          console.log(`[ocr] upgraded ${filled} stored page(s)`);
          continue;
        }
      }
      // Straight back round while there is work; otherwise wait before asking
      // again, so an idle worker is not polling the database in a tight loop.
      if (processed > 0) continue;
    } catch (error) {
      console.error('[ocr] worker pass failed:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, config.queuePollIntervalMs));
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
  state.loop = loop();
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
  await ensureWorkerDirectories();
  const storageStatus = await storage.check();
  if (!storageStatus.ok) {
    throw new Error(`Storage is not reachable (${storageStatus.driver}): ${storageStatus.detail}`);
  }
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
