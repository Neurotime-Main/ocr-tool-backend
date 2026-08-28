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
  // The API and the recognition worker are separate containers with separate
  // ephemeral disks, so a PDF the API writes locally is a file the worker can
  // never open. That used to work only because both ran in one process. This is
  // fatal at boot rather than on the first page, because otherwise the symptom
  // is every page of every upload failing with a message about a missing file.
  if (process.env.NODE_ENV === 'production' && !isSpacesDriver(process.env.STORAGE_DRIVER)) {
    throw new Error(
      `STORAGE_DRIVER is '${process.env.STORAGE_DRIVER ?? 'local'}', which cannot work in production: `
      + 'the API and the OCR worker run as separate services and do not share a disk, so the worker '
      + 'cannot read the PDFs the API stores. Set STORAGE_DRIVER=spaces together with DO_SPACES_BUCKET, '
      + 'DO_SPACES_ENDPOINT, DO_SPACES_REGION, DO_SPACES_KEY and DO_SPACES_SECRET on BOTH services.',
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

// Recognition is CPU bound, so the useful amount of parallel work is set by
// the number of cores the container is actually scheduled for.
const cpuCount = (() => {
  const reported = (() => {
    try { return availableParallelism(); } catch { return 2; }
  })();
  const limit = cgroupCpuLimit();
  // A fractional allowance still runs one page, just not two at once.
  return Number.isFinite(limit) ? Math.max(1, Math.min(reported, Math.floor(limit))) : reported;
})();

// Each recognition daemon holds the PP-OCRv5 models plus its ONNX Runtime
// arena, measured at roughly 360 MB resident and flat across pages. The budget
// is rounded up from that so a container is never sized into the OOM reaper.
const WORKER_MEMORY_BUDGET = 420 * 1024 * 1024;
const usableMemory = (() => {
  const available = (globalThis as { process?: { availableMemory?: () => number } }).process?.availableMemory;
  const free = typeof available === 'function' ? available() : freemem();
  // Leave room for Node itself, Poppler, and the rest of the host.
  return Math.max(0, Math.min(free, totalmem()) - 320 * 1024 * 1024);
})();
const memoryBoundConcurrency = Math.max(1, Math.floor(usableMemory / WORKER_MEMORY_BUDGET));

/**
 * How many pages are recognised at once.
 *
 * This used to be `cpuCount - 1`, which evaluates to zero -- and is then
 * clamped to one -- on every single-CPU plan, so production ran one page at a
 * time however much work was queued while a developer laptop ran eight. OCR
 * now lives in its own service with no HTTP traffic to protect, so the whole
 * CPU allowance is used and a one-core plan is described honestly as one page.
 */
const defaultOcrConcurrency = Math.max(1, Math.min(8, cpuCount, memoryBoundConcurrency));

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
  // The languages the upload form offers. They select the recognition script;
  // PP-OCRv5's Latin model covers both English and Azerbaijani, so the choice
  // no longer changes which model is loaded, and the values are kept only so
  // existing clients and stored documents stay valid.
  tesseractLanguages: [...new Set([
    'eng',
    'aze',
    'aze+eng',
    ...(process.env.TESSERACT_LANGS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  ])],

  // --- Recognition engine -------------------------------------------------
  pythonBin: process.env.PYTHON_BIN ?? 'python3',
  pythonDir: path.resolve(moduleDir, '../python'),
  ocrModelDir: process.env.PPOCR_MODEL_DIR ?? path.resolve(moduleDir, '../models'),
  // Threads inside one daemon. Pages are already run in parallel, and giving
  // each daemon a single thread measured faster than the reverse split: four
  // one-thread daemons finish four pages in the time one four-thread daemon
  // finishes about one and a half.
  ocrThreadsPerWorker: positiveInteger(process.env.PPOCR_THREADS, 1, 16),
  // Longest side the detector sees. It downsamples internally, so this trades
  // small-text recall against detection time; 1600 reads broadsheet body copy.
  ocrDetectionMaxSide: positiveInteger(process.env.PPOCR_DET_MAX_SIDE, 1600),
  ocrStartupTimeoutMs: positiveInteger(process.env.PPOCR_STARTUP_TIMEOUT_MS, 120_000),
  // A page that has not come back by now is treated as a lost daemon rather
  // than a slow one, so a single pathological page cannot hold a slot forever.
  ocrPageTimeoutMs: positiveInteger(process.env.PPOCR_PAGE_TIMEOUT_MS, 180_000),

  // --- Rasterisation ------------------------------------------------------
  renderDpi: Math.max(120, Number(process.env.OCR_RENDER_DPI ?? 200)),
  // Oversized pages are rendered below OCR_RENDER_DPI so a single page never
  // rasterises past this many pixels. A4 at 200 DPI is 3.9 MP.
  maxRenderPixels: positiveInteger(process.env.OCR_MAX_PAGE_PIXELS, 12_000_000),
  minRenderDpi: positiveInteger(process.env.OCR_MIN_RENDER_DPI, 150),
  renderJpegQuality: Math.min(100, Math.max(40, positiveInteger(process.env.OCR_JPEG_QUALITY, 88))),
  renderTimeoutMs: positiveInteger(process.env.OCR_RENDER_TIMEOUT_MS, 120_000),

  // --- Throughput ---------------------------------------------------------
  ocrConcurrency,
  // Poppler competes with the recogniser for the same cores, so rendering runs
  // at roughly half the recognition width and is overlapped with it. JPEG
  // output made rasterising cheap enough that it is no longer the limit.
  renderConcurrency: positiveInteger(
    process.env.OCR_RENDER_CONCURRENCY,
    Math.max(1, Math.min(cpuCount, Math.ceil(ocrConcurrency / 2))),
    32,
  ),

  // --- Page queue ---------------------------------------------------------
  // Pages are claimed in runs so one PDF is opened and downloaded once per
  // batch instead of once per page.
  pageClaimSize: positiveInteger(process.env.OCR_PAGE_CLAIM_SIZE, Math.max(4, ocrConcurrency * 2), 64),
  maxPageAttempts: positiveInteger(process.env.OCR_MAX_PAGE_ATTEMPTS, 3, 10),
  queuePollIntervalMs: positiveInteger(process.env.OCR_POLL_INTERVAL_MS, 2_000),
  // A page still marked as running after this long belongs to a worker that
  // was redeployed or killed, and is offered to the pool again.
  staleLockMs: positiveInteger(process.env.OCR_STALE_LOCK_MS, 10 * 60_000),
  documentCacheEntries: positiveInteger(process.env.OCR_PDF_CACHE_ENTRIES, 4, 32),
  /**
   * Runs the page worker inside the API process. Off in production, where the
   * worker is its own Render service and OCR must not compete with HTTP for
   * the CPU; on by default elsewhere so `npm run dev` is still a single
   * command.
   */
  runWorkerInProcess: (process.env.RUN_OCR_IN_API ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) !== 'false',

  uploadStorageConcurrency: positiveInteger(process.env.UPLOAD_STORAGE_CONCURRENCY, 4, 8),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  maxBatchFiles: positiveInteger(process.env.MAX_BATCH_FILES, 30),
};
