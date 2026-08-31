/**
 * Writes .env and .env.example from one template.
 *
 * They exist as two files but describe one thing, and editing them separately
 * is how they drift: a variable gets added to one, renamed in the other, or a
 * hand-edit truncates a section without anyone noticing. Generating both from
 * the list below keeps them in step, and `npm run doctor` will not agree with a
 * file that has lost half its contents.
 *
 * Existing values in .env are preserved, so running this never overwrites a
 * secret or a local override.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

/** Current values, so regenerating never loses a secret. */
const current = existsSync(envPath)
  ? Object.fromEntries([...readFileSync(envPath, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
    .map(([, key, value]) => [key, value.trim()]))
  : {};

/** Value as it should appear, unquoting whatever is already there. */
const value = (key, fallback = '') => {
  const raw = current[key] ?? fallback;
  const bare = raw.length > 1 && raw[0] === raw.at(-1) && (raw[0] === '"' || raw[0] === "'")
    ? raw.slice(1, -1)
    : raw;
  return bare;
};
const quoted = (key, fallback = '') => `"${value(key, fallback)}"`;

/** Secrets and machine-specific paths, blanked in the example file. */
const SECRET = new Set([
  'DATABASE_URL', 'DIRECT_URL', 'SERVER_DB_HOST', 'SERVER_DB_USER', 'SERVER_DB_PASSWORD',
  'SERVER_DB_NAME', 'DO_SPACES_BUCKET', 'DO_SPACES_KEY', 'DO_SPACES_SECRET', 'PYTHON_BIN',
]);

const section = (title) => `\n# ─── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}\n`;

const template = [
  '# Markwise OCR — backend configuration',
  '#',
  '# Required settings are filled in below. Everything under "Optional" is',
  '# commented out and shows its default; uncomment only to override. Every',
  '# variable the code reads appears here, and nothing else does.',
  '#',
  '# Regenerate with `npm run write-env` (existing values are preserved).',
  section('Runtime'),
  `NODE_ENV=${quoted('NODE_ENV', 'development')}`,
  `PORT=${value('PORT', '4000')}`,
  '',
  '# Browser origins allowed to call this API. Comma-separated, no trailing',
  '# slash. Vite moves to 5174+ when 5173 is taken, so the dev ports are listed.',
  `CLIENT_ORIGIN=${quoted('CLIENT_ORIGIN', 'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173')}`,
  section('Application database (Neon)'),
  '# DATABASE_URL is the POOLED string (host contains "-pooler"), used at runtime.',
  '# DIRECT_URL is the non-pooled string, used only by `prisma migrate`.',
  `DATABASE_URL=${quoted('DATABASE_URL')}`,
  `DIRECT_URL=${quoted('DIRECT_URL')}`,
  section('Neurotime database (media_analyse)'),
  '# Source of keywords and projects, and the destination for published results.',
  '# This service only ever runs SELECT and INSERT against it; serverDb.ts refuses',
  '# anything else before it reaches the wire.',
  `SERVER_DB_HOST=${value('SERVER_DB_HOST')}`,
  `SERVER_DB_PORT=${value('SERVER_DB_PORT', '5432')}`,
  `SERVER_DB_USER=${value('SERVER_DB_USER')}`,
  `SERVER_DB_PASSWORD=${value('SERVER_DB_PASSWORD')}`,
  `SERVER_DB_NAME=${value('SERVER_DB_NAME')}`,
  `SERVER_DB_SSLMODE=${value('SERVER_DB_SSLMODE', 'disable')}`,
  '# Newspapers. Keywords are fetched for this source type and published rows are',
  '# stamped with it.',
  `NEWS_SOURCE_TYPE_ID=${value('NEWS_SOURCE_TYPE_ID', '10')}`,
  section('Uploaded files'),
  '# The uploaded PDF is kept for the life of the document: the OCR worker reads',
  '# it, the viewer streams it, re-running OCR parses it again, and publishing',
  '# rasterises it to draw the highlighted pages. So it goes to the bucket under',
  '# DO_SPACES_PREFIX. Use "local" only in development, where losing the file on',
  '# restart does not matter.',
  `STORAGE_DRIVER=${quoted('STORAGE_DRIVER', 'spaces')}`,
  `STORAGE_DIR=${quoted('STORAGE_DIR', './storage')}`,
  `TEMP_DIR=${quoted('TEMP_DIR', './tmp')}`,
  `MAX_UPLOAD_MB=${value('MAX_UPLOAD_MB', '50')}`,
  `MAX_BATCH_FILES=${value('MAX_BATCH_FILES', '30')}`,
  `UPLOAD_STORAGE_CONCURRENCY=${value('UPLOAD_STORAGE_CONCURRENCY', '4')}`,
  section('Object storage (DigitalOcean Spaces)'),
  '# Two prefixes in one bucket: uploaded PDFs under DO_SPACES_PREFIX, published',
  '# page images under MEDIA_IMAGE_PREFIX. The bucket is required whenever',
  '# publishing is used, because an image URL is written into media_results and',
  '# opened by people with no access to this host.',
  `DO_SPACES_BUCKET=${quoted('DO_SPACES_BUCKET')}`,
  '# The endpoint is what selects Spaces. Without it the SDK resolves an AWS',
  '# hostname, and "ams3" is not an AWS region.',
  `DO_SPACES_ENDPOINT=${quoted('DO_SPACES_ENDPOINT', 'https://ams3.digitaloceanspaces.com')}`,
  `DO_SPACES_REGION=${quoted('DO_SPACES_REGION', 'ams3')}`,
  `DO_SPACES_KEY=${quoted('DO_SPACES_KEY')}`,
  `DO_SPACES_SECRET=${quoted('DO_SPACES_SECRET')}`,
  '# Prefix for uploaded PDFs.',
  `DO_SPACES_PREFIX=${quoted('DO_SPACES_PREFIX', 'journals')}`,
  `DO_SPACES_FORCE_PATH_STYLE=${value('DO_SPACES_FORCE_PATH_STYLE', 'true')}`,
  "# Spaces rejects the SDK's \"aws-chunked\" upload framing.",
  `DO_SPACES_DISABLE_CHECKSUMS=${value('DO_SPACES_DISABLE_CHECKSUMS', 'true')}`,
  section('Published images'),
  '# Prefix inside the bucket. Published URLs are <bucket origin>/<prefix>/...',
  `MEDIA_IMAGE_PREFIX=${value('MEDIA_IMAGE_PREFIX', 'newspaper')}`,
  '# A custom host serving the bucket, if one is ever set up. Empty means the',
  "# bucket's own address is used, which always resolves. A host that does not",
  '# point at the bucket produces links that look right and open for nobody.',
  `MEDIA_IMAGE_BASE_URL=${value('MEDIA_IMAGE_BASE_URL')}`,
  section('Recognition'),
  '# The Python interpreter running the PaddleOCR daemon. Set by the Docker image;',
  '# locally it is the virtualenv from `npm run setup:python`.',
  `PYTHON_BIN=${quoted('PYTHON_BIN')}`,
  '# Rasterisation DPI for recognition. PP-OCRv5 downsamples again before',
  '# detection, so higher values mostly cost time.',
  `OCR_RENDER_DPI=${value('OCR_RENDER_DPI', '200')}`,
  '# A single page never rasterises past this many pixels; oversized page boxes',
  '# render below OCR_RENDER_DPI. A4 at 200 DPI is 3.9 MP.',
  `OCR_MAX_PAGE_PIXELS=${value('OCR_MAX_PAGE_PIXELS', '12000000')}`,
  `OCR_MIN_RENDER_DPI=${value('OCR_MIN_RENDER_DPI', '150')}`,
  section('Optional'),
  '# Defaults shown. Uncomment only to override.',
  '',
  '# Runs the OCR worker inside this process. Set false only when a separate',
  '# worker service is running `node dist/worker.js`.',
  '# RUN_OCR_IN_API=true',
  '# Keeps one deployment\'s queue separate from another\'s on a shared database.',
  '# OCR_QUEUE_NAMESPACE=development',
  '',
  '# Pages recognised at once, and threads inside each recogniser. These are one',
  '# decision: pages x threads should stay near the core count. More, thinner',
  '# recognisers do not raise throughput, they just make each page slower -- and a',
  '# page slow enough to hit PPOCR_PAGE_TIMEOUT_MS is retried, which makes the',
  '# oversubscription worse. Defaults: ceil(cores/3) recognisers, capped at 4 and',
  '# by memory (~700 MB each), with the remaining cores as threads.',
  '# OCR_CONCURRENCY=2',
  '# PPOCR_THREADS=2',
  '# OCR_RENDER_CONCURRENCY=1',
  '# OCR_PAGE_CLAIM_SIZE=8          # pages claimed per pass',
  '# OCR_PREPARE_BATCH_SIZE=10      # documents opened per preparation pass',
  '# OCR_MAX_PAGE_ATTEMPTS=3        # tries before a page is given up on',
  '# OCR_POLL_INTERVAL_MS=2000      # idle poll interval',
  '# OCR_STALE_LOCK_MS=600000       # before another worker may retake a claimed page',
  '# OCR_PREPARE_STALE_MS=600000    # before an abandoned preparation is retried',
  '# OCR_PDF_CACHE_ENTRIES=4        # PDFs kept open on disk between pages',
  '# OCR_RENDER_TIMEOUT_MS=120000',
  '# OCR_JPEG_QUALITY=88            # quality of the image handed to the recogniser',
  '',
  '# Longest side the text detector sees. The accuracy control for dense pages:',
  '# 1600 finds broadsheet body copy, 1280 is ~a third faster and loses small text.',
  '# PPOCR_DET_MAX_SIDE=1600',
  '# PPOCR_IDLE_TIMEOUT_MS=90000    # before an unused daemon releases its ~360 MB',
  '# PPOCR_STARTUP_TIMEOUT_MS=120000',
  '# PPOCR_PAGE_TIMEOUT_MS=420000   # a stuck-daemon detector, not a speed budget',
  '# PPOCR_MODEL_DIR=./models       # set by the Docker image',
  '',
  '# Word/Excel/PowerPoint uploads are converted to PDF on arrival.',
  '# LIBREOFFICE_BIN=soffice',
  '# CONVERSION_TIMEOUT_MS=180000',
  '',
  '# Uploaded photos and scans are wrapped in a one-page PDF. A picture larger',
  '# than IMAGE_MAX_EDGE on its longest side is scaled down first: past this,',
  '# extra pixels cost recognition time without finding more text.',
  '# IMAGE_MAX_EDGE=4000',
  '# IMAGE_JPEG_QUALITY=88',
  '',
  '# Published image rendering.',
  '# MEDIA_IMAGE_DPI=150',
  '# MEDIA_IMAGE_MAX_EDGE=2200      # longest edge in pixels',
  '# MEDIA_IMAGE_QUALITY=82',
  '',
  '# Object storage tuning.',
  '# DO_SPACES_MAX_ATTEMPTS=3',
  '# DO_SPACES_CONNECTION_TIMEOUT_MS=5000',
  '# DO_SPACES_REQUEST_TIMEOUT_MS=120000',
  '# DO_SPACES_SSE=                 # leave unset; Spaces rejects the SSE header',
  '# SERVER_DB_POOL_SIZE=4',
  '',
].join('\n');

writeFileSync(envPath, template);

const example = template
  .replace('# Regenerate with `npm run write-env` (existing values are preserved).',
    '# Copy to .env and fill in the blanks.')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !SECRET.has(match[1])) return line;
    return `${match[1]}=${match[2].startsWith('"') ? '""' : ''}`;
  })
  .join('\n');
writeFileSync(path.join(root, '.env.example'), example);

console.log('wrote .env and .env.example');
