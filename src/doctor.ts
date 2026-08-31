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
import { checkConverter, checkImageConverter } from './convert.js';
import { mediaStorageIsPublic, storage, uploadsAreDurable } from './storage.js';
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

// Uploads living on the container's disk is the intended arrangement, not a
// misconfiguration -- but the consequence is worth stating plainly.
if (!uploadsAreDurable()) {
  add('Uploaded PDFs', 'warn', `kept on this container's disk (${config.storageDir})`,
    'A deploy or restart clears them and any document still being worked on must be re-uploaded. '
    + 'Recognised text and published images are unaffected. Set STORAGE_DRIVER=spaces to keep uploads in the bucket.');
}
add('Published images', mediaStorageIsPublic() ? 'ok' : 'fail',
  mediaStorageIsPublic() ? `${config.spaces.bucket}/${config.mediaImages.prefix}` : 'no bucket configured',
  mediaStorageIsPublic() ? undefined
    : 'Publishing has nowhere to put page images. Set DO_SPACES_BUCKET and the other DO_SPACES_* variables.');

// --- Rasteriser -----------------------------------------------------------
const renderer = await checkRenderer();
add('PDF renderer (Poppler)', renderer.ok, renderer.detail,
  renderer.ok ? undefined
    : 'Install it: `sudo apt-get install -y poppler-utils` (macOS: `brew install poppler`). The Docker image installs it already.');

// --- Office conversion ----------------------------------------------------
// Only a warning: PDFs still work without it, and plenty of deployments never
// see a Word file.
const converter = await checkConverter();
add('Office to PDF (LibreOffice)', converter.ok ? 'ok' : 'warn', converter.detail,
  converter.ok ? undefined
    : 'Install it with `sudo apt-get install -y libreoffice-writer-nogui` to accept .doc/.docx/.xlsx/.pptx uploads. PDFs are unaffected.');

// --- Image conversion -----------------------------------------------------
// Also only a warning, for the same reason: it is needed to accept photos and
// scans, not to process a PDF.
const imageConverter = await checkImageConverter();
add('Image to PDF (img2pdf)', imageConverter.ok ? 'ok' : 'warn', imageConverter.detail,
  imageConverter.ok ? undefined
    : 'Run `npm run setup:python` to accept .jpg/.png/.heic uploads. PDFs are unaffected.');

// --- Recognition models ---------------------------------------------------
const models = ['det.onnx', 'cls.onnx', 'rec_latin.onnx', 'rec_latin.yml', 'rec_cyrillic.onnx', 'rec_cyrillic.yml'];
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

// --- Published image URLs -------------------------------------------------
// Publishing writes an image and records its address. Whether that address is
// actually reachable is invisible from inside the process, so it is proved the
// only way that means anything: store a probe, fetch it over plain HTTP the way
// a reader's browser would, then remove it.
if (isSpacesDriver(config.storageDriver)) {
  const probeKey = `${config.mediaImages.prefix}/.public-access-probe.txt`;
  try {
    await storage.savePublicObject(probeKey, Buffer.from('probe\n'), 'text/plain');
    const url = storage.publicUrl(probeKey);
    const origin = new URL(url).origin;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      add('Published image URLs', response.ok ? 'ok' : 'fail',
        `${origin} -> HTTP ${response.status}`,
        response.ok ? undefined
          : 'Published images will not open. Either make this host serve the Space, or clear '
            + 'MEDIA_IMAGE_BASE_URL so the Space\'s own origin is used.');
    } catch (error) {
      add('Published image URLs', 'fail', `${origin} -> ${(error as Error).message}`,
        config.mediaImages.baseUrl
          ? `MEDIA_IMAGE_BASE_URL is set to ${config.mediaImages.baseUrl}, which does not serve the Space. `
            + 'Clear it to use the Space origin, or point that host at the bucket.'
          : 'The Space origin did not respond. Check the bucket name and endpoint.');
    }
    await storage.delete(probeKey).catch(() => undefined);
  } catch (error) {
    add('Published image URLs', 'fail', (error as Error).message.split('\n')[0] ?? 'probe upload failed',
      'The service could not write a public object. Check the Spaces key has write access.');
  }
}

// --- Queue ----------------------------------------------------------------
try {
  const queue = await getQueueHealth();
  // This command does not itself read the queue, so waiting pages only mean the
  // server is not running right now -- which during setup is the normal case.
  add('Page queue', queue.stalled ? 'warn' : 'ok',
    `${queue.unpreparedDocuments} unprepared documents, ${queue.pendingPages} pending pages, ${queue.processingPages} running`
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
