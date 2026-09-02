import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import {
  assertRuntimeEnvironment, config, describeRuntime, OCR_LANGUAGE_CODES, parseOcrLanguages,
  serializeOcrLanguages, type OcrLanguageCode,
} from './config.js';

// Used to run as a side effect of opening the database connection. With no
// database to open, the check has to be made explicitly -- and still at import
// time, so a misconfigured service fails at boot rather than on first upload.
assertRuntimeEnvironment();
import {
  createDocument, deleteDocuments, evictOverflow, getDocument, getDocuments, highlightsOf,
  pagesOf, replaceAllHighlights, storeStats,
} from './store.js';
import { storage } from './storage.js';
import { checkOcrEngine } from './ocrEngine.js';
import { checkRenderer } from './render.js';
import { ensureWorkerDirectories, startOcrWorker, stopOcrWorker } from './ocrWorker.js';
import { getOcrProgress, requeueDocument } from './documents.js';
import { getQueueHealth } from './pageQueue.js';
import {
  ACCEPTED_EXTENSIONS, checkConverter, convertToPdf, imageToPdf, isAcceptedUpload, isImageUpload,
  needsConversion, pdfNameFor,
} from './convert.js';
import { fetchNewsKeywords } from './keywords.js';
import { ImageRecognitionError, recognizeImageFile } from './recognizeImage.js';
import { publishDocuments } from './publish.js';
import { checkServerDb, serverDbConfigured } from './serverDb.js';
import { documentIdsSchema, documentSearchSchema, highlightListSchema } from './validation.js';
import { searchDocuments } from './search.js';

console.log(describeRuntime('api'));
await ensureWorkerDirectories();
// In production the recognition worker is its own Render service, so that OCR
// never takes CPU away from HTTP. Everywhere else it runs here, which keeps
// local development to a single command.
if (config.runWorkerInProcess) startOcrWorker();
else {
  console.log(
    '[boot] OCR runs in the separate markwise-ocr-worker service. If documents stay PENDING, that '
    + 'worker loop has stopped or is crash-looping. GET /api/health '
    + 'reports the queue state.',
  );
}

const app = express();
app.set('trust proxy', 1);

function isAllowedOrigin(origin: string) {
  return config.clientOrigins.some((allowed) => {
    if (allowed === origin) return true;
    if (!allowed.includes('*')) return false;
    const pattern = allowed
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`).test(origin);
  });
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    // Name both sides. The old message said only that the origin was refused,
    // which is the one fact the reader already has; what they need is the
    // origin the browser actually sent and the list it was compared against.
    callback(new Error(
      `Origin ${origin} is not allowed. CLIENT_ORIGIN currently allows: ${config.clientOrigins.join(', ') || '(nothing)'}. `
      + 'Add this origin to CLIENT_ORIGIN, comma-separated and without a trailing slash.',
    ));
  },
}));
app.use(express.json({ limit: '10mb' }));

const uploadDir = path.join(config.tempDir, 'uploads');
await mkdir(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.maxUploadBytes, files: config.maxBatchFiles },
  fileFilter: (_request, file, callback) => {
    if (!isAcceptedUpload(file.originalname, file.mimetype)) {
      callback(new Error(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}.`));
      return;
    }
    callback(null, true);
  },
});

/**
 * Turns one uploaded file into a stored document.
 *
 * A Word or spreadsheet upload is converted to PDF first and recorded under the
 * converted name, so the rest of the system -- pages, highlights, published
 * images -- only ever deals with PDFs. The temporary files from both the upload
 * and the conversion are cleaned up whichever way this goes.
 */
async function storeUpload(file: Express.Multer.File, options: {
  languages: OcrLanguageCode[];
  ocrMode: string;
}) {
  let sourcePath = file.path;
  let converted: string | undefined;

  if (isImageUpload(file.originalname, file.mimetype)) {
    // A photograph or scan becomes a one-page PDF at its own resolution.
    converted = await imageToPdf(file.path, file.originalname);
    sourcePath = converted;
  } else if (needsConversion(file.originalname)) {
    converted = await convertToPdf(file.path, file.originalname);
    sourcePath = converted;
  }

  try {
    const storageKey = await storage.saveTemporaryFile(sourcePath);
    const { size } = converted ? await stat(converted).catch(() => ({ size: file.size })) : file;
    const document = createDocument({
      originalName: pdfNameFor(file.originalname),
      storageKey,
      size,
      ocrLanguage: serializeOcrLanguages(options.languages),
      ocrMode: options.ocrMode,
    });
    // The workspace is memory, so it has to be bounded. Anything dropped here
    // is a finished document well past the retention cap; its PDF goes with it.
    for (const evicted of evictOverflow()) {
      await storage.delete(evicted.storageKey).catch(() => undefined);
    }
    return { document, storageKey };
  } finally {
    // `saveTemporaryFile` consumes the file it is given; the other one, and the
    // conversion's working directory, are ours to remove.
    if (converted) await rm(path.dirname(converted), { recursive: true, force: true }).catch(() => undefined);
    await unlink(file.path).catch(() => undefined);
  }
}

async function mapWithConcurrency<T, Result>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<Result>,
) {
  const results: Result[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Stops any OCR work for these documents and removes every trace of them: the
 * workspace entry and the stored PDF. Cancelling waits for the running job to
 * settle first, so a job can never write pages back after the rollback.
 */
async function discardDocuments(ids: string[]) {
  // Removing the document takes its pages with it, so anything still queued
  // simply stops existing. A page already in flight finishes into a page the
  // store no longer holds, which `updatePage` ignores.
  const removed = deleteDocuments(ids);
  if (!removed.length) return [];
  await Promise.all(removed.map((document) => storage.delete(document.storageKey).catch(() => undefined)));
  return removed.map((document) => document.id);
}

app.get('/api/health', async (_request, response) => {
  // Render gates a deploy on this endpoint, so it reports on every dependency
  // the service cannot work without. A broken bucket policy, a wrong region, or
  // an image missing the OCR binary then fails the deploy instead of surfacing
  // on a user's first upload.
  const [storageStatus, ocrEngine, renderer, converter, queue, serverDb] = await Promise.all([
    storage.check(),
    checkOcrEngine(),
    checkRenderer(),
    checkConverter(),
    getQueueHealth().catch(() => null),
    checkServerDb(),
  ]);
  const ok = storageStatus.ok && ocrEngine.ok && renderer.ok;
  response.status(ok ? 200 : 503).json({
    ok,
    // The workspace is this process's memory, so there is no database to be
    // up or down -- what is worth reporting is how much of it is in use, since
    // that is now bounded by the heap rather than by a disk somewhere else.
    workspace: { ...storeStats(), retentionLimit: config.maxRetainedDocuments },
    storage: {
      driver: storageStatus.driver,
      ok: storageStatus.ok,
      ...(storageStatus.ok ? { target: storageStatus.detail } : { error: storageStatus.detail }),
    },
    ocr: {
      ok: ocrEngine.ok,
      ...(ocrEngine.ok ? { engine: ocrEngine.detail } : { error: ocrEngine.detail }),
    },
    renderer: {
      ok: renderer.ok,
      ...(renderer.ok ? { engine: renderer.detail } : { error: renderer.detail }),
    },
    // Reported but not part of `ok`: the OCR side of the service works without
    // it, and failing the health check would take the whole API down when only
    // keywords and publishing are affected.
    // Not part of `ok`: PDFs work without it, only office uploads are affected.
    officeConversion: {
      ok: converter.ok,
      ...(converter.ok ? { engine: converter.detail } : { error: converter.detail }),
    },
    neurotimeDb: {
      ok: serverDb.ok,
      ...(serverDb.ok ? { target: serverDb.detail } : { error: serverDb.detail }),
    },
    runtime: {
      workerInApi: config.runWorkerInProcess,
      queueNamespace: config.queueNamespace,
      cpuQuota: config.runtimeResources.cpuQuota,
      memoryLimitMb: config.runtimeResources.memoryLimitBytes == null
        ? null
        : Math.round(config.runtimeResources.memoryLimitBytes / 1024 / 1024),
      ocrConcurrency: config.ocrConcurrency,
      renderConcurrency: config.renderConcurrency,
      ...((config.runtimeResources.requestedOcrConcurrency > config.ocrConcurrency
        || config.runtimeResources.requestedRenderConcurrency > config.renderConcurrency)
        ? {
          concurrencyWarning: 'Configured OCR concurrency was clamped to the container CPU/memory limit.',
        }
        : {}),
      ...(config.runtimeResources.cpuQuota != null && config.runtimeResources.cpuQuota < 1
        ? { warning: 'This service has less than one CPU. PaddleOCR is CPU-bound; use at least 1 CPU for testing and 2 CPUs for production batches.' }
        : {}),
    },
    // Reported but deliberately not part of `ok`: a stalled queue is a problem
    // with the worker service, and failing the API's health check over it would
    // take the API down too, which helps nobody.
    ...(queue ? {
      queue: {
        ...queue,
        ...(queue.stalled ? {
          warning: config.runWorkerInProcess
            ? 'OCR work is waiting but the in-process worker has not made progress recently. Check the Render log for a preparation or worker crash.'
            : 'OCR work is waiting but nothing has made progress recently. Check the log for a preparation or worker crash.',
        } : {}),
      },
    } : {}),
  });
});

app.post('/api/documents', upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a file to upload.' });
    const languages = parseOcrLanguages(String(request.body.language ?? 'eng'));
    const ocrMode = String(request.body.ocrMode ?? 'AUTO').toUpperCase();
    if (!languages) {
      await unlink(request.file.path).catch(() => undefined);
      return response.status(400).json({ error: 'Choose one or more supported OCR languages.' });
    }
    if (!['AUTO', 'FORCE_OCR'].includes(ocrMode)) {
      await unlink(request.file.path).catch(() => undefined);
      return response.status(400).json({ error: `Unsupported OCR mode: ${ocrMode}` });
    }
    const { document } = await storeUpload(request.file, { languages, ocrMode });
    response.status(201).json(document);
  } catch (error) {
    if (request.file) await unlink(request.file.path).catch(() => undefined);
    next(error);
  }
});

app.post('/api/documents/batch', upload.array('files', config.maxBatchFiles), async (request, response, next) => {
  const files = request.files as Express.Multer.File[] | undefined;
  try {
    if (!files?.length) return response.status(400).json({ error: 'Choose one or more files to upload.' });
    const languages = parseOcrLanguages(String(request.body.language ?? 'eng'));
    const ocrMode = String(request.body.ocrMode ?? 'AUTO').toUpperCase();
    if (!languages) {
      return response.status(400).json({ error: 'Choose one or more supported OCR languages.' });
    }
    if (!['AUTO', 'FORCE_OCR'].includes(ocrMode)) {
      return response.status(400).json({ error: `Unsupported OCR mode: ${ocrMode}` });
    }

    // S3 uploads used to be serial here, making a four-file batch wait for
    // every round trip before the browser received an answer. Persist a small
    // number in parallel: much faster on S3 without opening 30 large streams.
    const outcomes = await mapWithConcurrency(files, config.uploadStorageConcurrency, async (file) => {
      let storageKey: string | undefined;
      try {
        const stored = await storeUpload(file, { languages, ocrMode });
        storageKey = stored.storageKey;
        return { document: stored.document, storageKey, error: undefined };
      } catch (error) {
        // Return failures instead of throwing inside the pool, so every
        // in-flight file settles before rollback starts.
        return { document: undefined, storageKey, error };
      }
    });

    const failed = outcomes.find((item) => item.error);
    if (failed) {
      const documentIds = outcomes.flatMap((item) => item.document ? [item.document.id] : []);
      const storageKeys = outcomes.flatMap((item) => item.storageKey ? [item.storageKey] : []);
      if (documentIds.length) deleteDocuments(documentIds);
      await Promise.all(storageKeys.map((key) => storage.delete(key).catch(() => undefined)));
      throw failed.error;
    }
    const documents = outcomes.flatMap((item) => item.document ? [item.document] : []);

    // The browser can cancel an upload after the last byte arrived but before
    // the reply is sent. Nobody would ever see these documents, so they are
    // rolled back instead of queued. The request stream is always destroyed by
    // this point (multer has read it to the end), so only the response tells
    // us whether the socket is still there.
    if (response.destroyed) {
      await discardDocuments(documents.map((document) => document.id));
      return;
    }

    response.status(201).json({ documents });
  } catch (error) {
    next(error);
  } finally {
    await Promise.all((files ?? []).map((file) => unlink(file.path).catch(() => undefined)));
  }
});

app.post('/api/documents/cancel', async (request, response, next) => {
  try {
    const { ids } = documentIdsSchema.parse(request.body);
    response.json({ cancelled: await discardDocuments(ids) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/statuses', async (request, response, next) => {
  try {
    const { ids } = documentIdsSchema.parse(request.body);
    const progress = await getOcrProgress(ids);
    const documents = getDocuments(ids).map((document) => ({
      id: document.id,
      originalName: document.originalName,
      size: document.size,
      pageCount: document.pageCount,
      ocrStatus: document.ocrStatus,
      ocrLanguage: document.ocrLanguage,
      ocrMode: document.ocrMode,
      ocrError: document.ocrError,
      createdAt: document.createdAt,
      highlights: highlightsOf(document.id),
      ocrProgress: progress.get(document.id) ?? null,
    }));
    response.json({ documents });
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/search', async (request, response, next) => {
  try {
    const { ids, keywords } = documentSearchSchema.parse(request.body);
    const documents = await searchDocuments(ids, keywords);
    response.json({ documents });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', async (request, response, next) => {
  try {
    const document = getDocument(request.params.id);
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    response.json({
      ...document,
      pages: pagesOf(document.id),
      highlights: highlightsOf(document.id),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/file', async (request, response, next) => {
  try {
    const document = getDocument(request.params.id);
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    // Publishing removes the upload once its images and rows are safely
    // written. The recognised text and the highlights are still here, so this
    // says what happened rather than failing as a missing file.
    if (document.sourceRemoved) {
      return response.status(410).json({
        error: 'This document has been published, and its PDF was removed. '
          + 'The extracted text and highlights are still available; upload the file again to view its pages.',
      });
    }
    response.type('application/pdf');
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.originalName)}`);
    // The stored PDF never changes once uploaded -- a re-run replaces the pages,
    // never the file -- so the browser is told it may keep it. Without this the
    // viewer pulls the whole document from object storage again every time the
    // operator switches between files, which on a thirty-file batch is the
    // slowest thing in the session by a wide margin.
    response.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    response.setHeader('ETag', `"${document.id}"`);
    if (request.headers['if-none-match'] === `"${document.id}"`) return response.status(304).end();
    const stream = await storage.createReadStream(document.storageKey);
    stream.on('error', next).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/:id/ocr', async (request, response, next) => {
  try {
    const document = getDocument(request.params.id);
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    if (document.ocrStatus === 'PROCESSING') return response.status(409).json({ error: 'OCR is already running.' });
    if (document.sourceRemoved) {
      return response.status(410).json({
        error: 'This document has been published and its PDF was removed, so it cannot be read again. Upload the file to re-run OCR.',
      });
    }
    const requestedMode = request.body?.ocrMode == null ? document.ocrMode : String(request.body.ocrMode).toUpperCase();
    if (!['AUTO', 'FORCE_OCR'].includes(requestedMode)) return response.status(400).json({ error: `Unsupported OCR mode: ${requestedMode}` });
    await requeueDocument(document.id, requestedMode);
    response.status(202).json({ status: 'PENDING' });
  } catch (error) {
    next(error);
  }
});

app.put('/api/documents/:id/highlights', async (request, response, next) => {
  try {
    const payload = highlightListSchema.parse(request.body);
    if (!getDocument(request.params.id)) return response.status(404).json({ error: 'Document not found.' });
    const highlights = replaceAllHighlights(
      request.params.id,
      payload.highlights.map(({ id: _id, ...highlight }) => ({
        ...highlight,
        documentId: request.params.id,
      })),
    );
    response.json({ highlights });
  } catch (error) {
    next(error);
  }
});

/**
 * Keywords offered for newspapers, with the projects each belongs to.
 *
 * Served from the Neurotime database rather than typed by the operator, so the
 * words searched for are exactly the ones the rest of the platform tracks.
 */
/**
 * Reads one image and returns its text. Nothing is stored.
 *
 * The other half of this service. Everything above belongs to the document
 * tool: upload, queue, search, publish, all of it built around pages someone
 * will come back to. This endpoint answers a different question -- "what does
 * this picture say?" -- for callers like the Instagram scraper, which keeps its
 * own files and only needs the words back.
 *
 * Deliberately stateless: no document row, no queue entry, no object in the
 * bucket, so a caller polling it thousands of times leaves nothing behind. It
 * shares the recognition daemons with the document worker, which is what keeps
 * the two from oversubscribing the machine when both are busy.
 *
 * POST multipart/form-data with an `image` file, optionally `languages`
 * (default "aze+eng"; accepts "aze+eng+rus" or a comma-separated list).
 */
app.post('/api/ocr/image', upload.single('image'), async (request, response, next) => {
  const uploadedPath = request.file?.path;
  try {
    if (!request.file) {
      return response.status(400).json({ error: 'Attach an image as the "image" field.' });
    }
    if (!isImageUpload(request.file.originalname, request.file.mimetype)) {
      return response.status(415).json({
        error: `This endpoint reads images. ${request.file.originalname} is not one; `
          + 'use POST /api/documents for PDFs and office files.',
      });
    }

    const requested = typeof request.body?.languages === 'string' ? request.body.languages : undefined;
    const languages = parseOcrLanguages(requested);
    if (requested && !languages) {
      return response.status(400).json({
        error: `Unknown language in "${requested}". Available: ${OCR_LANGUAGE_CODES.join(', ')}.`,
      });
    }
    const selected = languages ? serializeOcrLanguages(languages) : 'aze+eng';

    // A caller that hangs up mid-recognition should release its daemon rather
    // than hold one for a reply nobody will read.
    const controller = new AbortController();
    request.on('aborted', () => controller.abort());

    const result = await recognizeImageFile(
      request.file.path,
      request.file.originalname,
      selected,
      controller.signal,
    );
    response.json(result);
  } catch (error) {
    if (error instanceof ImageRecognitionError) {
      return response.status(422).json({ error: error.message });
    }
    next(error);
  } finally {
    if (uploadedPath) await unlink(uploadedPath).catch(() => undefined);
  }
});

app.get('/api/keywords', async (_request, response, next) => {
  try {
    if (!serverDbConfigured()) {
      return response.status(503).json({
        error: 'The keyword source is not configured. Set the SERVER_DB_* variables on this service.',
      });
    }
    const keywords = await fetchNewsKeywords();
    response.json({ sourceTypeId: config.newsSourceTypeId, keywords });
  } catch (error) {
    next(error);
  }
});

/**
 * Publishes a document's mentions: one highlighted image per keyword per page,
 * and one `media_results` row per project behind each of those images.
 *
 * Replaces the Excel and highlighted-PDF downloads. The response reports what
 * was written, including keywords that matched but belong to no project and so
 * produced no rows.
 */
/**
 * Publishes the reviewed mentions for a whole batch.
 *
 * One highlighted image per keyword per page, and one `media_results` row per
 * project behind each image. The response reports what was written and, just as
 * importantly, which documents produced nothing and why.
 */
app.post('/api/documents/publish', async (request, response, next) => {
  const controller = new AbortController();
  request.on('aborted', () => controller.abort());
  try {
    if (!serverDbConfigured()) {
      return response.status(503).json({
        error: 'Publishing is not configured. Set the SERVER_DB_* variables on this service.',
      });
    }
    const { ids } = documentIdsSchema.parse(request.body);
    const report = await publishDocuments(ids, controller.signal);
    if (!report.rows && report.skippedDocuments.length) {
      // Nothing was written at all; surface the first reason rather than an
      // empty success the operator has to go digging to understand.
      return response.status(400).json({
        error: `Nothing was published. ${report.skippedDocuments[0]!.originalName}: ${report.skippedDocuments[0]!.reason}`,
        ...report,
      });
    }
    response.json(report);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `One of the files is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
      : error.code === 'LIMIT_FILE_COUNT'
        ? `You can upload up to ${config.maxBatchFiles} files at once.`
        // Multer says only "Unexpected field", which does not say which field
        // it wanted -- the one thing a caller wiring up a request needs.
        : error.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Unexpected form field "${error.field ?? ''}". `
            + 'POST /api/ocr/image expects the file in a field named "image"; '
            + 'the document endpoints expect "file" or "files".'
          : error.message;
    return response.status(400).json({ error: message });
  }
  const candidate = error as { name?: string; issues?: unknown; message?: string };
  if (candidate.message?.startsWith('Unsupported file type')) return response.status(400).json({ error: candidate.message });
  if (candidate.name === 'ConversionError') return response.status(400).json({ error: candidate.message });
  if (candidate.message?.startsWith('Origin ') && candidate.message.includes('is not allowed')) return response.status(403).json({ error: candidate.message });
  if (candidate.name === 'ZodError') return response.status(400).json({ error: 'Invalid request data.', details: candidate.issues });
  response.status(500).json({ error: candidate.message ?? 'Unexpected server error.' });
});

const server = app.listen(config.port, () => {
  console.log(`OCR Highlight API listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close();
  await stopOcrWorker();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
