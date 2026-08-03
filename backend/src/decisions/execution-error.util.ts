import {
  runContentFree as sharedRunContentFree,
  SafeResult as SharedSafeResult,
  SanitizedOperationalError,
} from '../common/operational-error.util';

// Thrown by ExecutionAdapter (or anything it wraps) to signal an error BullMQ
// should not retry — e.g. the downstream system rejected the request as
// permanently invalid. Anything else thrown is treated as retryable.
//
// Note: the message passed here is for the thrower's own use only. Nothing in
// this module ever reads it — see classifyExecutionError below.
export class NonRetryableExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableExecutionError';
  }
}

/**
 * The complete set of stable execution error codes. Every failure surface —
 * `decision_executions.last_error`/`error_code`, audit payloads, application
 * logs, the reviewer-facing API, and BullMQ's own failedReason/stacktrace —
 * carries one of these and nothing else.
 */
export const EXECUTION_ERROR_CODES = {
  /** The downstream system permanently rejected the request (not retryable). */
  DOWNSTREAM_REJECTED: 'DOWNSTREAM_REJECTED',
  /** The downstream call failed in a way worth retrying. */
  DOWNSTREAM_EXECUTION_FAILED: 'DOWNSTREAM_EXECUTION_FAILED',
  /** The CAS claim query itself failed (DB/Prisma outage). */
  EXECUTION_CLAIM_FAILED: 'EXECUTION_CLAIM_FAILED',
  /** Recording the outcome failed after the claim (and possibly after the
   *  external effect already happened). */
  EXECUTION_BOOKKEEPING_FAILED: 'EXECUTION_BOOKKEEPING_FAILED',
} as const;

export type ExecutionErrorCode =
  (typeof EXECUTION_ERROR_CODES)[keyof typeof EXECUTION_ERROR_CODES];

export const EXECUTION_CLAIM_FAILED_CODE =
  EXECUTION_ERROR_CODES.EXECUTION_CLAIM_FAILED;
export const EXECUTION_BOOKKEEPING_FAILED_CODE =
  EXECUTION_ERROR_CODES.EXECUTION_BOOKKEEPING_FAILED;

// Fixed operator-facing text, one entry per code. These are constants, not
// templates — nothing derived from an exception is ever interpolated in.
const EXECUTION_ERROR_MESSAGES: Record<ExecutionErrorCode, string> = {
  DOWNSTREAM_REJECTED:
    'The downstream provisioning system permanently rejected this execution. ' +
    'It will not be retried automatically.',
  DOWNSTREAM_EXECUTION_FAILED:
    'The downstream provisioning call failed. It will be retried until the ' +
    'attempt budget is exhausted.',
  EXECUTION_CLAIM_FAILED:
    'The execution could not be claimed because a database operation failed. ' +
    'No external effect was attempted; it remains claimable.',
  EXECUTION_BOOKKEEPING_FAILED:
    'The execution outcome could not be recorded because a database operation ' +
    'failed. The row stays claimable and is recovered by the stale-execution ' +
    'sweep; the downstream idempotency key makes a replay safe.',
};

/** Fixed message for a code. Never derived from an exception. */
export function executionErrorMessage(code: ExecutionErrorCode): string {
  return EXECUTION_ERROR_MESSAGES[code];
}

export interface ClassifiedExecutionError {
  code: ExecutionErrorCode;
  message: string;
}

/**
 * Stable codes for the operational steps around execution: stale-execution
 * recovery, and the initial outbox enqueue. Each names *which step* failed —
 * never why, since "why" only exists inside an exception body the shared
 * boundary refuses to read.
 */
export const OPERATIONAL_ERROR_CODES = {
  RECOVERY_SCAN_FAILED: 'RECOVERY_SCAN_FAILED',
  RECOVERY_CAS_FAILED: 'RECOVERY_CAS_FAILED',
  RECOVERY_OWNERSHIP_LOST: 'RECOVERY_OWNERSHIP_LOST',
  RECOVERY_JOB_INSPECT_FAILED: 'RECOVERY_JOB_INSPECT_FAILED',
  RECOVERY_JOB_REMOVE_FAILED: 'RECOVERY_JOB_REMOVE_FAILED',
  RECOVERY_ENQUEUE_FAILED: 'RECOVERY_ENQUEUE_FAILED',
  RECOVERY_AUDIT_FAILED: 'RECOVERY_AUDIT_FAILED',
  RECOVERY_ROW_FAILED: 'RECOVERY_ROW_FAILED',
  RECOVERY_SWEEP_FAILED: 'RECOVERY_SWEEP_FAILED',
  /** The post-commit enqueue in DecisionsService failed; the row stays
   *  PENDING for the sweeper to pick up. */
  INITIAL_EXECUTION_ENQUEUE_FAILED: 'INITIAL_EXECUTION_ENQUEUE_FAILED',
  /** The best-effort post-commit precedent ingestion enqueue failed. */
  INITIAL_PRECEDENT_ENQUEUE_FAILED: 'INITIAL_PRECEDENT_ENQUEUE_FAILED',
  /** A state write was rejected because this worker no longer owns the
   *  processing lease — another worker reclaimed the row. */
  EXECUTION_LEASE_LOST: 'EXECUTION_LEASE_LOST',
} as const;

export type OperationalErrorCode =
  (typeof OPERATIONAL_ERROR_CODES)[keyof typeof OPERATIONAL_ERROR_CODES];

export type SafeResult<T> = SharedSafeResult<T, OperationalErrorCode>;

// Re-exported so existing call sites in this module's domain keep a single
// import, while the implementation lives in one shared place — see
// common/operational-error.util.ts for why there is exactly one `catch`.
export const runContentFree = sharedRunContentFree;

/**
 * Reduce an arbitrary thrown value to a stable code plus that code's fixed
 * message — deliberately WITHOUT reading `err.message`, `err.stack`,
 * `err.cause`, or any other property that could carry exception-derived text.
 * The only thing inspected is the value's *type* (is it a
 * NonRetryableExecutionError?), which is what decides retry semantics.
 *
 * This is stricter than redaction on purpose. An earlier version of this
 * module regex-scrubbed credentials and EMP-/CC- identifiers out of
 * `err.message` and persisted the remainder, which still let through internal
 * hostnames, unrecognized URL/token shapes, and query fragments — a redaction
 * denylist can never be complete against arbitrary downstream error text. The
 * only way to guarantee `decision_executions.last_error`, audit payloads,
 * logs, the API, and BullMQ's Redis-persisted failedReason are all
 * content-free is never to read the exception body in the first place.
 *
 * Consequence, stated plainly: raw exception detail is *not* available
 * anywhere in this application. That is the intended trade-off. Detailed
 * diagnostics for these failures belong in a separately secured
 * observability integration (an APM/error tracker with its own access
 * controls, retention limits, and PII policy) that the downstream HTTP client
 * or Prisma layer reports to directly — not in this application's logs,
 * database, or queue state. Correlate by `executionId` (safe, non-sensitive,
 * and present in every audit row and log line here).
 */
export function classifyExecutionError(err: unknown): ClassifiedExecutionError {
  const code: ExecutionErrorCode =
    err instanceof NonRetryableExecutionError
      ? EXECUTION_ERROR_CODES.DOWNSTREAM_REJECTED
      : EXECUTION_ERROR_CODES.DOWNSTREAM_EXECUTION_FAILED;
  return { code, message: executionErrorMessage(code) };
}

/**
 * Thrown by DecisionExecutionProcessor.process() at its outer boundary so
 * BullMQ — which persists a caught error's message and stack verbatim as
 * failedReason/stacktrace in Redis, including across retries — never
 * receives anything derived from the original downstream/Prisma exception.
 * The message comes solely from the code's fixed table entry, and `stack` is
 * fully overridden (rather than left to V8's default capture) so no
 * incidentally-embedded frame content can leak either.
 */
export class SanitizedRetryableExecutionError extends SanitizedOperationalError {
  declare readonly code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode) {
    super(
      'SanitizedRetryableExecutionError',
      code,
      `Execution failed (${code}). ${executionErrorMessage(code)}`,
    );
  }
}
