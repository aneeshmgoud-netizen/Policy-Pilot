import { Logger } from '@nestjs/common';
import { RecommendationResult } from '../agent/agent.types';
import { SodConflictFinding } from '../entitlements/entitlement-lookup.service';
import { RetrievedPrecedent } from '../precedents/precedent-retrieval.service';
import { RagService, RetrievedChunk } from '../rag/rag.service';
import { buildSodConflictRecommendation } from './access-request.processor';
import {
  RecommendationGroundingService,
  checkOperatingRuleReviewCompleteness,
  checkPrecedentReviewCompleteness,
} from './recommendation-grounding.service';

const CHUNK: RetrievedChunk = {
  id: 'chunk-1',
  documentName: 'POL-DATA-001',
  section: '3.1 Standard Read Access Protocol',
  content: 'Members of CC-FIN-07 may request baseline read access.',
  similarity: 0.9,
};
const SOURCE_ID = 'POLICY_SOURCE_001';

const PRECEDENT: RetrievedPrecedent = {
  id: 'precedent-1',
  summary: 'A comparable finance request was granted.',
  outcome: 'GRANT',
  targetSystem: 'DATA_WAREHOUSE',
  entitlementKey: 'FIN_DATASET_READ',
  department: 'Finance Analytics',
  costCenter: 'CC-FIN-07',
  policyVersionSnapshot: [],
  createdAt: new Date('2026-07-30T12:00:00.000Z'),
  similarity: 0.92,
};

const OPERATING_RULE = {
  id: 'rule-1',
  guidance: 'Escalate this scope to Data Governance.',
  approvedAt: '2026-07-30T12:00:00.000Z',
};

function llmResult(
  overrides: Partial<RecommendationResult['recommendation']> = {},
): RecommendationResult {
  const recommendation = {
    decision: 'APPROVE' as const,
    justification: 'Permitted by the selected policy evidence.',
    policy_citation_refs: [{ source_id: SOURCE_ID }],
    precedent_citations: [],
    precedent_review: [],
    operating_rule_review: [],
    confidence: 0.9,
    conflict_detected: false,
    conflict_explanation: '',
    ...overrides,
  };
  return {
    recommendation,
    modelName: 'gpt-4o-mini',
    promptVersion: 'v6',
    rawResponse: recommendation,
    attemptNumber: 1,
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.0001,
      latencyMs: 10,
    },
  };
}

function makeRagServiceMock(chunksByCall: RetrievedChunk[][] = []) {
  const retrieveRelevantChunks = jest.fn();
  chunksByCall.forEach((chunks) =>
    retrieveRelevantChunks.mockResolvedValueOnce(chunks),
  );
  return { retrieveRelevantChunks } as unknown as RagService & {
    retrieveRelevantChunks: jest.Mock;
  };
}

describe('RecommendationGroundingService policy evidence selection', () => {
  it('copies the selected authoritative segment into the required citation shape', () => {
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const result = llmResult();
    const outcome = service.groundLlmRecommendation(result, [CHUNK], []);

    expect(outcome.recommendation.decision).toBe('APPROVE');
    expect(outcome.decisionSource).toBe('MODEL');
    expect(outcome.recommendation).not.toHaveProperty('policy_citation_refs');
    expect(outcome.recommendation.policy_citations).toEqual([
      {
        document_name: CHUNK.documentName,
        section: CHUNK.section,
        excerpt: CHUNK.content,
      },
    ]);
    expect(outcome.citations[0].excerpt).toBe(CHUNK.content);
    expect(outcome.rawResponse).toBe(result.rawResponse);
  });

  it('fails closed when the model selects an unavailable source id', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const result = llmResult({
      policy_citation_refs: [{ source_id: 'invented:segment:1' }],
    });
    const outcome = service.groundLlmRecommendation(result, [CHUNK], []);

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.decisionSource).toBe('GROUNDING_GATE');
    expect(outcome.citations).toEqual([]);
    expect(outcome.audit.rejectionReasonCounts).toEqual({
      UNKNOWN_SOURCE_ID: 1,
    });
    expect(JSON.stringify(outcome.rawResponse)).not.toContain(
      'invented:segment:1',
    );
  });

  it('fails closed on a duplicate source selection', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        policy_citation_refs: [
          { source_id: SOURCE_ID },
          { source_id: SOURCE_ID },
        ],
      }),
      [CHUNK],
      [],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.rejectionReasonCounts).toEqual({
      DUPLICATE_SOURCE_ID: 1,
    });
  });

  it('requires at least one valid policy source for APPROVE or DENY', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({ policy_citation_refs: [] }),
      [CHUNK],
      [],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.proposedCitationCount).toBe(0);
    expect(outcome.audit.validatedCitationCount).toBe(0);
  });

  it('rewrites an ESCALATE justification when it selected an invalid source', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = llmResult({
      decision: 'ESCALATE',
      justification: 'Unsupported model explanation.',
      policy_citation_refs: [{ source_id: 'unknown' }],
    });
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(result, [CHUNK], []);

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.recommendation.justification).not.toBe(
      result.recommendation.justification,
    );
    expect(outcome.decisionSource).toBe('GROUNDING_GATE');
  });
});

describe('RecommendationGroundingService governed evidence checks', () => {
  it('forces ESCALATE when the model flags a conflict and keeps verified policy', () => {
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        conflict_detected: true,
        conflict_explanation: 'Policy and precedent disagree.',
      }),
      [CHUNK],
      [],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.audit.convertedToEscalateForConflict).toBe(true);
  });

  it('forces ESCALATE and flags a retrieved precedent the model omitted', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult(),
      [CHUNK],
      [PRECEDENT],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.convertedToEscalateForPrecedentReview).toBe(true);
    expect(outcome.precedentCitations).toEqual([
      expect.objectContaining({ precedentRecordId: PRECEDENT.id }),
    ]);
    expect(outcome.citations).toHaveLength(1);
  });

  it('accepts a complete applicable precedent review with a matching outcome', () => {
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        precedent_review: [{ precedent_id: PRECEDENT.id, applies: true }],
        precedent_citations: [
          {
            precedent_id: PRECEDENT.id,
            relevance_reason: 'Same scope and requester category.',
          },
        ],
      }),
      [CHUNK],
      [PRECEDENT],
    );

    expect(outcome.recommendation.decision).toBe('APPROVE');
    expect(outcome.precedentCitations).toEqual([
      expect.objectContaining({
        precedentRecordId: PRECEDENT.id,
        outcomeSnapshot: 'GRANT',
      }),
    ]);
  });

  it('forces ESCALATE when an applicable precedent outcome contradicts the decision', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const deniedPrecedent = { ...PRECEDENT, outcome: 'DENY' };
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        precedent_review: [
          { precedent_id: deniedPrecedent.id, applies: true },
        ],
      }),
      [CHUNK],
      [deniedPrecedent],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.convertedToEscalateForPrecedentReview).toBe(true);
  });

  it('forces ESCALATE when an active operating rule is omitted', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult(),
      [CHUNK],
      [],
      [OPERATING_RULE],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.convertedToEscalateForOperatingRuleReview).toBe(true);
  });

  it('still surfaces omitted precedent and rules when the model already chose ESCALATE', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        decision: 'ESCALATE',
        justification: 'The model escalated without discussing governed evidence.',
      }),
      [CHUNK],
      [PRECEDENT],
      [OPERATING_RULE],
    );

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.decisionSource).toBe('GROUNDING_GATE');
    expect(outcome.audit.convertedToEscalateForPrecedentReview).toBe(true);
    expect(outcome.audit.convertedToEscalateForOperatingRuleReview).toBe(true);
    expect(outcome.precedentCitations).toEqual([
      expect.objectContaining({ precedentRecordId: PRECEDENT.id }),
    ]);
    expect(outcome.recommendation.justification).toContain(PRECEDENT.id);
    expect(outcome.recommendation.justification).toContain(OPERATING_RULE.id);
  });

  it('accepts a complete operating-rule review', () => {
    const service = new RecommendationGroundingService(makeRagServiceMock());
    const outcome = service.groundLlmRecommendation(
      llmResult({
        operating_rule_review: [
          { rule_id: OPERATING_RULE.id, applies: true },
        ],
      }),
      [CHUNK],
      [],
      [OPERATING_RULE],
    );

    expect(outcome.recommendation.decision).toBe('APPROVE');
  });
});

describe('review completeness helpers', () => {
  it('detects unknown, duplicate, and missing precedent reviews', () => {
    const issues = checkPrecedentReviewCompleteness(
      {
        decision: 'APPROVE',
        precedent_review: [
          { precedent_id: 'unknown', applies: true },
          { precedent_id: PRECEDENT.id, applies: true },
          { precedent_id: PRECEDENT.id, applies: false },
        ],
        operating_rule_review: [],
      },
      [PRECEDENT],
    );

    expect(issues.map((issue) => issue.reason)).toEqual([
      'UNKNOWN_PRECEDENT_ID',
      'DUPLICATE_REVIEW',
    ]);
  });

  it('detects unknown, duplicate, and missing operating-rule reviews', () => {
    const issues = checkOperatingRuleReviewCompleteness(
      {
        decision: 'APPROVE',
        precedent_review: [],
        operating_rule_review: [
          { rule_id: 'unknown', applies: true },
          { rule_id: OPERATING_RULE.id, applies: true },
          { rule_id: OPERATING_RULE.id, applies: false },
        ],
      },
      [OPERATING_RULE],
    );

    expect(issues.map((issue) => issue.reason)).toEqual([
      'UNKNOWN_RULE_ID',
      'DUPLICATE_REVIEW',
    ]);
  });
});

describe('RecommendationGroundingService deterministic SoD evidence', () => {
  const conflict: SodConflictFinding = {
    ruleId: 'SoD-DATA-01',
    conflictingEntitlementKey: 'BILLING_EXPORT',
    description: 'POL-DATA-001 §5.1 prohibits this combination.',
  };
  const sodChunk: RetrievedChunk = {
    id: 'sod-chunk',
    documentName: 'POL-DATA-001: Enterprise Data Governance Policy',
    section: '§ 5.1 Separation of Duties',
    content: 'The conflicting entitlements must not be held together.',
    similarity: 0.9,
  };

  it('keeps a deterministic DENY and copies retrieved policy evidence', async () => {
    const shortCircuit = buildSodConflictRecommendation({
      sodConflicts: [conflict],
    })!;
    const service = new RecommendationGroundingService(
      makeRagServiceMock([[sodChunk]]),
    );
    const outcome = await service.groundSodDenial(shortCircuit, [conflict]);

    expect(outcome.recommendation.decision).toBe('DENY');
    expect(outcome.decisionSource).toBe('SOD_RULE');
    expect(outcome.recommendation.policy_citations[0].excerpt).toBe(
      sodChunk.content,
    );
  });

  it('fails closed when SoD policy evidence cannot be retrieved', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const shortCircuit = buildSodConflictRecommendation({
      sodConflicts: [conflict],
    })!;
    const rag = makeRagServiceMock();
    rag.retrieveRelevantChunks.mockRejectedValueOnce(new Error('offline'));
    const service = new RecommendationGroundingService(rag);
    const outcome = await service.groundSodDenial(shortCircuit, [conflict]);

    expect(outcome.recommendation.decision).toBe('ESCALATE');
    expect(outcome.audit.evidenceRetrievalFailed).toBe(true);
  });
});
