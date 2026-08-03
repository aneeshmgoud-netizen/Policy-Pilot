import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PRECEDENT_INGESTION_JOB_NAME } from '../precedents/precedent-ingestion.constants';
import { PrecedentIngestionJobData } from '../precedents/precedent-ingestion.processor';
import { PrismaService } from '../prisma/prisma.service';
import { DecisionExecutionJobData } from './decision-execution.processor';
import { DecisionsService } from './decisions.service';

// Exercises the safety properties around the human decision transaction:
// RECOMMENDED-only, atomic one-terminal-decision transition, rationale
// required whenever the reviewer's outcome disagrees with the AI
// recommendation, and — the point of this refactor — that recordDecision
// NEVER calls anything execution-related directly. It only creates a PENDING
// outbox row and enqueues a job referencing it; DecisionExecutionProcessor
// (covered in its own spec) is what actually executes. Prisma and the BullMQ
// queue are both mocked; $transaction is faked by invoking the callback with
// a `tx` object that mirrors the top-level client shape.

interface AccessRequestRow {
  id: string;
  status: string;
  employeeId: string;
  targetSystem: string;
  entitlementKey: string;
  recommendations: Array<{
    id: string;
    decision: string;
    modelDecision?: string | null;
    modelName?: string;
    decisionSource?: string | null;
  }>;
}

function makeTx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accessRequest: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    humanDecision: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'hd-1', ...data }),
      ),
    },
    decisionFeedback: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'fb-1', ...data }),
      ),
    },
    decisionExecution: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'exec-1', ...data }),
      ),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

function makePrisma(accessRequest: AccessRequestRow | null, tx = makeTx()) {
  return {
    accessRequest: {
      findUnique: jest.fn().mockResolvedValue(accessRequest),
    },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    __tx: tx,
  } as unknown as PrismaService & { __tx: ReturnType<typeof makeTx> };
}

function makeQueue(add: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
  return { add } as unknown as Queue<DecisionExecutionJobData> &
    Queue<PrecedentIngestionJobData> & { add: jest.Mock };
}

const RECOMMENDED_REQUEST: AccessRequestRow = {
  id: 'ar-1',
  status: 'RECOMMENDED',
  employeeId: 'EMP-1',
  targetSystem: 'DATA_WAREHOUSE',
  entitlementKey: 'FIN_DATASET_READ',
  recommendations: [
    {
      id: 'rec-1',
      decision: 'APPROVE',
      modelDecision: 'APPROVE',
      modelName: 'gpt-4o-mini',
      decisionSource: 'MODEL',
    },
  ],
};

describe('DecisionsService.recordDecision', () => {
  it('throws NotFoundException when the access request does not exist', async () => {
    const prisma = makePrisma(null);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('missing', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects deciding a request that is not RECOMMENDED (already DECIDED)', async () => {
    const prisma = makePrisma({ ...RECOMMENDED_REQUEST, status: 'DECIDED' });
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects deciding a request still PENDING (no recommendation yet)', async () => {
    const prisma = makePrisma({ ...RECOMMENDED_REQUEST, status: 'PENDING' });
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(ConflictException);
  });

  it('requires rationale when the outcome disagrees with an APPROVE recommendation', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not require rationale when the outcome agrees with the recommendation', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    const result = await service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice');
    expect(result.overridesRecommendation).toBe(false);
    expect(result.status).toBe('DECIDED');
  });

  it('captures feedback even when the reviewer simply agrees with the AI', async () => {
    // The reason code is required for every decision, not only for overrides:
    // the brief asks the system to preserve why a recommendation was
    // "accepted or changed". Agreement without a recorded reason used to be
    // the default path, which meant the most common outcome recorded the
    // least information — and could never become usable precedent, since the
    // precedent summary is built from this reason code.
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const precedentQueue = makeQueue();
    const service = new DecisionsService(
      prisma,
      makeQueue(),
      precedentQueue,
    );

    const result = await service.recordDecision(
      'ar-1',
      { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' },
      'reviewer:alice',
    );

    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledWith({
      data: {
        humanDecisionId: 'hd-1',
        reasonCode: 'CONFIRMS_POLICY',
        missingContext: null,
        precedentEligible: false,
      },
    });
    // Feedback capture alone is not a precedent nomination — that still
    // requires the reviewer to opt in via precedentEligible.
    expect(precedentQueue.add).not.toHaveBeenCalled();
    const auditPayload = prisma.__tx.auditLog.create.mock.calls[0][0].data.payload;
    expect(auditPayload).toMatchObject({
      feedbackProvided: true,
      reasonCode: 'CONFIRMS_POLICY',
      precedentEligible: false,
    });
    expect(result).toEqual({
      id: 'hd-1',
      accessRequestId: 'ar-1',
      outcome: 'GRANT',
      overridesRecommendation: false,
      status: 'DECIDED',
      executionStatus: 'PENDING',
      feedbackCaptured: true,
    });
  });

  it('creates one feedback row for a supplied reason and returns feedbackCaptured true', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    const result = await service.recordDecision(
      'ar-1',
      {
        outcome: 'GRANT',
        reasonCode: 'MISSING_CONTEXT',
        missingContext: '  Manager approval was unavailable.  ',
        precedentEligible: true,
      },
      'reviewer:alice',
    );

    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledWith({
      data: {
        humanDecisionId: 'hd-1',
        reasonCode: 'MISSING_CONTEXT',
        missingContext: 'Manager approval was unavailable.',
        precedentEligible: true,
      },
    });
    expect(result.feedbackCaptured).toBe(true);

    const auditPayload = prisma.__tx.auditLog.create.mock.calls[0][0].data.payload;
    expect(auditPayload).toMatchObject({
      feedbackProvided: true,
      reasonCode: 'MISSING_CONTEXT',
      precedentEligible: true,
    });
    expect(auditPayload).not.toHaveProperty('missingContext');
  });

  it('defaults precedentEligible to false when a feedback reason is supplied alone', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await service.recordDecision(
      'ar-1',
      { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' },
      'reviewer:alice',
    );

    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ precedentEligible: false }),
    });
  });

  it('enqueues nominated feedback with feedbackId as the stable jobId', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const precedentQueue = makeQueue();
    const service = new DecisionsService(
      prisma,
      makeQueue(),
      precedentQueue,
    );

    await service.recordDecision(
      'ar-1',
      {
        outcome: 'GRANT',
        reasonCode: 'CONFIRMS_POLICY',
        precedentEligible: true,
      },
      'reviewer:alice',
    );

    expect(precedentQueue.add).toHaveBeenCalledTimes(1);
    expect(precedentQueue.add).toHaveBeenCalledWith(
      PRECEDENT_INGESTION_JOB_NAME,
      { decisionFeedbackId: 'fb-1' },
      { jobId: 'fb-1' },
    );
  });

  it('does not enqueue feedback that was not nominated as precedent', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const precedentQueue = makeQueue();
    const service = new DecisionsService(
      prisma,
      makeQueue(),
      precedentQueue,
    );

    await service.recordDecision(
      'ar-1',
      { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' },
      'reviewer:alice',
    );

    expect(prisma.__tx.decisionFeedback.create).toHaveBeenCalledTimes(1);
    expect(precedentQueue.add).not.toHaveBeenCalled();
  });

  it('requires rationale when there is no recommendation to agree with (e.g. ESCALATE)', async () => {
    const prisma = makePrisma({
      ...RECOMMENDED_REQUEST,
      recommendations: [{ id: 'rec-1', decision: 'ESCALATE' }],
    });
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a disagreeing outcome once a rationale is supplied, and marks it as an override', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    const result = await service.recordDecision(
      'ar-1',
      {
        outcome: 'DENY',
        rationale: 'SoD conflict confirmed manually.',
        reasonCode: 'CONFIRMS_POLICY',
      },
      'reviewer:alice',
    );
    expect(result.overridesRecommendation).toBe(true);
    expect(prisma.__tx.humanDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'DENY',
          overridesRecommendation: true,
          rationale: 'SoD conflict confirmed manually.',
        }),
      }),
    );
  });

  it('records agreedWithAi as null for a deterministic SoD decision', async () => {
    const prisma = makePrisma({
      ...RECOMMENDED_REQUEST,
      recommendations: [
        {
          id: 'rec-sod',
          decision: 'DENY',
          // Defensive case: older rows could contain this incorrect value.
          // decisionSource is authoritative that no model was involved.
          modelDecision: 'DENY',
          modelName: 'system:sod-conflict-rule',
          decisionSource: 'SOD_RULE',
        },
      ],
    });
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    const result = await service.recordDecision(
      'ar-1',
      { outcome: 'DENY', reasonCode: 'CONFIRMS_POLICY' },
      'reviewer:alice',
    );

    expect(result.overridesRecommendation).toBe(false);
    expect(prisma.__tx.humanDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'DENY',
          overridesRecommendation: false,
          agreedWithAi: null,
        }),
      }),
    );
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ agreedWithAi: null }),
        }),
      }),
    );
  });

  it('loses a concurrent race: the status CAS inside the transaction matches zero rows', async () => {
    const tx = makeTx({
      accessRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    });
    const prisma = makePrisma(RECOMMENDED_REQUEST, tx);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(ConflictException);
  });

  it('converts a unique-constraint violation on human_decisions into a 409', async () => {
    const tx = makeTx();
    tx.humanDecision.create = jest
      .fn()
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );
    const prisma = makePrisma(RECOMMENDED_REQUEST, tx);
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    await expect(
      service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice'),
    ).rejects.toThrow(ConflictException);
  });

  it('creates exactly one PENDING execution row and never touches ExecutionAdapter directly', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const queue = makeQueue();
    const service = new DecisionsService(prisma, queue, makeQueue());

    const result = await service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice');

    expect(prisma.__tx.decisionExecution.create).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.decisionExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'GRANT', status: 'PENDING' }),
      }),
    );
    // The response reflects that execution is still pending — this method
    // returns as soon as the decision (and the PENDING row) are committed,
    // not after anything downstream has run.
    expect(result.executionStatus).toBe('PENDING');
  });

  it('enqueues the execution job with the execution row id as the stable jobId', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const queue = makeQueue();
    const service = new DecisionsService(prisma, queue, makeQueue());

    await service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, data, opts] = queue.add.mock.calls[0];
    expect(data).toEqual({ executionId: 'exec-1' });
    expect(opts).toEqual({ jobId: 'exec-1' });
  });

  it('still returns a committed decision when the enqueue call itself throws (sweeper recovers it), logging only a stable code', async () => {
    const prisma = makePrisma(RECOMMENDED_REQUEST);
    const queue = makeQueue(
      jest
        .fn()
        .mockRejectedValue(
          new Error(
            'redis://admin:secret@internal-redis.corp:6379 unreachable for EMP-52190',
          ),
        ),
    );
    const service = new DecisionsService(prisma, queue, makeQueue());
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await service.recordDecision('ar-1', { outcome: 'GRANT', reasonCode: 'CONFIRMS_POLICY' }, 'reviewer:alice');

    expect(result.status).toBe('DECIDED');
    expect(result.executionStatus).toBe('PENDING');

    // The Redis exception body never reaches the log — only the stable code
    // and safe ids. This enqueue goes through the same content-free boundary
    // as the execution processor and sweeper.
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('INITIAL_EXECUTION_ENQUEUE_FAILED');
    for (const sentinel of [
      'admin:secret',
      'internal-redis.corp',
      'EMP-52190',
      '52190',
    ]) {
      expect(logged).not.toContain(sentinel);
    }
    warnSpy.mockRestore();
  });
});

describe('DecisionsService.listAccessRequests', () => {
  it('includes and maps optional decision feedback into the dashboard projection', async () => {
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'ar-1',
        requestId: 'REQ-1',
        employeeId: 'EMP-1',
        requestType: 'NEW_ACCESS',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        justification: 'Quarterly reporting',
        requesterTitle: 'Analyst',
        requesterDepartment: 'Finance',
        requesterCostCenter: 'CC-1',
        status: 'DECIDED',
        entitlementSnapshot: null,
        submittedAt: createdAt,
        createdAt,
        recommendations: [
          {
            id: 'rec-1',
            decision: 'APPROVE',
            justification: 'Policy permits the access.',
            confidence: 0.9,
            modelName: 'gpt-4o-mini',
            promptVersion: 'v4',
            attemptNumber: 1,
            createdAt,
            citations: [],
            precedentCitations: [
              {
                precedentRecordId: 'precedent-1',
                relevanceReason: 'Same entitlement and business need.',
                outcomeSnapshot: 'GRANT',
                summarySnapshot: 'A comparable governed request was granted.',
              },
            ],
          },
        ],
        humanDecisions: [
          {
            id: 'hd-1',
            outcome: 'GRANT',
            overridesRecommendation: false,
            rationale: null,
            reviewerId: 'reviewer:alice',
            createdAt,
            execution: null,
            feedback: {
              reasonCode: 'CONFIRMS_POLICY',
              missingContext: null,
              precedentEligible: true,
              precedent: {
                status: 'ACTIVE',
                approvedAt: createdAt,
              },
            },
          },
          {
            id: 'hd-proposed',
            outcome: 'GRANT',
            overridesRecommendation: true,
            rationale: 'A documented business exception applies.',
            reviewerId: 'reviewer:alice',
            createdAt,
            execution: null,
            feedback: {
              reasonCode: 'BUSINESS_EXCEPTION',
              missingContext: 'Temporary quarter-end need.',
              precedentEligible: true,
              precedent: { status: 'PROPOSED', approvedAt: null },
            },
          },
          {
            id: 'hd-feedback-only',
            outcome: 'DENY',
            overridesRecommendation: false,
            rationale: null,
            reviewerId: 'reviewer:bob',
            createdAt,
            execution: null,
            feedback: {
              reasonCode: 'POLICY_MISAPPLIED',
              missingContext: null,
              precedentEligible: true,
              precedent: null,
            },
          },
          {
            id: 'hd-legacy',
            outcome: 'DENY',
            overridesRecommendation: false,
            rationale: null,
            reviewerId: 'reviewer:bob',
            createdAt,
            execution: null,
            feedback: null,
          },
        ],
      },
    ]);
    const prisma = {
      accessRequest: { findMany },
    } as unknown as PrismaService;
    const service = new DecisionsService(prisma, makeQueue(), makeQueue());

    const result = await service.listAccessRequests();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          recommendations: expect.objectContaining({
            include: { citations: true, precedentCitations: true },
          }),
          humanDecisions: expect.objectContaining({
            include: {
              execution: true,
              feedback: { include: { precedent: true } },
            },
          }),
        }),
      }),
    );
    expect(result[0].humanDecisions.map((decision) => decision.feedback)).toEqual([
      {
        reasonCode: 'CONFIRMS_POLICY',
        missingContext: null,
        precedentEligible: true,
        precedentStatus: 'ACTIVE',
        precedentApprovedAt: createdAt,
      },
      {
        reasonCode: 'BUSINESS_EXCEPTION',
        missingContext: 'Temporary quarter-end need.',
        precedentEligible: true,
        precedentStatus: 'PROPOSED',
        precedentApprovedAt: null,
      },
      {
        reasonCode: 'POLICY_MISAPPLIED',
        missingContext: null,
        precedentEligible: true,
        precedentStatus: null,
        precedentApprovedAt: null,
      },
      null,
    ]);
    expect(result[0].recommendations[0].precedentCitations).toEqual([
      {
        precedentRecordId: 'precedent-1',
        relevanceReason: 'Same entitlement and business need.',
        outcomeSnapshot: 'GRANT',
        summarySnapshot: 'A comparable governed request was granted.',
      },
    ]);
  });
});
