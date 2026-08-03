import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { DecisionExecutionSweeperService } from './decision-execution-sweeper.service';
import { DecisionExecutionJobData } from './decision-execution.processor';
import {
  PROCESSING_LEASE_DURATION_MS,
  RECOVERY_LEASE_DURATION_MS,
} from './decision-execution.constants';
import {
  FakeExecutionStore,
  SENTINEL_SECRETS,
  expectNoSentinelSecrets,
  makeJob,
  spyOnAllLoggerMethods,
  loggedText,
  restoreLoggerSpies,
} from './testing/execution-store.fixture';

function makePrisma(store: FakeExecutionStore) {
  return {
    decisionExecution: {
      findMany: store.findMany,
      findFirst: store.findFirst,
      updateMany: store.updateMany,
    },
    auditLog: { create: store.createAudit },
  } as unknown as PrismaService & {
    decisionExecution: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      updateMany: jest.Mock;
    };
    auditLog: { create: jest.Mock };
  };
}

function makeQueue(
  existingJob: ReturnType<typeof makeJob> | undefined = undefined,
  overrides: Partial<{ add: jest.Mock; getJob: jest.Mock }> = {},
) {
  return {
    add: overrides.add ?? jest.fn().mockResolvedValue(undefined),
    getJob: overrides.getJob ?? jest.fn().mockResolvedValue(existingJob),
  } as unknown as Queue<DecisionExecutionJobData> & {
    add: jest.Mock;
    getJob: jest.Mock;
  };
}

function sweeperFor(store: FakeExecutionStore, queue: ReturnType<typeof makeQueue>) {
  return new DecisionExecutionSweeperService(makePrisma(store), queue);
}

describe('DecisionExecutionSweeperService', () => {
  describe('eligibility is driven by the explicit processing lease, never updatedAt', () => {
    it('recovers a PROCESSING row whose processing lease has expired', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
      expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);
    });

    it('does NOT recover a PROCESSING row whose processing lease is still active', async () => {
      const store = new FakeExecutionStore();
      store.addProcessing({ leaseExpiresAt: store.msFromNow(60_000) });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.getJob).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
    });

    it('recovers a PROCESSING row whose lease was never written (null), rather than stranding it', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: null });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
    });

    it('recovers an orphaned PENDING row (committed but never enqueued)', async () => {
      const store = new FakeExecutionStore();
      const id = store.addPending({ updatedAt: store.msAgo(5 * 60_000) });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
    });

    it('acquiring recovery ownership does not alter the processing lease or processing staleness', async () => {
      const store = new FakeExecutionStore();
      const leaseExpiresAt = store.msAgo(60_000);
      const id = store.addProcessing({ leaseExpiresAt });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      const row = store.row(id);
      // The processing lease is byte-identical: still expired, so the worker
      // the sweep just enqueued can claim the row immediately.
      expect(row.processingLeaseExpiresAt).toEqual(leaseExpiresAt);
      // Only the recovery-lease columns were written.
      expect(row.recoveryLeaseToken).not.toBeNull();
      expect(row.recoveryLeaseExpiresAt).not.toBeNull();
      expect(row.status).toBe('PROCESSING');
      expect(row.attempts).toBe(0);
    });
  });

  describe('single-winner recovery ownership across replicas', () => {
    it('two concurrent sweepers produce exactly one enqueue and exactly one recovery audit', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const queueA = makeQueue(undefined);
      const queueB = makeQueue(undefined);

      await Promise.all([
        sweeperFor(store, queueA).sweep(),
        sweeperFor(store, queueB).sweep(),
      ]);

      const totalAdds =
        (queueA.add as jest.Mock).mock.calls.length +
        (queueB.add as jest.Mock).mock.calls.length;
      expect(totalAdds).toBe(1);
      expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);
      // Exactly one token is held afterwards.
      expect(store.row(id).recoveryLeaseToken).not.toBeNull();
    });

    it('the CAS loser performs no Redis access, no audit, and no recovery log', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      // A winner already holds live ownership.
      store.setRecoveryLease(id, 'winner-token', store.msFromNow(30_000));

      const retainedJob = makeJob('completed');
      const queue = makeQueue(retainedJob);
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, queue).sweep();

      expect(queue.getJob).not.toHaveBeenCalled();
      expect(retainedJob.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
      expect(loggedText(spies)).not.toContain('Re-enqueued');
      restoreLoggerSpies(spies);

      // The winner's token is untouched by the loser.
      expect(store.row(id).recoveryLeaseToken).toBe('winner-token');
    });

    it('expired recovery ownership can be re-acquired by another replica', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      store.setRecoveryLease(id, 'dead-replica-token', store.msAgo(1_000));
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
      expect(store.row(id).recoveryLeaseToken).not.toBe('dead-replica-token');
      expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);
    });

    it('a row that resolved to SUCCEEDED mid-sweep fails the CAS: nothing enqueued or audited', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      // Scan returns it, then it finishes before the CAS runs.
      type FindManyArgs = Parameters<FakeExecutionStore['realFindMany']>[0];
      store.findMany.mockImplementationOnce(async (args: FindManyArgs) => {
        const rows = await store.realFindMany(args);
        store.setStatus(id, 'SUCCEEDED');
        return rows;
      });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
    });

    it('declines ownership when a worker claims a fresh processing lease between the scan and the CAS', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });

      // The scan legitimately sees the row as stale; a worker then claims it
      // (writing a live lease) before the ownership CAS runs.
      type FindManyArgs = Parameters<FakeExecutionStore['realFindMany']>[0];
      store.findMany.mockImplementationOnce(async (args: FindManyArgs) => {
        const rows = await store.realFindMany(args);
        store.row(id).processingLeaseExpiresAt = store.msFromNow(5 * 60_000);
        store.row(id).processingLeaseToken = 'worker-token';
        return rows;
      });

      const retainedJob = makeJob('completed');
      const queue = makeQueue(retainedJob);
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, queue).sweep();

      // The CAS ran and matched zero rows...
      expect(store.updateMany).toHaveBeenCalledTimes(1);
      await expect(
        store.updateMany.mock.results[0].value,
      ).resolves.toEqual({ count: 0 });
      // ...so no Redis access, no enqueue, no audit, no recovery log.
      expect(queue.getJob).not.toHaveBeenCalled();
      expect(retainedJob.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
      expect(loggedText(spies)).not.toContain('Re-enqueued');
      restoreLoggerSpies(spies);

      // The worker's lease is untouched by the sweeper.
      expect(store.row(id).processingLeaseToken).toBe('worker-token');
      expect(store.row(id).recoveryLeaseToken).toBeNull();
    });

    it('declines ownership when a stale-PENDING row is refreshed between the scan and the CAS', async () => {
      const store = new FakeExecutionStore();
      const id = store.addPending({ updatedAt: store.msAgo(5 * 60_000) });
      type FindManyArgs = Parameters<FakeExecutionStore['realFindMany']>[0];
      store.findMany.mockImplementationOnce(async (args: FindManyArgs) => {
        const rows = await store.realFindMany(args);
        store.row(id).updatedAt = new Date(); // no longer orphaned
        return rows;
      });
      const queue = makeQueue(undefined);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
    });

    it('does not audit when ownership is lost between the enqueue and the audit write', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const queue = makeQueue(undefined, {
        // A worker claims the row (clearing recovery ownership, as claim() does)
        // in the window after the job is created but before we take credit.
        add: jest.fn(() => {
          store.setRecoveryLease(id, null, null);
          store.row(id).processingLeaseExpiresAt = store.msFromNow(5 * 60_000);
          return Promise.resolve(undefined);
        }),
      });
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
      const logged = loggedText(spies);
      expect(logged).toContain('RECOVERY_OWNERSHIP_LOST');
      expect(logged).not.toContain('Re-enqueued');
      restoreLoggerSpies(spies);
    });

    it('sets the recovery lease to expire after RECOVERY_LEASE_DURATION_MS', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const before = Date.now();

      await sweeperFor(store, makeQueue(undefined)).sweep();

      const expiry = store.row(id).recoveryLeaseExpiresAt!.getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + RECOVERY_LEASE_DURATION_MS);
      // Shorter than a processing lease, by design.
      expect(RECOVERY_LEASE_DURATION_MS).toBeLessThan(PROCESSING_LEASE_DURATION_MS);
    });
  });

  describe('Redis job-state safety', () => {
    it.each(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized'])(
      'never removes or duplicates a runnable job (%s)',
      async (state) => {
        const store = new FakeExecutionStore();
        store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
        const runnableJob = makeJob(state);
        const queue = makeQueue(runnableJob);

        await sweeperFor(store, queue).sweep();

        expect(runnableJob.remove).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
        expect(store.auditEventTypes()).toEqual([]);
      },
    );

    it('removes a retained completed job and replaces it with a fresh one', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const completedJob = makeJob('completed');
      const queue = makeQueue(completedJob);

      await sweeperFor(store, queue).sweep();

      expect(completedJob.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
      expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);
    });

    it('removes a retained failed job and replaces it with a fresh one', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const failedJob = makeJob('failed');
      const queue = makeQueue(failedJob);

      await sweeperFor(store, queue).sweep();

      expect(failedJob.remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: id },
        { jobId: id },
      );
    });

    it('an unknown job state is treated conservatively: nothing removed, nothing added', async () => {
      const store = new FakeExecutionStore();
      store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const oddJob = makeJob('unknown');
      const queue = makeQueue(oddJob);

      await sweeperFor(store, queue).sweep();

      expect(oddJob.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
    });

    it('a lost remove() race is treated conservatively: nothing added, nothing audited', async () => {
      const store = new FakeExecutionStore();
      store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const racedJob = makeJob('completed', {
        remove: jest.fn().mockRejectedValue(new Error(SENTINEL_SECRETS.redisUrl)),
      });
      const queue = makeQueue(racedJob);

      await sweeperFor(store, queue).sweep();

      expect(queue.add).not.toHaveBeenCalled();
      expect(store.auditEventTypes()).toEqual([]);
    });
  });

  describe('content-free failure handling', () => {
    // One case per fallible step. Each injects a sentinel-bearing exception and
    // asserts nothing from it reaches any log line, and that the sweep still
    // resolves rather than rejecting across the Nest scheduler boundary.
    const steps: Array<{
      name: string;
      build: (store: FakeExecutionStore) => ReturnType<typeof makeQueue>;
    }> = [
      {
        name: 'the eligibility scan (Prisma findMany)',
        build: (store) => {
          store.findMany.mockRejectedValueOnce(
            new Error(SENTINEL_SECRETS.dbHost),
          );
          return makeQueue(undefined);
        },
      },
      {
        name: 'the ownership CAS (Prisma updateMany)',
        build: (store) => {
          store.updateMany.mockRejectedValueOnce(
            new Error(SENTINEL_SECRETS.dbHost),
          );
          return makeQueue(undefined);
        },
      },
      {
        name: 'getJob',
        build: () =>
          makeQueue(undefined, {
            getJob: jest
              .fn()
              .mockRejectedValue(new Error(SENTINEL_SECRETS.redisHost)),
          }),
      },
      {
        name: 'getState',
        build: () => {
          const job = {
            getState: jest
              .fn()
              .mockRejectedValue(new Error(SENTINEL_SECRETS.redisUrl)),
            remove: jest.fn().mockResolvedValue(undefined),
          };
          return makeQueue(job as unknown as ReturnType<typeof makeJob>);
        },
      },
      {
        name: 'remove',
        build: () =>
          makeQueue(
            makeJob('completed', {
              remove: jest
                .fn()
                .mockRejectedValue(new Error(SENTINEL_SECRETS.bearer)),
            }),
          ),
      },
      {
        name: 'add (enqueue)',
        build: () =>
          makeQueue(undefined, {
            add: jest
              .fn()
              .mockRejectedValue(new Error(SENTINEL_SECRETS.redisUrl)),
          }),
      },
      {
        name: 'audit persistence',
        build: (store) => {
          store.createAudit.mockRejectedValueOnce(
            new Error(SENTINEL_SECRETS.employeeId),
          );
          return makeQueue(undefined);
        },
      },
    ];

    it.each(steps)('$name exposes no sentinel secret anywhere', async ({ build }) => {
      const store = new FakeExecutionStore();
      store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const queue = build(store);
      const spies = spyOnAllLoggerMethods();

      // Never rejects across the @Interval/Nest boundary.
      await expect(sweeperFor(store, queue).sweep()).resolves.toBeUndefined();

      expectNoSentinelSecrets(loggedText(spies));
      expectNoSentinelSecrets(JSON.stringify(store.audits));
      restoreLoggerSpies(spies);
    });

    it('logs only a stable code and the execution id when a step fails', async () => {
      const store = new FakeExecutionStore();
      const id = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const queue = makeQueue(undefined, {
        add: jest.fn().mockRejectedValue(new Error(SENTINEL_SECRETS.redisUrl)),
      });
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, queue).sweep();

      const logged = loggedText(spies);
      expect(logged).toContain('RECOVERY_ENQUEUE_FAILED');
      expect(logged).toContain(id);
      expect(logged).not.toContain('Re-enqueued');
      expectNoSentinelSecrets(logged);
      restoreLoggerSpies(spies);
    });

    it('a per-row failure does not prevent recovery of the next row', async () => {
      const store = new FakeExecutionStore();
      const failing = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      const healthy = store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });

      // Only the first row's getJob blows up; the second must still recover.
      const queue = makeQueue(undefined, {
        getJob: jest.fn().mockImplementation((jobId: string) => {
          if (jobId === failing) {
            return Promise.reject(new Error(SENTINEL_SECRETS.redisHost));
          }
          return Promise.resolve(undefined);
        }),
      });
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, queue).sweep();

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        { executionId: healthy },
        { jobId: healthy },
      );
      expect(store.auditEventTypes()).toEqual(['STALE_EXECUTION_REQUEUED']);
      expectNoSentinelSecrets(loggedText(spies));
      restoreLoggerSpies(spies);
    });

    it('an audit failure does not produce a success log line', async () => {
      const store = new FakeExecutionStore();
      store.addProcessing({ leaseExpiresAt: store.msAgo(60_000) });
      store.createAudit.mockRejectedValueOnce(new Error('audit write failed'));
      const spies = spyOnAllLoggerMethods();

      await sweeperFor(store, makeQueue(undefined)).sweep();

      expect(loggedText(spies)).not.toContain('Re-enqueued');
      restoreLoggerSpies(spies);
    });
  });

  it('does nothing when there are no recoverable rows', async () => {
    const store = new FakeExecutionStore();
    const queue = makeQueue(undefined);

    await sweeperFor(store, queue).sweep();

    expect(queue.add).not.toHaveBeenCalled();
    expect(store.auditEventTypes()).toEqual([]);
  });
});
