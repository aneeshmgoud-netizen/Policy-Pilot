import { JobsOptions } from 'bullmq';

export const DECISION_EXECUTION_QUEUE = 'decision-execution';
export const DECISION_EXECUTION_JOB_NAME = 'execute-decision';

/**
 * How long a worker's claim on a row is honored. Written to
 * `processingLeaseExpiresAt` atomically with `status = PROCESSING`; once it
 * elapses, the row is reclaimable by any worker's CAS claim and eligible for
 * sweeper recovery.
 *
 * This must comfortably exceed the maximum time a single
 * ExecutionAdapter.execute() call can take, or two workers could hold the same
 * row concurrently — the lease would expire while the first is still inside
 * the downstream call. Two things keep that safe here:
 *
 *  1. The adapter must enforce its own timeout strictly below this value. The
 *     current ExecutionAdapter is an in-process mock that returns
 *     immediately, so the margin is total; a real HTTP/ITSM integration
 *     replacing it MUST set a request timeout (plus retry budget) under this
 *     bound, or renew the lease mid-flight. This is a documented constraint
 *     on that future integration, not something this module can enforce for it.
 *  2. Even if the bound were violated, overlap is not a correctness failure
 *     for the external effect: both attempts pass the same row id as the
 *     downstream idempotency key, which is what makes a replay a no-op. It
 *     would waste work, not double-apply it — assuming the downstream system
 *     honors the key (see the at-least-once caveat in ExecutionAdapter).
 */
export const PROCESSING_LEASE_DURATION_MS = 5 * 60_000;

/**
 * How long a sweeper replica's recovery ownership lasts. Deliberately shorter
 * than PROCESSING_LEASE_DURATION_MS: recovery is a handful of Redis calls plus
 * one audit insert, so a winner that dies mid-recovery should be replaceable
 * quickly rather than blocking the row for a full processing lease. It is
 * still long enough that a slow Redis round trip can't cause two replicas to
 * think they both own the row.
 *
 * Held from the CAS win until either the worker successfully claims the row
 * (claim() clears both leases) or this expiry passes.
 */
export const RECOVERY_LEASE_DURATION_MS = 60_000;

// How long a PENDING row may sit unenqueued (the Postgres-committed,
// Redis-never-enqueued dual-write gap) before the sweeper treats it as
// orphaned and re-enqueues it with the same deterministic jobId. PENDING rows
// have no processing lease — nobody holds them — so their age is the only
// available signal; `updatedAt` is safe to use for that here because the
// claim CAS accepts PENDING unconditionally, so no staleness comparison
// gates recovery of these rows. Repeat sweeps are prevented by the recovery
// lease, not by this threshold.
export const STALE_PENDING_THRESHOLD_MS = 2 * 60_000;

export const SWEEP_INTERVAL_MS = 60_000;

// PostgreSQL (the DecisionExecution row) is the durable execution record —
// not Redis. A terminal BullMQ job retained here provides no value and is
// actively harmful: it permanently reserves this job's deterministic jobId
// (== execution.id), so if a crash later leaves the row stuck
// PENDING/PROCESSING, DecisionExecutionSweeperService's re-add with that same
// jobId would silently no-op against the stale completed/failed job instead
// of creating new runnable work. Exported as a standalone constant (rather
// than inlined in DecisionsModule's registerQueue call) so the terminal-job
// removal settings are directly unit-testable without bootstrapping Nest DI.
export const DECISION_EXECUTION_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  removeOnComplete: true,
  removeOnFail: true,
};
