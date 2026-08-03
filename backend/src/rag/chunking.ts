// Structure-aware chunking for policy markdown.
//
// Naive fixed-window chunking shreds a policy mid-clause and loses the section
// heading a reader (or an LLM citing the chunk) needs for context. Instead we
// split on markdown headings first, then only token-window a section if it
// exceeds the target size. Most policy sections fit in one chunk; long ones are
// windowed with overlap so a rule that straddles a boundary survives in at
// least one chunk intact.

// Token abstraction so the chunker stays pure and unit-testable. The ingest
// script injects a real tokenizer (gpt-tokenizer, cl100k/o200k); tests inject a
// trivial reversible word tokenizer.
export interface Tokenizer {
  encode(text: string): number[];
  decode(tokens: number[]): string;
}

export interface ChunkOptions {
  /** Target maximum tokens per chunk. */
  maxTokens: number;
  /** Tokens of overlap between adjacent windows of an over-long section. */
  overlapTokens: number;
}

export interface RawChunk {
  chunkIndex: number;
  /** Heading label of the section this chunk came from. */
  section: string;
  /** Chunk text: the section heading followed by (a window of) its body. */
  content: string;
}

interface Section {
  /** Heading text without the leading `#`s, e.g. "3.2 Elevated Write ...". */
  label: string;
  /** Body text under the heading, excluding the heading line itself. */
  body: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Split policy markdown into sections keyed by their `##`/`###` headings.
 * Everything before the first `##` (the H1 title + metadata block) becomes a
 * single "Document Header" section. Sections whose body is empty (a heading
 * that only introduces sub-headings) are dropped so we don't emit heading-only
 * chunks.
 */
export function parseSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let label = 'Document Header';
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body.length > 0) {
      sections.push({ label, body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    // Start a new section on H2/H3 headings. H1 and deeper (####+) stay as body
    // so the title lands in the header section and rare deep headings don't
    // fragment a section.
    if (heading && (heading[1].length === 2 || heading[1].length === 3)) {
      flush();
      label = heading[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Chunk policy markdown into ~maxTokens windows, section by section. A section
 * that fits becomes one chunk; an over-long section is split into overlapping
 * windows. Each chunk's `content` is prefixed with its section heading so the
 * heading travels with the text into the embedding and the stored excerpt.
 */
export function chunkMarkdown(
  markdown: string,
  tokenizer: Tokenizer,
  options: ChunkOptions,
): RawChunk[] {
  const { maxTokens, overlapTokens } = options;
  if (maxTokens <= 0) {
    throw new Error('maxTokens must be positive');
  }
  if (overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('overlapTokens must be >= 0 and < maxTokens');
  }

  const step = maxTokens - overlapTokens;
  const chunks: RawChunk[] = [];
  let chunkIndex = 0;
  for (const section of parseSections(markdown)) {
    const tokens = tokenizer.encode(section.body);

    if (tokens.length <= maxTokens) {
      chunks.push({
        chunkIndex: chunkIndex++,
        section: section.label,
        content: `${section.label}\n\n${section.body}`.trim(),
      });
      continue;
    }

    for (let start = 0; start < tokens.length; start += step) {
      const window = tokens.slice(start, start + maxTokens);
      const windowText = tokenizer.decode(window).trim();
      chunks.push({
        chunkIndex: chunkIndex++,
        section: section.label,
        content: `${section.label}\n\n${windowText}`.trim(),
      });
      if (start + maxTokens >= tokens.length) {
        break;
      }
    }
  }

  return chunks;
}
