import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentRetrievedPrecedent } from '../agent/agent.types';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { toVectorLiteral } from '../rag/rag.service';
import {
  buildPrecedentCaseFactsText,
  PrecedentCaseFacts,
} from './precedent-case-facts';
import { CURRENT_PRECEDENT_EMBEDDING_VERSION } from './precedent-embedding-version';
import { isPrecedentStale } from './precedent-staleness';

export interface PrecedentRetrievalOptions {
  limit?: number;
}

export interface RetrievedPrecedent {
  id: string;
  summary: string;
  outcome: string;
  targetSystem: string;
  entitlementKey: string;
  department: string | null;
  costCenter: string | null;
  policyVersionSnapshot: unknown;
  createdAt: Date;
  similarity: number;
}

const DEFAULT_LIMIT = 5;
const STALENESS_OVERFETCH_FACTOR = 3;

/**
 * Absolute cosine-similarity floor a precedent must clear before it is shown
 * to the model at all. Vector search is inherently relative — it always
 * returns the nearest N rows, however far away they actually are — so without
 * a floor, the single least-unrelated case in the corpus is presented as
 * "relevant precedent" simply because nothing closer exists. That is exactly
 * what the brief rules out: a recommendation must "avoid using precedents
 * that ... do not sufficiently match the current case", and must recognize
 * when "there is insufficient evidence to apply a precedent confidently".
 *
 * Enforced here in code rather than left to the model's judgment, for the
 * same reason applicability conflicts are (see
 * RecommendationGroundingService): "is this close enough to be worth
 * considering" is a threshold question answerable from data we already have,
 * and a precedent that never enters the prompt cannot be misapplied,
 * misquoted, or reasoned around.
 *
 * 0.75 remains a conservative starting value rather than a production-tuned
 * threshold. Its inputs are now symmetric: both vectors come from the same
 * canonical request-facts builder. Recalibrate it against a representative
 * labeled corpus as that corpus grows.
 */
export const MIN_PRECEDENT_SIMILARITY = 0.75;

export function buildPrecedentFilterConditions(
  facts: Pick<PrecedentCaseFacts, 'targetSystem' | 'entitlementKey'>,
): Prisma.Sql {
  return Prisma.join(
    [
      Prisma.sql`AND pr.status = 'ACTIVE'`,
      Prisma.sql`AND pr.embedding_version = ${CURRENT_PRECEDENT_EMBEDDING_VERSION}`,
      Prisma.sql`AND pr.target_system = ${facts.targetSystem}`,
      Prisma.sql`AND pr.entitlement_key = ${facts.entitlementKey}`,
    ],
    ' ',
  );
}

/**
 * Project a retrieved precedent onto exactly the facts the agent may reason
 * over. Deliberately a single shared function rather than an inline literal
 * at each call site: the production worker and the evaluation harness both
 * build this input, and when they were mapped independently the worker
 * silently dropped department/costCenter/createdAt — so the model was asked
 * to judge department applicability using fields that had already been
 * discarded one layer above it. Adding a field to AgentRetrievedPrecedent
 * should mean editing one place, not remembering every place.
 *
 * policyVersionSnapshot is intentionally NOT forwarded: staleness is decided
 * deterministically in retrieval (a stale precedent never reaches the model
 * at all), so exposing raw version data would only invite the model to
 * re-litigate a question already settled in code.
 */
export function toAgentPrecedent(
  precedent: RetrievedPrecedent,
): AgentRetrievedPrecedent {
  return {
    id: precedent.id,
    summary: precedent.summary,
    outcome: precedent.outcome,
    targetSystem: precedent.targetSystem,
    entitlementKey: precedent.entitlementKey,
    department: precedent.department,
    costCenter: precedent.costCenter,
    recordedAt: precedent.createdAt ? toIsoString(precedent.createdAt) : null,
    similarity: precedent.similarity,
  };
}

// createdAt arrives as a Date from Prisma but as a string from JSON fixtures
// (the golden dataset). Normalize both without assuming either.
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

interface PrecedentRow {
  id: string;
  summary: string;
  outcome: string;
  targetSystem: string;
  entitlementKey: string;
  department: string | null;
  costCenter: string | null;
  policyVersionSnapshot: unknown;
  createdAt: Date;
  similarity: number | string;
}

@Injectable()
export class PrecedentRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  async retrieveRelevantPrecedents(
    facts: PrecedentCaseFacts,
    options: PrecedentRetrievalOptions = {},
  ): Promise<RetrievedPrecedent[]> {
    const retrievalText = buildPrecedentCaseFactsText(facts);
    const vector = toVectorLiteral(await this.embeddings.embed(retrievalText));
    const limit = options.limit ?? DEFAULT_LIMIT;
    const overfetchLimit = limit * STALENESS_OVERFETCH_FACTOR;
    const conditions = buildPrecedentFilterConditions(facts);

    const [rows, currentVersions] = await Promise.all([
      this.prisma.$queryRaw<PrecedentRow[]>(Prisma.sql`
        SELECT
          pr.id,
          pr.summary,
          pr.target_system AS "targetSystem",
          pr.entitlement_key AS "entitlementKey",
          pr.department,
          pr.cost_center AS "costCenter",
          pr.policy_version_snapshot AS "policyVersionSnapshot",
          pr.created_at AS "createdAt",
          hd.outcome AS "outcome",
          1 - (pr.embedding <=> ${vector}::vector) AS similarity
        FROM precedent_records pr
        JOIN decision_feedback df ON df.id = pr.decision_feedback_id
        JOIN human_decisions hd ON hd.id = df.human_decision_id
        WHERE pr.embedding IS NOT NULL
        ${conditions}
        ORDER BY pr.embedding <=> ${vector}::vector
        LIMIT ${overfetchLimit}
      `),
      this.prisma.policyDocument.findMany({
        select: { documentName: true, version: true },
      }),
    ]);

    return rows
      .filter(
        (row) =>
          // Both exclusions are "this precedent is not usable evidence for
          // this request", applied before the model sees anything: decided
          // under policy that has since changed, or not close enough to this
          // request to be the same kind of case.
          !isPrecedentStale(row.policyVersionSnapshot, currentVersions) &&
          Number(row.similarity) >= MIN_PRECEDENT_SIMILARITY,
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        summary: row.summary,
        outcome: row.outcome,
        targetSystem: row.targetSystem,
        entitlementKey: row.entitlementKey,
        department: row.department,
        costCenter: row.costCenter,
        policyVersionSnapshot: row.policyVersionSnapshot,
        createdAt: row.createdAt,
        similarity: Number(row.similarity),
      }));
  }
}
