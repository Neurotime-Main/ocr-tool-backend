import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  allDocuments, allPages, getDocument, getPage, pagesOf, updateDocument, updatePage,
  type DocumentRow, type PageRow,
} from './store.js';
import type { OcrWord } from './types.js';

/**
 * The work queue, held in this process's memory.
 *
 * It used to live in Postgres, claimed with `FOR UPDATE SKIP LOCKED`, so that
 * several worker processes could share it and a deploy could not drop what was
 * in flight. Neither applies now: there is one process, and its memory is the
 * only copy. What the queue still owes its callers is unchanged -- pages come
 * out in upload order, a page is handed to exactly one runner at a time, and a
 * page that keeps failing runs out of attempts instead of looping forever.
 *
 * Claiming needs no lock. `claimPages` runs start to finish without awaiting,
 * and JavaScript will not interleave another turn inside it, so two concurrent
 * callers cannot see the same page as PENDING.
 */

export const WORKER_ID = `${config.queueNamespace}-${process.pid}-${randomUUID().slice(0, 8)}`;

export type ClaimedPage = {
  id: string;
  documentId: string;
  pageNumber: number;
  attempts: number;
  storageKey: string;
  ocrLanguage: string;
  ocrMode: string;
};

const claimable = (document: DocumentRow, page: PageRow) =>
  page.status === 'PENDING'
  && page.attempts < config.maxPageAttempts
  && document.preparedAt !== null;

/**
 * Takes up to `limit` pending pages.
 *
 * Order is upload order and then page number, which keeps the pages of one
 * batch clustered in a few documents -- so the PDF each page belongs to is
 * opened once for the whole run rather than once per page.
 */
export async function claimPages(limit: number): Promise<ClaimedPage[]> {
  const claimed: ClaimedPage[] = [];
  const now = new Date();
  for (const { document, page } of allPages()) {
    if (claimed.length >= limit) break;
    if (!claimable(document, page)) continue;
    page.status = 'PROCESSING';
    page.attempts += 1;
    page.lockedBy = WORKER_ID;
    page.startedAt = now;
    page.updatedAt = now;
    claimed.push({
      id: page.id,
      documentId: document.id,
      pageNumber: page.pageNumber,
      attempts: page.attempts,
      storageKey: document.storageKey,
      ocrLanguage: document.ocrLanguage,
      ocrMode: document.ocrMode,
    });
  }
  return claimed;
}

/**
 * Returns pages whose runner never settled them.
 *
 * With one process this is a narrower case than it was: a page is only left in
 * PROCESSING by a code path that threw somewhere the page handler does not
 * cover. The attempt has already been counted, so a page that keeps doing this
 * still runs out of retries rather than cycling.
 */
export async function releaseStalePages() {
  const cutoff = Date.now() - config.staleLockMs;
  let recovered = 0;
  for (const { page } of allPages()) {
    const stale = page.status === 'PROCESSING'
      && page.startedAt !== null
      && page.startedAt.getTime() < cutoff;
    // A page abandoned on its final attempt must be retired, not offered again:
    // returned to PENDING with its attempts spent, it would be invisible to the
    // claim query and its document would report PROCESSING forever.
    if (stale && page.attempts >= config.maxPageAttempts) {
      updatePage(page.id, {
        status: 'FAILED',
        error: 'The reader for this page stopped before it finished, and no attempts were left.',
        lockedBy: null,
        startedAt: null,
      });
      recovered += 1;
      continue;
    }
    if (stale) {
      updatePage(page.id, { status: 'PENDING', lockedBy: null, startedAt: null });
      recovered += 1;
      continue;
    }
    if (page.status === 'PENDING' && page.attempts >= config.maxPageAttempts) {
      updatePage(page.id, {
        status: 'FAILED',
        error: 'This page ran out of attempts.',
        lockedBy: null,
        startedAt: null,
      });
      recovered += 1;
    }
  }
  return recovered;
}

/**
 * Finishes documents whose pages have all settled.
 *
 * A document's status is refreshed by whoever finished its last page. If that
 * path threw in between, nothing looks at the document again and it reports
 * PROCESSING for good, even though every page is done -- a batch that never
 * completes and cannot be published. This sweeps for exactly that.
 */
export async function reconcileDocumentStatuses(limit = 50) {
  const stranded: string[] = [];
  for (const document of documentsNeedingStatus()) {
    if (stranded.length >= limit) break;
    stranded.push(document.id);
  }
  for (const id of stranded) await refreshDocumentStatus(id);
  return stranded.length;
}

function* documentsNeedingStatus() {
  const seen = new Set<string>();
  for (const { document } of allPages()) {
    if (seen.has(document.id)) continue;
    seen.add(document.id);
    if (document.ocrStatus !== 'PENDING' && document.ocrStatus !== 'PROCESSING') continue;
    if (document.preparedAt === null) continue;
    const outstanding = pagesOf(document.id)
      .some((page) => page.status === 'PENDING' || page.status === 'PROCESSING');
    if (!outstanding) yield document;
  }
}

export async function pendingPageCount() {
  let count = 0;
  for (const { page } of allPages()) {
    if (page.status === 'PENDING' || page.status === 'PROCESSING') count += 1;
  }
  return count;
}

/**
 * Recomputes a document's status from its pages.
 *
 * The document is a summary of its pages, never a separate source of truth, so
 * this is safe to call at any point.
 *
 * A document is COMPLETE once no page is still waiting, even when some pages
 * failed: the pages that were read are worth searching and publishing, and the
 * failures are reported in `ocrError` rather than by discarding the rest. Only
 * a document where nothing at all could be read is FAILED.
 */
export async function refreshDocumentStatus(documentId: string) {
  const pages = pagesOf(documentId);
  const total = pages.length;
  if (!total) return;
  const by = (status: string) => pages.filter((page) => page.status === status).length;
  const outstanding = by('PENDING') + by('PROCESSING');
  const failed = by('FAILED');
  const complete = by('COMPLETE');

  if (outstanding > 0) {
    const document = getDocument(documentId);
    if (document && document.ocrStatus !== 'PROCESSING') {
      updateDocument(documentId, { ocrStatus: 'PROCESSING' });
    }
    return;
  }

  const firstFailure = pages
    .filter((page) => page.status === 'FAILED')
    .sort((a, b) => a.pageNumber - b.pageNumber)[0];

  updateDocument(documentId, {
    ocrStatus: complete > 0 ? 'COMPLETE' : 'FAILED',
    pageCount: total,
    ocrError: failed
      ? `${failed} of ${total} page${total === 1 ? '' : 's'} could not be read (first was page ${firstFailure?.pageNumber ?? '?'}: ${firstFailure?.error ?? 'unknown error'}).`.slice(0, 1000)
      : null,
  });
}

/** Marks a claimed page finished. */
export async function completePage(pageId: string, data: {
  width: number;
  height: number;
  source: string;
  text: string;
  searchText: string;
  words: OcrWord[];
}) {
  updatePage(pageId, { ...data, status: 'COMPLETE', error: null, lockedBy: null, startedAt: null });
}

/**
 * Records a failed attempt.
 *
 * The page goes back to PENDING while it has retries left, so a transient
 * failure -- a daemon that died mid-page -- costs one page rather than the
 * document. Once the attempts are spent it stays FAILED and the rest of the
 * document carries on without it.
 */
export async function failPage(pageId: string, attempts: number, message: string) {
  const exhausted = attempts >= config.maxPageAttempts;
  updatePage(pageId, {
    status: exhausted ? 'FAILED' : 'PENDING',
    error: message.slice(0, 1000),
    lockedBy: null,
    startedAt: null,
  });
  return exhausted;
}

/** Puts pages back without spending an attempt, for a clean shutdown. */
export async function releasePages(pageIds: string[]) {
  for (const pageId of pageIds) {
    const page = getPageIfProcessing(pageId);
    if (!page) continue;
    updatePage(pageId, {
      status: 'PENDING',
      lockedBy: null,
      startedAt: null,
      attempts: Math.max(0, page.attempts - 1),
    });
  }
}

function getPageIfProcessing(pageId: string) {
  const page = getPage(pageId);
  return page?.status === 'PROCESSING' ? page : undefined;
}

export type QueueHealth = {
  unpreparedDocuments: number;
  pendingPages: number;
  processingPages: number;
  oldestUnpreparedSeconds: number | null;
  oldestPendingSeconds: number | null;
  lastClaimSeconds: number | null;
  stalled: boolean;
};

/**
 * Reports whether anything is actually draining the queue.
 *
 * There is no heartbeat, but `startedAt` is written every time a page is
 * claimed, so the most recent claim stands in for "the worker is alive". Work
 * waiting while nothing has been claimed for minutes is the signature of a
 * worker loop that has stopped.
 */
export async function getQueueHealth(): Promise<QueueHealth> {
  let unpreparedDocuments = 0;
  let pendingPages = 0;
  let processingPages = 0;
  let oldestUnprepared: number | null = null;
  let oldestPending: number | null = null;
  let lastClaim: number | null = null;

  for (const document of allDocuments()) {
    const unprepared = document.preparedAt === null
      && (document.ocrStatus === 'PENDING' || document.ocrStatus === 'PROCESSING');
    if (unprepared) {
      unpreparedDocuments += 1;
      const at = document.createdAt.getTime();
      if (oldestUnprepared === null || at < oldestUnprepared) oldestUnprepared = at;
    }
    for (const page of pagesOf(document.id)) {
      if (page.status === 'PENDING') {
        pendingPages += 1;
        const at = page.createdAt.getTime();
        if (oldestPending === null || at < oldestPending) oldestPending = at;
      }
      if (page.status === 'PROCESSING') processingPages += 1;
      if (page.startedAt) {
        const at = page.startedAt.getTime();
        if (lastClaim === null || at > lastClaim) lastClaim = at;
      }
    }
  }

  const secondsSince = (at: number | null) =>
    at === null ? null : Math.round((Date.now() - at) / 1000);
  const oldestUnpreparedSeconds = secondsSince(oldestUnprepared);
  const oldestPendingSeconds = secondsSince(oldestPending);
  const lastClaimSeconds = secondsSince(lastClaim);

  return {
    unpreparedDocuments,
    pendingPages,
    processingPages,
    oldestUnpreparedSeconds,
    oldestPendingSeconds,
    lastClaimSeconds,
    stalled: (pendingPages > 0 || unpreparedDocuments > 0)
      && Math.max(oldestPendingSeconds ?? 0, oldestUnpreparedSeconds ?? 0) > 120
      && (lastClaimSeconds === null || lastClaimSeconds > 120),
  };
}
