# Markwise API

Standalone Node.js/Express backend for batch OCR processing, highlight persistence, PDF export, and Excel findings reports.

## Production architecture

- **Render:** one Docker web service. It serves HTTP and reads the OCR queue in the same process. (Recognition can be split into its own worker later — see "Scaling up" — but that is not the default.)
- **Neon:** PostgreSQL through Prisma. It also holds the work queue.
- **DigitalOcean Spaces (`ams3`):** private storage for uploaded source PDFs, reached through the S3 SDK. Render's filesystem holds only temporary page images.
- **PaddleOCR PP-OCRv5** on ONNX Runtime, in a Python daemon beside the worker. The models ship inside the image, so no page ever leaves the container.

The batch API accepts up to 30 PDFs per request. Source files are persisted to Spaces with four bounded parallel uploads by default (`UPLOAD_STORAGE_CONCURRENCY`). `MAX_BATCH_FILES` controls the upload count and each file is limited independently by `MAX_UPLOAD_MB`.

## How a document is processed

Pages, not documents, are the unit of work, and the queue is a table in Postgres rather than an array in the API process. That gives four things the previous design could not:

1. **Results appear as they are read.** Every finished page is written immediately, so a batch is searchable while the rest of it is still running. Nothing waits for the slowest PDF.
2. **A bad page costs a page.** Each page gets three attempts; one that keeps failing is marked `FAILED` and the rest of its document completes without it. `ocrError` then says how many pages were lost and which one failed first.
3. **A deploy loses nothing.** Workers claim pages with `FOR UPDATE SKIP LOCKED` and hand them back on shutdown. A page whose worker vanished is returned to the queue when its lock expires (`OCR_STALE_LOCK_MS`).
4. **Workers scale sideways.** Any number of instances can share the queue with no coordination.

The pipeline for each page:

```
upload -> Spaces -> prepare (open PDF, read text layer per page)
                       |
       .---------------+----------------.
       |                                |
  text layer usable              needs recognition
   write page, done              queue page -> claim -> render JPEG
                                    -> PaddleOCR PP-OCRv5 -> write page
```

### The text layer comes first

Most pages never reach the recogniser. `prepare` reads each page's embedded text and uses it when it is complete and well-formed — about **0.05 s a page**, against several seconds to rasterise and recognise one. Across the sample corpus in `storage/`, 93% of pages are served this way.

Two things make that number as high as it is:

- **Legacy Azerbaijani font encodings are decoded, not rejected.** Several of these publications draw perfectly good text with non-Unicode fonts, so their text layer arrives looking like `Àçÿðáàéúàíûí` (byte-mapped) or `ийул` (Cyrillic-mapped). Both are decoded to `Azərbaycanın` and `iyul`. Previously they were treated as mojibake and every such page was rasterised and recognised instead — which is why the documents with the *best* text layers were the slowest in the batch.
- **A few undecodable glyphs no longer condemn a page.** Wingdings list bullets land in the Unicode private-use area; two of them in ten thousand characters used to send the whole page to OCR. They are now stripped, and only a page that is *substantially* undecodable (over 2%) is recognised.

Force-OCR mode skips this branch entirely and rasterises every page.

## OCR throughput

Recognition is CPU bound and each page uses one core, so **pages in parallel is simply the worker's core count**. The knobs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCR_CONCURRENCY` | smaller of the container's CPU quota and free memory ÷ 420 MB, capped at 8 | Pages recognised at once. "CPU" is the cgroup quota where one is set, not the host's core count. |
| `OCR_RENDER_CONCURRENCY` | half of `OCR_CONCURRENCY` | Parallel Poppler rasterisations, overlapped with recognition. |
| `OCR_RENDER_DPI` | `200` | Rasterisation DPI. PP-OCRv5 downsamples again before detection, so higher values mostly cost time. |
| `PPOCR_DET_MAX_SIDE` | `1600` | Longest side the text detector sees. This is the accuracy control for dense pages: 1600 finds broadsheet body copy; 1280 is roughly a third faster and loses the smallest text. |
| `PPOCR_THREADS` | `1` | Threads inside one recognition daemon. Four single-threaded daemons beat one four-threaded daemon by a wide margin, so leave this alone unless the worker has one core. |
| `OCR_MAX_PAGE_PIXELS` | `12000000` | Ceiling on one rendered page; oversized page boxes render below `OCR_RENDER_DPI`. |
| `OCR_MAX_PAGE_ATTEMPTS` | `3` | Attempts before a page is given up on. |
| `OCR_STALE_LOCK_MS` | `600000` | How long a claimed page may be silent before another worker may take it. |
| `RUN_OCR_IN_API` | `false` in production | Runs the worker inside the API process. On by default in development so `npm run dev` is one command. |

### Why PaddleOCR, and why not Tesseract

Measured on a broadsheet page from `storage/`, single-threaded, same machine:

| | Tesseract 5.5 | PaddleOCR PP-OCRv5 |
| --- | --- | --- |
| Time | 11.1 s (plus a second 11 s pass on weak pages) | ~7 s |
| Words found | 1931 | 1742 |
| Mean confidence | 0.75 | 0.98 |
| Azerbaijani output | heavily garbled | clean |

Tesseract also needed a second full pass whenever the first returned few words or low confidence, which on scanned pages was often — so its real cost was frequently double the figure above. PP-OCRv5 detects and recognises in one pass.

The recogniser runs as a **persistent daemon** rather than a process per page: loading the three models costs about a fifth of a second, which would otherwise be paid on every page. A daemon that crashes, times out, or breaks protocol is killed and replaced, and its page is retried on a fresh process.

**One upstream gap is worth knowing about.** PaddleOCR's Latin PP-OCRv5 model has no lowercase `ə` in its character set, though it has `Ə`, so it writes `Azrbaycan` where the page reads `Azərbaycan`. Keyword search compensates by removing `ə` from both the query and the stored text, so `Azərbaycan` matches either spelling. Exported text keeps whatever was recognised.

## Search

Keyword search filters candidate pages in the database before loading anything. Each page stores `searchText`: its text put through the same normaliser the matcher uses, with spaces removed, indexed with a `pg_trgm` GIN index. A page that cannot contain a keyword is ruled out in Postgres rather than having its word boxes shipped to the API to find that out.

Matching then runs on a line's letters with the spaces taken out. These documents are typeset in justified columns that break words across syllables — `şəbəkələrdən` is set as `şə bə kə lər dən` — and PDF text layers routinely split one word into several glyph runs. A word-by-word comparison misses those; requiring the match to begin at a word start and end at a word end keeps it from over-matching. Highlight rectangles are the union of the boxes the match actually covers, so the output shape is unchanged.

Pages written before `searchText` existed carry an empty value and are always treated as candidates. The worker backfills them in batches whenever the queue is idle, after which the index does its job for them too.

## Cancelling a batch

`POST /api/documents/cancel` with `{ "ids": [...] }` deletes those documents completely: their page rows (and so their queue entries), their highlights, and their stored PDFs. Deleting the queue entry is what stops the work — a page already in flight finishes into rows that no longer exist, which is harmless. It is what the browser's **Stop and discard** button calls, and the batch upload endpoint uses the same path to clean up after a client that aborts mid-upload.

Excel reports include the PDF filename, page number, inferred article/page title, keyword, matched text, surrounding context, match type, OCR confidence, and user note. Heading inference uses word geometry and returns an empty title when no reliable heading is available. Export values are cleaned for UTF-8/XLSX compatibility, preserve Azerbaijani characters, repair common encoding corruption, and are protected from accidental Excel formulas.

## Setup

### What you need installed

| | Why | Where it comes from |
| --- | --- | --- |
| **Poppler** (`pdftoppm`) | Turns a PDF page into an image for OCR | Docker image; locally `apt-get install poppler-utils` |
| **Python 3** | Runs the PaddleOCR recognition daemon | Docker image; locally `apt-get install python3 python3-venv` |
| **PaddleOCR models** (~13 MB) | The recognition weights | Downloaded at image build; locally `npm run setup:python` |

Nothing else. There is no OCR service to sign up for and no API key: every page
is read inside your own container.

### Why Python at all

The whole app is Node except one piece. PaddleOCR's PP-OCRv5 models are
published for Python, and the surrounding maths -- the DB text-detection
post-process, the perspective crop of each text line, the CTC decode -- exists
as tested library code there (OpenCV, NumPy, pyclipper) and nowhere usable in
Node. Reimplementing contour finding and polygon offsetting in TypeScript to
avoid one dependency would be a lot of subtly wrong code.

So `python/ppocr_daemon.py` is a long-lived process that Node starts and talks
to over stdin/stdout, one JSON line per page. It holds no state, no queue and no
database connection. If it crashes it is killed and replaced, and its page is
retried. **PaddlePaddle itself is not installed** -- the models run on ONNX
Runtime, which starts in a fraction of a second and holds several hundred
megabytes less per process, so more pages fit on a small container.

### Local

```bash
cd backend
cp .env.example .env          # then fill in DATABASE_URL / DIRECT_URL
npm install
npm run prisma:migrate

npm run setup:python          # venv + dependencies + models, one command
#   prints the PYTHON_BIN line to paste into .env

npm run doctor                # checks everything and names the fix for anything missing
npm run dev
```

`npm run doctor` is the thing to run whenever something is wrong. It checks the
database, the schema, storage, Poppler, the models, the recognition engine and
the queue, and prints the exact command that fixes whatever is broken.

### Render

**One service. Docker.** Do not create a second one.

1. **New → Web Service**, point it at this repository, **Runtime: Docker**,
   root directory `backend`, health check path `/api/health`.
2. **Plan: Standard or better.** One page is recognised per CPU core, and one
   core is reserved for HTTP, so a 1-CPU plan leaves nothing for OCR.
3. Set the environment variables below.
4. Deploy. The container runs `prisma migrate deploy` before starting, so the
   schema is applied for you.
5. Open `/api/health`. It should report `"ok": true` and `"queue": {"stalled":
   false}`. If it does not, the response names the failing dependency.

| Variable | Value | Required |
| --- | --- | --- |
| `DATABASE_URL` | Neon **pooled** string (host contains `-pooler`), `?sslmode=require` | yes |
| `DIRECT_URL` | Neon **direct** string, used by migrations | yes |
| `CLIENT_ORIGIN` | your Vercel origin, comma-separated for several | yes |
| `STORAGE_DRIVER` | `spaces` | yes |
| `DO_SPACES_BUCKET` | the Space name alone, no URL | yes |
| `DO_SPACES_ENDPOINT` | `https://ams3.digitaloceanspaces.com` | yes |
| `DO_SPACES_REGION` | `ams3` — must match the endpoint host | yes |
| `DO_SPACES_KEY` / `DO_SPACES_SECRET` | Spaces key pair, **not** AWS IAM | yes |
| `DO_SPACES_PREFIX` | `documents` | no |
| `DO_SPACES_FORCE_PATH_STYLE` | `true` | no |
| `DO_SPACES_DISABLE_CHECKSUMS` | `true` — Spaces rejects the SDK's chunked framing | no |
| `MAX_BATCH_FILES` / `MAX_UPLOAD_MB` | `30` / `50` | no |
| `OCR_CONCURRENCY` | pages at once; defaults to cores − 1 | no |
| `PPOCR_DET_MAX_SIDE` | `1600`; lower to `1280` for ~⅓ faster, less small text | no |
| `NODE_ENV` | set by the Dockerfile | no |

`STORAGE_DRIVER=spaces` is **not optional in production**. Render erases the
service's disk on every deploy, so locally stored PDFs would not survive one.
The process refuses to start without it rather than losing uploads later.

### What goes wrong, and how it looks

| Symptom | Cause | Fix |
| --- | --- | --- |
| Documents stay `PENDING` forever | Nothing is reading the queue | `/api/health` → `queue.lastClaimSeconds: null`. Usually `RUN_OCR_IN_API=false` with no worker service. Unset it. |
| Every page: *the stored PDF is missing* | `STORAGE_DRIVER` is not `spaces` | Set it and the `DO_SPACES_*` variables. Re-upload — the old files are gone. |
| *The OCR engine could not be started* | No Python, or `PYTHON_BIN` points nowhere | Locally `npm run setup:python`. On Render this means the service is not the Docker image. |
| *The PDF page renderer is not installed* | No Poppler | Same cause as above: not built from the Dockerfile. |
| Health check fails on deploy | A dependency is down | The `/api/health` body names which one. |
| Batch is slow, CPU pinned | Too few cores | Raise the plan, or lower `PPOCR_DET_MAX_SIDE` to `1280`. |
| Deploy killed a running batch | Normal | In-flight pages return to the queue and resume. Nothing is lost. |

### Scaling up

Recognition can move to its own service once OCR volume justifies it: same
image, `dockerCommand: node dist/worker.js`, **every environment variable
copied across**, and `RUN_OCR_IN_API=false` on the web service. The worker
refuses to start if its storage or engine is misconfigured rather than failing
page by page.

Do this only when API latency actually suffers during batches. Two services is
two sets of variables to keep in step, and every production failure this project
has had came from them drifting apart.

## Neon setup

Create a Neon project and copy both connection strings from its connection dialog:

- `DATABASE_URL`: the pooled hostname containing `-pooler`, used by the running API.
- `DIRECT_URL`: the non-pooled hostname, used by Prisma migrations.

Both URLs should include `sslmode=require`. The Docker startup command runs `prisma migrate deploy` before starting the API.

## Object storage setup

Render's filesystem is ephemeral, so uploaded PDFs must live in object storage. This project uses a **DigitalOcean Space in `ams3` (Amsterdam)**. The AWS SDK is the client because Spaces speaks the S3 protocol, but no AWS account is involved: `DO_SPACES_ENDPOINT` is what decides which service is called.

Create the Space with **File Listing set to Restricted**. The frontend never talks to object storage directly — every byte is streamed back through the API — so the Space needs no public access and no browser CORS rules.

Then create a **Spaces access key** (API → Spaces Keys). These are not AWS IAM credentials and carry no JSON policy; scope the key to this one Space if your team's plan offers scoped keys.

| Variable | Value |
| --- | --- |
| `DO_SPACES_ENDPOINT` | `https://ams3.digitaloceanspaces.com` |
| `DO_SPACES_REGION` | `ams3` |
| `DO_SPACES_BUCKET` | the Space name alone — no region, no URL |
| `DO_SPACES_FORCE_PATH_STYLE` | `true` |
| `DO_SPACES_DISABLE_CHECKSUMS` | `true` |

`DO_SPACES_DISABLE_CHECKSUMS` is the one that is easy to miss. The SDK otherwise frames `PutObject` as `aws-chunked` to append a trailing checksum, which Spaces rejects — uploads then fail with a signature or `InvalidArgument` error while every other call keeps working.

`/api/health` probes with `HeadObject` on a key that does not exist, rather than `HeadBucket`, so it needs only read permission and a `404` counts as success.

Objects are written with an explicit `ContentLength` and no SSE header — Spaces encrypts at rest on its own and rejects the header AWS expects. Set `DO_SPACES_SSE=AES256` only if these variables are ever repointed at real S3.

A lifecycle rule on the `documents/` prefix is worth adding if uploads are not meant to be kept forever; the app only deletes an object when a batch is cancelled.

Amsterdam and the Frankfurt API are about 350 km apart, which is a low-single-digit millisecond hop — fine. Keeping storage in the same city as the database matters more than matching the API, because a page image is pulled back for every OCR'd page.

To move to real AWS S3 instead, unset `DO_SPACES_ENDPOINT`, set `DO_SPACES_FORCE_PATH_STYLE=false` and `DO_SPACES_DISABLE_CHECKSUMS=false`, set `DO_SPACES_SSE=AES256`, set `DO_SPACES_REGION` to a genuine region such as `eu-central-1`, and grant an IAM user `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on `arn:aws:s3:::YOUR_BUCKET/documents/*`. Those three actions are all the service uses.

This MVP has no user authentication, so add it before accepting untrusted public uploads.

## Deploy the frontend to Vercel

The frontend is a separate Vercel project pointed at this API.

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `https://YOUR-SERVICE.onrender.com/api` |

Set it for **Production, Preview, and Development**. Vite inlines `VITE_*` at build time, so changing it needs a redeploy, not just a restart. Then add the resulting Vercel origins to the backend's `CLIENT_ORIGIN` and redeploy the API.

Preview deployments get a new hostname per branch, which is why `CLIENT_ORIGIN` accepts a wildcard pattern such as `https://markwise-*.vercel.app`. An origin that is not allowed gets a `403` from the API.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API and OCR worker together, with reload |
| `npm run doctor` | Checks every dependency and names the fix for anything broken |
| `npm run setup:python` | Creates the Python runtime and downloads the models |
| `npm run build` / `npm start` | Compile / run the compiled server |
| `npm run prisma:migrate` | Apply migrations locally |
| `npm run prisma:deploy` | Apply migrations in production (the container does this on boot) |
| `npm run start:worker` | Standalone OCR worker, for the split deployment only |
