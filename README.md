# Markwise API

Standalone Node.js/Express backend for batch OCR processing, highlight persistence, PDF export, and Excel findings reports.

## Production architecture

- **Render:** Docker web service. The image includes Poppler for PDF text extraction and page rasterization.
- **Neon:** PostgreSQL database accessed through Prisma.
- **AWS S3:** Private storage for uploaded source PDFs. Render's filesystem is used only for temporary page images and exported files.
- **Tesseract:** Runs inside the Render service with bundled English and Azerbaijani language data; no OCR API is called.

OCR supports `eng`, `aze`, and mixed `aze+eng`. Automatic mode uses usable embedded PDF text when available and OCRs image-based or low-quality pages. Force OCR mode rasterizes every page and falls back to sparse-text layout analysis for decorated forms, posters, columns, and scattered text. The Render Docker image includes Tesseract's official English and Azerbaijani models; OCR remains entirely local to the server.

The batch API accepts up to 30 PDFs per request. Source files are persisted to S3 with four bounded parallel uploads by default (`UPLOAD_STORAGE_CONCURRENCY`), so a batch does not wait for every S3 round trip in sequence. `MAX_BATCH_FILES` controls the upload count and each file is still limited independently by `MAX_UPLOAD_MB`.

## OCR throughput

Pages, not documents, are the unit of parallel work. Every queued document draws from one shared pool of warm Tesseract workers, so a single 40-page scan uses the whole machine just as a 30-file batch does. The knobs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCR_CONCURRENCY` | smaller of CPU cores − 1 and free memory ÷ 512 MB, capped at 8 | Pages recognized at the same time across all documents. Each worker holds its language models and a WASM heap, so the default stays at 1 on a small container instead of being OOM-killed. |
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

## AWS S3 setup

Create a private bucket with Block Public Access enabled. The frontend never communicates with S3 directly, so the bucket does not need public access or browser CORS rules.

Create a dedicated IAM user or role limited to the configured prefix. Replace the bucket name and prefix in this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/documents/*"
    }
  ]
}
```

Uploads use S3 server-side AES-256 encryption and are streamed back through the application boundary. This MVP does not yet implement user authentication, so add authentication before accepting untrusted public uploads.

## Deploy to Render

1. Push this `backend` directory as its own Git repository.
2. In Render, create a Blueprint from the repository. `render.yaml` selects the Docker runtime and `/api/health` health check.
3. Add the secret environment variables requested by the Blueprint:
   - `DATABASE_URL` and `DIRECT_URL` from Neon.
   - `CLIENT_ORIGIN`, for example `https://markwise.vercel.app`. Multiple origins are comma-separated; a project-specific preview pattern such as `https://markwise-*.vercel.app` is supported.
   - `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.
4. Deploy and verify `https://YOUR-SERVICE.onrender.com/api/health` returns a connected database and `s3` storage.

Render receives `PORT` automatically. Do not add AWS or Neon secrets to Git.

## Commands

```bash
npm run typecheck
npm run build
npm run prisma:generate
npm run prisma:deploy
npm audit --omit=dev
```

For higher traffic, move `processDocument` into a durable background worker/queue. The current in-process job is appropriate for the MVP but can be interrupted by a service restart or deployment.
