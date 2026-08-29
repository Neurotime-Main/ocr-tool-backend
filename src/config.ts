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

export const OCR_LANGUAGE_CODES = ['aze', 'eng', 'rus'] as const;
export type OcrLanguageCode = typeof OCR_LANGUAGE_CODES[number];
export type OcrScript = 'latin' | 'cyrillic';

const OCR_LANGUAGE_ALIASES: Record<string, OcrLanguageCode> = {
  az: 'aze',
  aze: 'aze',
  en: 'eng',
  eng: 'eng',
  ru: 'rus',
  rus: 'rus',
};

/** Normalizes old `aze+eng` values and multi-select form values alike. */
export function parseOcrLanguages(value: string | undefined) {
  const tokens = (value ?? '').toLowerCase().split(/[+,]/).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const languages = tokens.map((token) => OCR_LANGUAGE_ALIASES[token]);
  if (languages.some((language) => !language)) return null;
  return OCR_LANGUAGE_CODES.filter((language) => languages.includes(language));
}

export function serializeOcrLanguages(languages: OcrLanguageCode[]) {
  return OCR_LANGUAGE_CODES.filter((language) => languages.includes(language)).join('+');
}

/** Azerbaijani and English share the Latin recognizer; Russian needs Cyrillic. */
export function ocrScriptsForLanguage(value: string): OcrScript[] {
  const languages = parseOcrLanguages(value) ?? ['eng'];
  const scripts: OcrScript[] = [];
  if (languages.some((language) => language === 'aze' || language === 'eng')) scripts.push('latin');
  if (languages.includes('rus')) scripts.push('cyrillic');
  return scripts.length ? scripts : ['latin'];
}

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
    if (!process.env.DO_SPACES_REGION) missing.push('DO_SPACES_REGION');
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
  // Render gives a service a fresh, empty disk on every deploy, so a PDF stored
  // locally is gone the next time the code changes -- along with any batch that
  // was still being read. Fatal at boot rather than on the first page, because
  // otherwise it surfaces much later as pages failing with a missing file.
  if (process.env.NODE_ENV === 'production' && !isSpacesDriver(process.env.STORAGE_DRIVER)) {
    throw new Error(
      `STORAGE_DRIVER is '${process.env.STORAGE_DRIVER ?? 'local'}', which cannot work in production: `
      + "the host's disk is erased on every deploy, so uploaded PDFs would not survive one, and a "
      + 'separate OCR worker could never read them at all. Set STORAGE_DRIVER=spaces together with '
      + 'DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_REGION, DO_SPACES_KEY and DO_SPACES_SECRET.',
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
const reportedCpuCount = (() => {
  try { return availableParallelism(); } catch { return 2; }
})();
const cpuQuota = cgroupCpuLimit();
const cpuCount = (() => {
  // A fractional allowance still runs one page, just not two at once.
  return Number.isFinite(cpuQuota)
    ? Math.max(1, Math.min(reportedCpuCount, Math.floor(cpuQuota)))
    : reportedCpuCount;
})();

/**
 * The memory this container is actually allowed, or Infinity when uncapped.
 *
 * `freemem()` reports the *host's* free memory, which on a platform that caps a
 * container through cgroups (Render, Fly, ECS) is tens of gigabytes while the
 * service itself may have two. Sizing the recognition pool from it is the same
 * mistake as sizing it from the host's core count: the process cheerfully
 * starts more daemons than fit and is then killed by the OOM reaper, or spends
 * its time swapping -- which looks like a service that has become inexplicably
 * slow rather than one that is out of memory.
 */
function cgroupMemoryLimit() {
  const read = (path: string) => {
    try { return readFileSync(path, 'utf8').trim(); } catch { return undefined; }
  };
  // cgroup v2, then v1.
  const raw = read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (!raw || raw === 'max') return Number.POSITIVE_INFINITY;
  const limit = Number(raw);
  // cgroup v1 reports an enormous sentinel value when nothing is set.
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1024 ** 4) return Number.POSITIVE_INFINITY;
  return limit;
}

// Each recognition daemon holds the PP-OCRv5 models plus its ONNX Runtime
// arena, measured at roughly 360 MB resident and flat across pages. The budget
// is rounded up from that so a container is never sized into the OOM reaper.
const WORKER_MEMORY_BUDGET = 420 * 1024 * 1024;

/**
 * What is left for recognition after everything else this process does.
 *
 * Reading a document is itself expensive -- an eight-page broadsheet peaks
 * around 600 MB while its thirty thousand word boxes are being built -- so that
 * has to be reserved before any daemon is allowed to exist, not discovered
 * afterwards when the two collide.
 */
const NODE_MEMORY_RESERVE = 700 * 1024 * 1024;
const memoryLimit = cgroupMemoryLimit();
const usableMemory = (() => {
  const available = (globalThis as { process?: { availableMemory?: () => number } }).process?.availableMemory;
  const free = typeof available === 'function' ? available() : freemem();
  // The cgroup cap wins wherever there is one; it is the only figure that
  // describes this container rather than the machine underneath it.
  const ceiling = Number.isFinite(memoryLimit) ? memoryLimit : Math.min(free, totalmem());
  return Math.max(0, ceiling - NODE_MEMORY_RESERVE);
})();
const memoryBoundConcurrency = Math.max(1, Math.floor(usableMemory / WORKER_MEMORY_BUDGET));

/**
 * Whether this process reads the queue itself.
 *
 * Defaults to on, everywhere. Splitting recognition into its own service is the
 * right shape once OCR volume justifies it, but it is a second deployment to
 * keep in step -- same image, same database, same storage credentials -- and
 * getting any of that wrong fails silently, with documents queueing forever or
 * every page reporting a missing file. One service that works beats two that
 * might. Set RUN_OCR_IN_API=false on the API once a dedicated worker exists.
 */
const runWorkerInProcess = (process.env.RUN_OCR_IN_API ?? 'true') !== 'false';

/**
 * How many pages are recognised at once.
 *
 * The recognisers are child processes, so the OS scheduler still gives the
 * lightweight Node HTTP process time while they are busy. Reserving a whole
 * core here made a 2-CPU Render plan run only one single-threaded recogniser,
 * leaving half of the plan idle. Memory remains an independent hard cap.
 */
const defaultOcrConcurrency = Math.max(1, Math.min(8, cpuCount, memoryBoundConcurrency));

const requestedOcrConcurrency = positiveInteger(process.env.OCR_CONCURRENCY, defaultOcrConcurrency, 32);
// An old dashboard override must not defeat the cgroup sizing and turn a small
// instance into an oversubscribed/OOMing one.
const ocrConcurrency = Math.max(1, Math.min(requestedOcrConcurrency, cpuCount, memoryBoundConcurrency));
const requestedRenderConcurrency = positiveInteger(
  process.env.OCR_RENDER_CONCURRENCY,
  Math.max(1, Math.ceil(ocrConcurrency / 2)),
  32,
);
const renderConcurrency = Math.max(1, Math.min(requestedRenderConcurrency, cpuCount));

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
  runtimeResources: {
    reportedCpuCount,
    // Preserve a fractional cgroup allowance: Render Free is 0.1 CPU, not one
    // CPU, even though at least one job still has to be allowed to run.
    cpuQuota: Number.isFinite(cpuQuota) ? cpuQuota : null,
    schedulableCpuCount: cpuCount,
    memoryLimitBytes: Number.isFinite(memoryLimit) ? memoryLimit : null,
    memoryBoundConcurrency,
    requestedOcrConcurrency,
    requestedRenderConcurrency,
  },
  // Poppler competes with the recogniser for the same cores, so rendering runs
  // at roughly half the recognition width and is overlapped with it. JPEG
  // output made rasterising cheap enough that it is no longer the limit.
  renderConcurrency,

  // --- Page queue ---------------------------------------------------------
  // Pages are claimed in runs so one PDF is opened and downloaded once per
  // batch instead of once per page.
  pageClaimSize: positiveInteger(process.env.OCR_PAGE_CLAIM_SIZE, Math.max(4, ocrConcurrency * 2), 64),
  maxPageAttempts: positiveInteger(process.env.OCR_MAX_PAGE_ATTEMPTS, 3, 10),
  queuePollIntervalMs: positiveInteger(process.env.OCR_POLL_INTERVAL_MS, 2_000),
  // Documents opened per preparation pass. Preparation is cheap and resolves
  // most pages outright, so this is deliberately larger than it looks: the
  // sooner a batch is read, the sooner it can be searched.
  prepareBatchSize: positiveInteger(process.env.OCR_PREPARE_BATCH_SIZE, 10, 50),
  // A page still marked as running after this long belongs to a worker that
  // was redeployed or killed, and is offered to the pool again.
  staleLockMs: positiveInteger(process.env.OCR_STALE_LOCK_MS, 10 * 60_000),
  documentCacheEntries: positiveInteger(process.env.OCR_PDF_CACHE_ENTRIES, 4, 32),
  // A local dev process and Render may point at the same Neon database, but
  // they do not share local files or compute. Keep their queues separate.
  queueNamespace: process.env.OCR_QUEUE_NAMESPACE
    ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  prepareStaleMs: positiveInteger(process.env.OCR_PREPARE_STALE_MS, 10 * 60_000),
  /**
   * How long an unused recognition daemon is kept alive.
   *
   * Each holds about 360 MB, and on these documents most pages are served from
   * the text layer and never reach one -- so a pool that has been used once and
   * then idles was permanently holding memory the document reader needed. They
   * are cheap to restart (models load in about a fifth of a second), so idle
   * ones are released and re-created on demand.
   */
  ocrIdleTimeoutMs: positiveInteger(process.env.PPOCR_IDLE_TIMEOUT_MS, 90_000),
  runWorkerInProcess,

  uploadStorageConcurrency: positiveInteger(process.env.UPLOAD_STORAGE_CONCURRENCY, 4, 8),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
  maxBatchFiles: positiveInteger(process.env.MAX_BATCH_FILES, 30),
};

/**
 * A one-line summary of what this process will actually do, logged at boot.
 *
 * Every production failure so far has been a service configured differently
 * from the one next to it -- a worker without the storage credentials, or built
 * from a Node runtime rather than the Dockerfile, so with no Python and no
 * models. None of that is visible until a page fails, and the failure names a
 * missing file rather than the missing setting behind it. Printing the
 * effective settings makes the first ten lines of a deploy log enough to tell.
 */
export function describeRuntime(role: 'api' | 'worker') {
  return [
    `[boot] role=${role}`,
    `nodeEnv=${process.env.NODE_ENV ?? '(unset)'}`,
    `storage=${config.storageDriver}${isSpacesDriver(config.storageDriver) ? `:${config.spaces.bucket}` : `:${config.storageDir}`}`,
    `workerInApi=${config.runWorkerInProcess}`,
    `queueNamespace=${config.queueNamespace}`,
    `cpuQuota=${config.runtimeResources.cpuQuota ?? 'unlimited'}`,
    `memoryLimitMb=${config.runtimeResources.memoryLimitBytes == null ? 'unlimited' : Math.round(config.runtimeResources.memoryLimitBytes / 1024 / 1024)}`,
    `ocrConcurrency=${config.ocrConcurrency}`,
    `renderConcurrency=${config.renderConcurrency}`,
    `python=${config.pythonBin}`,
    `models=${config.ocrModelDir}`,
  ].join(' ');
}
