/**
 * Checks every dependency the pipeline needs and says how to fix each one.
 *
 * Run with `npm run doctor`, locally or in a Render shell. It exists because
 * the failures this service can have all look the same from outside -- uploads
 * that never finish -- while the causes are unrelated: a missing Python
 * runtime, models that were never downloaded, Poppler absent, storage pointing
 * at a disk instead of a bucket, or a migration that has not run. Each check
 * below prints the command that fixes it rather than only the symptom.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { config, describeRuntime, isSpacesDriver } from './config.js';
import { prisma } from './db.js';
import { checkOcrEngine } from './ocrEngine.js';
import { checkRenderer } from './render.js';
import { storage } from './storage.js';
import { getQueueHealth } from './pageQueue.js';

// `warn` is for things that are wrong for production but perfectly normal on a
// developer machine. Reporting those as failures trains you to ignore the
// output, which defeats the point of having it.
type Level = 'ok' | 'warn' | 'fail';
type Result = { name: string; level: Level; detail: string; fix?: string };

const results: Result[] = [];
const add = (name: string, level: Level | boolean, detail: string, fix?: string) =>
  results.push({ name, level: level === true ? 'ok' : level === false ? 'fail' : level, detail, fix });
const inProduction = process.env.NODE_ENV === 'production';

console.log(describeRuntime(config.runWorkerInProcess ? 'api' : 'worker'));
console.log('');

// --- Database -------------------------------------------------------------
try {
  await prisma.$queryRaw`SELECT 1`;
  add('Database connection', true, 'connected');
  try {
    const pages = await prisma.ocrPage.count();
    add('Database schema', true, `OcrPage reachable (${pages} page rows)`);
  } catch (error) {
    add('Database schema', false, (error as Error).message.split('\n')[0] ?? 'query failed',
      'Run `npx prisma migrate deploy`. The page queue needs the 20260828000000_page_queue migration.');
  }
} catch (error) {
  add('Database connection', false, (error as Error).message.split('\n')[0] ?? 'unreachable',
    'Check DATABASE_URL. It should be the Neon POOLED string (host contains "-pooler") with ?sslmode=require.');
}

// --- Storage --------------------------------------------------------------
const storageStatus = await storage.check();
add(`Storage (${storageStatus.driver})`, storageStatus.ok, storageStatus.detail,
  storageStatus.ok ? undefined
    : 'Check DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET and DO_SPACES_ENDPOINT.');

if (!isSpacesDriver(config.storageDriver)) {
  add('Storage durability', inProduction ? 'fail' : 'warn', `STORAGE_DRIVER=${config.storageDriver}`,
    'Fine for local development. In production set STORAGE_DRIVER=spaces: a Render disk is erased on every deploy, taking uploaded PDFs with it.');
}

// --- Rasteriser -----------------------------------------------------------
const renderer = await checkRenderer();
add('PDF renderer (Poppler)', renderer.ok, renderer.detail,
  renderer.ok ? undefined
    : 'Install it: `sudo apt-get install -y poppler-utils` (macOS: `brew install poppler`). The Docker image installs it already.');

// --- Recognition models ---------------------------------------------------
const models = ['det.onnx', 'cls.onnx', 'rec_latin.onnx', 'rec_latin.yml'];
const missingModels: string[] = [];
for (const name of models) {
  await access(path.join(config.ocrModelDir, name)).catch(() => missingModels.push(name));
}
add('PaddleOCR models', missingModels.length === 0,
  missingModels.length ? `missing from ${config.ocrModelDir}: ${missingModels.join(', ')}` : config.ocrModelDir,
  missingModels.length ? `Download them: \`${config.pythonBin} python/download_models.py ${config.ocrModelDir}\`` : undefined);

// --- Recognition engine ---------------------------------------------------
const engine = await checkOcrEngine();
add('PaddleOCR engine', engine.ok, engine.detail,
  engine.ok ? undefined
    : `Create the Python runtime: \`python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt\`, then set PYTHON_BIN to its python. Currently PYTHON_BIN=${config.pythonBin}.`);

// --- Queue ----------------------------------------------------------------
try {
  const queue = await getQueueHealth();
  // This command does not itself read the queue, so waiting pages only mean the
  // server is not running right now -- which during setup is the normal case.
  add('Page queue', queue.stalled ? 'warn' : 'ok',
    `${queue.pendingPages} pending, ${queue.processingPages} running`
    + (queue.lastClaimSeconds === null ? ', never claimed' : `, last claim ${queue.lastClaimSeconds}s ago`),
    queue.stalled
      ? (config.runWorkerInProcess
        ? 'Pages are waiting. If the server is running and this does not clear, check its log for a worker crash.'
        : 'RUN_OCR_IN_API is false, so a separate worker service must be running `node dist/worker.js` against this same database. Either start it, or set RUN_OCR_IN_API=true here.')
      : undefined);
} catch {
  add('Page queue', false, 'could not be read', 'Fix the database checks above first.');
}

// --- Report ---------------------------------------------------------------
console.log('');
const label = { ok: ' ok ', warn: 'warn', fail: 'FAIL' } as const;
for (const result of results) {
  console.log(`${label[result.level]}  ${result.name}: ${result.detail}`);
  if (result.level !== 'ok' && result.fix) console.log(`      -> ${result.fix}`);
}

const failures = results.filter((result) => result.level === 'fail');
const warnings = results.filter((result) => result.level === 'warn');
console.log('');
if (failures.length) {
  console.log(`${failures.length} problem(s) will stop OCR from working. Fix them, then run this again.`);
} else {
  console.log(`Everything needed is in place. Uploads will be processed.${warnings.length ? ` (${warnings.length} warning(s) above.)` : ''}`);
}

await prisma.$disconnect();
process.exit(failures.length ? 1 : 0);
