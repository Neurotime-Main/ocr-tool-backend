import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, rm, unlink } from 'node:fs/promises';
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
  ACCEPTED_EXTENSIONS, checkConverter, checkImageConverter, checkVideoConverter, convertToPdf, isAcceptedUpload,
  isImageUpload, isVideoUpload, needsConversion,
} from './convert.js';
import { fetchNewsKeywords } from './keywords.js';
import { ImageRecognitionError, recognizeImageFile } from './recognizeImage.js';
import { publishDocuments } from './publish.js';
import { checkServerDb, serverDbConfigured } from './serverDb.js';
import { documentIdsSchema, documentSearchSchema, highlightListSchema } from './validation.js';
import { searchDocuments } from './search.js';

console.log(describeRuntime('api'));
await ensureWorkerDirectories();
// The queue is in this process's memory, so the API and OCR worker intentionally
// run together. This is one independently deployed OCR service that can serve
// several client applications, not a separate worker container.
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

/**
 * Where multer parks an upload while the request is read.
 *
 * The directory is created per request rather than only at boot, because it can
 * stop existing under a running process: TEMP_DIR is a scratch area, and a
 * tmpfs mount, a cleaner, or someone reclaiming disk takes it away without
 * warning. Multer then fails with a bare `ENOENT ... open .../uploads/<hash>`,
 * which reads as a lost file rather than a missing directory and sends whoever
 * sees it looking in the wrong place -- it cost a scraping run to work out.
 *
 * `recursive: true` makes this a no-op in the normal case.
 */
const storage_ = multer.diskStorage({
  destination(_request, _file, callback) {
    mkdir(uploadDir, { recursive: true })
      .then(() => callback(null, uploadDir))
      .catch((error: Error) => callback(error, uploadDir));
  },
  filename(_request, _file, callback) {
    callback(null, randomUUID().replace(/-/g, ''));
  },
});

const upload = multer({
  storage: storage_,
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
 * Office files become PDFs so their pages can be rendered consistently. Images
 * and videos stay in their original containers here; background preparation
 * sends their pixels straight to OCR and only packages a viewer PDF afterwards.
 */
async function storeUpload(file: Express.Multer.File, options: {
  languages: OcrLanguageCode[];
  ocrMode: string;
}) {
  let sourcePath = file.path;
  let converted: string | undefined;
  let frameIntervalSeconds: number | null = null;
  const mediaKind = isVideoUpload(file.originalname, file.mimetype)
    ? 'video'
    : isImageUpload(file.originalname, file.mimetype) ? 'image' : 'document';

  if (needsConversion(file.originalname)) {
    converted = await convertToPdf(file.path, file.originalname);
    sourcePath = converted;
  }

  try {
    // Keep visual media in its original container until background preparation.
    // Decoding it inside this request would hide progress behind proxy timeouts.
    const storageKey = await storage.saveTemporaryFile(sourcePath, mediaKind !== 'document'
      ? { extension: path.extname(file.originalname).toLowerCase() || `.${mediaKind}`, contentType: file.mimetype || 'application/octet-stream' }
      : { extension: '.pdf', contentType: 'application/pdf' });
    const document = createDocument({
      // Keep the user-facing original name regardless of internal packaging.
      originalName: file.originalname,
      storageKey,
      size: file.size,
      ocrLanguage: serializeOcrLanguages(options.languages),
      ocrMode: options.ocrMode,
      mimeType: file.mimetype || 'application/octet-stream',
      mediaKind,
      frameIntervalSeconds,
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
  const [storageStatus, ocrEngine, renderer, converter, imageConverter, videoConverter, queue, serverDb] = await Promise.all([
    storage.check(),
    checkOcrEngine(),
    checkRenderer(),
    checkConverter(),
    checkImageConverter(),
    checkVideoConverter(),
    getQueueHealth().catch(() => null),
    checkServerDb(),
  ]);
  const ok = storageStatus.ok && ocrEngine.ok && renderer.ok
    && converter.ok && imageConverter.ok && videoConverter.ok;
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
    // All advertised input paths are part of readiness. A deploy missing one
    // converter should fail before its first user discovers the broken format.
    officeConversion: {
      ok: converter.ok,
      ...(converter.ok ? { engine: converter.detail } : { error: converter.detail }),
    },
    viewerPackaging: {
      ok: imageConverter.ok,
      ...(imageConverter.ok ? { engine: imageConverter.detail } : { error: imageConverter.detail }),
    },
    videoConversion: {
      ok: videoConverter.ok,
      ...(videoConverter.ok ? { engine: videoConverter.detail } : { error: videoConverter.detail }),
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

app.get('/api/capabilities', (_request, response) => {
  response.json({
    acceptedExtensions: ACCEPTED_EXTENSIONS,
    languages: OCR_LANGUAGE_CODES,
    maxFileSizeMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    maxBatchFiles: config.maxBatchFiles,
    endpoints: {
      image: { method: 'POST', path: '/api/ocr/image', synchronous: true, stored: false, apiKeyRequired: Boolean(config.serviceApiKey) },
      files: { method: 'POST', path: '/api/documents/batch', synchronous: false, stored: true },
      text: { method: 'GET', path: '/api/documents/:id/text' },
    },
    video: {
      sampleEverySeconds: config.videoFrameIntervalSeconds,
      maxFrames: config.videoMaxFrames,
      longVideos: 'rejected when fixed-rate sampling would exceed maxFrames',
    },
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
      mimeType: document.mimeType,
      mediaKind: document.mediaKind,
      frameIntervalSeconds: document.frameIntervalSeconds,
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

/**
 * A service-friendly text representation of any completed upload.
 * Video output includes timestamps and a de-duplicated transcript so static
 * on-screen text is not repeated for every sampled frame.
 */
app.get('/api/documents/:id/text', async (request, response, next) => {
  try {
    const document = getDocument(request.params.id);
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    if (document.ocrStatus !== 'COMPLETE' && document.ocrStatus !== 'FAILED') {
      return response.status(409).json({ error: 'Text extraction is still processing.', status: document.ocrStatus });
    }
    const pages = pagesOf(document.id).filter((page) => page.status === 'COMPLETE');
    const seenVideoLines = new Set<string>();
    const segments = pages.map((page) => {
      const timestampSeconds = document.mediaKind === 'video' && document.frameIntervalSeconds
        ? (page.pageNumber - 1) * document.frameIntervalSeconds
        : null;
      let text = page.text.trim();
      if (document.mediaKind === 'video') {
        const unique: string[] = [];
        for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
          const key = line.toLocaleLowerCase().replace(/\s+/g, ' ');
          if (seenVideoLines.has(key)) continue;
          seenVideoLines.add(key);
          unique.push(line);
        }
        text = unique.join('\n');
      }
      return { pageNumber: page.pageNumber, timestampSeconds, text };
    });
    response.json({
      documentId: document.id,
      originalName: document.originalName,
      mediaKind: document.mediaKind,
      status: document.ocrStatus,
      durationMs: Math.max(0, document.updatedAt.getTime() - document.createdAt.getTime()),
      text: segments.map((segment) => segment.text).filter(Boolean).join('\n\n'),
      segments,
      failedPages: pagesOf(document.id).filter((page) => page.status === 'FAILED').length,
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
    const internalPdfName = `${document.originalName.replace(/\.[^.]+$/, '') || 'document'}.pdf`;
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(internalPdfName)}`);
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
const requireServiceApiKey: express.RequestHandler = (request, response, next) => {
  if (config.serviceApiKey && request.get('x-api-key') !== config.serviceApiKey) {
    console.warn(`[ocr-image] rejected ${JSON.stringify({
      status: 401,
      remoteAddress: request.ip || request.socket.remoteAddress || 'unknown',
      userAgent: request.get('user-agent') ?? null,
      error: 'Missing or invalid X-API-Key.',
    })}`);
    response.status(401).json({ error: 'A valid X-API-Key header is required.' });
    return;
  }
  next();
};

app.post('/api/ocr/image', requireServiceApiKey, upload.single('image'), async (request, response, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const uploadedPath = request.file?.path;
  const requestLog = {
    requestId,
    remoteAddress: request.ip || request.socket.remoteAddress || 'unknown',
    userAgent: request.get('user-agent') ?? null,
    originalName: request.file?.originalname ?? null,
    mimeType: request.file?.mimetype ?? null,
    bytes: request.file?.size ?? 0,
    requestedLanguages: typeof request.body?.languages === 'string' ? request.body.languages : null,
  };

  // Keep this as one JSON object per line so Docker/journald logs remain easy
  // to search. The upload's bytes and API key are deliberately excluded; the
  // recognised text is logged with the response below for scraper debugging.
  console.log(`[ocr-image] received ${JSON.stringify(requestLog)}`);

  try {
    if (!request.file) {
      console.warn(`[ocr-image] rejected ${JSON.stringify({
        requestId,
        status: 400,
        durationMs: Date.now() - startedAt,
        error: 'Missing multipart image field.',
      })}`);
      return response.status(400).json({ error: 'Attach an image as the "image" field.' });
    }
    if (!isImageUpload(request.file.originalname, request.file.mimetype)) {
      console.warn(`[ocr-image] rejected ${JSON.stringify({
        requestId,
        status: 415,
        durationMs: Date.now() - startedAt,
        error: 'Uploaded file is not a supported image.',
      })}`);
      return response.status(415).json({
        error: `This endpoint reads images. ${request.file.originalname} is not one; `
          + 'use POST /api/documents for documents and videos.',
      });
    }

    const requested = typeof request.body?.languages === 'string' ? request.body.languages : undefined;
    const languages = parseOcrLanguages(requested);
    if (requested && !languages) {
      console.warn(`[ocr-image] rejected ${JSON.stringify({
        requestId,
        status: 400,
        durationMs: Date.now() - startedAt,
        error: `Unknown OCR languages: ${requested}`,
      })}`);
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
    console.log(`[ocr-image] completed ${JSON.stringify({
      requestId,
      status: 200,
      durationMs: Date.now() - startedAt,
      result,
    })}`);
    response.json(result);
  } catch (error) {
    console.error(`[ocr-image] failed ${JSON.stringify({
      requestId,
      status: error instanceof ImageRecognitionError ? 422 : 500,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })}`);
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
