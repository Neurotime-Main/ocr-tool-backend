-- Pages become the unit of work.
--
-- The old pipeline processed a document as one indivisible job held in the API
-- process's memory: nothing was written until the last page finished, a single
-- bad page discarded the whole document, and a restart lost everything in
-- flight. Making the page row the job fixes all three at once, and lets several
-- workers share one batch without coordinating.

CREATE TYPE "PageStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

ALTER TABLE "OcrPage"
  ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '',
  -- Existing rows were written by the previous pipeline, which only ever
  -- persisted finished pages, so COMPLETE is the correct default for them.
  ADD COLUMN "status" "PageStatus" NOT NULL DEFAULT 'COMPLETE',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3);

-- A page row is now created before it has been read, so every column the
-- pipeline fills in later needs a default.
ALTER TABLE "OcrPage"
  ALTER COLUMN "width" SET DEFAULT 0,
  ALTER COLUMN "height" SET DEFAULT 0,
  ALTER COLUMN "source" SET DEFAULT 'pending',
  ALTER COLUMN "text" SET DEFAULT '',
  ALTER COLUMN "words" SET DEFAULT '[]';

CREATE INDEX "OcrPage_status_createdAt_idx" ON "OcrPage"("status", "createdAt");

-- Keyword search reads `searchText` with a containment match, which without a
-- trigram index is a sequential scan over every page in the workspace.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "OcrPage_searchText_trgm_idx" ON "OcrPage" USING GIN ("searchText" gin_trgm_ops);
