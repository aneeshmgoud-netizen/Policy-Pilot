import { PrecedentCitation } from '../agent/agent.types';
import { RetrievedPrecedent } from '../precedents/precedent-retrieval.service';

export type PrecedentCitationRejectionReason =
  | 'UNKNOWN_PRECEDENT'
  | 'EMPTY_RELEVANCE_REASON';

export interface ValidatedPrecedentCitation {
  precedentRecordId: string;
  relevanceReason: string;
  // Authoritative snapshots are copied from the retrieved record, never from
  // model-authored text.
  summarySnapshot: string;
  outcomeSnapshot: string;
}

export interface RejectedPrecedentCitation {
  precedentId: string;
  reason: PrecedentCitationRejectionReason;
}

export interface PrecedentCitationValidationSummary {
  proposedCount: number;
  validated: ValidatedPrecedentCitation[];
  rejected: RejectedPrecedentCitation[];
}

export function validatePrecedentCitations(
  citations: PrecedentCitation[],
  retrievedPrecedents: RetrievedPrecedent[],
): PrecedentCitationValidationSummary {
  const validated: ValidatedPrecedentCitation[] = [];
  const rejected: RejectedPrecedentCitation[] = [];
  const seenPrecedentIds = new Set<string>();

  for (const citation of citations) {
    if (citation.relevance_reason.trim().length === 0) {
      rejected.push({
        precedentId: citation.precedent_id,
        reason: 'EMPTY_RELEVANCE_REASON',
      });
      continue;
    }

    const match = retrievedPrecedents.find(
      (precedent) => precedent.id === citation.precedent_id,
    );
    if (!match) {
      rejected.push({
        precedentId: citation.precedent_id,
        reason: 'UNKNOWN_PRECEDENT',
      });
      continue;
    }

    if (seenPrecedentIds.has(match.id)) {
      continue; // redundant, not invalid
    }
    seenPrecedentIds.add(match.id);
    validated.push({
      precedentRecordId: match.id,
      relevanceReason: citation.relevance_reason,
      summarySnapshot: match.summary,
      outcomeSnapshot: match.outcome,
    });
  }

  return { proposedCount: citations.length, validated, rejected };
}
