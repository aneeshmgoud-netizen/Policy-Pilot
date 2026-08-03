/**
 * The application's single content-free error boundary.
 *
 * Rationale (learned the hard way, across several rounds of partial fixes):
 * redaction denylists don't hold. Every attempt to scrub `err.message` — EMP-/
 * CC- patterns, then credentials, then URLs — left something through: internal
 * hostnames, unrecognized token shapes, query fragments, even the exception's
 * constructor name. The only reliable guarantee is never to read the exception
 * body at all, and the only way to keep that guarantee across many call sites
 * is to have exactly one place that catches.
 *
 * So: nothing derived from a caught exception may reach PostgreSQL, an audit
 * payload, an application log, a BullMQ job's failedReason/stacktrace, the
 * scheduler, or an API response. What callers get instead is a stable code
 * from their own fixed enum, plus whatever safe structured context they
 * already had in hand (ids, attempt counters, stage names, status flags).
 *
 * Detailed diagnostics are not available anywhere in this application, by
 * design. They belong in a restricted observability system with its own
 * access controls and retention policy, which the Prisma/HTTP/Redis clients
 * would report to directly. Correlate by the ids that appear in these logs.
 */

export type SafeResult<T, C extends string> =
  | { ok: true; value: T }
  | { ok: false; code: C };

/**
 * Runs `operation`, converting any thrown value into a failure carrying only
 * `code`.
 *
 * The `catch` binds no variable. That is the enforcement mechanism: there is
 * no identifier in scope that could be logged, serialized, attached as a
 * cause, or re-thrown, so leaking here is a syntax error rather than a
 * code-review question.
 */
export async function runContentFree<T, C extends string>(
  code: C,
  operation: () => Promise<T>,
): Promise<SafeResult<T, C>> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    return { ok: false, code };
  }
}

/**
 * Base class for errors that cross a framework boundary (a BullMQ worker
 * result, a Nest exception filter) where the framework will persist or print
 * whatever it receives.
 *
 * `message` must be built by the subclass from a fixed table keyed on `code` —
 * never interpolated from a caught exception — and `stack` is overwritten
 * rather than left to V8's capture, so no incidentally-embedded frame content
 * survives either. Nothing is attached as `cause`.
 */
export class SanitizedOperationalError extends Error {
  readonly code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.stack = `${name}: ${message}`;
  }
}
