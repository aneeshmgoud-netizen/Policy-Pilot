import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AccessRequestJobData } from './access-request.processor';
import {
  STALE_THRESHOLD_MS,
  StaleRequestSweeperService,
} from './stale-request-sweeper.service';

function makeDeps(staleRows: unknown[]) {
  const prisma = {
    accessRequest: { findMany: jest.fn().mockResolvedValue(staleRows) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  } as unknown as PrismaService & {
    accessRequest: { findMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  const queue = {
    add: jest.fn().mockResolvedValue({}),
  } as unknown as Queue<AccessRequestJobData> & { add: jest.Mock };
  const service = new StaleRequestSweeperService(prisma, queue);
  return { service, prisma, queue };
}

describe('StaleRequestSweeperService', () => {
  it('does nothing when there are no stale PENDING requests', async () => {
    const { service, queue, prisma } = makeDeps([]);

    await service.sweep();

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('queries only PENDING requests older than the stale threshold', async () => {
    const { service, prisma } = makeDeps([]);
    const before = Date.now();

    await service.sweep();

    const where = (prisma.accessRequest.findMany as jest.Mock).mock.calls[0][0]
      .where;
    expect(where.status).toBe('PENDING');
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // The cutoff is STALE_THRESHOLD_MS in the past, not "now".
    expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(
      before - STALE_THRESHOLD_MS,
    );
  });

  it('re-enqueues each stale request with a deterministic jobId and audits it', async () => {
    const staleRow = {
      id: 'ar-stale-1',
      requestId: 'req-stale-1',
      createdAt: new Date(Date.now() - STALE_THRESHOLD_MS - 5_000),
    };
    const { service, queue, prisma } = makeDeps([staleRow]);

    await service.sweep();

    // The deterministic jobId is what makes this safe: BullMQ dedupes by
    // jobId, so calling add() again for a request that's actually just still
    // legitimately queued (not orphaned) is a no-op rather than a duplicate.
    expect(queue.add).toHaveBeenCalledWith(
      'process-access-request',
      { accessRequestId: 'ar-stale-1', requestId: 'req-stale-1' },
      { jobId: 'ar-stale-1' },
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-stale-1',
        eventType: 'STALE_REQUEST_REQUEUED',
        actor: 'system:stale-request-sweeper',
        payload: { staleForMs: expect.any(Number) },
      },
    });
  });

  it('re-enqueues every stale request found, not just the first', async () => {
    const staleRows = [
      {
        id: 'ar-1',
        requestId: 'req-1',
        createdAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1_000),
      },
      {
        id: 'ar-2',
        requestId: 'req-2',
        createdAt: new Date(Date.now() - STALE_THRESHOLD_MS - 2_000),
      },
    ];
    const { service, queue } = makeDeps(staleRows);

    await service.sweep();

    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
