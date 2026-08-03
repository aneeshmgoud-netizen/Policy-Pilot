-- Support a genuine async execution outbox: a PROCESSING status so a worker
-- can claim a row via compare-and-swap (distinct from PENDING, so a second
-- worker or duplicate delivery can't claim the same row), an UNKNOWN_LEGACY
-- status for decisions that predate this table (backfilled in the next
-- migration), a sanitized error_code alongside the existing sanitized
-- last_error, and updated_at so a worker crash mid-PROCESSING can be
-- detected and reclaimed by staleness.

-- AlterEnum
ALTER TYPE "execution_status" ADD VALUE 'PROCESSING';
ALTER TYPE "execution_status" ADD VALUE 'UNKNOWN_LEGACY';

-- AlterTable
ALTER TABLE "decision_executions" ADD COLUMN "error_code" TEXT;
ALTER TABLE "decision_executions" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
