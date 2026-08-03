import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AgentService } from '../agent/agent.service';
import { SanitizedProcessingError } from './processing-error.util';
import {
  GroundedRecommendation,
  PolicyCitation,
  RecommendationResult,
} from '../agent/agent.types';
import { EntitlementLookupService } from '../entitlements/entitlement-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  OperatingRuleRetrievalService,
  RetrievedOperatingRule,
} from '../precedents/operating-rule-retrieval.service';
import {
  PrecedentRetrievalService,
  RetrievedPrecedent,
} from '../precedents/precedent-retrieval.service';
import { RagService } from '../rag/rag.service';
import {
  AccessRequestJobData,
  AccessRequestProcessor,
  buildSodConflictRecommendation,
} from './access-request.processor';
import {
  GroundedRecommendationOutcome,
  RecommendationGroundingService,
} from './recommendation-grounding.service';

// A tx client used inside every interactive $transaction in this processor
// (entitlement loading and recommendation persistence both use the
// interactive/callback form now, so their CAS status guards can inspect the
// updateMany count before deciding what else to persist).
function makeTxMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accessRequest: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    aiRecommendation: { create: jest.fn().mockResolvedValue({ id: 'rec-1' }) },
    aiRecommendationCitation: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    precedentCitation: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function makePrismaMock(accessRequest: unknown, tx = makeTxMock()) {
  const prisma = {
    accessRequest: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(accessRequest),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockReturnValue('audit-op') },
    // Dual-mode: array form (recordFailure's final-attempt transaction)
    // resolves the array; function form (everything else) executes the
    // callback against the tx mock.
    $transaction: jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (t: unknown) => unknown)(tx);
      }
      return Promise.resolve(arg);
    }),
  } as unknown as PrismaService & {
    accessRequest: { findUniqueOrThrow: jest.Mock; updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  return { prisma, tx };
}

const ACCESS_REQUEST_ROW = {
  id: 'ar-1',
  requestId: 'req-1',
  status: 'PENDING',
  employeeId: 'EMP-84402',
  requestType: 'GRANT_ENTITLEMENT',
  targetSystem: 'VENDOR_PAYMENTS',
  entitlementKey: 'PAYMENT_APPROVE',
  justification: 'Need to approve vendor payments.',
  requesterTitle: 'Finance Analyst',
  requesterDepartment: 'Finance',
  requesterCostCenter: 'CC-FIN-12',
};

const CHUNKS = [
  {
    id: 'chunk-1',
    documentName: 'POL-FIN-003',
    section: '2.3 Mandatory Separation of Duties',
    content: 'PAYMENT_CREATE and PAYMENT_APPROVE must not be held together.',
    similarity: 0.71,
  },
];

const PRECEDENTS: RetrievedPrecedent[] = [
  {
    id: 'precedent-1',
    summary: 'Finance granted PAYMENT_APPROVE for a comparable governed request.',
    outcome: 'GRANT',
    targetSystem: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_APPROVE',
    department: 'Finance',
    costCenter: 'CC-FIN-12',
    policyVersionSnapshot: [],
    createdAt: new Date('2026-07-30T12:00:00.000Z'),
    similarity: 0.91,
  },
];

const OPERATING_RULES: RetrievedOperatingRule[] = [
  {
    id: 'rule-1',
    targetSystem: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_APPROVE',
    patternType: 'RECURRING_EXCEPTION',
    guidance:
      'Escalate PAYMENT_APPROVE requests to Finance Controls until the quarterly review closes.',
    approvedAt: new Date('2026-07-28T09:00:00.000Z'),
  },
];

const AGENT_RESULT: RecommendationResult = {
  recommendation: {
    decision: 'DENY',
    justification: 'SoD-FIN-01 conflict: requester already holds PAYMENT_CREATE.',
    policy_citation_refs: [{ source_id: 'POLICY_SOURCE_001' }],
    precedent_citations: [
      {
        precedent_id: 'precedent-1',
        relevance_reason: 'Same system, entitlement, department, and cost center.',
      },
    ],
    precedent_review: [{ precedent_id: 'precedent-1', applies: true }],
    operating_rule_review: [],
    confidence: 0.93,
    conflict_detected: false,
    conflict_explanation: '',
  },
  modelName: 'gpt-4o-mini',
  promptVersion: 'v1',
  rawResponse: { decision: 'DENY' },
  attemptNumber: 1,
  usage: {
    promptTokens: 1500,
    completionTokens: 180,
    totalTokens: 1680,
    estimatedCostUsd: 0.000333,
    latencyMs: 842,
  },
};

// The processor delegates all grounding-policy decisions to
// RecommendationGroundingService (covered in its own spec) — these tests
// only check that the processor calls it, and persists exactly what it
// returns. This is the grounded outcome a valid LLM source selection would
// produce after the backend materializes the authoritative citation.
const GROUNDED_LLM_OUTCOME: GroundedRecommendationOutcome = {
  recommendation: {
    decision: AGENT_RESULT.recommendation.decision,
    justification: AGENT_RESULT.recommendation.justification,
    policy_citations: [
      {
        document_name: 'POL-FIN-003',
        section: '2.3 Mandatory Separation of Duties',
        excerpt: 'must not be held together',
      },
    ],
    precedent_citations: AGENT_RESULT.recommendation.precedent_citations,
    precedent_review: AGENT_RESULT.recommendation.precedent_review,
    operating_rule_review: AGENT_RESULT.recommendation.operating_rule_review,
    confidence: AGENT_RESULT.recommendation.confidence,
    conflict_detected: AGENT_RESULT.recommendation.conflict_detected,
    conflict_explanation: AGENT_RESULT.recommendation.conflict_explanation,
  },
  citations: [
    {
      policyChunkId: 'chunk-1',
      documentName: 'POL-FIN-003',
      section: '2.3 Mandatory Separation of Duties',
      excerpt: 'must not be held together',
    },
  ],
  precedentCitations: [
    {
      precedentRecordId: 'precedent-1',
      relevanceReason: 'Same system, entitlement, department, and cost center.',
      outcomeSnapshot: 'GRANT',
      summarySnapshot: PRECEDENTS[0].summary,
    },
  ],
  rawResponse: AGENT_RESULT.rawResponse,
  decisionSource: 'MODEL',
  audit: {
    proposedCitationCount: 1,
    validatedCitationCount: 1,
    rejectionReasonCounts: {},
    proposedPrecedentCitationCount: 1,
    validatedPrecedentCitationCount: 1,
    precedentRejectionReasonCounts: {},
    conflictDetected: false,
    convertedToEscalateForConflict: false,
    convertedToEscalateForPrecedentReview: false,
    convertedToEscalateForOperatingRuleReview: false,
    convertedToEscalate: false,
    sodConflictDetected: false,
    evidenceRetrievalFailed: false,
  },
};

const LOOKUP_RESULT = {
  currentActiveEntitlements: [
    {
      systemName: 'VENDOR_PAYMENTS',
      entitlementKey: 'PAYMENT_CREATE',
      grantedDate: new Date('2025-05-18T00:00:00.000Z'),
    },
  ],
  alreadyHasRequestedEntitlement: false,
  // Empty by default so the "recommendation" describe block below exercises
  // the ordinary RAG + agent pipeline. The SoD short-circuit has its own
  // fixture (SOD_LOOKUP_RESULT) and describe block further down.
  sodConflicts: [] as Array<{
    ruleId: string;
    conflictingEntitlementKey: string;
    description: string;
  }>,
};

const SOD_LOOKUP_RESULT = {
  ...LOOKUP_RESULT,
  sodConflicts: [
    {
      ruleId: 'SoD-FIN-01',
      conflictingEntitlementKey: 'PAYMENT_CREATE',
      description: 'payment creation and approval must not be held simultaneously',
    },
  ],
};

const JOB = {
  id: 'job-1',
  data: { accessRequestId: 'ar-1', requestId: 'req-1' },
  attemptsMade: 0,
  opts: { attempts: 3 },
} as unknown as Job<AccessRequestJobData>;

function jobOnAttempt(attemptsMade: number): Job<AccessRequestJobData> {
  return {
    id: 'job-1',
    data: { accessRequestId: 'ar-1', requestId: 'req-1' },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<AccessRequestJobData>;
}

function groundModelRecommendation(
  recommendation: RecommendationResult['recommendation'],
  policyCitations: PolicyCitation[] = [],
): GroundedRecommendation {
  const { policy_citation_refs: _selectedSources, ...fields } = recommendation;
  return { ...fields, policy_citations: policyCitations };
}

function makeGroundingMock(
  llmOutcome: GroundedRecommendationOutcome = GROUNDED_LLM_OUTCOME,
  sodOutcomeFor?: (shortCircuited: RecommendationResult) => GroundedRecommendationOutcome,
) {
  return {
    groundLlmRecommendation: jest.fn().mockReturnValue(llmOutcome),
    groundSodDenial: jest.fn().mockImplementation(async (shortCircuited: RecommendationResult) =>
      sodOutcomeFor
        ? sodOutcomeFor(shortCircuited)
        : ({
            recommendation: groundModelRecommendation(
              shortCircuited.recommendation,
            ),
            citations: [],
            precedentCitations: [],
            rawResponse: shortCircuited.rawResponse,
            decisionSource: 'SOD_RULE',
            audit: {
              proposedCitationCount: 0,
              validatedCitationCount: 0,
              rejectionReasonCounts: {},
              proposedPrecedentCitationCount: 0,
              validatedPrecedentCitationCount: 0,
              precedentRejectionReasonCounts: {},
              conflictDetected: false,
              convertedToEscalateForConflict: false,
              convertedToEscalateForPrecedentReview: false,
              convertedToEscalateForOperatingRuleReview: false,
              convertedToEscalate: false,
              sodConflictDetected: true,
              evidenceRetrievalFailed: false,
            },
          } satisfies GroundedRecommendationOutcome)),
  } as unknown as RecommendationGroundingService & {
    groundLlmRecommendation: jest.Mock;
    groundSodDenial: jest.Mock;
  };
}

function makeDeps(
  accessRequest: unknown,
  lookupResult: unknown = LOOKUP_RESULT,
  tx = makeTxMock(),
  grounding = makeGroundingMock(),
) {
  const { prisma } = makePrismaMock(accessRequest, tx);
  const entitlementLookupService = {
    lookup: jest.fn().mockResolvedValue(lookupResult),
  } as unknown as EntitlementLookupService;
  const ragService = {
    retrieveRelevantChunks: jest.fn().mockResolvedValue(CHUNKS),
  } as unknown as RagService & { retrieveRelevantChunks: jest.Mock };
  const precedentRetrievalService = {
    retrieveRelevantPrecedents: jest.fn().mockResolvedValue(PRECEDENTS),
  } as unknown as PrecedentRetrievalService & {
    retrieveRelevantPrecedents: jest.Mock;
  };
  const operatingRuleRetrievalService = {
    retrieveApplicableRules: jest.fn().mockResolvedValue(OPERATING_RULES),
  } as unknown as OperatingRuleRetrievalService & {
    retrieveApplicableRules: jest.Mock;
  };
  const agentService = {
    recommend: jest.fn().mockResolvedValue(AGENT_RESULT),
  } as unknown as AgentService & { recommend: jest.Mock };
  const processor = new AccessRequestProcessor(
    prisma,
    entitlementLookupService,
    ragService,
    precedentRetrievalService,
    operatingRuleRetrievalService,
    agentService,
    grounding,
  );
  return {
    processor,
    prisma,
    tx,
    entitlementLookupService,
    ragService,
    precedentRetrievalService,
    operatingRuleRetrievalService,
    agentService,
    grounding,
  };
}

describe('AccessRequestProcessor — entitlement loading', () => {
  it('loads entitlements and persists ENTITLEMENTS_LOADED conditionally (not DECIDED)', async () => {
    const { processor, tx, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );

    await processor.process(JOB);

    expect(entitlementLookupService.lookup).toHaveBeenCalledWith(
      'EMP-84402',
      'VENDOR_PAYMENTS',
      'PAYMENT_APPROVE',
    );
    expect(tx.accessRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'ar-1', status: { not: 'DECIDED' } },
      data: {
        status: 'ENTITLEMENTS_LOADED',
        entitlementSnapshot: {
          currentActiveEntitlements: [
            {
              systemName: 'VENDOR_PAYMENTS',
              entitlementKey: 'PAYMENT_CREATE',
              grantedDate: '2025-05-18T00:00:00.000Z',
            },
          ],
          alreadyHasRequestedEntitlement: false,
          sodConflicts: LOOKUP_RESULT.sodConflicts,
        },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'ENTITLEMENTS_LOADED' }),
      }),
    );
  });

  it('serializes grantedDate to an ISO string before persisting the snapshot', async () => {
    const { processor, tx } = makeDeps(ACCESS_REQUEST_ROW);

    await processor.process(JOB);

    const snapshot = (tx.accessRequest.updateMany as jest.Mock).mock.calls[0][0]
      .data.entitlementSnapshot;
    expect(typeof snapshot.currentActiveEntitlements[0].grantedDate).toBe(
      'string',
    );
    expect(snapshot.currentActiveEntitlements[0].grantedDate).toBe(
      '2025-05-18T00:00:00.000Z',
    );
  });

  it('stops safely at job start when the request is already DECIDED — no lookup, no writes', async () => {
    const { processor, entitlementLookupService, tx } = makeDeps({
      ...ACCESS_REQUEST_ROW,
      status: 'DECIDED',
    });

    await processor.process(JOB);

    expect(entitlementLookupService.lookup).not.toHaveBeenCalled();
    expect(tx.accessRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('discards the entitlement snapshot if the request became DECIDED during the lookup itself', async () => {
    const tx = makeTxMock({
      accessRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    });
    const { processor, agentService } = makeDeps(ACCESS_REQUEST_ROW, LOOKUP_RESULT, tx);

    await processor.process(JOB);

    // The CAS inside loadEntitlements's transaction found zero rows (a
    // decision landed mid-lookup): no audit entry, and the pipeline stops
    // there — generateRecommendation (and therefore the agent) never runs.
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(agentService.recommend).not.toHaveBeenCalled();
  });
});

describe('AccessRequestProcessor — recommendation', () => {
  it('retrieves chunks, invokes the agent, grounds via RecommendationGroundingService, and persists exactly what it returns', async () => {
    const {
      processor,
      tx,
      ragService,
      precedentRetrievalService,
      operatingRuleRetrievalService,
      agentService,
      grounding,
    } = makeDeps(ACCESS_REQUEST_ROW);

    await processor.process(JOB);

    expect(ragService.retrieveRelevantChunks).toHaveBeenCalledTimes(1);
    // The agent receives the structured request, the authoritative snapshot,
    // and the retrieved chunks.
    const agentInput = agentService.recommend.mock.calls[0][0];
    expect(agentInput.accessRequest.entitlementKey).toBe('PAYMENT_APPROVE');
    expect(agentInput.entitlementSnapshot.sodConflicts).toEqual(
      LOOKUP_RESULT.sodConflicts,
    );
    expect(agentInput.retrievedChunks).toBe(CHUNKS);
    expect(precedentRetrievalService.retrieveRelevantPrecedents).toHaveBeenCalledWith(
      {
        requestType: 'GRANT_ENTITLEMENT',
        targetSystem: 'VENDOR_PAYMENTS',
        entitlementKey: 'PAYMENT_APPROVE',
        requesterTitle: 'Finance Analyst',
        requesterDepartment: 'Finance',
        requesterCostCenter: 'CC-FIN-12',
        justification: 'Need to approve vendor payments.',
      },
      {
        limit: 3,
      },
    );
    // Governance-approved rules for this exact scope reach the model. This is
    // the mechanism by which an approved change influences a later request
    // with no code or prompt deployment, so it is asserted rather than assumed.
    expect(
      operatingRuleRetrievalService.retrieveApplicableRules,
    ).toHaveBeenCalledWith('VENDOR_PAYMENTS', 'PAYMENT_APPROVE');
    expect(agentInput.operatingRules).toEqual([
      {
        id: 'rule-1',
        guidance: OPERATING_RULES[0].guidance,
        approvedAt: OPERATING_RULES[0].approvedAt.toISOString(),
      },
    ]);

    // department/costCenter/recordedAt are forwarded, not dropped: the prompt
    // asks the model to judge whether a precedent covers the same eligible
    // department/cost-center category, so withholding those fields would be
    // asking for a judgment on evidence it was never given.
    expect(agentInput.retrievedPrecedents).toEqual([
      {
        id: 'precedent-1',
        summary: PRECEDENTS[0].summary,
        outcome: 'GRANT',
        targetSystem: 'VENDOR_PAYMENTS',
        entitlementKey: 'PAYMENT_APPROVE',
        department: PRECEDENTS[0].department,
        costCenter: PRECEDENTS[0].costCenter,
        recordedAt: PRECEDENTS[0].createdAt.toISOString(),
        similarity: 0.91,
      },
    ]);

    // Grounding is invoked with the raw agent result and the exact chunks
    // retrieved for this attempt — never with anything the agent didn't see.
    // The gate receives the operating rules as well, so a rule the model
    // ignored is caught deterministically rather than trusted.
    expect(grounding.groundLlmRecommendation).toHaveBeenCalledWith(
      AGENT_RESULT,
      CHUNKS,
      PRECEDENTS,
      agentInput.operatingRules,
    );
    expect(grounding.groundSodDenial).not.toHaveBeenCalled();

    // Second updateMany call in this test is the RECOMMENDED-stage CAS (the
    // first was ENTITLEMENTS_LOADED).
    expect(tx.accessRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'ar-1', status: { not: 'DECIDED' } },
      data: { status: 'RECOMMENDED' },
    });

    // Persisted decision/citations come from the grounding outcome, not
    // straight from the agent's raw recommendation.
    expect(tx.aiRecommendation.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        decision: GROUNDED_LLM_OUTCOME.recommendation.decision,
        justification: GROUNDED_LLM_OUTCOME.recommendation.justification,
        confidence: GROUNDED_LLM_OUTCOME.recommendation.confidence,
        modelName: 'gpt-4o-mini',
        promptVersion: 'v1',
        rawResponse: AGENT_RESULT.rawResponse,
        attemptNumber: 1,
        // Provenance: what the agent itself proposed, recorded alongside the
        // effective (post-grounding) decision above.
        modelDecision: AGENT_RESULT.recommendation.decision,
        modelConfidence: AGENT_RESULT.recommendation.confidence,
        decisionSource: GROUNDED_LLM_OUTCOME.decisionSource,
        // Which governance-approved rules were in scope, so "an approved rule
        // influenced this request" is checkable from the stored row.
        retrievedOperatingRuleIds: ['rule-1'],
      },
    });

    expect(tx.aiRecommendationCitation.createMany).toHaveBeenCalledWith({
      data: [
        {
          aiRecommendationId: 'rec-1',
          policyChunkId: 'chunk-1',
          documentName: 'POL-FIN-003',
          section: '2.3 Mandatory Separation of Duties',
          excerpt: 'must not be held together',
        },
      ],
    });
    expect(tx.precedentCitation.createMany).toHaveBeenCalledWith({
      data: [
        {
          aiRecommendationId: 'rec-1',
          precedentRecordId: 'precedent-1',
          relevanceReason:
            'Same system, entitlement, department, and cost center.',
          outcomeSnapshot: 'GRANT',
          summarySnapshot: PRECEDENTS[0].summary,
        },
      ],
    });
  });

  it('writes an AI_RECOMMENDED audit entry including the grounding audit payload', async () => {
    const { processor, tx } = makeDeps(ACCESS_REQUEST_ROW);

    await processor.process(JOB);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        eventType: 'AI_RECOMMENDED',
        actor: 'system:recommendation-agent',
        payload: {
          decision: 'DENY',
          confidence: 0.93,
          model: 'gpt-4o-mini',
          promptVersion: 'v1',
          attemptNumber: 1,
          citationCount: 1,
          decisionSource: 'MODEL',
          modelDecision: 'DENY',
          retrievedOperatingRuleCount: 1,
          tokenUsage: {
            promptTokens: 1500,
            completionTokens: 180,
            totalTokens: 1680,
          },
          estimatedCostUsd: 0.000333,
          latencyMs: 842,
          grounding: GROUNDED_LLM_OUTCOME.audit,
        },
      },
    });
  });

  it('persists an ESCALATE (and zero citations) when the grounding service downgrades the recommendation', async () => {
    const escalated: GroundedRecommendationOutcome = {
      recommendation: {
        decision: 'ESCALATE',
        justification: 'Escalated automatically: policy evidence could not be verified.',
        policy_citations: [],
        precedent_citations: [],
        precedent_review: [],
        operating_rule_review: [],
        confidence: 0.93,
        conflict_detected: false,
        conflict_explanation: '',
      },
      citations: [],
      precedentCitations: [],
      rawResponse: { note: 'sanitized' },
      decisionSource: 'MODEL',
      audit: {
        proposedCitationCount: 1,
        validatedCitationCount: 0,
        rejectionReasonCounts: { UNKNOWN_SOURCE_ID: 1 },
        proposedPrecedentCitationCount: 0,
        validatedPrecedentCitationCount: 0,
        precedentRejectionReasonCounts: {},
        conflictDetected: false,
        convertedToEscalateForConflict: false,
        convertedToEscalateForPrecedentReview: false,
        convertedToEscalateForOperatingRuleReview: false,
        convertedToEscalate: true,
        sodConflictDetected: false,
        evidenceRetrievalFailed: false,
      },
    };
    const grounding = makeGroundingMock(escalated);
    const { processor, tx } = makeDeps(ACCESS_REQUEST_ROW, LOOKUP_RESULT, undefined, grounding);

    await processor.process(JOB);

    expect(tx.aiRecommendation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'ESCALATE',
          // Never the agent's original rawResponse (which would still carry
          // the unknown Source ID) — the grounding outcome's sanitized one.
          rawResponse: { note: 'sanitized' },
        }),
      }),
    );
    expect(tx.aiRecommendationCitation.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            grounding: expect.objectContaining({ convertedToEscalate: true }),
          }),
        }),
      }),
    );
  });

  it('a human decision winning the race (RECOMMENDED-stage CAS matches zero rows) discards the recommendation entirely', async () => {
    let call = 0;
    const tx = makeTxMock({
      accessRequest: {
        // First updateMany (ENTITLEMENTS_LOADED) succeeds; second
        // (RECOMMENDED) loses the race — a decision landed while the agent
        // was still generating its recommendation.
        updateMany: jest.fn().mockImplementation(() => {
          call += 1;
          return Promise.resolve({ count: call === 1 ? 1 : 0 });
        }),
      },
    });
    const { processor, agentService } = makeDeps(ACCESS_REQUEST_ROW, LOOKUP_RESULT, tx);

    await processor.process(JOB);

    // The agent (and grounding) still ran before the final CAS check, but
    // nothing from the result was persisted.
    expect(agentService.recommend).toHaveBeenCalledTimes(1);
    expect(tx.aiRecommendation.create).not.toHaveBeenCalled();
    expect(tx.aiRecommendationCitation.createMany).not.toHaveBeenCalled();
    // Only the ENTITLEMENTS_LOADED audit entry was written — never AI_RECOMMENDED.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'ENTITLEMENTS_LOADED' }),
      }),
    );
  });
});

describe('AccessRequestProcessor — SoD conflict short-circuit', () => {
  it('skips RAG retrieval and the agent call, and delegates grounding to groundSodDenial', async () => {
    const {
      processor,
      tx,
      ragService,
      precedentRetrievalService,
      agentService,
      grounding,
    } = makeDeps(ACCESS_REQUEST_ROW, SOD_LOOKUP_RESULT);

    await processor.process(JOB);

    expect(ragService.retrieveRelevantChunks).not.toHaveBeenCalled();
    expect(
      precedentRetrievalService.retrieveRelevantPrecedents,
    ).not.toHaveBeenCalled();
    expect(agentService.recommend).not.toHaveBeenCalled();
    expect(grounding.groundLlmRecommendation).not.toHaveBeenCalled();
    expect(grounding.groundSodDenial).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: 'system:sod-conflict-rule' }),
      SOD_LOOKUP_RESULT.sodConflicts,
    );

    expect(tx.aiRecommendation.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        decision: 'DENY',
        justification: expect.stringContaining('SoD-FIN-01'),
        confidence: 1,
        modelName: 'system:sod-conflict-rule',
        promptVersion: 'n/a',
        rawResponse: expect.objectContaining({ decision: 'DENY' }),
        attemptNumber: 1,
        // No model was invoked; the deterministic rule is identified solely
        // by decisionSource/modelName and must not masquerade as an AI vote.
        modelDecision: null,
        modelConfidence: null,
        decisionSource: 'SOD_RULE',
        // The short-circuit never reaches the LLM, so no rule was consulted.
        retrievedOperatingRuleIds: [],
      },
    });
    // The default SoD grounding mock returns zero citations.
    expect(tx.aiRecommendationCitation.createMany).not.toHaveBeenCalled();
    expect(tx.accessRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'ar-1', status: { not: 'DECIDED' } },
      data: { status: 'RECOMMENDED' },
    });
  });

  it('persists a verified citation when groundSodDenial returns one', async () => {
    const grounding = makeGroundingMock(GROUNDED_LLM_OUTCOME, (shortCircuited) => ({
      recommendation: groundModelRecommendation(shortCircuited.recommendation, [
        {
          document_name: 'POL-FIN-003',
          section: '2.3',
          excerpt:
            'payment creation and payment approval must not be held simultaneously',
        },
      ]),
      citations: [
        {
          policyChunkId: 'sod-chunk-1',
          documentName: 'POL-FIN-003',
          section: '2.3',
          excerpt: 'payment creation and payment approval must not be held simultaneously',
        },
      ],
      precedentCitations: [],
      rawResponse: shortCircuited.rawResponse,
      decisionSource: 'SOD_RULE',
      audit: {
        proposedCitationCount: 0,
        validatedCitationCount: 1,
        rejectionReasonCounts: {},
        proposedPrecedentCitationCount: 0,
        validatedPrecedentCitationCount: 0,
        precedentRejectionReasonCounts: {},
        conflictDetected: false,
        convertedToEscalateForConflict: false,
        convertedToEscalateForPrecedentReview: false,
        convertedToEscalateForOperatingRuleReview: false,
        convertedToEscalate: false,
        sodConflictDetected: true,
        evidenceRetrievalFailed: false,
      },
    }));
    const { processor, tx } = makeDeps(
      ACCESS_REQUEST_ROW,
      SOD_LOOKUP_RESULT,
      undefined,
      grounding,
    );

    await processor.process(JOB);

    expect(tx.aiRecommendation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: 'DENY' }) }),
    );
    expect(tx.aiRecommendationCitation.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          aiRecommendationId: 'rec-1',
          policyChunkId: 'sod-chunk-1',
        }),
      ],
    });
  });

  it('escalates when groundSodDenial cannot verify supporting policy evidence', async () => {
    const grounding = makeGroundingMock(GROUNDED_LLM_OUTCOME, (shortCircuited) => ({
      recommendation: {
        ...groundModelRecommendation(shortCircuited.recommendation),
        decision: 'ESCALATE',
        justification: 'Escalated: SoD conflict detected but no citation could be verified.',
        policy_citations: [],
      },
      citations: [],
      precedentCitations: [],
      rawResponse: shortCircuited.rawResponse,
      decisionSource: 'GROUNDING_GATE',
      audit: {
        proposedCitationCount: 0,
        validatedCitationCount: 0,
        rejectionReasonCounts: {},
        proposedPrecedentCitationCount: 0,
        validatedPrecedentCitationCount: 0,
        precedentRejectionReasonCounts: {},
        conflictDetected: false,
        convertedToEscalateForConflict: false,
        convertedToEscalateForPrecedentReview: false,
        convertedToEscalateForOperatingRuleReview: false,
        convertedToEscalate: true,
        sodConflictDetected: true,
        evidenceRetrievalFailed: false,
      },
    }));
    const { processor, tx } = makeDeps(
      ACCESS_REQUEST_ROW,
      SOD_LOOKUP_RESULT,
      undefined,
      grounding,
    );

    await processor.process(JOB);

    expect(tx.aiRecommendation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: 'ESCALATE',
          modelDecision: null,
          modelConfidence: null,
          decisionSource: 'GROUNDING_GATE',
        }),
      }),
    );
    expect(tx.aiRecommendationCitation.createMany).not.toHaveBeenCalled();
  });

  it('writes an AI_RECOMMENDED audit entry with zero cost/latency and the sentinel model name', async () => {
    const { processor, tx } = makeDeps(ACCESS_REQUEST_ROW, SOD_LOOKUP_RESULT);

    await processor.process(JOB);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        eventType: 'AI_RECOMMENDED',
        actor: 'system:recommendation-agent',
        payload: {
          decision: 'DENY',
          confidence: 1,
          model: 'system:sod-conflict-rule',
          promptVersion: 'n/a',
          attemptNumber: 1,
          citationCount: 0,
          decisionSource: 'SOD_RULE',
          modelDecision: null,
          retrievedOperatingRuleCount: 0,
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          estimatedCostUsd: 0,
          latencyMs: 0,
          grounding: expect.objectContaining({ sodConflictDetected: true }),
        },
      },
    });
  });
});

describe('buildSodConflictRecommendation', () => {
  it('returns null when there are no SoD conflicts', () => {
    expect(buildSodConflictRecommendation(LOOKUP_RESULT)).toBeNull();
  });

  it('returns a deterministic DENY recommendation naming every conflicting rule', () => {
    const result = buildSodConflictRecommendation(SOD_LOOKUP_RESULT);

    expect(result).not.toBeNull();
    expect(result!.recommendation.decision).toBe('DENY');
    expect(result!.recommendation.confidence).toBe(1);
    expect(result!.recommendation.policy_citation_refs).toEqual([]);
    expect(result!.recommendation.justification).toContain('SoD-FIN-01');
    expect(result!.recommendation.justification).toContain('PAYMENT_CREATE');
    expect(result!.modelName).toBe('system:sod-conflict-rule');
    expect(result!.promptVersion).toBe('n/a');
    expect(result!.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 0,
    });
  });
});

describe('AccessRequestProcessor — failure handling', () => {
  // Every sensitive shape an exception from Prisma, the LLM client, or an HTTP
  // layer could carry. None may reach the audit payload, the log, or BullMQ.
  const SENTINELS = [
    'EMP-52190',
    '52190',
    'CC-FIN-07',
    'FIN-07',
    'internal-redis.corp',
    'db-primary.internal',
    'redis://admin:secret@host',
    'admin:secret',
    'Bearer abc123',
  ];
  const SENTINEL_MESSAGE =
    'lookup failed for EMP-52190 in cost center CC-FIN-07 via ' +
    'redis://admin:secret@host and db-primary.internal, ' +
    'Authorization: Bearer abc123, upstream internal-redis.corp';

  function expectContentFree(surface: string) {
    for (const sentinel of SENTINELS) {
      expect(surface).not.toContain(sentinel);
    }
  }

  function spyOnLoggers() {
    return (['error', 'warn', 'log'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  }

  function loggedText(spies: jest.SpyInstance[]) {
    return spies
      .flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')))
      .join('\n');
  }

  it('records PROCESSING_FAILED with only a stable code and safe context when a retry remains', async () => {
    const { processor, prisma } = makeDeps(ACCESS_REQUEST_ROW);
    // The entitlement-loading transaction (function form) fails.
    (prisma.$transaction as jest.Mock).mockImplementationOnce(() => {
      throw new Error('connection lost');
    });

    await expect(processor.process(jobOnAttempt(0))).rejects.toBeInstanceOf(
      SanitizedProcessingError,
    );

    // Exact payload shape: no `error`, no `errorStack`, nothing
    // exception-derived — only the code and safe state fields.
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        eventType: 'PROCESSING_FAILED',
        actor: 'system:worker',
        payload: {
          attempt: 1,
          maxAttempts: 3,
          finalAttempt: false,
          stage: 'LOAD_ENTITLEMENTS',
          errorCode: 'ENTITLEMENT_LOAD_FAILED',
        },
      },
    });
  });

  it('no exception-derived text reaches the audit payload, the logs, or the BullMQ-facing error', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );
    (entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error(SENTINEL_MESSAGE),
    );
    const spies = spyOnLoggers();

    const rejected = await processor
      .process(jobOnAttempt(0))
      .catch((err: unknown) => err);

    const payload = (prisma.auditLog.create as jest.Mock).mock.calls.find(
      (call) => call[0].data.eventType === 'PROCESSING_FAILED',
    )[0].data.payload;
    const thrown = rejected as SanitizedProcessingError;

    for (const surface of [
      JSON.stringify(payload),
      loggedText(spies),
      thrown.message,
      thrown.stack ?? '',
      JSON.stringify(thrown),
    ]) {
      expectContentFree(surface);
      expect(surface).not.toContain(SENTINEL_MESSAGE);
    }
    // No stack trace is retained anywhere in the persisted payload.
    expect(payload.errorStack).toBeUndefined();
    expect(payload.error).toBeUndefined();
    expect('cause' in thrown).toBe(false);
    jest.restoreAllMocks();
  });

  it('attributes the failure to the stage it occurred in', async () => {
    const load = makeDeps(ACCESS_REQUEST_ROW);
    (load.entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error('boom'),
    );
    await load.processor.process(jobOnAttempt(0)).catch(() => undefined);
    expect(
      (load.prisma.auditLog.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.eventType === 'PROCESSING_FAILED',
      )[0].data.payload,
    ).toMatchObject({
      stage: 'LOAD_ENTITLEMENTS',
      errorCode: 'ENTITLEMENT_LOAD_FAILED',
    });

    const generate = makeDeps(ACCESS_REQUEST_ROW);
    generate.agentService.recommend.mockRejectedValue(new Error('agent gave up'));
    await generate.processor.process(jobOnAttempt(0)).catch(() => undefined);
    expect(
      (generate.prisma.auditLog.create as jest.Mock).mock.calls.find(
        (c) => c[0].data.eventType === 'PROCESSING_FAILED',
      )[0].data.payload,
    ).toMatchObject({
      stage: 'GENERATE_RECOMMENDATION',
      errorCode: 'RECOMMENDATION_FAILED',
    });
  });

  it('transitions to FAILED (conditionally, not DECIDED) on the final attempt', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );
    (entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error('lookup exploded'),
    );

    await expect(processor.process(jobOnAttempt(2))).rejects.toBeInstanceOf(
      SanitizedProcessingError,
    );

    expect(prisma.accessRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'ar-1', status: { not: 'DECIDED' } },
      data: { status: 'FAILED' },
    });
  });

  it('still throws (keeping BullMQ retry/backoff in control) when the agent cannot produce valid output', async () => {
    const { processor, prisma, agentService } = makeDeps(ACCESS_REQUEST_ROW);
    agentService.recommend.mockRejectedValue(new Error('agent gave up'));

    await expect(processor.process(jobOnAttempt(0))).rejects.toBeInstanceOf(
      SanitizedProcessingError,
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PROCESSING_FAILED',
          payload: expect.objectContaining({
            errorCode: 'RECOMMENDATION_FAILED',
          }),
        }),
      }),
    );
  });

  it('does not leak a bookkeeping failure’s own exception when recording the failure fails', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );
    (entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error('boom'),
    );
    (prisma.auditLog.create as jest.Mock).mockImplementation(() => {
      throw new Error(SENTINEL_MESSAGE);
    });
    const spies = spyOnLoggers();

    // The original failure still surfaces (sanitized) to drive the retry.
    await expect(processor.process(jobOnAttempt(0))).rejects.toBeInstanceOf(
      SanitizedProcessingError,
    );

    const logged = loggedText(spies);
    expectContentFree(logged);
    expect(logged).toContain('FAILURE_BOOKKEEPING_FAILED');
    jest.restoreAllMocks();
  });

  it('does not record PROCESSING_FAILED or touch status when a human decision won the race (TerminalRequestError)', async () => {
    let call = 0;
    const tx = makeTxMock({
      accessRequest: {
        updateMany: jest.fn().mockImplementation(() => {
          call += 1;
          return Promise.resolve({ count: call === 1 ? 1 : 0 });
        }),
      },
    });
    const { processor, prisma } = makeDeps(ACCESS_REQUEST_ROW, LOOKUP_RESULT, tx);

    // Should resolve cleanly (not throw, not retry) — a race loss is not a
    // processing failure.
    await expect(processor.process(JOB)).resolves.toBeUndefined();

    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'PROCESSING_FAILED' }),
      }),
    );
  });

  it('propagates a sanitized error when the access request cannot be found, and never looks up entitlements', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(undefined);
    (prisma.accessRequest.findUniqueOrThrow as jest.Mock).mockRejectedValue(
      new Error('No AccessRequest found'),
    );

    const rejected = await processor
      .process(jobOnAttempt(0))
      .catch((err: unknown) => err);

    expect(rejected).toBeInstanceOf(SanitizedProcessingError);
    expect((rejected as SanitizedProcessingError).code).toBe(
      'ENTITLEMENT_LOAD_FAILED',
    );
    expect(entitlementLookupService.lookup).not.toHaveBeenCalled();
  });
});
