import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { DecisionExecutionSweeperService } from './decision-execution-sweeper.service';
import {
  DecisionExecutionJobData,
  DecisionExecutionProcessor,
} from './decision-execution.processor';
import { ExecutionAdapter } from './execution-adapter.service';
import { PROCESSING_LEASE_DURATION_MS } from './decision-execution.constants';
import { FakeExecutionStore, makeJob } from './testing/execution-store.fixture';
import { Job } from 'bullmq';

/**
 * End-to-end recovery path over ONE shared row store. The sweeper's
 * recovery-lease write and the processor's claim CAS are deliberately NOT
 * mocked apart from each other here: the regression these tests exist for was
 * an interaction between them (the sweeper refreshing the very field the claim
 * compared against), which is invisible to any test that stubs one side.
 */
describe('decision execution recovery (sweeper -> processor -> adapter)', () => {
  function harness() {
    const store = new FakeExecutionStore();
    const prisma = store.asPrismaService() as unknown as PrismaService;

    const enqueued: string[] = [];
    const queue = {
      add: jest.fn((_name: string, data: DecisionExecutionJobData) => {
        enqueued.push(data.executionId);
        return Promise.resolve(undefined);
      }),
      getJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<DecisionExecutionJobData> & {
      add: jest.Mock;
      getJob: jest.Mock;
    };

    const execute = jest.fn().mockResolvedValue(undefined);
    const adapter = { execute } as unknown as ExecutionAdapter;

    const sweeper = new DecisionExecutionSweeperService(prisma, queue);
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const job = (executionId: string) =>
      ({
        id: executionId,
        data: { executionId },
        attemptsMade: 0,
        opts: { attempts: 3 },
      }) as unknown as Job<DecisionExecutionJobData>;

    return { store, queue, execute, sweeper, processor, enqueued, job };
  }

  it('recovers a stale PROCESSING row: sweeper claims recovery and enqueues, then the processor claims IMMEDIATELY and the adapter executes', async () => {
    const { store, sweeper, processor, execute, enqueued, job } = harness();
    // A worker claimed this row and died: PROCESSING with an expired lease.
    const id = store.addProcessing({
      leaseExpiresAt: store.msAgo(60_000),
      attempts: 1,
    });

    await sweeper.sweep();

    expect(enqueued).toEqual([id]);
    expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);

    // The crucial assertion: no waiting, no clock advance, no second sweep.
    // The processor claims the row on the very next tick. Under the previous
    // updatedAt-as-lease design this failed — the sweeper's own bookkeeping
    // write refreshed updatedAt, so the claim CAS found the row "fresh" and
    // no-oped, leaving it PROCESSING forever.
    await processor.process(job(id));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: id, outcome: 'GRANT' }),
    );

    const row = store.row(id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempts).toBe(2); // incremented by the recovering claim
    // Both leases released on the terminal transition.
    expect(row.processingLeaseExpiresAt).toBeNull();
    expect(row.recoveryLeaseToken).toBeNull();
    expect(row.recoveryLeaseExpiresAt).toBeNull();
    expect(store.auditEventTypes()).toEqual([
      'STALE_EXECUTION_REQUEUED',
      'EXECUTION_SUCCEEDED',
    ]);
  });

  it('a stalled worker whose lease was reclaimed cannot overwrite the new owner’s SUCCEEDED outcome', async () => {
    const store = new FakeExecutionStore();
    const prisma = store.asPrismaService() as unknown as PrismaService;
    const id = store.addPending({});
    const job = {
      id,
      data: { executionId: id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<DecisionExecutionJobData>;

    // Worker A claims the row, then stalls inside the adapter call.
    let releaseA: () => void = () => undefined;
    const workerA = new DecisionExecutionProcessor(prisma, {
      execute: jest.fn(() => new Promise<void>((resolve) => {
        releaseA = resolve;
      })),
    } as unknown as ExecutionAdapter);
    const aRun = workerA.process(job).catch((err: unknown) => err);
    await Promise.resolve();
    const tokenA = store.row(id).processingLeaseToken;
    expect(tokenA).not.toBeNull();

    // A's lease expires while it is stalled.
    store.row(id).processingLeaseExpiresAt = store.msAgo(1_000);

    // Worker B legitimately reclaims the row and completes it.
    const workerB = new DecisionExecutionProcessor(prisma, {
      execute: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionAdapter);
    await workerB.process(job);

    expect(store.row(id).status).toBe('SUCCEEDED');
    expect(store.row(id).processingLeaseToken).toBeNull();
    expect(store.auditEventTypes()).toEqual(['EXECUTION_SUCCEEDED']);

    // Now A resumes and tries to record its own outcome. It holds tokenA,
    // which no longer matches, so the fence rejects the write.
    releaseA();
    await aRun;

    const row = store.row(id);
    expect(row.status).toBe('SUCCEEDED'); // not overwritten
    expect(row.errorCode).toBeNull();
    expect(row.lastError).toBeNull();
    // And no contradictory audit entry was appended.
    expect(store.auditEventTypes()).toEqual(['EXECUTION_SUCCEEDED']);
  });

  it('a stalled worker that FAILED cannot resurrect a row the new owner already completed', async () => {
    const store = new FakeExecutionStore();
    const prisma = store.asPrismaService() as unknown as PrismaService;
    const id = store.addPending({});
    const job = {
      id,
      data: { executionId: id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<DecisionExecutionJobData>;

    // Worker A claims, then its adapter call fails — but only after its lease
    // has expired and worker B has completed the row.
    let failA: (err: Error) => void = () => undefined;
    const workerA = new DecisionExecutionProcessor(prisma, {
      execute: jest.fn(() => new Promise<void>((_resolve, reject) => {
        failA = reject;
      })),
    } as unknown as ExecutionAdapter);
    const aRun = workerA.process(job).catch((err: unknown) => err);
    await Promise.resolve();

    store.row(id).processingLeaseExpiresAt = store.msAgo(1_000);
    await new DecisionExecutionProcessor(prisma, {
      execute: jest.fn().mockResolvedValue(undefined),
    } as unknown as ExecutionAdapter).process(job);
    expect(store.row(id).status).toBe('SUCCEEDED');

    failA(new Error('downstream 500'));
    await aRun;

    // With retries remaining, A would have written PENDING — un-terminalizing
    // a completed execution. The fence prevents it.
    expect(store.row(id).status).toBe('SUCCEEDED');
    expect(store.auditEventTypes()).toEqual(['EXECUTION_SUCCEEDED']);
  });

  it('recovers an orphaned PENDING row the same way', async () => {
    const { store, sweeper, processor, execute, enqueued, job } = harness();
    const id = store.addPending({ updatedAt: store.msAgo(5 * 60_000) });

    await sweeper.sweep();
    expect(enqueued).toEqual([id]);

    await processor.process(job(id));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.row(id).status).toBe('SUCCEEDED');
  });

  it('the processor claim clears the recovery ownership the sweeper took', async () => {
    const { store, sweeper, processor, job } = harness();
    const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });

    await sweeper.sweep();
    // Ownership is held between enqueue and pickup, so a second replica's
    // sweep can't re-enqueue the same row in that window.
    expect(store.row(id).recoveryLeaseToken).not.toBeNull();
    expect(store.row(id).recoveryLeaseExpiresAt).not.toBeNull();

    await processor.process(job(id));

    expect(store.row(id).recoveryLeaseToken).toBeNull();
    expect(store.row(id).recoveryLeaseExpiresAt).toBeNull();
  });

  it('a fresh claim writes a live processing lease, which then blocks a concurrent sweep from recovering the row', async () => {
    const { store, sweeper, processor, enqueued, job } = harness();
    const id = store.addPending({ updatedAt: store.msAgo(5 * 60_000) });

    // Hold the row mid-flight: the adapter never resolves during this test.
    const slowProcessor = new DecisionExecutionProcessor(
      store.asPrismaService() as unknown as PrismaService,
      { execute: jest.fn(() => new Promise<void>(() => {})) } as unknown as ExecutionAdapter,
    );
    void slowProcessor.process(job(id));
    await Promise.resolve(); // let the claim commit

    const row = store.row(id);
    expect(row.status).toBe('PROCESSING');
    expect(row.processingLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.processingLeaseExpiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + PROCESSING_LEASE_DURATION_MS,
    );

    // A sweeper running now must leave the in-flight row alone.
    await sweeper.sweep();
    expect(enqueued).toEqual([]);
    expect(store.auditEventTypes()).toEqual([]);

    // Silence the unused-binding lint on the processor we intentionally
    // didn't drive to completion.
    expect(processor).toBeDefined();
  });

  it('a retryable failure returns the row to PENDING with no lease, so the retry claims it immediately', async () => {
    const store = new FakeExecutionStore();
    const prisma = store.asPrismaService() as unknown as PrismaService;
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('downstream 500'))
      .mockResolvedValueOnce(undefined);
    const processor = new DecisionExecutionProcessor(
      prisma,
      { execute } as unknown as ExecutionAdapter,
    );
    const id = store.addPending({});
    const job = {
      id,
      data: { executionId: id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<DecisionExecutionJobData>;

    await expect(processor.process(job)).rejects.toBeDefined();

    let row = store.row(id);
    expect(row.status).toBe('PENDING');
    expect(row.processingLeaseExpiresAt).toBeNull();

    // The BullMQ retry re-claims with no waiting at all.
    await processor.process(job);

    row = store.row(id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempts).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('a stale PROCESSING row whose job is a retained completed job is recovered by removing and replacing it', async () => {
    const { store, sweeper, processor, execute, queue, enqueued, job } = harness();
    const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
    const retained = makeJob('completed');
    (queue.getJob as jest.Mock).mockResolvedValue(retained);

    await sweeper.sweep();

    expect(retained.remove).toHaveBeenCalled();
    expect(enqueued).toEqual([id]);

    await processor.process(job(id));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.row(id).status).toBe('SUCCEEDED');
  });
});
