import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { config } from './config.js';
import { prisma } from './db.js';
import { storage } from './storage.js';
import { checkOcrEngine } from './ocrEngine.js';
import { checkRenderer } from './render.js';
import { ensureWorkerDirectories, startOcrWorker, stopOcrWorker } from './ocrWorker.js';
import { getOcrProgress, requeueDocument } from './documents.js';
import { addHighlightsToPdf } from './exportPdf.js';
import { createFindingsWorkbook } from './excelReport.js';
import { documentIdsSchema, documentSearchSchema, highlightListSchema } from './validation.js';
import { buildStoredFindings, searchDocuments } from './search.js';

await ensureWorkerDirectories();
// In production the recognition worker is its own Render service, so that OCR
// never takes CPU away from HTTP. Everywhere else it runs here, which keeps
// local development to a single command.
if (config.runWorkerInProcess) startOcrWorker();

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
    callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '10mb' }));

const uploadDir = path.join(config.tempDir, 'uploads');
await mkdir(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.maxUploadBytes, files: config.maxBatchFiles },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      callback(new Error('Only PDF files are supported.'));
      return;
    }
    callback(null, true);
  },
});

const documentInclude = {
  pages: { orderBy: { pageNumber: 'asc' as const } },
  highlights: { orderBy: { createdAt: 'asc' as const } },
};

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
 * Stops any OCR work for these documents and removes every trace of them:
 * database rows and the stored PDF. Cancelling waits for the running job to
 * settle first, so a job can never write pages back after the rollback.
 */
async function discardDocuments(ids: string[]) {
  const documents = await prisma.document.findMany({
    where: { id: { in: ids } },
    select: { id: true, storageKey: true },
  });
  if (!documents.length) return [];
  // Deleting the document removes its page rows too, so anything still queued
  // simply stops existing. A page already in flight finishes into rows that the
  // cascade has removed, which Prisma reports and the worker logs as a failed
  // page for a document nobody is waiting for.
  await prisma.document.deleteMany({ where: { id: { in: documents.map((document) => document.id) } } });
  await Promise.all(documents.map((document) => storage.delete(document.storageKey).catch(() => undefined)));
  return documents.map((document) => document.id);
}

app.get('/api/health', async (_request, response) => {
  // Render gates a deploy on this endpoint, so it reports on every dependency
  // the service cannot work without. A broken bucket policy, a wrong region, or
  // an image missing the OCR binary then fails the deploy instead of surfacing
  // on a user's first upload.
  const [database, storageStatus, ocrEngine, renderer] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => 'connected' as const).catch(() => 'unavailable' as const),
    storage.check(),
    checkOcrEngine(),
    checkRenderer(),
  ]);
  const ok = database === 'connected' && storageStatus.ok && ocrEngine.ok && renderer.ok;
  response.status(ok ? 200 : 503).json({
    ok,
    database,
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
  });
});

app.post('/api/documents', upload.single('file'), async (request, response, next) => {
  let storageKey: string | undefined;
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a PDF to upload.' });
    storageKey = await storage.saveTemporaryFile(request.file.path);
    const language = String(request.body.language ?? 'eng');
    const ocrMode = String(request.body.ocrMode ?? 'AUTO').toUpperCase();
    if (!config.tesseractLanguages.includes(language)) {
      await storage.delete(storageKey);
      return response.status(400).json({ error: `Unsupported OCR language: ${language}` });
    }
    if (!['AUTO', 'FORCE_OCR'].includes(ocrMode)) {
      await storage.delete(storageKey);
      return response.status(400).json({ error: `Unsupported OCR mode: ${ocrMode}` });
    }
    const document = await prisma.document.create({
      data: {
        originalName: request.file.originalname,
        storageKey,
        size: request.file.size,
        ocrLanguage: language,
        ocrMode,
      },
    });
    response.status(201).json(document);
  } catch (error) {
    if (request.file) await unlink(request.file.path).catch(() => undefined);
    if (storageKey) await storage.delete(storageKey);
    next(error);
  }
});

app.post('/api/documents/batch', upload.array('files', config.maxBatchFiles), async (request, response, next) => {
  const files = request.files as Express.Multer.File[] | undefined;
  try {
    if (!files?.length) return response.status(400).json({ error: 'Choose one or more PDFs to upload.' });
    const language = String(request.body.language ?? 'eng');
    const ocrMode = String(request.body.ocrMode ?? 'AUTO').toUpperCase();
    if (!config.tesseractLanguages.includes(language)) {
      return response.status(400).json({ error: `Unsupported OCR language: ${language}` });
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
        storageKey = await storage.saveTemporaryFile(file.path);
        const document = await prisma.document.create({
          data: {
            originalName: file.originalname,
            storageKey,
            size: file.size,
            ocrLanguage: language,
            ocrMode,
          },
        });
        return { document, storageKey, error: undefined };
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
      if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
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
    const documents = await prisma.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        originalName: true,
        size: true,
        pageCount: true,
        ocrStatus: true,
        ocrLanguage: true,
        ocrMode: true,
        ocrError: true,
        createdAt: true,
        highlights: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const progress = await getOcrProgress(ids);
    response.json({ documents: documents.map((document) => ({ ...document, ocrProgress: progress.get(document.id) ?? null })) });
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
    const document = await prisma.document.findUnique({
      where: { id: request.params.id },
      include: documentInclude,
    });
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    response.json(document);
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id/file', async (request, response, next) => {
  try {
    const document = await prisma.document.findUnique({ where: { id: request.params.id } });
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    response.type('application/pdf');
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.originalName)}`);
    const stream = await storage.createReadStream(document.storageKey);
    stream.on('error', next).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/:id/ocr', async (request, response, next) => {
  try {
    const document = await prisma.document.findUnique({ where: { id: request.params.id } });
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    if (document.ocrStatus === 'PROCESSING') return response.status(409).json({ error: 'OCR is already running.' });
    const requestedMode = request.body?.ocrMode == null ? document.ocrMode : String(request.body.ocrMode).toUpperCase();
    if (!['AUTO', 'FORCE_OCR'].includes(requestedMode)) return response.status(400).json({ error: `Unsupported OCR mode: ${requestedMode}` });
    await requeueDocument(document.id, requestedMode);
    response.status(202).json({ status: 'PENDING' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reports/excel', async (request, response, next) => {
  try {
    const { ids } = documentIdsSchema.parse(request.body);
    const findings = await buildStoredFindings(ids);
    const workbook = await createFindingsWorkbook(findings);
    response.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="markwise-findings.xlsx"');
    response.send(workbook);
  } catch (error) {
    next(error);
  }
});

app.put('/api/documents/:id/highlights', async (request, response, next) => {
  try {
    const payload = highlightListSchema.parse(request.body);
    const exists = await prisma.document.count({ where: { id: request.params.id } });
    if (!exists) return response.status(404).json({ error: 'Document not found.' });
    const highlights = await prisma.$transaction(async (tx) => {
      await tx.highlight.deleteMany({ where: { documentId: request.params.id } });
      if (payload.highlights.length) {
        await tx.highlight.createMany({
          data: payload.highlights.map(({ id: _id, ...highlight }) => ({
            ...highlight,
            documentId: request.params.id,
          })),
        });
      }
      return tx.highlight.findMany({
        where: { documentId: request.params.id },
        orderBy: { createdAt: 'asc' },
      });
    });
    response.json({ highlights });
  } catch (error) {
    next(error);
  }
});

app.post('/api/documents/:id/export', async (request, response, next) => {
  try {
    const payload = highlightListSchema.parse(request.body);
    const document = await prisma.document.findUnique({ where: { id: request.params.id } });
    if (!document) return response.status(404).json({ error: 'Document not found.' });
    const workDir = await mkdtemp(path.join(config.tempDir, `export-${document.id}-`));
    try {
      const localPath = await storage.materialize(document.storageKey, workDir);
      const bytes = await addHighlightsToPdf(localPath, payload.highlights);
      const baseName = document.originalName.replace(/\.pdf$/i, '');
      response.type('application/pdf');
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-highlighted.pdf`)}`);
      response.send(bytes);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'One of the PDFs is too large.'
      : error.code === 'LIMIT_FILE_COUNT'
        ? `You can upload up to ${config.maxBatchFiles} PDFs at once.`
        : error.message;
    return response.status(400).json({ error: message });
  }
  const candidate = error as { name?: string; issues?: unknown; message?: string };
  if (candidate.message === 'Only PDF files are supported.') return response.status(400).json({ error: candidate.message });
  if (candidate.message === 'Origin is not allowed by CORS.') return response.status(403).json({ error: candidate.message });
  if (candidate.name === 'ZodError') return response.status(400).json({ error: 'Invalid request data.', details: candidate.issues });
  response.status(500).json({ error: candidate.message ?? 'Unexpected server error.' });
});

const server = app.listen(config.port, () => {
  console.log(`OCR Highlight API listening on http://localhost:${config.port}`);
});

async function shutdown() {
  server.close();
  await stopOcrWorker();
  await prisma.$disconnect();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
