-- Existing vectors were generated from verbose decision summaries. Mark them
-- as version 1 so the new retrieval path cannot mix incomparable vector
-- representations. New rows use canonical request facts (version 2).
ALTER TABLE "precedent_records"
ADD COLUMN "embedding_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "precedent_records"
ALTER COLUMN "embedding_version" SET DEFAULT 2;

DROP INDEX IF EXISTS "precedent_records_target_system_entitlement_key_status_idx";

CREATE INDEX "precedent_records_target_system_entitlement_key_status_embedding_version_idx"
ON "precedent_records"("target_system", "entitlement_key", "status", "embedding_version");
