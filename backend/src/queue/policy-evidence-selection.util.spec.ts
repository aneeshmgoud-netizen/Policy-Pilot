import { RetrievedChunk } from '../rag/rag.service';
import {
  sectionsMatch,
  validatePolicyEvidenceSelections,
} from './policy-evidence-selection.util';

const CHUNKS: RetrievedChunk[] = [
  {
    id: 'chunk-1',
    documentName: 'POL-DATA-001',
    section: '§ 3.1 Standard Access',
    content: 'Employees in CC-FIN-07 may request baseline read access.',
    similarity: 0.91,
  },
];

describe('validatePolicyEvidenceSelections', () => {
  it('copies citation text and metadata from the selected retrieved source', () => {
    const summary = validatePolicyEvidenceSelections(
      [{ source_id: 'POLICY_SOURCE_001' }],
      CHUNKS,
    );

    expect(summary.rejected).toEqual([]);
    expect(summary.validated).toEqual([
      {
        policyChunkId: 'chunk-1',
        documentName: 'POL-DATA-001',
        section: '§ 3.1 Standard Access',
        excerpt: CHUNKS[0].content,
      },
    ]);
  });

  it('rejects a source id that was not generated from retrieved chunks', () => {
    const summary = validatePolicyEvidenceSelections(
      [{ source_id: 'POLICY_SOURCE_999' }],
      CHUNKS,
    );

    expect(summary.validated).toEqual([]);
    expect(summary.rejected).toEqual([
      { sourceId: 'POLICY_SOURCE_999', reason: 'UNKNOWN_SOURCE_ID' },
    ]);
  });

  it('rejects duplicate source selections', () => {
    const summary = validatePolicyEvidenceSelections(
      [
        { source_id: 'POLICY_SOURCE_001' },
        { source_id: 'POLICY_SOURCE_001' },
      ],
      CHUNKS,
    );

    expect(summary.validated).toHaveLength(1);
    expect(summary.rejected).toEqual([
      { sourceId: 'POLICY_SOURCE_001', reason: 'DUPLICATE_SOURCE_ID' },
    ]);
  });
});

describe('sectionsMatch', () => {
  it('matches equivalent numeric section labels', () => {
    expect(sectionsMatch('3.1', '§ 3.1 Standard Access')).toBe(true);
  });

  it('rejects different section numbers', () => {
    expect(sectionsMatch('3.2', '§ 3.1 Standard Access')).toBe(false);
  });
});
