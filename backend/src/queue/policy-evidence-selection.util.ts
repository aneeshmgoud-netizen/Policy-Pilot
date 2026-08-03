import {
  PolicyCitationReference,
  PolicyCitation,
} from '../agent/agent.types';
import { buildPolicyEvidenceSegments } from '../agent/policy-evidence';
import { RetrievedChunk } from '../rag/rag.service';

export type PolicyEvidenceSelectionRejectionReason =
  | 'UNKNOWN_SOURCE_ID'
  | 'DUPLICATE_SOURCE_ID';

export interface ValidatedCitation {
  policyChunkId: string;
  documentName: string;
  section: string | null;
  excerpt: string;
}

export interface RejectedPolicyEvidenceSelection {
  sourceId: string;
  reason: PolicyEvidenceSelectionRejectionReason;
}

export interface PolicyEvidenceSelectionSummary {
  proposedCount: number;
  validated: ValidatedCitation[];
  rejected: RejectedPolicyEvidenceSelection[];
}

export function sectionNumberOf(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return value.match(/\d+(?:\.\d+)*/)?.[0] ?? null;
}

export function sectionsMatch(
  citedSection: string,
  chunkSection: string | null,
): boolean {
  const citedNumber = sectionNumberOf(citedSection);
  const chunkNumber = sectionNumberOf(chunkSection);
  if (citedNumber !== null && chunkNumber !== null) {
    return citedNumber === chunkNumber;
  }
  if (citedNumber !== null || chunkNumber !== null) return false;
  return citedSection.trim().toLowerCase() === (chunkSection ?? '').trim().toLowerCase();
}

/**
 * Resolve model-selected Source IDs only against evidence segments derived
 * from chunks retrieved for this exact recommendation attempt. Citation text
 * and metadata are copied from those authoritative segments; none are read
 * from model output.
 */
export function validatePolicyEvidenceSelections(
  references: PolicyCitationReference[],
  chunks: RetrievedChunk[],
): PolicyEvidenceSelectionSummary {
  const available = new Map(
    buildPolicyEvidenceSegments(chunks).map((segment) => [
      segment.sourceId,
      segment,
    ]),
  );
  const validated: ValidatedCitation[] = [];
  const rejected: RejectedPolicyEvidenceSelection[] = [];
  const seenSourceIds = new Set<string>();

  for (const reference of references) {
    if (seenSourceIds.has(reference.source_id)) {
      rejected.push({
        sourceId: reference.source_id,
        reason: 'DUPLICATE_SOURCE_ID',
      });
      continue;
    }
    seenSourceIds.add(reference.source_id);

    const segment = available.get(reference.source_id);
    if (!segment) {
      rejected.push({
        sourceId: reference.source_id,
        reason: 'UNKNOWN_SOURCE_ID',
      });
      continue;
    }

    validated.push({
      policyChunkId: segment.policyChunkId,
      documentName: segment.documentName,
      section: segment.section,
      excerpt: segment.excerpt,
    });
  }

  return { proposedCount: references.length, validated, rejected };
}

export function toPolicyCitation(citation: ValidatedCitation): PolicyCitation {
  return {
    document_name: citation.documentName,
    section: citation.section ?? '',
    excerpt: citation.excerpt,
  };
}
