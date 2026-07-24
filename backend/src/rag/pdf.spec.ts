import { Tokenizer, chunkMarkdown } from './chunking';

// Mock pdf-parse so the test needs no real PDF binary: PDFParse().getText()
// returns a fixed text layer resembling what pdf-parse emits for a policy PDF
// (plain numbered headings, pipe-delimited metadata, a numbered list item).
const MOCK_PDF_TEXT = [
  'POL-FIN-003: Financial Systems and Payroll Separation of Duties Policy',
  'Document Reference: POL-FIN-003 | Version: 2.1.0 | Effective Date: January 1, 2025 | Classification: Confidential',
  '2. Vendor Disbursement Access Protocol (VENDOR_PAYMENTS)',
  'Body text about vendor payments and PAYMENT_CREATE.',
  '2.1 Operational Architecture and Entry Entitlements (PAYMENT_CREATE)',
  'Requests for PAYMENT_CREATE require managerial approval.',
  '1. Individual User Accounts: Assigned exclusively to specific full-time employees and contractors across the enterprise environment.',
].join('\n');

jest.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(_opts: unknown) {}
    async getText() {
      return { text: MOCK_PDF_TEXT, pages: [], total: 1 };
    }
    async destroy() {}
  },
}));

// Import after the mock is registered.
import { extractPdfText, pdfTextToMarkdown } from './pdf';

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
    encode: (text) => text.split(/\s+/).filter((w) => w.length > 0).map(idFor),
    decode: (tokens) => tokens.map((id) => vocab[id]).join(' '),
  };
}

describe('extractPdfText', () => {
  it('returns the PDF text layer via pdf-parse', async () => {
    const text = await extractPdfText(Buffer.from('%PDF-1.7 fake'));
    expect(text).toBe(MOCK_PDF_TEXT);
  });
});

describe('pdfTextToMarkdown', () => {
  it('promotes the first line to an H1 title', () => {
    const md = pdfTextToMarkdown(MOCK_PDF_TEXT);
    expect(md.split('\n')[0]).toBe(
      '# POL-FIN-003: Financial Systems and Payroll Separation of Duties Policy',
    );
  });

  it('promotes numbered section headings to ## / ###', () => {
    const md = pdfTextToMarkdown(MOCK_PDF_TEXT);
    expect(md).toContain('## 2. Vendor Disbursement Access Protocol (VENDOR_PAYMENTS)');
    expect(md).toContain('### 2.1 Operational Architecture and Entry Entitlements (PAYMENT_CREATE)');
  });

  it('does NOT promote a long numbered list item into a heading', () => {
    const md = pdfTextToMarkdown(MOCK_PDF_TEXT);
    expect(md).not.toContain('## 1. Individual User Accounts');
    expect(md).toContain(
      '1. Individual User Accounts: Assigned exclusively to specific full-time employees',
    );
  });
});

describe('PDF extraction interfaces with the chunker', () => {
  it('extracts, normalizes, and chunks PDF text on its section headings', async () => {
    const raw = await extractPdfText(Buffer.from('%PDF-1.7 fake'));
    const markdown = pdfTextToMarkdown(raw);
    const chunks = chunkMarkdown(markdown, makeWordTokenizer(), {
      maxTokens: 500,
      overlapTokens: 50,
    });

    const sections = chunks.map((c) => c.section);
    // The header (title + metadata) and both numbered headings became sections;
    // the list item stayed as body under section 2.1, not its own chunk.
    expect(sections).toContain('Document Header');
    expect(sections).toContain('2. Vendor Disbursement Access Protocol (VENDOR_PAYMENTS)');
    expect(sections).toContain(
      '2.1 Operational Architecture and Entry Entitlements (PAYMENT_CREATE)',
    );
    expect(sections).not.toContain('1. Individual User Accounts');

    const sub = chunks.find((c) => c.section.startsWith('2.1'));
    expect(sub?.content).toContain('Individual User Accounts');
  });
});
