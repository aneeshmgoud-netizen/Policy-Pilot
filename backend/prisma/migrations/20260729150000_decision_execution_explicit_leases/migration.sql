-- Replace the implicit "updated_at is the processing lease" scheme with two
-- explicit, independent leases.
--
-- Why: updated_at is Prisma @updatedAt, so it moves on ANY write to the row.
-- Using it as the processing-staleness signal meant an unrelated update — in
-- particular a sweeper claiming recovery ownership — refreshed it, making a
-- genuinely stale PROCESSING row look freshly claimed. The worker the sweeper
-- had just enqueued would then fail its CAS claim and no-op, so the row could
-- not be recovered promptly. Separating the two concerns removes that
-- interaction entirely: processing staleness is now decided only by
-- processing_lease_expires_at, and recovery ownership writes only the
-- recovery_lease_* columns.

-- AlterTable
ALTER TABLE "decision_executions" ADD COLUMN "processing_lease_expires_at" TIMESTAMP(3);
ALTER TABLE "decision_executions" ADD COLUMN "recovery_lease_token" TEXT;
ALTER TABLE "decision_executions" ADD COLUMN "recovery_lease_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "decision_executions_status_processing_lease_expires_at_idx"
  ON "decision_executions"("status", "processing_lease_expires_at");

-- Backfill: keep every row already in flight recoverable, and reproduce the
-- exact staleness timing the previous implementation gave it. Rows that were
-- PROCESSING under the old scheme became reclaimable 5 minutes after their
-- last write, so their lease is dated from updated_at by that same interval.
-- Rows already past that point get an expiry in the past and are therefore
-- immediately reclaimable — which is correct: nothing is holding them.
--
-- No outcome is invented here. Status, attempts, executed_at, error_code and
-- last_error are all untouched; a PROCESSING row stays PROCESSING and is
-- re-attempted through the normal claim path, where the row id is passed to
-- the downstream system as the idempotency key exactly as before.
UPDATE "decision_executions"
   SET "processing_lease_expires_at" = "updated_at" + INTERVAL '5 minutes'
 WHERE "status" = 'PROCESSING';

-- PENDING rows intentionally keep a NULL processing lease: they are not
-- claimed by anyone, and the claim CAS accepts PENDING unconditionally.
