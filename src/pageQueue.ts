import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { config } from './config.js';
import { compactWords, needsCompaction } from './words.js';
import { prisma } from './db.js';

/**
 * The work queue, kept in Postgres rather than in the API process's memory.
 *
 * The previous queue was an array inside the web service: it could not be
 * shared with a second process, it competed with HTTP traffic for the CPU, and
 * a deploy dropped whatever was in flight. Claiming rows with
 * `FOR UPDATE SKIP LOCKED` gives the same ordering guarantees with none of
 * that -- any number of workers can pull from it, a crashed worker's pages are
 * recovered by their lock expiring, and the queue survives a restart because it
 * is simply the set of pages that are not finished yet.
 */

export const WORKER_ID = `${config.queueNamespace}-${process.env.RENDER_INSTANCE_ID ?? 'local'}-${process.pid}-${randomUUID().slice(0, 8)}`;

export type ClaimedPage = {
  id: string;
  documentId: string;
  pageNumber: number;
  attempts: number;
  storageKey: string;
  ocrLanguage: string;
  ocrMode: string;
};

/**
 * Takes up to `limit` pending pages for this worker.
 *
 * Ordering by document age and then page number means a batch is worked
 * through roughly in upload order, and it keeps the pages one worker holds
 * clustered in a few documents -- so the PDF each page belongs to is downloaded
 * and parsed once for the whole run instead of once per page.
 *
 * `SKIP LOCKED` is what makes several workers safe: two workers racing for the
 * same row do not block each other, the second simply takes the next one.
 */
export async function claimPages(limit: number): Promise<ClaimedPage[]> {
  return prisma.$queryRaw<ClaimedPage[]>`
    WITH claimed AS (
      SELECT p.id
      FROM "OcrPage" p
      JOIN "Document" d ON d.id = p."documentId"
      WHERE p.status = 'PENDING'
        AND p.attempts < ${config.maxPageAttempts}
        AND d."queueNamespace" = ${config.queueNamespace}
        AND d."preparedAt" IS NOT NULL
      ORDER BY d."createdAt" ASC, p."pageNumber" ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE "OcrPage" p
    SET status = 'PROCESSING',
        attempts = p.attempts + 1,
        "lockedBy" = ${WORKER_ID},
        "startedAt" = NOW(),
        "updatedAt" = NOW()
    FROM claimed, "Document" d2
    WHERE p.id = claimed.id AND d2.id = p."documentId"
    RETURNING p.id, p."documentId", p."pageNumber", p.attempts,
              d2."storageKey", d2."ocrLanguage", d2."ocrMode"
  `;
}

/**
 * Returns pages whose worker disappeared to the queue.
 *
 * A page is only ever left in PROCESSING by a worker that stopped between
 * claiming it and finishing it -- a deploy, an OOM kill, a lost instance. The
 * attempt has already been counted, so a page that keeps killing its worker
 * still runs out of retries rather than looping forever.
 */
export async function releaseStalePages() {
  const cutoff = new Date(Date.now() - config.staleLockMs);

  // A page abandoned on its final attempt must be retired, not offered again.
  // Returning it to PENDING with its attempts already spent would put it in a
  // state the claim query filters out, so nothing would ever pick it up and its
  // document would report PROCESSING forever. A worker being killed part-way
  // through its last attempt is routine -- it is what every deploy does -- so
  // this is the difference between a batch that finishes and one that never
  // does.
  const retired = await prisma.ocrPage.updateMany({
    where: {
      status: 'PROCESSING',
      document: { queueNamespace: config.queueNamespace },
      startedAt: { lt: cutoff },
      attempts: { gte: config.maxPageAttempts },
    },
    data: {
      status: 'FAILED',
      error: 'The worker reading this page stopped before it finished, and no attempts were left.',
      lockedBy: null,
      startedAt: null,
    },
  });

  const returned = await prisma.ocrPage.updateMany({
    where: {
      status: 'PROCESSING',
      document: { queueNamespace: config.queueNamespace },
      startedAt: { lt: cutoff },
    },
    data: { status: 'PENDING', lockedBy: null, startedAt: null },
  });

  // Rows already stranded by an earlier release, before the rule above existed.
  const rescued = await prisma.ocrPage.updateMany({
    where: {
      status: 'PENDING',
      document: { queueNamespace: config.queueNamespace },
      attempts: { gte: config.maxPageAttempts },
    },
    data: {
      status: 'FAILED',
      error: 'This page ran out of attempts while a worker was being restarted.',
      lockedBy: null,
      startedAt: null,
    },
  });

  return retired.count + returned.count + rescued.count;
}

/**
 * Finishes documents whose pages have all settled.
 *
 * A document's status is refreshed by whichever worker finished its last page.
 * If that worker died in between -- a deploy, an OOM kill, a lost connection --
 * nothing ever looks at the document again and it reports PROCESSING for good,
 * even though every page is done. The user sees a batch that never completes
 * and cannot publish it.
 *
 * This sweeps for exactly that: not-finished documents with no unfinished
 * pages. It is cheap because the condition is rare, and it is the only thing
 * that can rescue a document already in that state.
 */
export async function reconcileDocumentStatuses(limit = 50) {
  const stranded = await prisma.document.findMany({
    where: {
      queueNamespace: config.queueNamespace,
      ocrStatus: { in: ['PENDING', 'PROCESSING'] },
      // Prepared, so page rows exist, and none of them are still outstanding.
      preparedAt: { not: null },
      pages: { none: { status: { in: ['PENDING', 'PROCESSING'] } } },
    },
    select: { id: true },
    take: limit,
  });
  for (const document of stranded) await refreshDocumentStatus(document.id);
  return stranded.length;
}

export async function pendingPageCount() {
  return prisma.ocrPage.count({
    where: {
      status: { in: ['PENDING', 'PROCESSING'] },
      document: { queueNamespace: config.queueNamespace },
    },
  });
}

/**
 * Recomputes a document's status from its pages.
 *
 * The document row is a summary of the page rows, never a separate source of
 * truth, so this is safe to call from any worker at any time.
 *
 * A document is COMPLETE once no page is still waiting, even when some pages
 * failed: the pages that were read are worth searching and exporting, and the
 * failures are reported in `ocrError` rather than by discarding the rest. Only
 * a document where nothing at all could be read is FAILED.
 */
export async function refreshDocumentStatus(documentId: string) {
  const counts = await prisma.ocrPage.groupBy({
    by: ['status'],
    where: { documentId },
    _count: { _all: true },
  });
  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  if (!total) return;
  const by = (status: string) => counts.find((row) => row.status === status)?._count._all ?? 0;
  const outstanding = by('PENDING') + by('PROCESSING');
  const failed = by('FAILED');
  const complete = by('COMPLETE');

  if (outstanding > 0) {
    await prisma.document.updateMany({
      where: { id: documentId, ocrStatus: { not: 'PROCESSING' } },
      data: { ocrStatus: 'PROCESSING' },
    });
    return;
  }

  const firstFailure = failed
    ? await prisma.ocrPage.findFirst({
      where: { documentId, status: 'FAILED' },
      select: { pageNumber: true, error: true },
      orderBy: { pageNumber: 'asc' },
    })
    : null;

  await prisma.document.update({
    where: { id: documentId },
    data: {
      ocrStatus: complete > 0 ? 'COMPLETE' : 'FAILED',
      pageCount: total,
      ocrError: failed
        ? `${failed} of ${total} page${total === 1 ? '' : 's'} could not be read (first was page ${firstFailure?.pageNumber ?? '?'}: ${firstFailure?.error ?? 'unknown error'}).`.slice(0, 1000)
        : null,
    },
  }).catch(() => undefined);
}

/** Marks a claimed page finished. */
export async function completePage(pageId: string, data: {
  width: number;
  height: number;
  source: string;
  text: string;
  searchText: string;
  words: Prisma.InputJsonValue;
}) {
  // `updateMany` rather than `update`: a user can cancel a document while one
  // of its pages is being read, which deletes the row. That is a normal
  // outcome, not an error worth failing the worker pass over.
  await prisma.ocrPage.updateMany({
    where: { id: pageId },
    data: { ...data, status: 'COMPLETE', error: null, lockedBy: null, startedAt: null },
  });
}

/**
 * Records a failed attempt.
 *
 * The page goes back to PENDING while it has retries left, so a transient
 * failure -- a stalled download, a daemon that died mid-page -- costs one page
 * rather than the document. Once the attempts are spent it stays FAILED and the
 * rest of the document carries on without it.
 */
export async function failPage(pageId: string, attempts: number, message: string) {
  const exhausted = attempts >= config.maxPageAttempts;
  await prisma.ocrPage.updateMany({
    where: { id: pageId },
    data: {
      status: exhausted ? 'FAILED' : 'PENDING',
      error: message.slice(0, 1000),
      lockedBy: null,
      startedAt: null,
    },
  });
  return exhausted;
}

/** Puts pages back without spending an attempt, for a clean worker shutdown. */
export async function releasePages(pageIds: string[]) {
  if (!pageIds.length) return;
  await prisma.ocrPage.updateMany({
    where: { id: { in: pageIds }, status: 'PROCESSING' },
    data: { status: 'PENDING', lockedBy: null, startedAt: null, attempts: { decrement: 1 } },
  });
}

/**
 * Brings pages written by the previous pipeline up to date.
 *
 * Two things need fixing on those rows, and both are cheapest to do together
 * while the queue is idle:
 *
 *  - `searchText` is empty, so the keyword filter cannot rule those pages out
 *    and has to load them in full. The value has to come from the same
 *    normaliser the matcher uses, which lives in TypeScript rather than SQL,
 *    which is why this is not a migration.
 *  - `words` is stored in the original uncompacted shape, at roughly twice the
 *    bytes. Transferring word boxes is what a search over many matching pages
 *    actually spends its time on, so halving them is the single most effective
 *    thing that can be done to it.
 */
export async function backfillPages(normalize: (value: string) => string, batchSize = 100) {
  // An empty `searchText` on a page that has text identifies exactly the rows
  // the previous pipeline wrote, because the column and the compact word shape
  // were introduced together. A genuinely blank page is excluded by `text`.
  const pending = await prisma.ocrPage.findMany({
    where: {
      searchText: '',
      NOT: { text: '' },
      document: { queueNamespace: config.queueNamespace },
    },
    select: { id: true, text: true, words: true },
    take: batchSize,
  });
  if (!pending.length) return 0;
  await prisma.$transaction(pending.map((page) => prisma.ocrPage.update({
    where: { id: page.id },
    data: {
      searchText: normalize(page.text),
      ...(needsCompaction(page.words)
        ? { words: compactWords(page.words) as unknown as Prisma.InputJsonValue }
        : {}),
    },
  })));
  return pending.length;
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
 * Recognition runs in its own service, so the API can be perfectly healthy
 * while no worker exists at all -- and the only symptom is that documents stay
 * PENDING forever, with nothing anywhere saying why. There is no heartbeat
 * table, but `startedAt` is written every time a page is claimed, so the most
 * recent claim stands in for "a worker is alive". Work waiting while nothing
 * has been claimed for minutes is the signature of a worker that is missing,
 * crash-looping, or pointed at the wrong database.
 */
export async function getQueueHealth(): Promise<QueueHealth> {
  const unpreparedWhere: Prisma.DocumentWhereInput = {
    queueNamespace: config.queueNamespace,
    ocrStatus: { in: ['PENDING', 'PROCESSING'] },
    preparedAt: null,
  };
  const [unpreparedDocuments, pendingPages, processingPages, oldest, lastClaim, oldestUnprepared] = await Promise.all([
    prisma.document.count({ where: unpreparedWhere }),
    prisma.ocrPage.count({
      where: { status: 'PENDING', document: { queueNamespace: config.queueNamespace } },
    }),
    prisma.ocrPage.count({
      where: { status: 'PROCESSING', document: { queueNamespace: config.queueNamespace } },
    }),
    prisma.ocrPage.findFirst({
      where: { status: 'PENDING', document: { queueNamespace: config.queueNamespace } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.ocrPage.findFirst({
      where: {
        startedAt: { not: null },
        document: { queueNamespace: config.queueNamespace },
      },
      select: { startedAt: true },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.document.findFirst({
      where: unpreparedWhere,
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const secondsSince = (date: Date | null | undefined) =>
    date ? Math.round((Date.now() - date.getTime()) / 1000) : null;
  const oldestUnpreparedSeconds = secondsSince(oldestUnprepared?.createdAt);
  const oldestPendingSeconds = secondsSince(oldest?.createdAt);
  const lastClaimSeconds = secondsSince(lastClaim?.startedAt);

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
