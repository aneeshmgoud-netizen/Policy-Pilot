import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  DecisionExecutionJobData,
  DecisionExecutionProcessor,
} from './decision-execution.processor';
import { ExecutionAdapter } from './execution-adapter.service';
import {
  EXECUTION_BOOKKEEPING_FAILED_CODE,
  EXECUTION_CLAIM_FAILED_CODE,
  executionErrorMessage,
  NonRetryableExecutionError,
  SanitizedRetryableExecutionError,
} from './execution-error.util';

// Every sensitive shape a downstream/Prisma/Redis exception could carry, in
// the messages injected below. None of these may appear on ANY surface.
const SENSITIVE_VALUES = [
  'EMP-52190',
  '52190',
  'CC-FIN-07',
  'FIN-07',
  'internal-provisioning.corp',
  'db-primary.internal',
  'hunter2',
  's3cr3t',
  'sk-live-abcdefghijklmnopqrstuvwxyz123456',
];

function expectContentFree(surface: string) {
  for (const value of SENSITIVE_VALUES) {
    expect(surface).not.toContain(value);
  }
}

// Capture every level, since a leak could go to any of them.
function spyOnAllLoggerMethods() {
  return (['error', 'warn', 'log', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
}

function loggedText(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
    .join('\n');
}

function restoreLoggerSpies(spies: jest.SpyInstance[]) {
  spies.forEach((spy) => spy.mockRestore());
}

const CLAIMED_ROW = {
  id: 'exec-1',
  humanDecisionId: 'hd-1',
  outcome: 'GRANT' as const,
  status: 'PROCESSING' as const,
  attempts: 1,
  lastError: null,
  errorCode: null,
  executedAt: null,
  createdAt: new Date('2026-07-29T00:00:00.000Z'),
  updatedAt: new Date('2026-07-29T00:00:00.000Z'),
  humanDecision: {
    accessRequestId: 'ar-1',
    accessRequest: {
      employeeId: 'EMP-52190',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
    },
  },
};

function makeClaimTxMock(claimedCount: number, row: unknown = CLAIMED_ROW) {
  return {
    decisionExecution: {
      updateMany: jest.fn().mockResolvedValue({ count: claimedCount }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
    },
  };
}

type TxWhere = { processingLeaseToken?: string } | undefined;

/**
 * Both claim() and fencedTransition() run in an interactive $transaction, so
 * this mock routes on the shape of the `where`: a clause presenting
 * `processingLeaseToken` is a fenced state write, anything else is the claim.
 *
 * `fencedCount` is what the fenced write reports matching — 1 for "this worker
 * still owns the lease", 0 for "it was reclaimed while we were stalled".
 */
function makePrismaMock(
  claimTx: ReturnType<typeof makeClaimTxMock>,
  { fencedCount = 1 }: { fencedCount?: number } = {},
) {
  const stateWrite = jest.fn().mockResolvedValue({ count: fencedCount });
  const auditCreate = jest.fn().mockResolvedValue({});

  const tx = {
    decisionExecution: {
      updateMany: jest.fn((args: { where: TxWhere }) =>
        args.where?.processingLeaseToken !== undefined
          ? stateWrite(args)
          : claimTx.decisionExecution.updateMany(args),
      ),
      findUniqueOrThrow: claimTx.decisionExecution.findUniqueOrThrow,
    },
    auditLog: { create: auditCreate },
  };

  const prisma = {
    // Exposed under the old names so assertions read naturally: `stateWrite`
    // is the fenced row update, `auditLog.create` the audit insert.
    decisionExecution: { update: stateWrite, updateMany: tx.decisionExecution.updateMany },
    auditLog: { create: auditCreate },
    $transaction: jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (t: unknown) => unknown)(tx);
      }
      return Promise.resolve(arg);
    }),
  } as unknown as PrismaService & {
    decisionExecution: { update: jest.Mock; updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  return prisma;
}

// $transaction always rejects with `err`, regardless of form — simulates
// claim() itself hitting a Prisma/DB failure before any row is claimed.
function makeClaimFailingPrismaMock(err: unknown) {
  return {
    decisionExecution: { update: jest.fn(), findUniqueOrThrow: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn().mockRejectedValue(err),
  } as unknown as PrismaService & {
    decisionExecution: { update: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
}

// claim() succeeds, but the fenced state write rejects — simulates a
// bookkeeping/Prisma failure while recording the outcome, after the row was
// already claimed (and, for the success case, after the downstream adapter
// call already happened).
function makeBookkeepingFailingPrismaMock(
  claimTx: ReturnType<typeof makeClaimTxMock>,
  err: unknown,
) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    decisionExecution: {
      updateMany: jest.fn((args: { where: TxWhere }) =>
        args.where?.processingLeaseToken !== undefined
          ? Promise.reject(err)
          : claimTx.decisionExecution.updateMany(args),
      ),
      findUniqueOrThrow: claimTx.decisionExecution.findUniqueOrThrow,
    },
    auditLog: { create: auditCreate },
  };
  return {
    decisionExecution: { update: jest.fn() },
    auditLog: { create: auditCreate },
    $transaction: jest.fn().mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (t: unknown) => unknown)(tx);
      }
      return Promise.reject(err);
    }),
  } as unknown as PrismaService & {
    decisionExecution: { update: jest.Mock };
    auditLog: { create: jest.Mock };
    $transaction: jest.Mock;
  };
}

function job(overrides: Partial<Job<DecisionExecutionJobData>> = {}): Job<DecisionExecutionJobData> {
  return {
    id: 'job-1',
    data: { executionId: 'exec-1' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job<DecisionExecutionJobData>;
}

describe('DecisionExecutionProcessor', () => {
  it('claims a PENDING row (via CAS), calls the adapter with the row id as the idempotency key, and marks it SUCCEEDED', async () => {
    const claimTx = makeClaimTxMock(1);
    const prisma = makePrismaMock(claimTx);
    const execute = jest.fn().mockResolvedValue(undefined);
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await processor.process(job());

    // The claim CAS writes a fresh processing lease, releases any recovery
    // ownership the sweeper held, and counts the attempt — all atomically.
    expect(claimTx.decisionExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'exec-1' }),
        data: {
          status: 'PROCESSING',
          processingLeaseExpiresAt: expect.any(Date),
          processingLeaseToken: expect.any(String),
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          attempts: { increment: 1 },
        },
      }),
    );
    // Eligibility is the explicit lease, never updatedAt.
    const claimWhere = (claimTx.decisionExecution.updateMany as jest.Mock).mock
      .calls[0][0].where;
    expect(JSON.stringify(claimWhere)).not.toContain('updatedAt');
    expect(claimWhere.OR).toEqual([
      { status: 'PENDING' },
      { status: 'PROCESSING', processingLeaseExpiresAt: { lte: expect.any(Date) } },
      { status: 'PROCESSING', processingLeaseExpiresAt: null },
    ]);
    expect(execute).toHaveBeenCalledWith({
      idempotencyKey: 'exec-1',
      outcome: 'GRANT',
      employeeId: 'EMP-52190',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
    });
    expect(prisma.decisionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED', lastError: null }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'EXECUTION_SUCCEEDED' }),
      }),
    );
  });

  describe('lease fencing: a superseded worker may not write terminal state', () => {
    it('conditions every state write on id + status=PROCESSING + this worker’s lease token', async () => {
      const claimTx = makeClaimTxMock(1);
      const prisma = makePrismaMock(claimTx);
      await new DecisionExecutionProcessor(
        prisma,
        { execute: jest.fn().mockResolvedValue(undefined) } as unknown as ExecutionAdapter,
      ).process(job());

      const fenced = (prisma.decisionExecution.update as jest.Mock).mock.calls[0][0];
      expect(fenced.where).toEqual({
        id: 'exec-1',
        status: 'PROCESSING',
        processingLeaseToken: expect.any(String),
      });
      // The token presented is the one the claim wrote, not a re-read value.
      const claimed = (claimTx.decisionExecution.updateMany as jest.Mock).mock
        .calls[0][0];
      expect(fenced.where.processingLeaseToken).toBe(
        claimed.data.processingLeaseToken,
      );
    });

    it('writes NOTHING — not the row, not the audit — when the lease was reclaimed before recording SUCCEEDED', async () => {
      const claimTx = makeClaimTxMock(1);
      // fencedCount 0 = another worker reclaimed this row while we were stalled.
      const prisma = makePrismaMock(claimTx, { fencedCount: 0 });
      const spies = spyOnAllLoggerMethods();

      await new DecisionExecutionProcessor(
        prisma,
        { execute: jest.fn().mockResolvedValue(undefined) } as unknown as ExecutionAdapter,
      ).process(job());

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      const logged = loggedText(spies);
      expect(logged).toContain('EXECUTION_LEASE_LOST');
      expect(logged).not.toContain('succeeded on attempt');
      restoreLoggerSpies(spies);
    });

    it('does not resurrect a row another worker already completed: a fenced-out retryable failure writes neither PENDING nor an audit', async () => {
      // The dangerous sequence: A stalls, B reclaims and records SUCCEEDED, A
      // resumes with retries remaining and would write PENDING — turning a
      // finished execution back into a pending one, with a contradictory
      // EXECUTION_FAILED audit entry.
      const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
      const prisma = makePrismaMock(claimTx, { fencedCount: 0 });
      const spies = spyOnAllLoggerMethods();

      await new DecisionExecutionProcessor(
        prisma,
        { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ExecutionAdapter,
      )
        .process(job({ attemptsMade: 0 }))
        .catch(() => undefined);

      // The write was attempted and rejected by the fence...
      expect(prisma.decisionExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING' }),
        }),
      );
      // ...and crucially left no audit trail claiming it happened.
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(loggedText(spies)).toContain('EXECUTION_LEASE_LOST');
      restoreLoggerSpies(spies);
    });

    it('does not write a fenced-out FAILED on the final attempt either', async () => {
      const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 3 });
      const prisma = makePrismaMock(claimTx, { fencedCount: 0 });

      await new DecisionExecutionProcessor(
        prisma,
        { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ExecutionAdapter,
      )
        .process(job({ attemptsMade: 2 }))
        .catch(() => undefined);

      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('clears the lease token on every terminal transition, so a stale token can never match again', async () => {
      for (const [attempts, attemptsMade, expected] of [
        [1, 0, 'PENDING'],
        [3, 2, 'FAILED'],
      ] as const) {
        const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts });
        const prisma = makePrismaMock(claimTx);
        await new DecisionExecutionProcessor(
          prisma,
          { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ExecutionAdapter,
        )
          .process(job({ attemptsMade }))
          .catch(() => undefined);
        expect(
          (prisma.decisionExecution.update as jest.Mock).mock.calls[0][0].data,
        ).toMatchObject({
          status: expected,
          processingLeaseExpiresAt: null,
          processingLeaseToken: null,
        });
      }
    });
  });

  it('releases the processing lease on every transition out of PROCESSING', async () => {
    // SUCCEEDED
    const okTx = makeClaimTxMock(1);
    const okPrisma = makePrismaMock(okTx);
    await new DecisionExecutionProcessor(
      okPrisma,
      { execute: jest.fn().mockResolvedValue(undefined) } as unknown as ExecutionAdapter,
    ).process(job());
    expect(
      (okPrisma.decisionExecution.update as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({ status: 'SUCCEEDED', processingLeaseExpiresAt: null });

    // PENDING (retryable failure, retries remaining)
    const retryTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const retryPrisma = makePrismaMock(retryTx);
    await new DecisionExecutionProcessor(
      retryPrisma,
      { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ExecutionAdapter,
    )
      .process(job({ attemptsMade: 0 }))
      .catch(() => undefined);
    expect(
      (retryPrisma.decisionExecution.update as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({ status: 'PENDING', processingLeaseExpiresAt: null });

    // FAILED (final attempt)
    const finalTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 3 });
    const finalPrisma = makePrismaMock(finalTx);
    await new DecisionExecutionProcessor(
      finalPrisma,
      { execute: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ExecutionAdapter,
    )
      .process(job({ attemptsMade: 2 }))
      .catch(() => undefined);
    expect(
      (finalPrisma.decisionExecution.update as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({ status: 'FAILED', processingLeaseExpiresAt: null });
  });

  it('is a safe no-op when the row is not claimable (already resolved, claimed elsewhere, or unknown)', async () => {
    const claimTx = makeClaimTxMock(0);
    const prisma = makePrismaMock(claimTx);
    const execute = jest.fn();
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await processor.process(job());

    expect(execute).not.toHaveBeenCalled();
    expect(prisma.decisionExecution.update).not.toHaveBeenCalled();
  });

  it('duplicate job delivery for an already-SUCCEEDED row never re-executes: the CAS claim simply fails', async () => {
    // Simulates redelivery of the same jobId after a prior run already
    // completed it: the claim query's WHERE (PENDING, or stale PROCESSING)
    // no longer matches a SUCCEEDED row, so updateMany claims zero rows.
    const claimTx = makeClaimTxMock(0);
    const prisma = makePrismaMock(claimTx);
    const execute = jest.fn();
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await processor.process(job());
    await processor.process(job()); // duplicate delivery

    expect(execute).not.toHaveBeenCalled();
  });

  it('on failure with retries remaining: resets status to PENDING (not left PROCESSING) so a retry can re-claim, records sanitized error, and rethrows', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const prisma = makePrismaMock(claimTx);
    const execute = jest
      .fn()
      .mockRejectedValue(new Error('downstream 500 for EMP-52190'));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await expect(processor.process(job({ attemptsMade: 0 }))).rejects.toBeInstanceOf(
      SanitizedRetryableExecutionError,
    );

    expect(prisma.decisionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    const updateCall = (prisma.decisionExecution.update as jest.Mock).mock
      .calls[0][0];
    // Fully code-derived: not even a masked form of the exception text.
    expect(updateCall.data.errorCode).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expect(updateCall.data.lastError).toBe(
      executionErrorMessage('DOWNSTREAM_EXECUTION_FAILED'),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'EXECUTION_FAILED' }),
      }),
    );
  });

  it('on the final attempt: marks the row FAILED (terminal) instead of resetting to PENDING', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 3 });
    const prisma = makePrismaMock(claimTx);
    const execute = jest.fn().mockRejectedValue(new Error('still down'));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await expect(processor.process(job({ attemptsMade: 2 }))).rejects.toBeInstanceOf(
      SanitizedRetryableExecutionError,
    );

    expect(prisma.decisionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('a NonRetryableExecutionError marks the row FAILED immediately and does not rethrow (no wasted retry budget)', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const prisma = makePrismaMock(claimTx);
    const execute = jest
      .fn()
      .mockRejectedValue(new NonRetryableExecutionError('permanently rejected'));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    await expect(processor.process(job({ attemptsMade: 0 }))).resolves.toBeUndefined();

    expect(prisma.decisionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('no exception-derived text reaches ANY surface: logger, decisionExecution update, audit payload, or the BullMQ-facing error', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const prisma = makePrismaMock(claimTx);
    const rawMessage =
      'downstream call to internal-provisioning.corp failed for EMP-52190 ' +
      '(CC-FIN-07): request to https://svc:hunter2@db-primary.internal:5432/api ' +
      'failed, Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456';
    const execute = jest.fn().mockRejectedValue(new Error(rawMessage));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const logSpies = spyOnAllLoggerMethods();

    const rejected = await processor
      .process(job({ attemptsMade: 0 }))
      .catch((err: unknown) => err);

    const updateCall = (prisma.decisionExecution.update as jest.Mock).mock
      .calls[0][0];
    const auditCall = (
      prisma.auditLog.create as jest.Mock
    ).mock.calls.find((c) => c[0].data.eventType === 'EXECUTION_FAILED')[0];
    const bullmqFacing = rejected as SanitizedRetryableExecutionError;

    const allSurfaces = [
      // 1. every application log line emitted during this run
      loggedText(logSpies),
      // 2. what gets written to decision_executions
      JSON.stringify(updateCall.data),
      // 3. what gets written to the audit trail
      JSON.stringify(auditCall.data.payload),
      // 4. what BullMQ persists as failedReason/stacktrace
      bullmqFacing.message,
      bullmqFacing.stack ?? '',
      JSON.stringify(bullmqFacing),
    ];

    for (const surface of allSurfaces) {
      expectContentFree(surface);
      expect(surface).not.toContain(rawMessage);
    }

    restoreLoggerSpies(logSpies);

    // ...while the safe structured fields are all still there.
    expect(updateCall.data.errorCode).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expect(updateCall.data.lastError).toBe(
      executionErrorMessage('DOWNSTREAM_EXECUTION_FAILED'),
    );
    expect(auditCall.data.payload).toMatchObject({
      executionId: 'exec-1',
      attempt: 1,
      maxAttempts: 3,
      finalAttempt: false,
      errorCode: 'DOWNSTREAM_EXECUTION_FAILED',
    });
  });

  it('a NonRetryableExecutionError’s own message never reaches any surface either, while staying terminal and distinctly coded', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const prisma = makePrismaMock(claimTx);
    const execute = jest
      .fn()
      .mockRejectedValue(
        new NonRetryableExecutionError(
          'rejected by internal-provisioning.corp for EMP-52190 (CC-FIN-07): ' +
            'Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456',
        ),
      );
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const logSpies = spyOnAllLoggerMethods();

    // Terminal without spending retry budget: resolves rather than rejecting.
    await expect(processor.process(job({ attemptsMade: 0 }))).resolves.toBeUndefined();

    const updateCall = (prisma.decisionExecution.update as jest.Mock).mock
      .calls[0][0];
    const auditCall = (
      prisma.auditLog.create as jest.Mock
    ).mock.calls.find((c) => c[0].data.eventType === 'EXECUTION_FAILED')[0];

    for (const surface of [
      loggedText(logSpies),
      JSON.stringify(updateCall.data),
      JSON.stringify(auditCall.data.payload),
    ]) {
      expectContentFree(surface);
    }
    restoreLoggerSpies(logSpies);

    expect(updateCall.data.status).toBe('FAILED');
    expect(updateCall.data.errorCode).toBe('DOWNSTREAM_REJECTED');
    expect(updateCall.data.lastError).toBe(
      executionErrorMessage('DOWNSTREAM_REJECTED'),
    );
  });

  it('never rethrows the raw adapter exception: the error rejected from process() contains none of the sensitive raw values and only the stable sanitized code, with no cause and no stack leakage', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const prisma = makePrismaMock(claimTx);
    const rawMessage =
      'downstream call to internal-provisioning.corp failed for EMP-52190 (CC-FIN-07): ' +
      'redis://default:hunter2@internal-redis.corp:6379 unreachable, ' +
      'Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456';
    const execute = jest.fn().mockRejectedValue(new Error(rawMessage));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const rejected = await processor
      .process(job({ attemptsMade: 0 }))
      .catch((err: unknown) => err);

    expect(rejected).toBeInstanceOf(SanitizedRetryableExecutionError);
    const sanitized = rejected as SanitizedRetryableExecutionError;
    expect(sanitized.code).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expect((sanitized as unknown as Record<string, unknown>).cause).toBeUndefined();

    for (const surface of [sanitized.message, sanitized.stack ?? '']) {
      expect(surface).not.toContain('52190');
      expect(surface).not.toContain('FIN-07');
      expect(surface).not.toContain('hunter2');
      expect(surface).not.toContain('internal-redis.corp');
      expect(surface).not.toContain('internal-provisioning.corp');
      expect(surface).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz123456');
      expect(surface).not.toContain(rawMessage);
    }
    // Only the stable code plus that code's fixed table entry — nothing
    // downstream-derived at all.
    expect(sanitized.message).toBe(
      `Execution failed (DOWNSTREAM_EXECUTION_FAILED). ` +
        `${executionErrorMessage('DOWNSTREAM_EXECUTION_FAILED')}`,
    );
  });

  it('a claim() failure (e.g. a Prisma outage) never reaches BullMQ raw, and is retryable', async () => {
    const dbErr = new Error(
      'connect ECONNREFUSED postgres://app:s3cr3t@db-primary.internal:5432/policy_pilot',
    );
    const prisma = makeClaimFailingPrismaMock(dbErr);
    const execute = jest.fn();
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const logSpies = spyOnAllLoggerMethods();
    const rejected = await processor.process(job()).catch((err: unknown) => err);

    expect(execute).not.toHaveBeenCalled();
    expect(rejected).toBeInstanceOf(SanitizedRetryableExecutionError);
    const sanitized = rejected as SanitizedRetryableExecutionError;
    expect(sanitized.code).toBe(EXECUTION_CLAIM_FAILED_CODE);
    for (const surface of [
      sanitized.message,
      sanitized.stack ?? '',
      loggedText(logSpies),
    ]) {
      expectContentFree(surface);
    }
    restoreLoggerSpies(logSpies);
  });

  it('a failure while recording FAILED state cannot leak its raw Prisma/error message to BullMQ, and remains retryable', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const bookkeepingErr = new Error(
      'prisma write failed: connection to postgres://app:s3cr3t@db-primary.internal:5432 lost',
    );
    const prisma = makeBookkeepingFailingPrismaMock(claimTx, bookkeepingErr);
    const execute = jest
      .fn()
      .mockRejectedValue(new Error('downstream 500 for EMP-52190'));
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const logSpies = spyOnAllLoggerMethods();
    const rejected = await processor
      .process(job({ attemptsMade: 0 }))
      .catch((err: unknown) => err);

    expect(rejected).toBeInstanceOf(SanitizedRetryableExecutionError);
    const sanitized = rejected as SanitizedRetryableExecutionError;
    expect(sanitized.code).toBe(EXECUTION_BOOKKEEPING_FAILED_CODE);
    for (const surface of [
      sanitized.message,
      sanitized.stack ?? '',
      loggedText(logSpies),
    ]) {
      expectContentFree(surface);
    }
    restoreLoggerSpies(logSpies);
  });

  it('a failure while recording SUCCEEDED state after the external effect already happened cannot leak raw details and stays retryable/recoverable', async () => {
    const claimTx = makeClaimTxMock(1, { ...CLAIMED_ROW, attempts: 1 });
    const bookkeepingErr = new Error(
      'prisma write failed: postgres://app:s3cr3t@db-primary.internal:5432 unreachable',
    );
    const prisma = makeBookkeepingFailingPrismaMock(claimTx, bookkeepingErr);
    const execute = jest.fn().mockResolvedValue(undefined); // adapter succeeded
    const adapter = { execute } as unknown as ExecutionAdapter;
    const processor = new DecisionExecutionProcessor(prisma, adapter);

    const logSpies = spyOnAllLoggerMethods();
    const rejected = await processor.process(job()).catch((err: unknown) => err);

    expect(execute).toHaveBeenCalled(); // the downstream effect did happen
    expect(rejected).toBeInstanceOf(SanitizedRetryableExecutionError);
    const sanitized = rejected as SanitizedRetryableExecutionError;
    expect(sanitized.code).toBe(EXECUTION_BOOKKEEPING_FAILED_CODE);
    for (const surface of [
      sanitized.message,
      sanitized.stack ?? '',
      loggedText(logSpies),
    ]) {
      expectContentFree(surface);
    }
    restoreLoggerSpies(logSpies);
    // The row's transaction rolled back (still PROCESSING in the DB
    // simulated here by the failed $transaction call) — recovery for this
    // case is the stale-execution mechanism (claim()'s staleness CAS /
    // DecisionExecutionSweeperService), not this test's concern directly,
    // but nothing here should have marked it SUCCEEDED.
  });
});
