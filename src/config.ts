import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
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

export const OCR_LANGUAGE_CODES = ['aze', 'eng', 'rus', 'uzb', 'tur'] as const;
export type OcrLanguageCode = typeof OCR_LANGUAGE_CODES[number];
export type OcrScript = 'latin' | 'cyrillic';

const OCR_LANGUAGE_ALIASES: Record<string, OcrLanguageCode> = {
  az: 'aze',
  aze: 'aze',
  en: 'eng',
  eng: 'eng',
  ru: 'rus',
  rus: 'rus',
  uz: 'uzb',
  uzb: 'uzb',
  tr: 'tur',
  tur: 'tur',
};

/**
 * Which recognition model each language needs.
 *
 * Four of the five are written in Latin script and share one model; only
 * Russian needs the Cyrillic one. Uzbek is listed as Latin because that is the
 * alphabet in official use -- a Cyrillic Uzbek document is recognised by
 * selecting Russian alongside it, since the two share the script.
 */
const OCR_LANGUAGE_SCRIPTS: Record<OcrLanguageCode, OcrScript> = {
  aze: 'latin',
  eng: 'latin',
  uzb: 'latin',
  tur: 'latin',
  rus: 'cyrillic',
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

/** The distinct recognition models a language selection needs. */
export function ocrScriptsForLanguage(value: string): OcrScript[] {
  const languages = parseOcrLanguages(value) ?? ['eng'];
  const scripts = [...new Set(languages.map((language) => OCR_LANGUAGE_SCRIPTS[language]))];
  return scripts.length ? scripts : ['latin'];
}

/**
 * Fails the process at boot with an actionable message rather than letting a
 * misconfigured deploy surface as a Prisma or AWS SDK error on the first
 * upload. Called from db.ts, which every entry point imports.
 */
export function assertRuntimeEnvironment() {
  const missing: string[] = [];
  if (isSpacesDriver(process.env.STORAGE_DRIVER) || process.env.DO_SPACES_BUCKET) {
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
      `Object storage requires ${missing.join(', ')}. They are needed for published page images; `
      + 'unset DO_SPACES_BUCKET entirely to run without publishing.',
    );
  }
  // Uploaded PDFs are working files kept on the container's own disk; only
  // published images go to object storage. That is deliberate, so a local
  // driver is no longer an error -- but publishing has nowhere to put its
  // images without a bucket, so those credentials are still required in
  // production.
  if (process.env.NODE_ENV === 'production' && !process.env.DO_SPACES_BUCKET) {
    throw new Error(
      'DO_SPACES_BUCKET is missing. Published page images are written to object storage and their '
      + 'addresses recorded in media_results, so a bucket is required even though uploaded PDFs now '
      + 'stay on the local disk. Set DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_REGION, '
      + 'DO_SPACES_KEY and DO_SPACES_SECRET.',
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

/**
 * Physical cores, not hyperthreads.
 *
 * The recogniser is dense matrix arithmetic: two threads on the two siblings of
 * one core share that core's vector units and finish at roughly the speed one
 * thread would, so counting hyperthreads does not buy parallelism -- it just
 * doubles the number of threads competing for the same silicon. Measured on a
 * 6-core/12-thread laptop, sizing the pool to 12 made a page take 73-140s that
 * takes about 14s when the machine is not oversubscribed.
 *
 * Read from the kernel's topology, where each logical CPU names the physical
 * core it sits on; counting the distinct ones gives the real figure. Absent or
 * unreadable (a container hiding sysfs, a non-Linux host), this returns nothing
 * and the reported count is used as before.
 */
function physicalCoreCount() {
  try {
    const cores = new Set<string>();
    for (const entry of readdirSync('/sys/devices/system/cpu')) {
      if (!/^cpu\d+$/.test(entry)) continue;
      const topology = `/sys/devices/system/cpu/${entry}/topology`;
      const socket = readFileSync(`${topology}/physical_package_id`, 'utf8').trim();
      const core = readFileSync(`${topology}/core_id`, 'utf8').trim();
      cores.add(`${socket}:${core}`);
    }
    return cores.size || undefined;
  } catch {
    return undefined;
  }
}

const physicalCpuCount = physicalCoreCount();
const cpuQuota = cgroupCpuLimit();
const cpuCount = (() => {
  // The cgroup allowance still wins where there is one -- it describes this
  // container, while sysfs describes the machine underneath it. A fractional
  // allowance still runs one page, just not two at once.
  if (Number.isFinite(cpuQuota)) {
    return Math.max(1, Math.min(reportedCpuCount, Math.floor(cpuQuota)));
  }
  return Math.max(1, Math.min(reportedCpuCount, physicalCpuCount ?? reportedCpuCount));
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
// arena. A single-threaded daemon settles around 360 MB resident, but the
// arena grows with the thread count: at three threads they were measured at
// ~650 MB. The budget is rounded up from the multi-threaded figure, because
// that is the shape the pool is actually sized into below.
const WORKER_MEMORY_BUDGET = 700 * 1024 * 1024;

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
/**
 * Always true now, and kept as a field only so the boot line and health report
 * still say so. The queue lives in this process's memory, so a worker anywhere
 * else would have nothing to read; RUN_OCR_IN_API=false would simply stop every
 * upload from ever being processed.
 */
const runWorkerInProcess = true;

/**
 * How many pages are recognised at once.
 *
 * Pages and threads are one decision, not two: what matters is that
 * concurrency x threads stays near the core count. Running one daemon per core
 * looks like maximum parallelism and is not -- measured on 12 cores, eight
 * single-threaded daemons took 28.0s per page while four three-threaded ones
 * took about 13s. Worse, oversubscription is self-amplifying: a page slow
 * enough to pass PPOCR_PAGE_TIMEOUT_MS is retried, which adds load, which
 * makes the next page slower still, until the queue stops draining entirely.
 *
 * So each recogniser is given a few cores to itself, and the count is capped:
 * past four concurrent pages the daemons contend more than they contribute.
 * Memory remains an independent hard cap.
 */
const OCR_CORES_PER_PAGE = 3;
const defaultOcrConcurrency = Math.max(1, Math.min(
  4,
  Math.ceil(cpuCount / OCR_CORES_PER_PAGE),
  memoryBoundConcurrency,
));

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
  /**
   * Origins the browser may call this API from.
   *
   * Each entry is stripped of surrounding quotes and any trailing slash. An
   * unbalanced quote in the environment file -- `CLIENT_ORIGIN="http://x` with
   * no closing quote -- otherwise survives into the allow-list as part of the
   * value, so the origin can never match and every request is rejected with a
   * message that mentions neither the quote nor the origin. A quote is never
   * part of a valid origin, so removing it costs nothing and saves an hour.
   */
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '').trim())
    .filter(Boolean),
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
  /**
   * LibreOffice, used to turn uploaded Word/Excel/PowerPoint files into PDFs.
   * Everything after the upload works in PDF pages, so converting at the door
   * keeps one pipeline rather than two.
   */
  libreOfficeBin: process.env.LIBREOFFICE_BIN ?? 'soffice',
  // A large presentation can take a while to lay out; well short of anything
  // that would hold an upload open indefinitely.
  conversionTimeoutMs: positiveInteger(process.env.CONVERSION_TIMEOUT_MS, 180_000),
  pythonDir: path.resolve(moduleDir, '../python'),
  ocrModelDir: process.env.PPOCR_MODEL_DIR ?? path.resolve(moduleDir, '../models'),
  // Threads inside one daemon. Pages are already run in parallel, and giving
  // each daemon a single thread measured faster than the reverse split: four
  // one-thread daemons finish four pages in the time one four-thread daemon
  // finishes about one and a half.
  // The other half of the sizing decision above: whatever cores the pool did
  // not spend on parallel pages are given to each recogniser instead, so the
  // machine stays busy without being oversubscribed.
  ocrThreadsPerWorker: positiveInteger(
    process.env.PPOCR_THREADS,
    Math.max(1, Math.floor(cpuCount / ocrConcurrency)),
    16,
  ),
  // Longest side the detector sees. It downsamples internally, so this trades
  // small-text recall against detection time; 1600 reads broadsheet body copy.
  ocrDetectionMaxSide: positiveInteger(process.env.PPOCR_DET_MAX_SIDE, 1600),
  ocrStartupTimeoutMs: positiveInteger(process.env.PPOCR_STARTUP_TIMEOUT_MS, 120_000),
  // A page that has not come back by now is treated as a lost daemon rather
  // than a slow one, so a single pathological page cannot hold a slot forever.
  // How long one page may take before the recogniser is assumed to be stuck.
  //
  // This is a deadlock detector, not a performance budget, so it is set well
  // above the slowest legitimate page. A broadsheet with 433 text lines was
  // measured at 100s on an idle machine and 181s under load -- and the old
  // 180s limit turned that into a failure: the page was killed after doing all
  // the work, requeued, and the retry added the load that made the next page
  // slower still. Killing a page that is merely slow is how a busy queue turns
  // into a stuck one.
  ocrPageTimeoutMs: positiveInteger(process.env.PPOCR_PAGE_TIMEOUT_MS, 420_000),

  // --- Rasterisation ------------------------------------------------------
  renderDpi: Math.max(120, Number(process.env.OCR_RENDER_DPI ?? 200)),
  // Oversized pages are rendered below OCR_RENDER_DPI so a single page never
  // rasterises past this many pixels. A4 at 200 DPI is 3.9 MP.
  maxRenderPixels: positiveInteger(process.env.OCR_MAX_PAGE_PIXELS, 12_000_000),
  minRenderDpi: positiveInteger(process.env.OCR_MIN_RENDER_DPI, 150),
  renderJpegQuality: Math.min(100, Math.max(40, positiveInteger(process.env.OCR_JPEG_QUALITY, 88))),

  // --- Uploaded images ----------------------------------------------------
  // A photo or scan is wrapped in a one-page PDF at upload. Anything longer
  // than this on its longest edge is scaled down first: a 12 MP phone photo of
  // a page carries no more readable text than a 4000px scan of it, and the
  // extra pixels are paid for again at every rasterisation.
  imageMaxEdge: positiveInteger(process.env.IMAGE_MAX_EDGE, 4000),
  imageJpegQuality: Math.min(100, Math.max(40, positiveInteger(process.env.IMAGE_JPEG_QUALITY, 88))),
  renderTimeoutMs: positiveInteger(process.env.OCR_RENDER_TIMEOUT_MS, 120_000),

  // --- Throughput ---------------------------------------------------------
  ocrConcurrency,
  runtimeResources: {
    reportedCpuCount,
    physicalCpuCount: physicalCpuCount ?? null,
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
  /**
   * How many documents the in-memory workspace keeps before dropping the oldest.
   *
   * The workspace has no database behind it, so this is what bounds the heap.
   * Word boxes dominate: a broadsheet page carries a few thousand of them, and
   * only pages read from the PDF's own text layer keep theirs -- a recognised
   * page stores its words too, but a document that needed OCR has fewer usable
   * pages to begin with. Measured on this corpus, a twelve-page issue costs a
   * few megabytes, so the default leaves a couple of hundred issues live in a
   * container sized for the recognisers.
   *
   * Only finished documents are dropped, so a busy workspace can exceed this
   * rather than throw away work in progress.
   */
  maxRetainedDocuments: positiveInteger(process.env.OCR_MAX_RETAINED_DOCUMENTS, 200, 5000),
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

  /**
   * The Neurotime production database, which owns keywords, projects and
   * `media_results`. Separate from the application's own Postgres: this service
   * only reads from it and appends to it. See `serverDb.ts`.
   */
  serverDb: {
    host: process.env.SERVER_DB_HOST ?? '',
    port: positiveInteger(process.env.SERVER_DB_PORT, 5432),
    user: process.env.SERVER_DB_USER ?? '',
    password: process.env.SERVER_DB_PASSWORD ?? '',
    database: process.env.SERVER_DB_NAME ?? '',
    ssl: (process.env.SERVER_DB_SSLMODE ?? 'disable') !== 'disable',
    poolSize: positiveInteger(process.env.SERVER_DB_POOL_SIZE, 4, 16),
  },

  /**
   * Newspapers are source type 10. Keywords are offered for this type, and
   * every published row is stamped with it.
   */
  newsSourceTypeId: positiveInteger(process.env.NEWS_SOURCE_TYPE_ID, 10),

  /** Where published page images are stored and how their URLs are built. */
  mediaImages: {
    // A prefix inside the existing Space, kept apart from the source PDFs
    // because these objects are public and those are not.
    prefix: (process.env.MEDIA_IMAGE_PREFIX ?? 'newspaper').replace(/^\/+|\/+$/g, ''),
    /**
     * A custom host serving the Space, if one is ever set up.
     *
     * Empty by default, so published URLs use DigitalOcean's own address for
     * the bucket. That address always resolves; a vanity domain only works once
     * someone actually points it at the Space, and until then it produces links
     * that look right and open for nobody.
     */
    baseUrl: (process.env.MEDIA_IMAGE_BASE_URL ?? '').replace(/\/+$/, ''),
    // Rasterisation DPI for the published image. Lower than recognition needs:
    // this is read by people, not by a model.
    dpi: positiveInteger(process.env.MEDIA_IMAGE_DPI, 150),
    // Long edge cap, so a broadsheet page does not become a 12 MP download.
    maxEdge: positiveInteger(process.env.MEDIA_IMAGE_MAX_EDGE, 2200),
    jpegQuality: Math.min(100, Math.max(40, positiveInteger(process.env.MEDIA_IMAGE_QUALITY, 82))),
  },

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
    `clientOrigins=${config.clientOrigins.join('|') || '(none)'}`,
    `uploads=${isSpacesDriver(config.storageDriver) ? `spaces:${config.spaces.bucket}` : `local:${config.storageDir}`}`,
    `images=${config.spaces.bucket ? `spaces:${config.spaces.bucket}/${config.mediaImages.prefix}` : '(none)'}`,
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
