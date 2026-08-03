import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRECEDENT_INGESTION_GRACE_MS,
  PRECEDENT_SWEEP_BATCH_SIZE,
  PrecedentIngestionSweeperService,
} from './precedent-ingestion-sweeper.service';

function makeHarness(stranded: Array<{ id: string }> = []) {
  const prisma = {
    decisionFeedback: { findMany: jest.fn().mockResolvedValue(stranded) },
  } as unknown as PrismaService & {
    decisionFeedback: { findMany: jest.Mock };
  };
  const add = jest.fn().mockResolvedValue({ id: 'job' });
  const queue = { add } as never;
  return {
    service: new PrecedentIngestionSweeperService(prisma, queue),
    prisma,
    add,
  };
}

describe('PrecedentIngestionSweeperService', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('defines "stranded" from durable state: eligible, no precedent row, past the grace period', () => {
    // The predicate is derived from Postgres rather than from queue
    // bookkeeping, which is what makes the sweep safe to run repeatedly: an
    // eligible nomination with no PrecedentRecord simply has not completed.
    const { service, prisma } = makeHarness();
    const before = Date.now();

    return service.sweep().then(() => {
      const where = prisma.decisionFeedback.findMany.mock.calls[0][0].where;
      expect(where.precedentEligible).toBe(true);
      expect(where.precedent).toBeNull();
      const cutoff = where.createdAt.lt as Date;
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(
        PRECEDENT_INGESTION_GRACE_MS - 1000,
      );
    });
  });

  it('re-enqueues using the feedback id as jobId, so it can never duplicate the original job', async () => {
    const { service, add } = makeHarness([{ id: 'feedback-1' }]);

    const swept = await service.sweep();

    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      { decisionFeedbackId: 'feedback-1' },
      { jobId: 'feedback-1' },
    );
    expect(swept).toEqual(['feedback-1']);
  });

  it('processes oldest first and bounds the batch', async () => {
    const { service, prisma } = makeHarness();

    await service.sweep();

    const args = prisma.decisionFeedback.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(args.take).toBe(PRECEDENT_SWEEP_BATCH_SIZE);
  });

  it('does nothing, and logs nothing, when no nomination is stranded', async () => {
    const { service, add } = makeHarness([]);

    expect(await service.sweep()).toEqual([]);
    expect(add).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('leaves a row eligible for the next pass when its re-enqueue fails, and never leaks the error body', async () => {
    const { service, add } = makeHarness([{ id: 'feedback-1' }, { id: 'feedback-2' }]);
    add
      .mockRejectedValueOnce(
        new Error('redis://user:hunter2@internal-host:6379 connection refused'),
      )
      .mockResolvedValueOnce({ id: 'job' });

    const swept = await service.sweep();

    // The failure does not abort the pass — the second row still recovers.
    expect(swept).toEqual(['feedback-2']);
    const warned = warnSpy.mock.calls.flat().join(' ');
    expect(warned).toContain('feedback-1');
    expect(warned).not.toContain('hunter2');
    expect(warned).not.toContain('internal-host');
  });

  it('never lets a scheduled sweep reject — @Interval calls it unawaited', async () => {
    const { service, prisma } = makeHarness();
    prisma.decisionFeedback.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.scheduledSweep()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
