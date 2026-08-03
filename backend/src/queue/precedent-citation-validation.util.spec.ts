import { PrecedentCitation } from '../agent/agent.types';
import { RetrievedPrecedent } from '../precedents/precedent-retrieval.service';
import { validatePrecedentCitations } from './precedent-citation-validation.util';

const PRECEDENT: RetrievedPrecedent = {
  id: 'precedent-1',
  summary: 'Finance approved PAYMENT_CREATE for a time-boxed vendor migration.',
  outcome: 'GRANT',
  targetSystem: 'VENDOR_PAYMENTS',
  entitlementKey: 'PAYMENT_CREATE',
  department: 'Finance',
  costCenter: 'CC-FIN-12',
  policyVersionSnapshot: [],
  createdAt: new Date('2026-07-30T12:00:00.000Z'),
  similarity: 0.91,
};

describe('validatePrecedentCitations', () => {
  it('validates a retrieved id and copies authoritative summary/outcome snapshots', () => {
    expect(
      validatePrecedentCitations(
        [
          {
            precedent_id: 'precedent-1',
            relevance_reason: 'Same entitlement and a comparable migration need.',
          },
        ],
        [PRECEDENT],
      ),
    ).toEqual({
      proposedCount: 1,
      validated: [
        {
          precedentRecordId: 'precedent-1',
          relevanceReason: 'Same entitlement and a comparable migration need.',
          summarySnapshot: PRECEDENT.summary,
          outcomeSnapshot: 'GRANT',
        },
      ],
      rejected: [],
    });
  });

  it('rejects an id that was not retrieved for this attempt', () => {
    const citations: PrecedentCitation[] = [
      { precedent_id: 'invented', relevance_reason: 'Looks similar.' },
    ];
    expect(validatePrecedentCitations(citations, [PRECEDENT]).rejected).toEqual([
      { precedentId: 'invented', reason: 'UNKNOWN_PRECEDENT' },
    ]);
  });

  it('rejects an empty or whitespace-only relevance reason', () => {
    const citations: PrecedentCitation[] = [
      { precedent_id: 'precedent-1', relevance_reason: '   ' },
    ];
    expect(validatePrecedentCitations(citations, [PRECEDENT]).rejected).toEqual([
      { precedentId: 'precedent-1', reason: 'EMPTY_RELEVANCE_REASON' },
    ]);
  });

  it('silently deduplicates repeated citations to the same precedent', () => {
    const citations: PrecedentCitation[] = [
      { precedent_id: 'precedent-1', relevance_reason: 'First reason.' },
      { precedent_id: 'precedent-1', relevance_reason: 'Redundant reason.' },
    ];
    const result = validatePrecedentCitations(citations, [PRECEDENT]);
    expect(result.proposedCount).toBe(2);
    expect(result.validated).toHaveLength(1);
    expect(result.validated[0].relevanceReason).toBe('First reason.');
    expect(result.rejected).toEqual([]);
  });
});
