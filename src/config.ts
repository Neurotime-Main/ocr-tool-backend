import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();

// Resolve the backend environment file by this module's location, rather than
// the caller's working directory. This also works when the server is started
// from a repository parent directory or a process manager.
dotenv.config({ path: path.resolve(moduleDir, '../.env'), quiet: true });

/** `s3` remains accepted so a service configured before the rename still boots. */
export const isSpacesDriver = (driver: string | undefined) => driver === 'spaces' || driver === 's3';

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
  if (isSpacesDriver(process.env.STORAGE_DRIVER)) {
    if (!process.env.DO_SPACES_BUCKET) missing.push('DO_SPACES_BUCKET');
    if (!process.env.DO_SPACES_ENDPOINT) missing.push('DO_SPACES_ENDPOINT');
    // Spaces has no instance roles or metadata service, so a key pair is the
    // only way to authenticate; there is no provider chain to fall back to.
    if (!process.env.DO_SPACES_KEY) missing.push('DO_SPACES_KEY');
    if (!process.env.DO_SPACES_SECRET) missing.push('DO_SPACES_SECRET');
  }
  if (missing.length) {
    throw new Error(
      `STORAGE_DRIVER=spaces requires ${missing.join(', ')}. Set them on the service, or use STORAGE_DRIVER=local for a machine with a persistent disk.`,
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

/**
 * The share of a CPU this container is actually scheduled for, or Infinity when
 * nothing caps it. `availableParallelism` reports the host's cores, which on a
 * platform that limits CPU through cgroups (Render, Fly, ECS) is several times
 * more than the process will ever get: sizing the pool from it puts every page
 * into contention instead of running the batch faster.
 */
function cgroupCpuLimit() {
  try {
    // cgroup v2: "<quota> <period>", or "max <period>" when uncapped.
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota && quota !== 'max' && period) {
      const limit = Number(quota) / Number(period);
      if (Number.isFinite(limit) && limit > 0) return limit;
    }
  } catch { /* not cgroup v2, or not readable */ }
  try {
    // cgroup v1.
    const quota = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const period = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (quota > 0 && period > 0) return quota / period;
  } catch { /* not cgroup v1, or not readable */ }
  return Number.POSITIVE_INFINITY;
}

// Tesseract recognition is CPU bound, so the useful amount of parallel work is
// set by the number of cores rather than by a fixed number. One core is left
// for the HTTP server, PDF rendering, and the database client.
const cpuCount = (() => {
  const reported = (() => {
    try { return availableParallelism(); } catch { return 2; }
  })();
  const limit = cgroupCpuLimit();
  // A fractional allowance still runs one page, just not two at once.
  return Number.isFinite(limit) ? Math.max(1, Math.min(reported, Math.floor(limit))) : reported;
})();

// Each concurrent page holds a `tesseract` process with the page raster and its
// language model, so the pool is also capped by memory. Without this a small
// container would happily start eight of them and be killed by the OOM reaper.
// `availableMemory` is used where the runtime has it, because a developer
// machine can have plenty of RAM installed and almost none of it free.
//
// A native process needs a fraction of what the previous in-process WASM worker
// did, which is why this budget no longer pins a 2 GB instance to a single page
// at a time.
const WORKER_MEMORY_BUDGET = 192 * 1024 * 1024;
const usableMemory = (() => {
  const available = (globalThis as { process?: { availableMemory?: () => number } }).process?.availableMemory;
  const free = typeof available === 'function' ? available() : freemem();
  // Leave room for the HTTP server, Poppler, and the rest of the host. Node no
  // longer carries the recognition heap itself, so this reserve is smaller than
  // it had to be for the WASM engine.
  return Math.max(0, Math.min(free, totalmem()) - 256 * 1024 * 1024);
})();
const memoryBoundConcurrency = Math.max(1, Math.floor(usableMemory / WORKER_MEMORY_BUDGET));
const defaultOcrConcurrency = Math.max(1, Math.min(8, cpuCount - 1, memoryBoundConcurrency));

const ocrConcurrency = positiveInteger(process.env.OCR_CONCURRENCY, defaultOcrConcurrency, 32);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((value) => value.trim()),
  storageDir: path.resolve(baseDir, process.env.STORAGE_DIR ?? './storage'),
  storageDriver: process.env.STORAGE_DRIVER ?? 'local',
  // DigitalOcean Spaces. The names below are the service's, not the SDK's: the
  // AWS SDK is used because Spaces speaks the S3 protocol, which is an
  // implementation detail rather than a statement about who stores the files.
  spaces: {
    // Signing needs a region, and it has to be the one in the endpoint host.
    // There is no sensible default: a wrong guess fails every request with a
    // signature error, so an unset value is left to the boot check above.
    region: process.env.DO_SPACES_REGION ?? '',
    bucket: process.env.DO_SPACES_BUCKET ?? '',
    prefix: (process.env.DO_SPACES_PREFIX ?? 'documents').replace(/^\/+|\/+$/g, ''),
    // What actually selects Spaces over AWS. Without it the SDK resolves an
    // amazonaws.com host and a Spaces region name signs against nothing.
    endpoint: process.env.DO_SPACES_ENDPOINT,
    forcePathStyle: process.env.DO_SPACES_FORCE_PATH_STYLE !== 'false',
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
    // The SDK frames PutObject as `aws-chunked` to append a trailing checksum,
    // which Spaces rejects. Sending a plain body with a Content-Length is the
    // default here, because no Spaces region accepts the chunked framing.
    disableChecksums: process.env.DO_SPACES_DISABLE_CHECKSUMS !== 'false',
    // Spaces encrypts at rest on its own and has no SSE header to request, so
    // this is off unless a deployment points these variables at real S3.
    serverSideEncryption: process.env.DO_SPACES_SSE,
    maxAttempts: positiveInteger(process.env.DO_SPACES_MAX_ATTEMPTS, 3, 10),
    connectionTimeoutMs: positiveInteger(process.env.DO_SPACES_CONNECTION_TIMEOUT_MS, 5_000),
    requestTimeoutMs: positiveInteger(process.env.DO_SPACES_REQUEST_TIMEOUT_MS, 120_000),
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
  // Never more rasterisers than the container has CPU for: on a one-core plan a
  // second Poppler process only takes time away from recognition.
  renderConcurrency: positiveInteger(
    process.env.OCR_RENDER_CONCURRENCY,
    Math.max(1, Math.min(cpuCount, Math.ceil(ocrConcurrency / 2))),
    32,
  ),
  uploadStorageConcurrency: positiveInteger(process.env.UPLOAD_STORAGE_CONCURRENCY, 4, 8),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  maxBatchFiles: positiveInteger(process.env.MAX_BATCH_FILES, 30),
};
