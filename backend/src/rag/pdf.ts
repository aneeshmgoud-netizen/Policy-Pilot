import { PDFParse } from 'pdf-parse';

// PDF handling for the policy ingest pipeline.
//
// Two concerns, deliberately separate from chunking.ts so the chunker stays a
// pure markdown function:
//   1. extractPdfText  — pull the raw text layer out of a PDF (pdf-parse v2).
//   2. pdfTextToMarkdown — promote the plain-text numbered headings that
//      pdf-parse emits ("2.1 Operational Architecture ...") into markdown
//      headings so the *existing* chunker can split PDFs on the same semantic
//      section boundaries it uses for markdown, instead of blindly windowing a
//      wall of text.

/** Extract the concatenated text layer from a PDF buffer. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// A heading is a line that starts with a section number (1, 2.1, 2.3.1, up to
// three levels) followed by a capitalized title. Two guards keep numbered list
// items and revision-history rows from being mistaken for headings:
//   - the title must start with a CAPITAL letter, so version/date rows like
//     "2.1.0 2025-01-01 Global Compliance Committee" (a digit follows) are out;
//   - the whole line must be short (<= MAX_HEADING_LEN), so list items like
//     "1. Individual User Accounts: Assigned exclusively to ..." (long prose)
//     stay as body text under their parent section.
const MAX_HEADING_LEN = 92;
const HEADING_RE = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+([A-Z].*)$/;

function detectHeading(line: string): string | null {
  if (line.length === 0 || line.length > MAX_HEADING_LEN) {
    return null;
  }
  const match = HEADING_RE.exec(line);
  if (!match) {
    return null;
  }
  const depth = match[1].split('.').length; // 1 = top-level, 2/3 = sub-section
  const prefix = depth >= 2 ? '###' : '##';
  // Preserve the original numbering + title verbatim (line minus nothing).
  return `${prefix} ${line}`;
}

/**
 * Convert extracted PDF text into markdown the chunker understands: the first
 * non-empty line becomes the H1 title, numbered section headings become
 * `##`/`###`, everything else is left untouched.
 */
export function pdfTextToMarkdown(text: string): string {
  let titleAssigned = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!titleAssigned && trimmed.length > 0) {
        titleAssigned = true;
        return trimmed.startsWith('#') ? trimmed : `# ${trimmed}`;
      }
      return detectHeading(trimmed) ?? line;
    })
    .join('\n');
}
