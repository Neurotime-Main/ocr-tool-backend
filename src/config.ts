import dotenv from 'dotenv';
import { availableParallelism, freemem, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();

// Resolve the backend environment file by this module's location, rather than
// the caller's working directory. This also works when the server is started
// from a repository parent directory or a process manager.
dotenv.config({ path: path.resolve(moduleDir, '../.env'), quiet: true });

/**
 * Fails the process at boot with an actionable message rather than letting a
 * misconfigured deploy surface as a Prisma or AWS SDK error on the first
 * upload. Called from db.ts, which every entry point imports.
 */
export function assertRuntimeEnvironment() {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is missing. Create backend/.env from backend/.env.example and set your Neon pooled connection string.',
    );
  }
  if ((process.env.STORAGE_DRIVER ?? 'local') === 's3') {
    if (!process.env.AWS_S3_BUCKET) missing.push('AWS_S3_BUCKET');
    if (!process.env.AWS_REGION) missing.push('AWS_REGION');
    // Render has no instance role, so the access keys are the only credential
    // source. Set AWS_USE_DEFAULT_CREDENTIALS=true to opt into the SDK's own
    // provider chain (a shared profile, an ECS task role, IRSA).
    if (process.env.AWS_USE_DEFAULT_CREDENTIALS !== 'true') {
      if (!process.env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID');
      if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY');
    }
  }
  if (missing.length) {
    throw new Error(
      `STORAGE_DRIVER=s3 requires ${missing.join(', ')}. Set them on the service, or use STORAGE_DRIVER=local for a machine with a persistent disk.`,
    );
  }
  if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_ORIGIN) {
    throw new Error(
      'CLIENT_ORIGIN is missing. Set it to your Vercel origin, for example https://markwise.vercel.app (comma-separated for several, and https://markwise-*.vercel.app for previews).',
    );
  }
}

function positiveInteger(value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

// Tesseract recognition is CPU bound, so the useful amount of parallel work is
// set by the number of cores rather than by a fixed number. One core is left
// for the HTTP server, PDF rendering, and the database client.
const cpuCount = (() => {
  try { return availableParallelism(); } catch { return 2; }
})();

// Each warm worker holds its language models and a WASM heap, so the pool is
// also capped by memory. Without this a small container would happily start
// eight workers and be killed by the OOM reaper. `availableMemory` is used
// where the runtime has it, because a developer machine can have plenty of RAM
// installed and almost none of it free.
const WORKER_MEMORY_BUDGET = 512 * 1024 * 1024;
const usableMemory = (() => {
  const available = (globalThis as { process?: { availableMemory?: () => number } }).process?.availableMemory;
  const free = typeof available === 'function' ? available() : freemem();
  // Leave room for the HTTP server, Poppler, and the rest of the host.
  return Math.max(0, Math.min(free, totalmem()) - 512 * 1024 * 1024);
})();
const memoryBoundConcurrency = Math.max(1, Math.floor(usableMemory / WORKER_MEMORY_BUDGET));
const defaultOcrConcurrency = Math.max(1, Math.min(8, cpuCount - 1, memoryBoundConcurrency));

const ocrConcurrency = positiveInteger(process.env.OCR_CONCURRENCY, defaultOcrConcurrency, 32);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((value) => value.trim()),
  storageDir: path.resolve(baseDir, process.env.STORAGE_DIR ?? './storage'),
  storageDriver: process.env.STORAGE_DRIVER ?? 'local',
  s3: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    bucket: process.env.AWS_S3_BUCKET ?? '',
    prefix: (process.env.AWS_S3_PREFIX ?? 'documents').replace(/^\/+|\/+$/g, ''),
    endpoint: process.env.AWS_S3_ENDPOINT,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
    // Left undefined when AWS_USE_DEFAULT_CREDENTIALS=true, which hands the
    // client back to the SDK's own provider chain.
    accessKeyId: process.env.AWS_USE_DEFAULT_CREDENTIALS === 'true' ? undefined : process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_USE_DEFAULT_CREDENTIALS === 'true' ? undefined : process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    // The SDK frames PutObject as `aws-chunked` to append a trailing checksum.
    // Real S3 handles that; some S3-compatible stores (R2, Spaces, older
    // MinIO) reject it. This sends a plain body with a Content-Length instead.
    disableChecksums: process.env.AWS_S3_DISABLE_CHECKSUMS === 'true',
    maxAttempts: positiveInteger(process.env.AWS_S3_MAX_ATTEMPTS, 3, 10),
    connectionTimeoutMs: positiveInteger(process.env.AWS_S3_CONNECTION_TIMEOUT_MS, 5_000),
    requestTimeoutMs: positiveInteger(process.env.AWS_S3_REQUEST_TIMEOUT_MS, 120_000),
  },
  tempDir: path.resolve(baseDir, process.env.TEMP_DIR ?? './tmp'),
  tesseractLanguages: [...new Set([
    'eng',
    'aze',
    'aze+eng',
    ...(process.env.TESSERACT_LANGS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  ])],
  tessdataPath: process.env.TESSDATA_PATH,
  renderDpi: Math.max(120, Number(process.env.OCR_RENDER_DPI ?? 260)),
  // Oversized scans (large-format or poster-sized pages) would rasterise into
  // 20+ megapixel images at a fixed DPI, which costs several seconds per page
  // in both Poppler and Tesseract without improving recognition. Pages larger
  // than this budget are rendered at a lower DPI; A4 at 260 DPI is 6.5 MP and
  // is therefore never downscaled.
  maxRenderPixels: positiveInteger(process.env.OCR_MAX_PAGE_PIXELS, 12_000_000),
  minRenderDpi: positiveInteger(process.env.OCR_MIN_RENDER_DPI, 150),
  // Recognition slots shared by every document in the batch. A single large
  // PDF can use all of them, so one big upload is as fast as many small ones.
  ocrConcurrency,
  // Documents are only a scheduling unit now; the recognition slots above are
  // what actually limits CPU use. Allowing several documents at once keeps the
  // slots busy when a batch is made of one- and two-page files.
  documentConcurrency: positiveInteger(process.env.OCR_DOCUMENT_CONCURRENCY, Math.max(2, ocrConcurrency), 32),
  // Poppler competes with Tesseract for the same cores, so rendering runs at a
  // lower width and is overlapped with recognition instead of blocking it.
  renderConcurrency: positiveInteger(process.env.OCR_RENDER_CONCURRENCY, Math.max(2, Math.ceil(ocrConcurrency / 2)), 32),
  uploadStorageConcurrency: positiveInteger(process.env.UPLOAD_STORAGE_CONCURRENCY, 4, 8),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  maxBatchFiles: positiveInteger(process.env.MAX_BATCH_FILES, 30),
};
