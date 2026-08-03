import {
  buildPolicyEvidenceSegments,
  MAX_POLICY_EVIDENCE_SEGMENT_LENGTH,
} from './policy-evidence';

describe('buildPolicyEvidenceSegments', () => {
  it('creates stable ids and preserves authoritative text exactly', () => {
    const chunks = [
      {
        id: 'chunk-1',
        documentName: 'POL-DATA-001',
        section: '3.1',
        content: 'First exact sentence. Second exact sentence.',
      },
    ];

    expect(buildPolicyEvidenceSegments(chunks)).toEqual([
      {
        sourceId: 'POLICY_SOURCE_001',
        policyChunkId: 'chunk-1',
        documentName: 'POL-DATA-001',
        section: '3.1',
        excerpt: 'First exact sentence. Second exact sentence.',
      },
    ]);
  });

  it('splits long content without inventing or rewriting text', () => {
    const first = `${'A'.repeat(350)}.`;
    const second = `${'B'.repeat(350)}.`;
    const content = `${first} ${second}`;
    const segments = buildPolicyEvidenceSegments([
      {
        id: 'chunk-long',
        documentName: 'POL-LONG',
        section: '1',
        content,
      },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.excerpt)).toEqual([first, second]);
    expect(segments.every((segment) => content.includes(segment.excerpt))).toBe(true);
    expect(
      segments.every(
        (segment) =>
          segment.excerpt.length <= MAX_POLICY_EVIDENCE_SEGMENT_LENGTH,
      ),
    ).toBe(true);
  });
});
