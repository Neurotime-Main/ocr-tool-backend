# Markwise API

Standalone Node.js/Express backend for batch OCR processing, highlight persistence, PDF export, and Excel findings reports.

## Production architecture

- **Render:** Docker web service. The image includes Poppler for PDF text extraction and page rasterization.
- **Neon:** PostgreSQL database accessed through Prisma.
- **DigitalOcean Spaces (`ams3`):** Private storage for uploaded source PDFs, reached through the S3 SDK. Render's filesystem is used only for temporary page images and exported files.
- **Tesseract:** Runs inside the Render service with bundled English and Azerbaijani language data; no OCR API is called.

OCR supports `eng`, `aze`, and mixed `aze+eng`. Automatic mode uses usable embedded PDF text when available and OCRs image-based or low-quality pages. Force OCR mode rasterizes every page and falls back to sparse-text layout analysis for decorated forms, posters, columns, and scattered text. The Render Docker image includes Tesseract's official English and Azerbaijani models; OCR remains entirely local to the server.

The batch API accepts up to 30 PDFs per request. Source files are persisted to S3 with four bounded parallel uploads by default (`UPLOAD_STORAGE_CONCURRENCY`), so a batch does not wait for every S3 round trip in sequence. `MAX_BATCH_FILES` controls the upload count and each file is still limited independently by `MAX_UPLOAD_MB`.

## OCR throughput

Pages, not documents, are the unit of parallel work. Every queued document draws from one shared pool of recognition slots, so a single 40-page scan uses the whole machine just as a 30-file batch does. Each slot runs the native `tesseract` binary as a short-lived process per page. The knobs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCR_CONCURRENCY` | smaller of CPU cores − 1 and free memory ÷ 192 MB, capped at 8 | Pages recognized at the same time across all documents. "CPU cores" is the container's cgroup CPU quota where one is set, not the host's core count, so a fractional-CPU plan does not oversubscribe itself. |
| `OCR_DOCUMENT_CONCURRENCY` | `OCR_CONCURRENCY` (min 2) | Documents allowed to have pages in flight. |
| `OCR_RENDER_CONCURRENCY` | half of `OCR_CONCURRENCY` (min 2) | Parallel Poppler rasterizations. Rendering overlaps recognition instead of blocking it. |
| `OCR_RENDER_DPI` | `260` | Target rasterization DPI. Use `300` for difficult small print. |
| `OCR_MAX_PAGE_PIXELS` | `12000000` | Ceiling on a single rendered page. Oversized page boxes are rendered below `OCR_RENDER_DPI` rather than producing 20+ megapixel images that cost seconds per page without adding readable detail. A4 at 260 DPI is 6.5 MP and is never downscaled. |
| `OCR_MIN_RENDER_DPI` | `150` | Floor for that downscaling. |

Other things that shape the runtime:

- The sparse-text second pass only runs when the automatic layout returns few words or low confidence, instead of on every force-OCR page.
- `aze+eng` runs two language models over every line and is roughly 1.7x slower per page than `aze` alone. Pick the single language when the set is not genuinely bilingual.
- The Docker image downloads `tessdata_fast`, which reads a page about twice as fast as `tessdata_best` with near-identical output on typical scans. Build with `--build-arg TESSDATA_VARIANT=tessdata_best` for very poor-quality originals.
- Recognized pages are written with `createMany`, so a long PDF costs a couple of statements rather than one round trip per page.

Use the workspace's **Re-run OCR** action to reprocess an existing file with the more thorough complex-layout mode.

## Cancelling a batch

`POST /api/documents/cancel` with `{ "ids": [...] }` stops queued and in-flight OCR for those documents and rolls them back completely: the in-flight page is abandoned, the queue entry is dropped, the database rows are deleted, and the stored PDFs are removed. The call waits for each running job to settle before deleting, so a job can never write pages back after the rollback. It is also what the browser's **Stop and discard** button calls, and the batch upload endpoint uses the same path to clean up after a client that aborts the request mid-upload.

Excel reports include the PDF filename, page number, inferred article/page title, keyword, matched text, surrounding context, match type, OCR confidence, and user note. Heading inference uses word geometry and returns an empty title when no reliable heading is available. Export values are cleaned for UTF-8/XLSX compatibility, preserve Azerbaijani characters, repair common encoding corruption, and are protected from accidental Excel formulas.

## Local development

Install Poppler first (`poppler-utils` on Debian/Ubuntu), then:

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run prisma:migrate
npm run dev
```

For the Docker PostgreSQL service, replace both database variables in `.env` with:

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ocr_highlighter?schema=public"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/ocr_highlighter?schema=public"
```

Local file storage is selected with `STORAGE_DRIVER=local`. Use `STORAGE_DRIVER=s3` to test AWS storage locally.

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

## Deploy to Render

1. Push this `backend` directory as its own Git repository.
2. In Render, create a Blueprint from the repository. `render.yaml` selects the Docker runtime, the Frankfurt region, the `standard` plan, and the `/api/health` check.
3. Fill in the secret variables the Blueprint asks for (everything below marked *secret*).
4. Deploy, then confirm `https://YOUR-SERVICE.onrender.com/api/health` returns `"ok": true` with both `database: "connected"` and `storage.ok: true`.

Render supplies `PORT` itself. Never commit AWS or Neon secrets.

### Render environment variables

| Variable | Value | |
| --- | --- | --- |
| `NODE_ENV` | `production` | in `render.yaml` |
| `DATABASE_URL` | Neon **pooled** string (host contains `-pooler`), `?sslmode=require` | *secret* |
| `DIRECT_URL` | Neon **direct** string, `?sslmode=require` | *secret* |
| `CLIENT_ORIGIN` | `https://YOUR-APP.vercel.app,https://YOUR-APP-*.vercel.app` | *secret* |
| `STORAGE_DRIVER` | `spaces` | in `render.yaml` |
| `DO_SPACES_BUCKET` | the Space name alone | *secret* |
| `DO_SPACES_ENDPOINT` | `https://ams3.digitaloceanspaces.com` | in `render.yaml` |
| `DO_SPACES_REGION` | `ams3` | in `render.yaml` |
| `DO_SPACES_FORCE_PATH_STYLE` | `true` | in `render.yaml` |
| `DO_SPACES_DISABLE_CHECKSUMS` | `true` | in `render.yaml` |
| `DO_SPACES_KEY` | Spaces access key | *secret* |
| `DO_SPACES_SECRET` | Spaces secret | *secret* |
| `DO_SPACES_PREFIX` | `documents` | in `render.yaml` |
| `MAX_BATCH_FILES` / `MAX_UPLOAD_MB` | `30` / `50` | in `render.yaml` |
| `OCR_RENDER_DPI` / `OCR_MAX_PAGE_PIXELS` | `260` / `12000000` | in `render.yaml` |
| `OCR_CONCURRENCY` | leave unset | sized from CPU and free memory |

The service refuses to start with a named-variable error if any of the required ones are missing, rather than failing on the first upload.

**Plan sizing.** Recognition is a native `tesseract` process per page, holding the page raster and its language model. On Starter (512 MB) the pool still sizes itself down to one page at a time; `standard` (2 GB) is the realistic floor for 30-file batches, and CPU is what decides how long a page takes. Because the pool is capped by the cgroup CPU quota, a fractional-CPU plan recognizes one page at a time no matter how many cores the host reports. Starter and free instances also spin down when idle, which adds a cold start to the first upload and drops any queued OCR — the queue is recovered on restart, but the wait is real.

## Deploy the frontend to Vercel

The frontend is a separate Vercel project pointed at this API.

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `https://YOUR-SERVICE.onrender.com/api` |

Set it for **Production, Preview, and Development**. Vite inlines `VITE_*` at build time, so changing it needs a redeploy, not just a restart. Then add the resulting Vercel origins to the backend's `CLIENT_ORIGIN` and redeploy the API.

Preview deployments get a new hostname per branch, which is why `CLIENT_ORIGIN` accepts a wildcard pattern such as `https://markwise-*.vercel.app`. An origin that is not allowed gets a `403` from the API.

## Commands

```bash
npm run typecheck
npm run build
npm run prisma:generate
npm run prisma:deploy
npm audit --omit=dev
```

For higher traffic, move `processDocument` into a durable background worker/queue. The current in-process job is appropriate for the MVP but can be interrupted by a service restart or deployment.
