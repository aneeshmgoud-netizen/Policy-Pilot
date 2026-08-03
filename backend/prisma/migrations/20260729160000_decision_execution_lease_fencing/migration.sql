-- Add a fencing token to the processing lease.
--
-- Why: the lease introduced in 20260729150000 decides who may *claim* a row,
-- but the success/failure writes were keyed on the row id alone. A worker
-- whose lease had expired — stalled by a GC pause, network partition, or VM
-- suspend — could resume after another worker legitimately reclaimed and
-- completed the row, and then overwrite that outcome: SUCCEEDED -> FAILED on
-- its final attempt, or SUCCEEDED -> PENDING with retries remaining, which
-- un-terminalizes a finished execution and emits a contradictory audit entry.
-- The downstream idempotency key protects the external effect from that
-- sequence; it does nothing for PostgreSQL state.
--
-- Every state transition is now conditioned on
--   id + status = PROCESSING + processing_lease_token = <the claimer's token>
-- so only the worker that still owns the lease can write the outcome or its
-- audit row.

-- AlterTable
ALTER TABLE "decision_executions" ADD COLUMN "processing_lease_token" TEXT;

-- Existing PROCESSING rows have no token, so no worker can present one and
-- write their terminal state. That is the safe direction, and it strands
-- nothing: such a row is still reclaimable through the normal claim CAS
-- (which accepts PROCESSING with an expired or NULL lease), and that claim
-- issues a fresh token. Deliberately no token is invented for them here —
-- fabricating one would hand ownership to whichever worker happened to be
-- mid-flight at deploy time.
