// CLI: parse the policy corpus (markdown + PDF), chunk + embed it, and
// (re)load it into policy_documents / policy_chunks. Idempotent per document —
// re-running replaces a document's chunks rather than duplicating them.
//
// Run with:      npm run rag:ingest --workspace backend
// Dry run:       npm run rag:ingest --workspace backend -- --dry-run
//   (dry run parses/chunks/tags and prints a report; no OpenAI calls, no DB
//    writes — so it needs neither an API key nor a database.)
//
// A full run requires OPENAI_API_KEY and DATABASE_URL in backend/.env (loaded
// via node --env-file; see the package.json script). Both *.md and *.pdf files
// in /policies are ingested.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { decode, encode } from 'gpt-tokenizer';
import { RawChunk, Tokenizer, chunkMarkdown } from '../chunking';
import { EmbeddingsService } from '../embeddings.service';
import {
  ChunkMetadata,
  DocumentHeader,
  documentCodeFromFilename,
  extractChunkMetadata,
  parseDocumentHeader,
  policyDomainFromCode,
} from '../metadata';
import { extractPdfText, pdfTextToMarkdown } from '../pdf';
import { toVectorLiteral } from '../rag.service';

const MAX_TOKENS = 500;
const OVERLAP_TOKENS = 50;

// Real tokenizer for production chunk sizing. The chunker itself is tokenizer-
// agnostic (see chunking.ts) so tests don't load this.
const tokenizer: Tokenizer = {
  encode: (text) => encode(text),
  decode: (tokens) => decode(tokens),
};

interface PreparedChunk extends RawChunk, ChunkMetadata {}

interface PreparedDocument {
  file: string;
  sourcePath: string;
  header: DocumentHeader;
  domain: string;
  chunks: PreparedChunk[];
}

async function loadAsMarkdown(file: string, dir: string): Promise<string> {
  const path = join(dir, file);
  if (file.toLowerCase().endsWith('.pdf')) {
    return pdfTextToMarkdown(await extractPdfText(readFileSync(path)));
  }
  return readFileSync(path, 'utf8');
}

async function prepareDocument(
  file: string,
  dir: string,
): Promise<PreparedDocument> {
  const markdown = await loadAsMarkdown(file, dir);
  const header = parseDocumentHeader(markdown);
  const domain = policyDomainFromCode(documentCodeFromFilename(file));
  const chunks = chunkMarkdown(markdown, tokenizer, {
    maxTokens: MAX_TOKENS,
    overlapTokens: OVERLAP_TOKENS,
  }).map((chunk) => ({
    ...chunk,
    ...extractChunkMetadata(chunk.section, chunk.content, domain),
  }));

  return { file, sourcePath: join(dir, file), header, domain, chunks };
}

function reportDryRun(doc: PreparedDocument): void {
  const maxTokens = doc.chunks.reduce(
    (max, c) => Math.max(max, tokenizer.encode(c.content).length),
    0,
  );
  const tagged = (predicate: (c: PreparedChunk) => boolean) =>
    doc.chunks.filter(predicate).length;

  console.log(`  ${doc.file}`);
  console.log(
    `    documentName=${JSON.stringify(doc.header.documentName)} version=${doc.header.version} ` +
      `effectiveDate=${doc.header.effectiveDate?.toISOString().slice(0, 10) ?? 'null'} domain=${doc.domain}`,
  );
  console.log(
    `    chunks=${doc.chunks.length} maxTokensInChunk=${maxTokens} ` +
      `withSection=${tagged((c) => c.sectionNumber !== null)} ` +
      `withCostCenter=${tagged((c) => c.costCenter !== null)} ` +
      `withDepartment=${tagged((c) => c.department !== null)} ` +
      `withSystem=${tagged((c) => c.targetSystem !== null)} ` +
      `withEntitlement=${tagged((c) => c.entitlementType !== null)}`,
  );
  const sample = doc.chunks.find((c) => c.entitlementType) ?? doc.chunks[1] ?? doc.chunks[0];
  if (sample) {
    console.log(
      `    sample chunk: section=${JSON.stringify(sample.sectionNumber)} ` +
        `system=${sample.targetSystem} entitlement=${sample.entitlementType} ` +
        `costCenter=${sample.costCenter} department=${sample.department}`,
    );
  }
}

async function persistDocument(
  prisma: PrismaClient,
  embeddings: EmbeddingsService,
  doc: PreparedDocument,
): Promise<void> {
  // Prefix each chunk with the document title so document-level context travels
  // into the embedding along with the section-prefixed content.
  const inputs = doc.chunks.map(
    (chunk) => `${doc.header.documentName}\n${chunk.content}`,
  );
  const vectors = await embeddings.embedBatch(inputs);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.policyDocument.findFirst({
      where: { sourcePath: doc.sourcePath },
    });

    let documentId: string;
    if (existing) {
      documentId = existing.id;
      await tx.$executeRaw`DELETE FROM policy_chunks WHERE document_id = ${documentId}::uuid`;
      await tx.policyDocument.update({
        where: { id: documentId },
        data: {
          documentName: doc.header.documentName,
          version: doc.header.version ?? 'unknown',
          effectiveDate: doc.header.effectiveDate ?? new Date(),
          ingestedAt: new Date(),
        },
      });
    } else {
      const created = await tx.policyDocument.create({
        data: {
          documentName: doc.header.documentName,
          version: doc.header.version ?? 'unknown',
          effectiveDate: doc.header.effectiveDate ?? new Date(),
          sourcePath: doc.sourcePath,
        },
      });
      documentId = created.id;
    }

    for (let i = 0; i < doc.chunks.length; i += 1) {
      const chunk = doc.chunks[i];
      const vector = toVectorLiteral(vectors[i]);
      await tx.$executeRaw`
        INSERT INTO policy_chunks
          (id, document_id, chunk_index, section, policy_domain, department, cost_center, target_system, entitlement_type, content, embedding, created_at)
        VALUES
          (${randomUUID()}::uuid, ${documentId}::uuid, ${chunk.chunkIndex}, ${chunk.section}, ${chunk.policyDomain}, ${chunk.department}, ${chunk.costCenter}, ${chunk.targetSystem}, ${chunk.entitlementType}, ${chunk.content}, ${vector}::vector, now())
      `;
    }
  });

  console.log(
    `  ${doc.file}: ${doc.chunks.length} chunks embedded and stored (domain=${doc.domain})`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dirArg = args.find((a) => !a.startsWith('--'));
  const policiesDir = dirArg
    ? resolve(dirArg)
    : resolve(__dirname, '../../../../policies');

  const files = readdirSync(policiesDir)
    .filter((file) => /\.(md|pdf)$/i.test(file))
    .sort();

  if (files.length === 0) {
    console.error(`No .md or .pdf policy files found in ${policiesDir}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Ingesting ${files.length} policy document(s) from ${policiesDir} ` +
      `(chunk=${MAX_TOKENS}/${OVERLAP_TOKENS})`,
  );

  if (dryRun) {
    let totalChunks = 0;
    for (const file of files) {
      const doc = await prepareDocument(file, policiesDir);
      reportDryRun(doc);
      totalChunks += doc.chunks.length;
    }
    console.log(`[DRY RUN] ${files.length} document(s), ${totalChunks} chunk(s). No data written.`);
    return;
  }

  const prisma = new PrismaClient();
  const embeddings = new EmbeddingsService({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_EMBEDDING_MODEL,
  });

  let totalChunks = 0;
  try {
    for (const file of files) {
      const doc = await prepareDocument(file, policiesDir);
      if (doc.chunks.length === 0) {
        console.warn(`  ${file}: produced no chunks, skipping`);
        continue;
      }
      await persistDocument(prisma, embeddings, doc);
      totalChunks += doc.chunks.length;
    }
    console.log(`Done. ${files.length} document(s), ${totalChunks} chunk(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
