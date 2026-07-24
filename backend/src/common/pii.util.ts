// PII masking for logs, audit payloads, and telemetry.
//
// CLAUDE.md requires that employee IDs (EMP-XXXXX) and cost-center codes
// (CC-XXXXX) never appear in the clear in any application log or audit payload.
// FK columns (e.g. audit_log.access_request_id) stay unmasked so an operator
// can always join a masked audit row back to the originating request and, from
// there, to the authoritative unmasked value on the access_requests row.
//
// Masking keeps the type-identifying prefix (up to and including the first
// hyphen) and the final two characters for coarse correlation, and replaces the
// middle with asterisks:
//   EMP-52190 -> EMP-***90
//   CC-FIN-07 -> CC-****07

const VISIBLE_SUFFIX = 2;

/**
 * Mask a structured identifier, preserving its prefix and a short suffix.
 * Returns the input unchanged for null/undefined so it is safe to apply to
 * optional fields.
 */
export function maskIdentifier<T extends string | null | undefined>(value: T): T {
  if (value == null || value === '') {
    return value;
  }

  const firstHyphen = value.indexOf('-');
  const prefix = firstHyphen >= 0 ? value.slice(0, firstHyphen + 1) : '';
  const body = value.slice(prefix.length);

  if (body.length <= VISIBLE_SUFFIX) {
    return (prefix + '*'.repeat(body.length)) as T;
  }

  const masked =
    '*'.repeat(body.length - VISIBLE_SUFFIX) + body.slice(body.length - VISIBLE_SUFFIX);
  return (prefix + masked) as T;
}

/** Mask an employee ID (EMP-XXXXX) for logs and audit payloads. */
export const maskEmployeeId = maskIdentifier;

/** Mask a cost-center code (CC-XXXXX) for logs and audit payloads. */
export const maskCostCenter = maskIdentifier;

// Defense-in-depth redaction for text/objects whose shape isn't known ahead of
// time — error messages, stack traces, raw payloads. Call-site masking above
// (maskEmployeeId/maskCostCenter on a known field) is preferred where the
// field is known; these scan arbitrary content for the id patterns themselves
// so a value that unexpectedly ends up in a log line or error message still
// gets masked rather than silently slipping through in the clear.
const EMP_ID_PATTERN = /\bEMP-\w[\w-]*/g;
const COST_CENTER_PATTERN = /\bCC-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;

/** Mask every EMP-/CC- identifier found anywhere within free text. */
export function redactPiiInText(text: string): string {
  return text
    .replace(EMP_ID_PATTERN, (match) => maskIdentifier(match))
    .replace(COST_CENTER_PATTERN, (match) => maskIdentifier(match));
}

/**
 * Recursively mask EMP-/CC- identifiers anywhere inside a value — plain
 * strings, and strings nested in objects/arrays. Non-string primitives, Date,
 * and other non-plain-object values pass through unchanged. Intended for
 * logging arbitrary payloads/objects safely, not for values persisted as
 * structured data (use the field-level maskEmployeeId/maskCostCenter there).
 */
export function maskPii<T>(value: T): T {
  if (typeof value === 'string') {
    return redactPiiInText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskPii(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const masked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      masked[key] = maskPii(entry);
    }
    return masked as T;
  }
  return value;
}
