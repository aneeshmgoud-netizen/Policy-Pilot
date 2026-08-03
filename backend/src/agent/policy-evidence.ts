import { AgentRetrievedChunk } from './agent.types';

// Short enough to keep a citation reviewable, long enough to preserve a
// complete policy sentence or compact bullet in the normal case.
export const MAX_POLICY_EVIDENCE_SEGMENT_LENGTH = 700;

export interface PolicyEvidenceSegment {
  sourceId: string;
  policyChunkId: string;
  documentName: string;
  section: string | null;
  excerpt: string;
}

/**
 * Split retrieved chunks into deterministic, exact source segments. Segment
 * text is always a literal substring of the stored chunk. IDs are stable
 * within the ordered evidence set for one recommendation attempt and are the
 * only policy citation values the model may return.
 */
export function buildPolicyEvidenceSegments(
  chunks: AgentRetrievedChunk[],
): PolicyEvidenceSegment[] {
  const segments: PolicyEvidenceSegment[] = [];
  for (const chunk of chunks) {
    for (const excerpt of splitExactSegments(chunk.content)) {
      segments.push({
        // Short ordinal ids are substantially easier for a small model to
        // select faithfully than UUID-derived strings. They are deterministic
        // within this exact, ordered retrieval attempt; the authoritative
        // chunk id never leaves the backend mapping.
        sourceId: `POLICY_SOURCE_${String(segments.length + 1).padStart(3, '0')}`,
        policyChunkId: chunk.id,
        documentName: chunk.documentName,
        section: chunk.section,
        excerpt,
      });
    }
  }
  return segments;
}

function splitExactSegments(content: string): string[] {
  const segments: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    while (cursor < content.length && /\s/.test(content[cursor])) cursor += 1;
    if (cursor >= content.length) break;

    const hardEnd = Math.min(
      cursor + MAX_POLICY_EVIDENCE_SEGMENT_LENGTH,
      content.length,
    );
    let end = hardEnd;

    if (hardEnd < content.length) {
      const window = content.slice(cursor, hardEnd + 1);
      const paragraphBoundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\r\n\r\n'),
      );
      const sentenceBoundary = lastSentenceBoundary(window);
      const lineBoundary = window.lastIndexOf('\n');
      const wordBoundary = window.lastIndexOf(' ');
      const relativeEnd =
        paragraphBoundary > 0
          ? paragraphBoundary
          : sentenceBoundary > 0
            ? sentenceBoundary
            : lineBoundary > 0
              ? lineBoundary
              : wordBoundary > 0
                ? wordBoundary
                : window.length;
      end = cursor + relativeEnd;
    }

    const excerpt = content.slice(cursor, end).trim();
    if (excerpt.length > 0) segments.push(excerpt);
    cursor = end;
  }

  return segments;
}

function lastSentenceBoundary(value: string): number {
  let boundary = -1;
  const pattern = /[.!?](?=\s|$)/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    boundary = match.index + 1;
  }
  return boundary;
}
