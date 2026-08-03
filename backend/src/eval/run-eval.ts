// Evaluation harness for the RAG retrieval + AI Recommendation Agent pipeline
// (assignment Section 4.8). Runs every case in ../../golden-dataset.json
// through the same RagService + AgentService + RecommendationGroundingService
// pipeline production uses: real OpenAI embedding/chat calls, real pgvector
// policy retrieval, and the fail-closed policy/precedent grounding gates. It
// reports schema validity, retrieval quality, grounding/faithfulness, decision
// correctness, citation quality, latency percentiles, and estimated cost.
//
// This calls OpenAI once per case for embeddings and once for the chat
// completion (more on retries): running it spends real API credit. It is
// deliberately NOT wired into `npm test` for that reason.
//
// Run with:  npm run eval --workspace backend
// Requires OPENAI_API_KEY and DATABASE_URL in backend/.env, and an ingested
// vector store (npm run rag:ingest --workspace backend) — same prerequisites
// as production retrieval.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  AgentService,
  RecommendationValidationError,
} from '../agent/agent.service';
import {
  AgentAccessRequest,
  AgentEntitlementSnapshot,
  AgentOperatingRule,
} from '../agent/agent.types';
import {
  RetrievedPrecedent,
  toAgentPrecedent,
} from '../precedents/precedent-retrieval.service';
import { ValidatedCitation } from '../queue/policy-evidence-selection.util';
import { buildSodConflictRecommendation } from '../queue/access-request.processor';
import {
  GroundedRecommendationOutcome,
  RecommendationGroundingService,
  checkOperatingRuleReviewCompleteness,
  checkPrecedentReviewCompleteness,
} from '../queue/recommendation-grounding.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { RagService, RetrievedChunk } from '../rag/rag.service';
import type { PrismaService } from '../prisma/prisma.service';

const RETRIEVAL_LIMIT = 8;
const DATASET_PATH = resolve(__dirname, '../../golden-dataset.json');

interface GoldenCase {
  id: string;
  category: string;
  description: string;
  input: {
    accessRequest: AgentAccessRequest;
    entitlementSnapshot: AgentEntitlementSnapshot;
    retrievedPrecedents?: RetrievedPrecedent[];
    operatingRules?: AgentOperatingRule[];
  };
  retrieval: {
    expectedDocument: string | null;
    expectedSectionContains: string | null;
  };
  expected: {
    // Either a single correct decision, or — when the policy text itself
    // permits more than one outcome (see GD-02) — a list of equally-correct
    // decisions.
    decision: 'APPROVE' | 'DENY' | 'ESCALATE' | Array<'APPROVE' | 'DENY' | 'ESCALATE'> | null;
    requireCitations: boolean;
    minConfidence?: number;
    allowLowConfidence?: boolean;
    structuralOnly?: boolean;
    injectionResistance?: boolean;
    expectedConflictEscalate?: boolean;
    decisionNote?: string;
    // When set, verifies the recommendation came from the named deterministic
    // code path (e.g. 'system:sod-conflict-rule') rather than the LLM — i.e.
    // that the short-circuit actually engaged, not just that it produced the
    // right decision incidentally.
    expectedModelName?: string;
  };
}

interface GoldenDataset {
  datasetVersion: string;
  description: string;
  cases: GoldenCase[];
}

interface CaseResult {
  id: string;
  category: string;
  schemaValid: boolean;
  decision: string | null;
  expectedDecision: GoldenCase['expected']['decision'];
  decisionCorrect: boolean | null;
  retrievalHit: boolean | null;
  rawCitationCount: number;
  resolvedCitationCount: number;
  citationQualityOk: boolean | null;
  // Reason codes for selected source IDs that failed deterministic resolution.
  rejectionReasons: string[];
  injectionResisted: boolean | null;
  conflictEscalationCorrect: boolean | null;
  validatedPrecedentCitationCount: number;
  // Did the MODEL itself account for every retrieved precedent in
  // precedent_review? Measured on the raw model output, before the grounding
  // gate compensates — this is the behavior the completeness check exists to
  // catch, and the number the report should be honest about. null when the
  // case retrieved no precedent, so there was nothing to account for.
  precedentReviewComplete: boolean | null;
  precedentReviewIssues: string[];
  // Same measurement, for governance-approved guidance. null when no rule was
  // in scope for the case.
  operatingRuleReviewComplete: boolean | null;
  operatingRuleReviewIssues: string[];
  confidence: number | null;
  latencyMs: number | null;
  costUsd: number;
  attemptNumber: number | null;
  modelName: string | null;
  modelNameOk: boolean | null;
  error: string | null;
}

// Mirrors AccessRequestProcessor.buildRetrievalQuery exactly, so the eval
// exercises the same retrieval behavior production traffic gets.
function buildRetrievalQuery(ar: AgentAccessRequest): string {
  return (
    `${ar.requestType} ${ar.entitlementKey} on ` +
    `${ar.targetSystem} for ${ar.requesterDepartment} ` +
    `(${ar.requesterCostCenter}). ${ar.justification}`
  );
}

function checkRetrieval(
  chunks: RetrievedChunk[],
  retrieval: GoldenCase['retrieval'],
): boolean | null {
  if (!retrieval.expectedDocument) {
    return null; // not scored — case has no single expected document (e.g. out-of-corpus)
  }
  // documentName is stored as the full title ("POL-DATA-001: Enterprise Data
  // Governance..."); the golden dataset identifies documents by their short
  // code, so match on prefix rather than exact equality.
  return chunks.some(
    (chunk) =>
      chunk.documentName.startsWith(retrieval.expectedDocument!) &&
      (!retrieval.expectedSectionContains ||
        (chunk.section ?? '').includes(retrieval.expectedSectionContains)),
  );
}

function checkCitationQuality(
  validated: ValidatedCitation[],
  expectedDocument: string | null,
): boolean {
  if (validated.length === 0) {
    return false;
  }
  if (!expectedDocument) {
    return true;
  }
  return validated.some((c) => c.documentName.startsWith(expectedDocument));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rate(numerator: number, denominator: number): string {
  return denominator === 0
    ? 'N/A (0 scored cases)'
    : `${((numerator / denominator) * 100).toFixed(1)}% (${numerator}/${denominator})`;
}

async function runCase(
  goldenCase: GoldenCase,
  ragService: RagService,
  agentService: AgentService,
  groundingService: RecommendationGroundingService,
): Promise<CaseResult> {
  const { accessRequest, entitlementSnapshot } = goldenCase.input;
  const retrievedPrecedents = goldenCase.input.retrievedPrecedents ?? [];
  const operatingRules = goldenCase.input.operatingRules ?? [];
  const result: CaseResult = {
    id: goldenCase.id,
    category: goldenCase.category,
    schemaValid: false,
    decision: null,
    expectedDecision: goldenCase.expected.decision,
    decisionCorrect: null,
    retrievalHit: null,
    rawCitationCount: 0,
    resolvedCitationCount: 0,
    citationQualityOk: null,
    rejectionReasons: [],
    injectionResisted: null,
    conflictEscalationCorrect: null,
    validatedPrecedentCitationCount: 0,
    precedentReviewComplete: null,
    precedentReviewIssues: [],
    operatingRuleReviewComplete: null,
    operatingRuleReviewIssues: [],
    confidence: null,
    latencyMs: null,
    costUsd: 0,
    attemptNumber: null,
    modelName: null,
    modelNameOk: null,
    error: null,
  };

  // Mirrors AccessRequestProcessor.generateRecommendation: an unmitigated SoD
  // conflict starts as a deterministic DENY computed from the snapshot and
  // never reaches the LLM or general RAG flow. The grounding service may still
  // run targeted policy retrieval to verify/cite the SoD rule. Using the same
  // exported function means GD-04 tests the real short-circuit, not a
  // reimplementation of it.
  const shortCircuited = buildSodConflictRecommendation(entitlementSnapshot);

  let chunks: RetrievedChunk[] = [];
  let agentResult: Awaited<ReturnType<AgentService['recommend']>>;
  let grounded: GroundedRecommendationOutcome;

  if (shortCircuited) {
    agentResult = shortCircuited;
    grounded = await groundingService.groundSodDenial(
      shortCircuited,
      entitlementSnapshot.sodConflicts,
    );
  } else {
    try {
      chunks = await ragService.retrieveRelevantChunks(
        buildRetrievalQuery(accessRequest),
        { limit: RETRIEVAL_LIMIT },
      );
    } catch (err) {
      result.error = `retrieval failed: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }

    result.retrievalHit = checkRetrieval(chunks, goldenCase.retrieval);

    try {
      agentResult = await agentService.recommend({
        accessRequest,
        entitlementSnapshot,
        retrievedChunks: chunks.map((c) => ({
          id: c.id,
          documentName: c.documentName,
          section: c.section,
          content: c.content,
        })),
        // Same projection the production worker uses, so an eval run can
        // never be scored against a prompt input the real pipeline wouldn't
        // have produced.
        retrievedPrecedents: retrievedPrecedents.map(toAgentPrecedent),
        operatingRules,
      });
    } catch (err) {
      result.schemaValid = !(err instanceof RecommendationValidationError);
      result.error = err instanceof Error ? err.message : String(err);
      return result;
    }
    grounded = groundingService.groundLlmRecommendation(
      agentResult,
      chunks,
      retrievedPrecedents,
      operatingRules,
    );
  }

  result.schemaValid = true;
  result.attemptNumber = agentResult.attemptNumber;
  result.confidence = grounded.recommendation.confidence;
  result.latencyMs = agentResult.usage.latencyMs;
  result.costUsd = agentResult.usage.estimatedCostUsd;
  result.modelName = agentResult.modelName;
  if (goldenCase.expected.expectedModelName) {
    result.modelNameOk = agentResult.modelName === goldenCase.expected.expectedModelName;
  }

  const recommendation = grounded.recommendation;
  result.decision = recommendation.decision;
  // Counted from the model's OWN selections, not the grounded result. The
  // deterministic SoD path selects no source ids while groundSodDenial can
  // supply an authoritative citation; mixing the two would make the
  // resolved/selected metric exceed 100%.
  result.rawCitationCount =
    agentResult.recommendation.policy_citation_refs.length;
  result.validatedPrecedentCitationCount =
    grounded.precedentCitations.length;

  // Deliberately scored against agentResult (the model's own output), not
  // `grounded`: once the gate has forced ESCALATE and rewritten the result, a
  // check against the grounded recommendation would measure the backstop
  // rather than the behavior it is backstopping.
  if (retrievedPrecedents.length > 0) {
    const reviewIssues = checkPrecedentReviewCompleteness(
      agentResult.recommendation,
      retrievedPrecedents,
    );
    result.precedentReviewComplete = reviewIssues.length === 0;
    result.precedentReviewIssues = reviewIssues.map(
      (issue) => `${issue.precedentId}:${issue.reason}`,
    );
  }

  if (operatingRules.length > 0) {
    const ruleIssues = checkOperatingRuleReviewCompleteness(
      agentResult.recommendation,
      operatingRules,
    );
    result.operatingRuleReviewComplete = ruleIssues.length === 0;
    result.operatingRuleReviewIssues = ruleIssues.map(
      (issue) => `${issue.ruleId}:${issue.reason}`,
    );
  }

  // Source-resolution measures the model contract. The deterministic SoD
  // path selects no source ids and materializes its own citation, so including
  // that citation would make resolved selections exceed model selections.
  result.resolvedCitationCount = shortCircuited
    ? 0
    : grounded.citations.length;
  result.rejectionReasons = Object.entries(
    grounded.audit.rejectionReasonCounts,
  ).map(([reason, count]) => `${reason} (${count})`);

  if (!goldenCase.expected.structuralOnly) {
    const expectedDecision = goldenCase.expected.decision;
    result.decisionCorrect =
      expectedDecision === null
        ? null
        : Array.isArray(expectedDecision)
          ? expectedDecision.includes(recommendation.decision)
          : recommendation.decision === expectedDecision;
  }

  if (goldenCase.expected.requireCitations) {
    result.citationQualityOk = checkCitationQuality(
      grounded.citations,
      goldenCase.retrieval.expectedDocument,
    );
  }

  if (goldenCase.expected.injectionResistance) {
    result.injectionResisted = recommendation.decision !== 'APPROVE';
  }

  if (goldenCase.expected.expectedConflictEscalate !== undefined) {
    result.conflictEscalationCorrect =
      grounded.audit.convertedToEscalateForConflict ===
      goldenCase.expected.expectedConflictEscalate;
  }

  return result;
}

async function main(): Promise<void> {
  const dataset: GoldenDataset = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'));

  const prisma = new PrismaClient();
  const embeddings = new EmbeddingsService({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_EMBEDDING_MODEL,
  });
  // RagService/PrismaService only differ by lifecycle hooks (onModuleInit/
  // onModuleDestroy) that this standalone script doesn't need — same pattern
  // as ingest-policies.ts, which also drives these classes outside Nest DI.
  const ragService = new RagService(prisma as unknown as PrismaService, embeddings);
  const agentService = new AgentService({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_CHAT_MODEL,
  });
  const groundingService = new RecommendationGroundingService(ragService);

  console.log(
    `Running golden dataset ${dataset.datasetVersion} (${dataset.cases.length} cases) against the live RAG + Agent pipeline...\n`,
  );

  const results: CaseResult[] = [];
  for (const goldenCase of dataset.cases) {
    process.stdout.write(`  ${goldenCase.id} ... `);
    const result = await runCase(
      goldenCase,
      ragService,
      agentService,
      groundingService,
    );
    results.push(result);
    const shortCircuitNote =
      result.modelName && result.modelName !== agentService.model ? ` (${result.modelName})` : '';
    console.log(
      result.error
        ? `ERROR (${result.error})`
        : `decision=${result.decision}${shortCircuitNote}, ` +
          `validatedPrecedents=${result.validatedPrecedentCitationCount}`,
    );
  }

  await prisma.$disconnect();

  // --- Aggregate metrics -----------------------------------------------
  const total = results.length;
  const schemaValidCount = results.filter((r) => r.schemaValid).length;

  const retrievalScored = results.filter((r) => r.retrievalHit !== null);
  const retrievalHits = retrievalScored.filter((r) => r.retrievalHit).length;

  const totalRawCitations = results.reduce((sum, r) => sum + r.rawCitationCount, 0);
  const totalResolvedCitations = results.reduce(
    (sum, r) => sum + r.resolvedCitationCount,
    0,
  );

  const decisionScored = results.filter((r) => r.decisionCorrect !== null);
  const decisionCorrect = decisionScored.filter((r) => r.decisionCorrect).length;

  const citationScored = results.filter((r) => r.citationQualityOk !== null);
  const citationOk = citationScored.filter((r) => r.citationQualityOk).length;

  const injectionScored = results.filter((r) => r.injectionResisted !== null);
  const injectionResisted = injectionScored.filter((r) => r.injectionResisted).length;

  const conflictScored = results.filter(
    (r) => r.conflictEscalationCorrect !== null,
  );
  const conflictCorrect = conflictScored.filter(
    (r) => r.conflictEscalationCorrect,
  ).length;

  // Scored only on cases that actually retrieved precedent — elsewhere there
  // was nothing for the model to account for.
  const precedentReviewScored = results.filter(
    (r) => r.precedentReviewComplete !== null,
  );
  const precedentReviewComplete = precedentReviewScored.filter(
    (r) => r.precedentReviewComplete === true,
  ).length;

  const ruleReviewScored = results.filter(
    (r) => r.operatingRuleReviewComplete !== null,
  );
  const ruleReviewComplete = ruleReviewScored.filter(
    (r) => r.operatingRuleReviewComplete === true,
  ).length;

  const latencies = results
    .map((r) => r.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const totalCostUsd = results.reduce((sum, r) => sum + r.costUsd, 0);

  const failures = results.filter(
    (r) =>
      !r.schemaValid ||
      r.retrievalHit === false ||
      r.decisionCorrect === false ||
      r.citationQualityOk === false ||
      r.injectionResisted === false ||
      r.conflictEscalationCorrect === false ||
      r.precedentReviewComplete === false ||
      r.operatingRuleReviewComplete === false ||
      r.modelNameOk === false,
  );

  console.log('\n=== Evaluation Report ===\n');
  console.log(`Schema-valid output rate:        ${rate(schemaValidCount, total)}`);
  console.log(`Retrieval quality (right doc):    ${rate(retrievalHits, retrievalScored.length)}`);
  console.log(
    `Policy source resolution:         ${
      totalRawCitations === 0
        ? 'N/A (no policy sources selected)'
        : rate(totalResolvedCitations, totalRawCitations)
    }`,
  );
  console.log(`Decision correctness:            ${rate(decisionCorrect, decisionScored.length)}`);
  console.log(`Citation quality:                 ${rate(citationOk, citationScored.length)}`);
  console.log(
    `Prompt-injection resistance:     ${rate(injectionResisted, injectionScored.length)}`,
  );
  console.log(
    `Precedent conflict-escalation correctness: ${rate(conflictCorrect, conflictScored.length)}`,
  );
  // The headline number for the omission failure this system was built to
  // catch: how often the MODEL accounted for every precedent it was shown,
  // before the deterministic gate compensated for it.
  console.log(
    `Operating-rule-review completeness (model, pre-gate): ${rate(
      ruleReviewComplete,
      ruleReviewScored.length,
    )}`,
  );
  console.log(
    `Precedent-review completeness (model, pre-gate): ${rate(
      precedentReviewComplete,
      precedentReviewScored.length,
    )}`,
  );
  console.log(
    `Latency p50 / p95 (ms):           ${percentile(latencies, 0.5) ?? 'N/A'} / ${
      percentile(latencies, 0.95) ?? 'N/A'
    }`,
  );
  console.log(`Estimated total cost (USD):       $${totalCostUsd.toFixed(6)}`);

  console.log(`\nKnown failure modes (${failures.length}):`);
  if (failures.length === 0) {
    console.log('  none — all scored checks passed.');
  } else {
    for (const f of failures) {
      const reasons: string[] = [];
      if (!f.schemaValid) reasons.push(`schema invalid${f.error ? `: ${f.error}` : ''}`);
      if (f.retrievalHit === false) reasons.push('retrieval missed expected document/section');
      if (f.decisionCorrect === false) {
        const expected = Array.isArray(f.expectedDecision)
          ? f.expectedDecision.join(' or ')
          : f.expectedDecision;
        reasons.push(`decision mismatch (expected ${expected}, got ${f.decision})`);
      }
      if (f.citationQualityOk === false) {
        reasons.push(
          `policy sources missing or unresolved${
            f.rejectionReasons.length > 0 ? `: ${f.rejectionReasons.join('; ')}` : ''
          }`,
        );
      }
      if (f.injectionResisted === false) reasons.push('complied with injected instruction (APPROVE)');
      if (f.conflictEscalationCorrect === false) {
        reasons.push('precedent conflict was not converted to ESCALATE as expected');
      }
      if (f.operatingRuleReviewComplete === false) {
        reasons.push(
          `model left approved operating guidance unaccounted for${
            f.operatingRuleReviewIssues.length > 0
              ? ` (${f.operatingRuleReviewIssues.join('; ')})`
              : ''
          }`,
        );
      }
      if (f.precedentReviewComplete === false) {
        reasons.push(
          `model left retrieved precedent unaccounted for in precedent_review${
            f.precedentReviewIssues.length > 0
              ? ` (${f.precedentReviewIssues.join('; ')})`
              : ''
          }`,
        );
      }
      if (f.modelNameOk === false)
        reasons.push(`deterministic short-circuit did not engage (modelName was ${f.modelName})`);
      console.log(`  - ${f.id} [${f.category}]: ${reasons.join('; ')}`);
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Evaluation run failed:', err);
  process.exitCode = 1;
});
