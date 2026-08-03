import { SanitizedOperationalError } from '../common/operational-error.util';

/**
 * Stable codes for access-request processing failures, named by the stage that
 * failed rather than by what went wrong inside it.
 *
 * These replace what this path used to persist and log: the exception's
 * message and full stack trace, PII-redacted. That redaction was never
 * sufficient — it masked EMP-/CC- identifiers and nothing else, so internal
 * hostnames, connection strings, model-provider URLs, and token-shaped values
 * all survived into `audit_log.payload` and the application log. Stack traces
 * additionally embed absolute file paths and, via frame arguments in some
 * runtimes, request data.
 *
 * The trade-off is deliberate and costly: this application no longer retains
 * diagnostics for these failures. Detailed exception data belongs in a
 * restricted observability system with explicit access and retention controls,
 * which the Prisma/LLM/HTTP clients would report to directly. Correlate by the
 * `requestId` and `stage` recorded here.
 */
export const PROCESSING_ERROR_CODES = {
  /** Loading the request and its entitlement snapshot failed. */
  ENTITLEMENT_LOAD_FAILED: 'ENTITLEMENT_LOAD_FAILED',
  /** Retrieval, generation, grounding, or persistence of the recommendation
   *  failed. */
  RECOMMENDATION_FAILED: 'RECOMMENDATION_FAILED',
  /** Recording a failure itself failed (a Prisma outage during bookkeeping). */
  FAILURE_BOOKKEEPING_FAILED: 'FAILURE_BOOKKEEPING_FAILED',
} as const;

export type ProcessingErrorCode =
  (typeof PROCESSING_ERROR_CODES)[keyof typeof PROCESSING_ERROR_CODES];

/**
 * The processing stage a failure occurred in — safe structured context, drawn
 * from a fixed set rather than from an exception.
 */
export const PROCESSING_STAGES = {
  LOAD_ENTITLEMENTS: 'LOAD_ENTITLEMENTS',
  GENERATE_RECOMMENDATION: 'GENERATE_RECOMMENDATION',
} as const;

export type ProcessingStage =
  (typeof PROCESSING_STAGES)[keyof typeof PROCESSING_STAGES];

const STAGE_CODES: Record<ProcessingStage, ProcessingErrorCode> = {
  LOAD_ENTITLEMENTS: PROCESSING_ERROR_CODES.ENTITLEMENT_LOAD_FAILED,
  GENERATE_RECOMMENDATION: PROCESSING_ERROR_CODES.RECOMMENDATION_FAILED,
};

/** Maps a stage to its stable code. Never inspects the thrown value. */
export function codeForStage(stage: ProcessingStage): ProcessingErrorCode {
  return STAGE_CODES[stage];
}

const PROCESSING_ERROR_MESSAGES: Record<ProcessingErrorCode, string> = {
  ENTITLEMENT_LOAD_FAILED:
    'Loading the access request and its entitlement snapshot failed. The ' +
    'request has not been assessed.',
  RECOMMENDATION_FAILED:
    'Generating or grounding the AI recommendation failed. No recommendation ' +
    'was persisted for this attempt.',
  FAILURE_BOOKKEEPING_FAILED:
    'Recording the processing failure did not complete. The request remains in ' +
    'its previous state.',
};

/** Fixed message for a code. Never derived from an exception. */
export function processingErrorMessage(code: ProcessingErrorCode): string {
  return PROCESSING_ERROR_MESSAGES[code];
}

/**
 * Thrown from AccessRequestProcessor.process() in place of the original
 * exception, so BullMQ's Redis-persisted failedReason/stacktrace carry only a
 * stable code. Retry semantics are unchanged: throwing at all is what keeps
 * BullMQ's attempts/backoff in control.
 */
export class SanitizedProcessingError extends SanitizedOperationalError {
  declare readonly code: ProcessingErrorCode;

  constructor(code: ProcessingErrorCode) {
    super(
      'SanitizedProcessingError',
      code,
      `Processing failed (${code}). ${processingErrorMessage(code)}`,
    );
  }
}
