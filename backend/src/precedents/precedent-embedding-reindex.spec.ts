import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { reindexPrecedentEmbeddings } from './precedent-embedding-reindex';

describe('reindexPrecedentEmbeddings', () => {
  it('replaces an outdated vector from canonical request facts and advances its version atomically', async () => {
    const record = {
      id: 'precedent-1',
      createdAt: new Date('2026-08-02T12:00:00.000Z'),
      accessRequest: {
        requestType: 'GRANT_ENTITLEMENT',
        targetSystem: 'VENDOR_PAYMENTS',
        entitlementKey: 'VENDOR_MASTER_EDIT',
        requesterTitle: 'AP Specialist',
        requesterDepartment: 'Finance Operations',
        requesterCostCenter: 'CC-FIN-12',
        justification: 'Need vendor updates; manager approved.',
      },
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const prisma = {
      precedentRecord: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([record])
          .mockResolvedValueOnce([]),
      },
      $transaction: jest.fn().mockImplementation((callback) =>
        callback({ $executeRaw: executeRaw }),
      ),
    } as unknown as PrismaService;
    const embeddings = {
      embedBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingsService & { embedBatch: jest.Mock };

    await expect(
      reindexPrecedentEmbeddings(prisma, embeddings),
    ).resolves.toBe(1);

    expect(embeddings.embedBatch).toHaveBeenCalledWith([
      [
        'Request type: GRANT_ENTITLEMENT',
        'Target system: VENDOR_PAYMENTS',
        'Entitlement: VENDOR_MASTER_EDIT',
        'Requester title: AP Specialist',
        'Requester department: Finance Operations',
        'Requester cost center: CC-FIN-12',
        'Business justification: Need vendor updates; manager approved.',
      ].join('\n'),
    ]);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [sqlStrings, vector, version, id, guardedVersion] =
      executeRaw.mock.calls[0];
    expect(Array.from(sqlStrings).join(' ')).toContain(
      'SET embedding =',
    );
    expect(vector).toBe('[0.1,0.2,0.3]');
    expect(version).toBe(2);
    expect(id).toBe('precedent-1');
    expect(guardedVersion).toBe(2);
  });

  it('is a no-op when every vector already uses the current representation', async () => {
    const prisma = {
      precedentRecord: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const embeddings = {
      embedBatch: jest.fn(),
    } as unknown as EmbeddingsService & { embedBatch: jest.Mock };

    await expect(
      reindexPrecedentEmbeddings(prisma, embeddings),
    ).resolves.toBe(0);
    expect(embeddings.embedBatch).not.toHaveBeenCalled();
  });
});
