import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import {
  PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS,
} from './precedent-ingestion.constants';
import {
  PrecedentIngestionJobData,
  PrecedentIngestionProcessor,
} from './precedent-ingestion.processor';
import { PrecedentIngestionService } from './precedent-ingestion.service';

const FEEDBACK = {
  id: 'fb-retry',
  precedentEligible: true,
  reasonCode: 'CONFIRMS_POLICY',
  missingContext: null,
  humanDecision: {
    id: 'hd-retry',
    outcome: 'GRANT',
    overridesRecommendation: false,
    agreedWithAi: true,
    rationale: null,
    accessRequest: {
      id: 'ar-retry',
      requestType: 'GRANT_ENTITLEMENT',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      requesterTitle: 'Data Analyst',
      requesterDepartment: 'Finance',
      requesterCostCenter: 'CC-FIN-07',
      justification: 'Need read access for financial reporting.',
    },
    aiRecommendation: {
      decision: 'APPROVE',
      confidence: 0.9,
      justification: 'Policy permits standard read access.',
      modelDecision: 'APPROVE',
      modelConfidence: 0.9,
      decisionSource: 'MODEL',
    },
  },
};

function fakeJob(attemptsMade: number): Job<PrecedentIngestionJobData> {
  return {
    data: { decisionFeedbackId: 'fb-retry' },
    attemptsMade,
  } as Job<PrecedentIngestionJobData>;
}

function makeProcessorWithTransaction(
  transaction: jest.Mock,
): PrecedentIngestionProcessor {
  const prisma = {
    decisionFeedback: { findUnique: jest.fn().mockResolvedValue(FEEDBACK) },
    policyDocument: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: transaction,
  } as unknown as PrismaService;
  const embeddings = {
    embed: jest.fn().mockResolvedValue([0.1, 0.2]),
  } as unknown as EmbeddingsService;
  return new PrecedentIngestionProcessor(
    new PrecedentIngestionService(prisma, embeddings),
  );
}

describe('PrecedentIngestionProcessor retry safety', () => {
  it('treats P2002 on attempt 2 as successful idempotent completion', async () => {
    const transientFailure = new Error('temporary database interruption');
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(transientFailure)
      .mockRejectedValueOnce(duplicate);
    const processor = makeProcessorWithTransaction(transaction);

    await expect(processor.process(fakeJob(0))).rejects.toBe(transientFailure);
    await expect(processor.process(fakeJob(1))).resolves.toBeUndefined();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('exhausts all configured attempts without committing a partial row or leaking an unhandled rejection', async () => {
    const committedRows: Array<Record<string, unknown>> = [];
    const transaction = jest.fn().mockImplementation(
      async (
        callback: (transactionClient: {
          precedentRecord: { create: jest.Mock };
          $executeRaw: jest.Mock;
        }) => Promise<unknown>,
      ) => {
        const stagedRows: Array<Record<string, unknown>> = [];
        const transactionClient = {
          precedentRecord: {
            create: jest.fn().mockImplementation(({ data }) => {
              const row = { id: 'partial-row', ...data };
              stagedRows.push(row);
              return Promise.resolve(row);
            }),
          },
          $executeRaw: jest
            .fn()
            .mockRejectedValue(new Error('transient vector write failure')),
        };
        const result = await callback(transactionClient);
        committedRows.push(...stagedRows);
        return result;
      },
    );
    const processor = makeProcessorWithTransaction(transaction);

    const runThroughBullRetryBoundary = async () => {
      let failuresHandled = 0;
      for (
        let attempt = 0;
        attempt < Number(PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS.attempts);
        attempt += 1
      ) {
        try {
          await processor.process(fakeJob(attempt));
          break;
        } catch {
          // BullMQ owns retry/final-failure handling. The final failed job is
          // removed by removeOnFail, so the worker boundary settles cleanly.
          failuresHandled += 1;
        }
      }
      return failuresHandled;
    };

    await expect(runThroughBullRetryBoundary()).resolves.toBe(3);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(committedRows).toEqual([]);
    expect(PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      removeOnFail: true,
    });
  });
});
