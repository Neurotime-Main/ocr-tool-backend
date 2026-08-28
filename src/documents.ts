import { prisma } from './db.js';

export type OcrProgress = {
  currentPage: number;
  totalPages: number;
  queuePosition?: number;
};

/**
 * Progress for a batch of documents, derived from their page rows.
 *
 * This used to be a counter held in the API process, which meant it only ever
 * described work that this process happened to be running: after a restart, or
 * with the worker in its own service, it had nothing to report. Counting
 * finished pages instead is accurate from any process, survives a deploy, and
 * is what the pipeline is actually doing.
 *
 * One grouped query answers the whole batch, so polling thirty documents costs
 * one round trip rather than thirty.
 */
export async function getOcrProgress(documentIds: string[]) {
  const progress = new Map<string, OcrProgress | null>();
  if (!documentIds.length) return progress;

  const counts = await prisma.ocrPage.groupBy({
    by: ['documentId', 'status'],
    where: { documentId: { in: documentIds } },
    _count: { _all: true },
  });

  const totals = new Map<string, { done: number; total: number }>();
  for (const row of counts) {
    const entry = totals.get(row.documentId) ?? { done: 0, total: 0 };
    entry.total += row._count._all;
    // A page that has run out of retries is finished as far as the batch is
    // concerned, so progress reaches the end instead of stalling one short.
    if (row.status === 'COMPLETE' || row.status === 'FAILED') entry.done += row._count._all;
    totals.set(row.documentId, entry);
  }

  // Documents with no pages yet have not been opened, so they are reported by
  // their position in the queue -- which tells the user the server is alive and
  // what it is waiting for.
  const unprepared = documentIds.filter((id) => !totals.has(id));
  const queue = unprepared.length
    ? await prisma.document.findMany({
      where: { ocrStatus: { in: ['PENDING', 'PROCESSING'] }, pages: { none: {} } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    : [];

  for (const documentId of documentIds) {
    const entry = totals.get(documentId);
    if (entry) {
      progress.set(documentId, entry.done >= entry.total
        ? null
        : { currentPage: entry.done, totalPages: entry.total });
      continue;
    }
    const position = queue.findIndex((document) => document.id === documentId);
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
  await prisma.$transaction([
    prisma.ocrPage.deleteMany({ where: { documentId } }),
    prisma.highlight.deleteMany({ where: { documentId, source: 'AUTO' } }),
    prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'PENDING', ocrError: null, ocrMode, pageCount: null },
    }),
  ]);
}
