import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { PrecedentIngestionService } from './precedent-ingestion.service';

const ELIGIBLE_FEEDBACK = {
  id: 'fb-1',
  precedentEligible: true,
  reasonCode: 'MISSING_CONTEXT',
  missingContext: 'Manager approval was missing',
  humanDecision: {
    id: 'hd-1',
    outcome: 'GRANT',
    overridesRecommendation: true,
    agreedWithAi: false as boolean | null,
    rationale: 'The approval was later verified',
    accessRequest: {
      id: 'ar-1',
      requestType: 'GRANT_ENTITLEMENT',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      requesterTitle: 'Finance Analyst',
      requesterDepartment: 'Finance',
      requesterCostCenter: 'CC-FIN-12',
      justification: 'Need read access for monthly reporting.',
    },
    aiRecommendation: {
      decision: 'DENY',
      confidence: 0.82,
      justification: 'Required approval was not present.',
      modelDecision: 'DENY' as string | null,
      modelConfidence: 0.82 as number | null,
      decisionSource: 'MODEL' as string | null,
    },
  },
};

function makeService(
  feedback: typeof ELIGIBLE_FEEDBACK | null = ELIGIBLE_FEEDBACK,
) {
  const tx = {
    precedentRecord: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'precedent-1', ...data }),
      ),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    decisionFeedback: {
      findUnique: jest.fn().mockResolvedValue(feedback),
    },
    policyDocument: {
      findMany: jest.fn().mockResolvedValue([
        { documentName: 'POL-DATA-001', version: '3.4.1' },
        { documentName: 'POL-GOV-000', version: '2.1.0' },
      ]),
    },
    $transaction: jest
      .fn()
      .mockImplementation((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    __tx: tx,
  } as unknown as PrismaService & { __tx: typeof tx; $transaction: jest.Mock };
  const embeddings = {
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingsService & { embed: jest.Mock };

  return {
    service: new PrecedentIngestionService(prisma, embeddings),
    prisma,
    embeddings,
  };
}

describe('PrecedentIngestionService', () => {
  it('skips cleanly when the feedback row is missing', async () => {
    const { service, prisma, embeddings } = makeService(null);

    await expect(service.ingest('missing')).resolves.toBeUndefined();

    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips cleanly when the feedback is not precedent-eligible', async () => {
    const { service, prisma, embeddings } = makeService({
      ...ELIGIBLE_FEEDBACK,
      precedentEligible: false,
    });

    await expect(service.ingest('fb-1')).resolves.toBeUndefined();

    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('embeds canonical request facts and stores the detailed summary separately', async () => {
    const { service, prisma, embeddings } = makeService();

    await service.ingest('fb-1');

    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    const retrievalText = embeddings.embed.mock.calls[0][0] as string;
    expect(retrievalText).toContain('Target system: DATA_WAREHOUSE');
    expect(retrievalText).toContain('Requester title: Finance Analyst');
    expect(retrievalText).toContain(
      'Business justification: Need read access for monthly reporting.',
    );
    expect(retrievalText).not.toContain('AI recommendation');
    expect(retrievalText).not.toContain('MISSING_CONTEXT');

    const createCall = prisma.__tx.precedentRecord.create.mock.calls[0][0];
    const summary = createCall.data.summary as string;
    expect(summary).toContain('requested FIN_DATASET_READ access');
    expect(summary).toContain('overriding the AI recommendation');
    expect(summary).toContain('MISSING_CONTEXT');

    expect(prisma.__tx.precedentRecord.create).toHaveBeenCalledWith({
      data: {
        decisionFeedbackId: 'fb-1',
        accessRequestId: 'ar-1',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        department: 'Finance',
        costCenter: 'CC-FIN-12',
        summary,
        embeddingVersion: 2,
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.1' },
          { documentName: 'POL-GOV-000', version: '2.1.0' },
        ],
      },
    });
    expect(prisma.__tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [sqlStrings, vector, recordId] =
      prisma.__tx.$executeRaw.mock.calls[0];
    expect(Array.from(sqlStrings).join(' ')).toContain(
      'UPDATE precedent_records',
    );
    expect(vector).toBe('[0.1,0.2,0.3]');
    expect(recordId).toBe('precedent-1');
    expect(
      prisma.__tx.precedentRecord.create.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.__tx.$executeRaw.mock.invocationCallOrder[0]);
  });

  it('does not relabel a deterministic SoD decision as an AI recommendation', async () => {
    const { service, prisma } = makeService({
      ...ELIGIBLE_FEEDBACK,
      humanDecision: {
        ...ELIGIBLE_FEEDBACK.humanDecision,
        outcome: 'DENY',
        overridesRecommendation: false,
        agreedWithAi: null,
        aiRecommendation: {
          decision: 'DENY',
          confidence: 1,
          justification: 'Denied automatically because SoD-FIN-01 applies.',
          modelDecision: null,
          modelConfidence: null,
          decisionSource: 'SOD_RULE',
        },
      },
    });

    await service.ingest('fb-1');

    const summary = prisma.__tx.precedentRecord.create.mock.calls[0][0].data
      .summary as string;
    expect(summary).toContain('There was no AI recommendation for this request.');
    expect(summary).toContain(
      'there was no AI recommendation to compare against',
    );
    expect(summary).not.toContain('The AI recommended DENY');
    expect(summary).not.toContain('agreeing with the AI recommendation');
  });

  it('swallows a P2002 duplicate as an idempotent no-op', async () => {
    const { service, prisma } = makeService();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );

    await expect(service.ingest('fb-1')).resolves.toBeUndefined();
  });

  it('rethrows any non-P2002 error for BullMQ to retry', async () => {
    const { service, prisma } = makeService();
    const failure = new Error('database unavailable');
    prisma.$transaction.mockRejectedValue(failure);

    await expect(service.ingest('fb-1')).rejects.toBe(failure);
  });

  it('leaves no precedent row when the vector update fails inside the transaction', async () => {
    const { service, prisma } = makeService();
    const committedRows: Array<Record<string, unknown>> = [];
    const vectorFailure = new Error('vector update failed');

    prisma.$transaction.mockImplementation(
      async (
        callback: (transaction: {
          precedentRecord: { create: jest.Mock };
          $executeRaw: jest.Mock;
        }) => Promise<unknown>,
      ) => {
        const stagedRows: Array<Record<string, unknown>> = [];
        const transactionalClient = {
          precedentRecord: {
            create: jest.fn().mockImplementation(({ data }) => {
              const row = { id: 'precedent-rolled-back', ...data };
              stagedRows.push(row);
              return Promise.resolve(row);
            }),
          },
          $executeRaw: jest.fn().mockRejectedValue(vectorFailure),
        };

        // Simulates Prisma commit: this line is reached only when the whole
        // callback succeeds. A later vector error leaves stagedRows discarded.
        const result = await callback(transactionalClient);
        committedRows.push(...stagedRows);
        return result;
      },
    );

    await expect(service.ingest('fb-1')).rejects.toBe(vectorFailure);
    expect(committedRows).toEqual([]);
  });
});
