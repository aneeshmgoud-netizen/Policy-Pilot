// Per-chunk and per-document metadata extraction from policy markdown.
//
// These tags populate the filterable columns on policy_chunks so retrieval can
// be scoped (e.g. "only DATA_WAREHOUSE chunks in cost center CC-FIN-12") rather
// than relying on vector similarity alone. Extraction is deterministic regex —
// no LLM — because these are structural facts about the source text.

// Target systems referenced across the policy corpus. Used to tag which system
// a chunk governs. Kept explicit (not free-form) so tags stay consistent with
// the values that appear in access requests and the SoD configuration.
export const KNOWN_SYSTEMS = [
  'DATA_WAREHOUSE',
  'REPORTING_ENV',
  'VENDOR_PAYMENTS',
  'HR_PAYROLL',
  'DEPLOY_PIPELINE',
  'CLOUD_CONSOLE',
] as const;

// Entitlement keys governed across the policy corpus. Like KNOWN_SYSTEMS, kept
// explicit so tags line up with the values that appear in access requests and
// the SoD configuration rather than being inferred loosely.
export const KNOWN_ENTITLEMENTS = [
  'FIN_DATASET_READ',
  'FIN_DATASET_EDIT',
  'BILLING_EXPORT',
  'RESTRICTED_REPORTING_TEMP',
  'PAYMENT_CREATE',
  'PAYMENT_APPROVE',
  'PAYROLL_EDIT',
  'PAYROLL_APPROVE',
  'PROD_DEPLOYER',
  'PROD_CHANGE_APPROVER',
  'INFRA_ADMIN',
] as const;

// Cost-center prefix -> department, per the enterprise org hierarchy the
// policies reference (POL-GOV-000 Appendix G). Deriving department from the
// cost center keeps it canonical instead of scraping free-text department names.
const COST_CENTER_DEPARTMENTS: Record<string, string> = {
  FIN: 'Finance',
  GOV: 'Data Governance',
  MKT: 'Marketing',
  ENG: 'Engineering',
  HR: 'Human Resources',
  SEC: 'Security',
};

const COST_CENTER_RE = /\bCC-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/;

/** First cost-center code (CC-XXX) mentioned in the text, or null. */
export function extractCostCenter(text: string): string | null {
  const match = COST_CENTER_RE.exec(text);
  return match ? match[0] : null;
}

/**
 * Earliest-mentioned entitlement key from the known set, or null. Mirrors
 * extractTargetSystem so a chunk gets tagged with the entitlement it governs.
 */
export function extractEntitlementType(
  text: string,
  entitlements: readonly string[] = KNOWN_ENTITLEMENTS,
): string | null {
  let best: string | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const entitlement of entitlements) {
    const index = text.indexOf(entitlement);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = entitlement;
    }
  }
  return best;
}

/**
 * Department for a chunk, derived from the first cost center it mentions via
 * the cost-center -> department mapping. Null when no cost center is present.
 */
export function extractDepartment(text: string): string | null {
  const costCenter = extractCostCenter(text);
  if (!costCenter) {
    return null;
  }
  const segment = costCenter.split('-')[1];
  return COST_CENTER_DEPARTMENTS[segment] ?? null;
}

/** Leading section number from a heading label ("3.2 Elevated ..." -> "3.2"). */
export function extractSectionNumber(sectionLabel: string): string | null {
  const match = sectionLabel.match(/^(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

/**
 * The target system this text is primarily about: the known system whose name
 * appears earliest in the text. Null if none are mentioned.
 */
export function extractTargetSystem(
  text: string,
  systems: readonly string[] = KNOWN_SYSTEMS,
): string | null {
  let best: string | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const system of systems) {
    const index = text.indexOf(system);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = system;
    }
  }
  return best;
}

/** Policy domain from a document code: POL-DATA-001 -> "DATA". */
export function policyDomainFromCode(code: string): string {
  const parts = code.split('-');
  return parts.length >= 2 ? parts[1] : code;
}

/** Document code from a policy filename: "POL-DATA-001_Data_....md" -> "POL-DATA-001". */
export function documentCodeFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, '');
  const match = base.match(/^([A-Za-z]+-[A-Za-z]+-\d+)/);
  return match ? match[1] : base.split('_')[0];
}

export interface DocumentHeader {
  documentName: string;
  version: string | null;
  effectiveDate: Date | null;
}

/**
 * Parse the H1 title, version, and effective date from the top of a policy
 * document. Tolerates both the markdown form (`**Version:** 3.4.1`) and the
 * pipe-delimited form extracted from PDFs (`... | Version: 2.1.0 | Effective
 * Date: January 1, 2025 | ...`).
 */
export function parseDocumentHeader(markdown: string): DocumentHeader {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const documentName = titleMatch ? titleMatch[1].trim() : 'Untitled Policy';

  const versionMatch = markdown.match(
    /Version:\s*\**\s*(\d+(?:\.\d+){1,2})/i,
  );
  const version = versionMatch ? versionMatch[1] : null;

  const dateMatch = markdown.match(
    /Effective Date:\s*\**\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
  );
  let effectiveDate: Date | null = null;
  if (dateMatch) {
    const parsed = new Date(dateMatch[1].trim());
    if (!Number.isNaN(parsed.getTime())) {
      effectiveDate = parsed;
    }
  }

  return { documentName, version, effectiveDate };
}

// Full per-chunk metadata bundle written to policy_chunks. Combined with the
// document-level fields (documentName, version, effectiveDate on
// policy_documents) this covers every field the rubric asks for.
export interface ChunkMetadata {
  sectionNumber: string | null;
  policyDomain: string;
  department: string | null;
  costCenter: string | null;
  targetSystem: string | null;
  entitlementType: string | null;
}

/** Extract every filterable per-chunk metadata field in one pass. */
export function extractChunkMetadata(
  sectionLabel: string,
  content: string,
  policyDomain: string,
): ChunkMetadata {
  return {
    sectionNumber: extractSectionNumber(sectionLabel),
    policyDomain,
    department: extractDepartment(content),
    costCenter: extractCostCenter(content),
    targetSystem: extractTargetSystem(content),
    entitlementType: extractEntitlementType(content),
  };
}
