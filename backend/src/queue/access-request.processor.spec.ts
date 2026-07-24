import { Job } from 'bullmq';
import { AgentService } from '../agent/agent.service';
import { RecommendationResult } from '../agent/agent.types';
import { EntitlementLookupService } from '../entitlements/entitlement-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import { RagService } from '../rag/rag.service';
import {
  AccessRequestJobData,
  AccessRequestProcessor,
  buildSodConflictRecommendation,
  resolveCitations,
} from './access-request.processor';

// A tx client used inside the interactive $transaction for the recommendation
// persistence step.
function makeTxMock() {
  return {
    aiRecommendation: { create: jest.fn().mockResolvedValue({ id: 'rec-1' }) },
    aiRecommendationCitation: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    accessRequest: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

function makePrismaMock(accessRequest: unknown) {
  const tx = makeTxMock();
  const prisma = {
    accessRequest: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(accessRequest),
      update: jest.fn().mockReturnValue('update-op'),
    },
    auditLog: { create: jest.fn().mockReturnValue('audit-op') },
    // Dual-mode: array form (entitlement step) resolves; function form
    // (recommendation step) executes the callback against the tx mock.
    $transaction: jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (t: unknown) => unknown)(tx);
      }
      return Promise.resolve(arg);
    }),
  } as unknown as PrismaService & {
    accessRequest: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  return { prisma, tx };
}

const ACCESS_REQUEST_ROW = {
  id: 'ar-1',
  requestId: 'req-1',
  employeeId: 'EMP-84402',
  requestType: 'GRANT_ENTITLEMENT',
  targetSystem: 'VENDOR_PAYMENTS',
  entitlementKey: 'PAYMENT_APPROVE',
  justification: 'Need to approve vendor payments.',
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

const AGENT_RESULT: RecommendationResult = {
  recommendation: {
    decision: 'DENY',
    justification: 'SoD-FIN-01 conflict: requester already holds PAYMENT_CREATE.',
    policy_citations: [
      {
        document_name: 'POL-FIN-003',
        section: '2.3',
        excerpt: 'must not be held together',
      },
    ],
    confidence: 0.93,
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

function makeDeps(accessRequest: unknown, lookupResult: unknown = LOOKUP_RESULT) {
  const { prisma, tx } = makePrismaMock(accessRequest);
  const entitlementLookupService = {
    lookup: jest.fn().mockResolvedValue(lookupResult),
  } as unknown as EntitlementLookupService;
  const ragService = {
    retrieveRelevantChunks: jest.fn().mockResolvedValue(CHUNKS),
  } as unknown as RagService & { retrieveRelevantChunks: jest.Mock };
  const agentService = {
    recommend: jest.fn().mockResolvedValue(AGENT_RESULT),
  } as unknown as AgentService & { recommend: jest.Mock };
  const processor = new AccessRequestProcessor(
    prisma,
    entitlementLookupService,
    ragService,
    agentService,
  );
  return { processor, prisma, tx, entitlementLookupService, ragService, agentService };
}

describe('AccessRequestProcessor — entitlement loading', () => {
  it('loads entitlements and persists ENTITLEMENTS_LOADED in a transaction', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );

    await processor.process(JOB);

    expect(entitlementLookupService.lookup).toHaveBeenCalledWith(
      'EMP-84402',
      'VENDOR_PAYMENTS',
      'PAYMENT_APPROVE',
    );
    expect(prisma.accessRequest.update).toHaveBeenCalledWith({
      where: { id: 'ar-1' },
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
    expect(prisma.$transaction).toHaveBeenCalledWith(['update-op', 'audit-op']);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'ENTITLEMENTS_LOADED' }),
      }),
    );
  });

  it('serializes grantedDate to an ISO string before persisting the snapshot', async () => {
    const { processor, prisma } = makeDeps(ACCESS_REQUEST_ROW);

    await processor.process(JOB);

    const snapshot = (prisma.accessRequest.update as jest.Mock).mock.calls[0][0]
      .data.entitlementSnapshot;
    expect(typeof snapshot.currentActiveEntitlements[0].grantedDate).toBe(
      'string',
    );
    expect(snapshot.currentActiveEntitlements[0].grantedDate).toBe(
      '2025-05-18T00:00:00.000Z',
    );
  });
});

describe('AccessRequestProcessor — recommendation', () => {
  it('retrieves chunks, invokes the agent, and persists the recommendation + citations + status', async () => {
    const { processor, tx, ragService, agentService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );

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

    expect(tx.aiRecommendation.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        decision: 'DENY',
        justification: AGENT_RESULT.recommendation.justification,
        confidence: 0.93,
        modelName: 'gpt-4o-mini',
        promptVersion: 'v1',
        rawResponse: AGENT_RESULT.rawResponse,
        attemptNumber: 1,
      },
    });

    // The LLM citation (POL-FIN-003 §2.3) resolves to the real retrieved chunk id.
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

    expect(tx.accessRequest.update).toHaveBeenCalledWith({
      where: { id: 'ar-1' },
      data: { status: 'RECOMMENDED' },
    });
  });

  it('writes an AI_RECOMMENDED audit entry with decision, confidence, and token cost', async () => {
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
          tokenUsage: {
            promptTokens: 1500,
            completionTokens: 180,
            totalTokens: 1680,
          },
          estimatedCostUsd: 0.000333,
          latencyMs: 842,
        },
      },
    });
  });
});

describe('AccessRequestProcessor — SoD conflict short-circuit', () => {
  it('skips RAG retrieval and the agent call, and persists a deterministic DENY', async () => {
    const { processor, tx, ragService, agentService } = makeDeps(
      ACCESS_REQUEST_ROW,
      SOD_LOOKUP_RESULT,
    );

    await processor.process(JOB);

    expect(ragService.retrieveRelevantChunks).not.toHaveBeenCalled();
    expect(agentService.recommend).not.toHaveBeenCalled();

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
      },
    });
    // No retrieved chunks means no citation can be grounded — the deterministic
    // path never calls createMany.
    expect(tx.aiRecommendationCitation.createMany).not.toHaveBeenCalled();
    expect(tx.accessRequest.update).toHaveBeenCalledWith({
      where: { id: 'ar-1' },
      data: { status: 'RECOMMENDED' },
    });
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
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          estimatedCostUsd: 0,
          latencyMs: 0,
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
    expect(result!.recommendation.policy_citations).toEqual([]);
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
  it('records PROCESSING_FAILED (no FAILED status) when a retry remains', async () => {
    const { processor, prisma } = makeDeps(ACCESS_REQUEST_ROW);
    // The entitlement-loading transaction (array form) fails.
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error('connection lost'),
    );

    await expect(processor.process(jobOnAttempt(0))).rejects.toThrow(
      'connection lost',
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        eventType: 'PROCESSING_FAILED',
        actor: 'system:worker',
        payload: {
          attempt: 1,
          maxAttempts: 3,
          finalAttempt: false,
          error: 'connection lost',
          errorStack: expect.stringContaining('connection lost'),
        },
      },
    });
  });

  it('captures a masked stack trace alongside the error message', async () => {
    const { processor, prisma } = makeDeps(ACCESS_REQUEST_ROW);
    const error = new Error('lookup failed for EMP-52190');
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(error);

    await expect(processor.process(jobOnAttempt(0))).rejects.toThrow();

    const payload = (prisma.auditLog.create as jest.Mock).mock.calls.find(
      (call) => call[0].data.eventType === 'PROCESSING_FAILED',
    )[0].data.payload;
    // The stack trace is real (contains this test file's own frames)...
    expect(payload.errorStack).toContain('access-request.processor.spec.ts');
    // ...but the employee id embedded in the message is still masked, and the
    // masking doesn't strip surrounding stack structure.
    expect(payload.errorStack).toContain('EMP-***90');
    expect(payload.errorStack).not.toContain('52190');
  });

  it('transitions to FAILED and logs the failure on the final attempt', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );
    (entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error('lookup exploded'),
    );

    await expect(processor.process(jobOnAttempt(2))).rejects.toThrow(
      'lookup exploded',
    );

    expect(prisma.accessRequest.update).toHaveBeenCalledWith({
      where: { id: 'ar-1' },
      data: { status: 'FAILED' },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(['update-op', 'audit-op']);
  });

  it('propagates and records failure when the agent cannot produce valid output', async () => {
    const { processor, prisma, agentService } = makeDeps(ACCESS_REQUEST_ROW);
    agentService.recommend.mockRejectedValue(new Error('agent gave up'));

    await expect(processor.process(jobOnAttempt(0))).rejects.toThrow(
      'agent gave up',
    );

    // Entitlements still loaded (first transaction), then the failure recorded.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PROCESSING_FAILED',
          payload: expect.objectContaining({ error: 'agent gave up' }),
        }),
      }),
    );
  });

  it('masks any EMP-/CC- identifier in an error message before logging or persisting it', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(
      ACCESS_REQUEST_ROW,
    );
    (entitlementLookupService.lookup as jest.Mock).mockRejectedValue(
      new Error('lookup failed for EMP-52190 in cost center CC-FIN-07'),
    );

    await expect(processor.process(jobOnAttempt(0))).rejects.toThrow();

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PROCESSING_FAILED',
          payload: expect.objectContaining({
            error: expect.stringContaining('EMP-***90'),
          }),
        }),
      }),
    );
    const payload = (prisma.auditLog.create as jest.Mock).mock.calls.find(
      (call) => call[0].data.eventType === 'PROCESSING_FAILED',
    )[0].data.payload;
    expect(payload.error).not.toContain('52190');
    expect(payload.error).toContain('CC-****07');
    expect(payload.error).not.toContain('FIN-07');
  });

  it('propagates an error when the access request cannot be found and never looks up entitlements', async () => {
    const { processor, prisma, entitlementLookupService } = makeDeps(undefined);
    (prisma.accessRequest.findUniqueOrThrow as jest.Mock).mockRejectedValue(
      new Error('No AccessRequest found'),
    );

    await expect(processor.process(jobOnAttempt(0))).rejects.toThrow(
      'No AccessRequest found',
    );
    expect(entitlementLookupService.lookup).not.toHaveBeenCalled();
  });
});

describe('resolveCitations', () => {
  it('maps citations to retrieved chunk ids by document and section number', () => {
    const resolved = resolveCitations(
      [{ document_name: 'POL-FIN-003', section: '§2.3', excerpt: 'quoted text' }],
      CHUNKS,
    );
    expect(resolved).toEqual([
      {
        policyChunkId: 'chunk-1',
        documentName: 'POL-FIN-003',
        section: '2.3 Mandatory Separation of Duties',
        excerpt: 'quoted text',
      },
    ]);
  });

  it('drops citations that match no retrieved chunk (grounding gate)', () => {
    const resolved = resolveCitations(
      [{ document_name: 'POL-NONEXISTENT-999', section: '1', excerpt: 'made up' }],
      CHUNKS,
    );
    expect(resolved).toEqual([]);
  });

  it('de-duplicates citations that resolve to the same chunk', () => {
    const resolved = resolveCitations(
      [
        { document_name: 'POL-FIN-003', section: '2.3', excerpt: 'a' },
        { document_name: 'POL-FIN-003', section: '2.3', excerpt: 'b' },
      ],
      CHUNKS,
    );
    expect(resolved).toHaveLength(1);
  });
});
