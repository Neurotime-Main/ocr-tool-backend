-- Isolate page queues that share one database. Existing rows came from the
-- production deployment, so the default deliberately adopts them there.
ALTER TABLE "Document"
  ADD COLUMN "queueNamespace" TEXT NOT NULL DEFAULT 'production',
  ADD COLUMN "preparedAt" TIMESTAMP(3);

-- Rows completed by the previous pipeline were fully enumerated. Failed and
-- in-progress rows stay NULL so the new worker can either retry or recover.
UPDATE "Document"
SET "preparedAt" = "updatedAt"
WHERE "ocrStatus" = 'COMPLETE';

CREATE INDEX "Document_queueNamespace_preparedAt_ocrStatus_createdAt_idx"
  ON "Document"("queueNamespace", "preparedAt", "ocrStatus", "createdAt");
