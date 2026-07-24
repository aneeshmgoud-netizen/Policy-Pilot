import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from './embeddings.service';

export interface RetrievalFilters {
  policyDomain?: string;
  costCenter?: string;
  targetSystem?: string;
  /** Max chunks to return (default 5). */
  limit?: number;
}

export interface RetrievedChunk {
  id: string;
  documentName: string;
  section: string | null;
  content: string;
  /** Cosine similarity in [0, 1] (1 - cosine distance). */
  similarity: number;
}

const DEFAULT_LIMIT = 5;

// Render a JS number[] as a pgvector literal: [0.1,0.2,...]. Passed as a bound
// parameter and cast to ::vector, never string-interpolated into SQL.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// Build the optional metadata filter predicates as a composable SQL fragment.
// Each value is a bound parameter (Prisma.sql placeholder), so this is not an
// injection vector. Returns Prisma.empty when no filters are supplied.
export function buildFilterConditions(filters: RetrievalFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filters.policyDomain) {
    parts.push(Prisma.sql`AND pc.policy_domain = ${filters.policyDomain}`);
  }
  if (filters.costCenter) {
    parts.push(Prisma.sql`AND pc.cost_center = ${filters.costCenter}`);
  }
  if (filters.targetSystem) {
    parts.push(Prisma.sql`AND pc.target_system = ${filters.targetSystem}`);
  }
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty;
}

interface ChunkRow {
  id: string;
  documentName: string;
  section: string | null;
  content: string;
  similarity: number | string;
}

@Injectable()
export class RagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /**
   * Embed the query and return the most similar policy chunks by cosine
   * distance, using the HNSW index on policy_chunks.embedding
   * (vector_cosine_ops). Optional filters scope the search to a policy domain,
   * cost center, or target system.
   */
  async retrieveRelevantChunks(
    query: string,
    filters: RetrievalFilters = {},
  ): Promise<RetrievedChunk[]> {
    const embedding = await this.embeddings.embed(query);
    const vector = toVectorLiteral(embedding);
    const limit = filters.limit ?? DEFAULT_LIMIT;
    const conditions = buildFilterConditions(filters);

    // `<=>` is pgvector's cosine-distance operator and drives the HNSW index.
    // similarity = 1 - distance so higher is better. The ORDER BY (not the
    // SELECT expression) is what the index accelerates.
    const rows = await this.prisma.$queryRaw<ChunkRow[]>(Prisma.sql`
      SELECT
        pc.id,
        pd.document_name AS "documentName",
        pc.section,
        pc.content,
        1 - (pc.embedding <=> ${vector}::vector) AS similarity
      FROM policy_chunks pc
      JOIN policy_documents pd ON pd.id = pc.document_id
      WHERE pc.embedding IS NOT NULL
      ${conditions}
      ORDER BY pc.embedding <=> ${vector}::vector
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      id: row.id,
      documentName: row.documentName,
      section: row.section,
      content: row.content,
      similarity: Number(row.similarity),
    }));
  }
}
