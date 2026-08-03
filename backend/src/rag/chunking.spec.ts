import {
  Tokenizer,
  chunkMarkdown,
  parseSections,
} from './chunking';

// Reversible word-based tokenizer: one token per whitespace-delimited word.
// Deterministic and exactly reversible, so window math is verifiable without
// pulling in the real BPE tokenizer.
function makeWordTokenizer(): Tokenizer {
  const vocab: string[] = [];
  const index = new Map<string, number>();
  const idFor = (word: string): number => {
    if (!index.has(word)) {
      index.set(word, vocab.length);
      vocab.push(word);
    }
    return index.get(word) as number;
  };
  return {
    encode: (text) =>
      text
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map(idFor),
    decode: (tokens) => tokens.map((id) => vocab[id]).join(' '),
  };
}

const SAMPLE = `# POL-TEST-001: Sample Policy

**Version:** 1.2.3

## 1. Overview

This is the overview body.

## 2. Container

### 2.1 First Sub

First sub body text.

### 2.2 Second Sub

Second sub body text.
`;

describe('parseSections', () => {
  it('captures the H1/metadata block as the Document Header section', () => {
    const sections = parseSections(SAMPLE);
    expect(sections[0].label).toBe('Document Header');
    expect(sections[0].body).toContain('# POL-TEST-001: Sample Policy');
    expect(sections[0].body).toContain('**Version:** 1.2.3');
  });

  it('splits on H2 and H3 headings', () => {
    const labels = parseSections(SAMPLE).map((s) => s.label);
    expect(labels).toEqual([
      'Document Header',
      '1. Overview',
      '2.1 First Sub',
      '2.2 Second Sub',
    ]);
  });

  it('drops heading-only sections with no body (e.g. "2. Container")', () => {
    const labels = parseSections(SAMPLE).map((s) => s.label);
    expect(labels).not.toContain('2. Container');
  });
});

describe('chunkMarkdown', () => {
  const tokenizer = makeWordTokenizer();

  it('emits one chunk per section when every section fits, with sequential indexes', () => {
    const chunks = chunkMarkdown(SAMPLE, tokenizer, {
      maxTokens: 500,
      overlapTokens: 50,
    });
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.section)).toEqual([
      'Document Header',
      '1. Overview',
      '2.1 First Sub',
      '2.2 Second Sub',
    ]);
  });

  it('prefixes each chunk with its section heading', () => {
    const chunks = chunkMarkdown(SAMPLE, tokenizer, {
      maxTokens: 500,
      overlapTokens: 50,
    });
    const overview = chunks.find((c) => c.section === '1. Overview');
    expect(overview?.content).toBe('1. Overview\n\nThis is the overview body.');
  });

  it('windows an over-long section with the configured overlap', () => {
    // A section body of 12 words, window 5, overlap 2 -> step 3.
    // Windows start at 0,3,6,9 -> tokens [0-5),[3-8),[6-11),[9-12) = 4 chunks.
    const body = 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11';
    const markdown = `## S1 Heading\n\n${body}\n`;
    const chunks = chunkMarkdown(markdown, tokenizer, {
      maxTokens: 5,
      overlapTokens: 2,
    });

    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => c.section === 'S1 Heading')).toBe(true);

    // Strip the "S1 Heading\n\n" prefix to inspect the windowed body text.
    const bodies = chunks.map((c) => c.content.replace('S1 Heading\n\n', ''));
    expect(bodies[0]).toBe('w0 w1 w2 w3 w4');
    expect(bodies[1]).toBe('w3 w4 w5 w6 w7');
    expect(bodies[2]).toBe('w6 w7 w8 w9 w10');
    expect(bodies[3]).toBe('w9 w10 w11');

    // Adjacent windows overlap by exactly `overlapTokens` words.
    expect(bodies[0].split(' ').slice(-2)).toEqual(bodies[1].split(' ').slice(0, 2));
  });

  it('rejects invalid overlap/window configuration', () => {
    expect(() =>
      chunkMarkdown(SAMPLE, tokenizer, { maxTokens: 5, overlapTokens: 5 }),
    ).toThrow();
    expect(() =>
      chunkMarkdown(SAMPLE, tokenizer, { maxTokens: 0, overlapTokens: 0 }),
    ).toThrow();
  });

  it('preserves source typography in stored chunk content', () => {
    const markdown =
      '## 3.1 Standard Read Access\n\n' +
      'Employees in cost centers—specifically Finance Analytics (`CC-FIN-07`) ' +
      'and Finance Operations (`CC-FIN-12`)—may request access using “standard” approval.\n';
    const chunks = chunkMarkdown(markdown, tokenizer, {
      maxTokens: 500,
      overlapTokens: 50,
    });

    expect(chunks[0].content).toContain('cost centers—specifically');
    expect(chunks[0].content).toContain('`CC-FIN-07`');
    expect(chunks[0].content).toContain('`CC-FIN-12`');
    expect(chunks[0].content).toContain('“standard”');
  });
});
