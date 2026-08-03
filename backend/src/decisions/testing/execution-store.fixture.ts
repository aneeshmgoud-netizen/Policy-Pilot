import { Logger } from '@nestjs/common';

/**
 * Shared test double for the `decision_executions` table.
 *
 * This exists so the sweeper's recovery-lease write and the processor's claim
 * CAS can be exercised against ONE piece of real mutable state, rather than
 * each being asserted against its own hand-stubbed mock. The interaction
 * between them is the thing that broke before — a sweeper write that
 * inadvertently refreshed the field the claim compared against — and a test
 * that mocks the interaction away cannot catch that class of bug.
 *
 * `where` clauses are evaluated by a small predicate interpreter covering the
 * operators these two services actually use (`lt`, `lte`, `in`, `null`,
 * equality, nested `AND`/`OR`), so the eligibility and CAS conditions under
 * test are the real ones, not a paraphrase.
 */

// Sentinels standing in for every sensitive shape a Prisma/Redis/downstream
// exception could carry. None may ever appear in a log line, a persisted row,
// an audit payload, or a thrown value.
export const SENTINEL_SECRETS = {
  redisHost: 'internal-redis.corp',
  dbHost: 'db-primary.internal',
  redisUrl: 'redis://admin:secret@host',
  bearer: 'Bearer abc123',
  employeeId: 'EMP-52190',
} as const;

export function expectNoSentinelSecrets(surface: string): void {
  for (const secret of Object.values(SENTINEL_SECRETS)) {
    expect(surface).not.toContain(secret);
  }
  // 'secret' alone would also catch a partially-redacted credential URL.
  expect(surface).not.toContain('admin:secret');
}

export function spyOnAllLoggerMethods(): jest.SpyInstance[] {
  return (['error', 'warn', 'log', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  );
}

export function loggedText(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
    .join('\n');
}

export function restoreLoggerSpies(spies: jest.SpyInstance[]): void {
  spies.forEach((spy) => spy.mockRestore());
}

export function makeJob(
  state: string,
  overrides: Partial<{ remove: jest.Mock }> = {},
) {
  return {
    getState: jest.fn().mockResolvedValue(state),
    remove: overrides.remove ?? jest.fn().mockResolvedValue(undefined),
  };
}

export interface ExecutionRow {
  id: string;
  humanDecisionId: string;
  outcome: 'GRANT' | 'REVOKE';
  status: string;
  attempts: number;
  lastError: string | null;
  errorCode: string | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  processingLeaseExpiresAt: Date | null;
  processingLeaseToken: string | null;
  recoveryLeaseToken: string | null;
  recoveryLeaseExpiresAt: Date | null;
  humanDecision: {
    accessRequestId: string;
    accessRequest: {
      employeeId: string;
      targetSystem: string;
      entitlementKey: string;
    };
  };
}

type Condition = Record<string, unknown>;

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null) {
    return value === null || value === undefined;
  }
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (typeof condition === 'object' && condition !== null) {
    const ops = condition as Record<string, unknown>;
    return Object.entries(ops).every(([op, operand]) => {
      switch (op) {
        case 'lt':
        case 'lte':
        case 'gt':
        case 'gte': {
          if (!(value instanceof Date) || !(operand instanceof Date)) {
            return false; // null/absent never satisfies a range comparison
          }
          const a = value.getTime();
          const b = operand.getTime();
          if (op === 'lt') return a < b;
          if (op === 'lte') return a <= b;
          if (op === 'gt') return a > b;
          return a >= b;
        }
        case 'in':
          return (operand as unknown[]).includes(value);
        case 'equals':
          return value === operand;
        default:
          throw new Error(`FakeExecutionStore: unsupported operator "${op}"`);
      }
    });
  }
  return value === condition;
}

function matches(row: ExecutionRow, where: Condition): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      return (condition as Condition[]).every((c) => matches(row, c));
    }
    if (key === 'OR') {
      return (condition as Condition[]).some((c) => matches(row, c));
    }
    return matchesField((row as unknown as Record<string, unknown>)[key], condition);
  });
}

/**
 * Row overrides, plus `leaseExpiresAt` as a readable shorthand for
 * `processingLeaseExpiresAt` — the field most tests here are actually about.
 */
export type RowOptions = Partial<ExecutionRow> & { leaseExpiresAt?: Date | null };

function normalizeOptions({
  leaseExpiresAt,
  ...rest
}: RowOptions): Partial<ExecutionRow> {
  return leaseExpiresAt === undefined
    ? rest
    : { ...rest, processingLeaseExpiresAt: leaseExpiresAt };
}

/**
 * A callable lazy thenable, modeling Prisma's PrismaPromise: the effect runs
 * when awaited directly or when array-form `$transaction` invokes it, and is
 * memoized so it happens exactly once either way.
 */
export interface LazyOp<T> {
  (): Promise<T>;
  then: Promise<T>['then'];
  catch: Promise<T>['catch'];
  finally: Promise<T>['finally'];
}

function lazyOp<T>(apply: () => T): LazyOp<T> {
  let started: Promise<T> | undefined;
  const run = (): Promise<T> => {
    started ??= (async () => apply())();
    return started;
  };
  const op = (() => run()) as LazyOp<T>;
  op.then = (...args) => run().then(...args);
  op.catch = (...args) => run().catch(...args);
  op.finally = (...args) => run().finally(...args);
  return op;
}

let sequence = 0;

export class FakeExecutionStore {
  private readonly rows = new Map<string, ExecutionRow>();
  readonly audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

  msAgo(ms: number): Date {
    return new Date(Date.now() - ms);
  }

  msFromNow(ms: number): Date {
    return new Date(Date.now() + ms);
  }

  private add(overrides: Partial<ExecutionRow>): string {
    const id = overrides.id ?? `exec-${++sequence}`;
    const now = new Date();
    this.rows.set(id, {
      id,
      humanDecisionId: `hd-${id}`,
      outcome: 'GRANT',
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      errorCode: null,
      executedAt: null,
      createdAt: now,
      updatedAt: now,
      processingLeaseExpiresAt: null,
      processingLeaseToken: null,
      recoveryLeaseToken: null,
      recoveryLeaseExpiresAt: null,
      humanDecision: {
        accessRequestId: `ar-${id}`,
        accessRequest: {
          employeeId: 'EMP-52190',
          targetSystem: 'DATA_WAREHOUSE',
          entitlementKey: 'FIN_DATASET_READ',
        },
      },
      ...overrides,
    });
    return id;
  }

  addPending(overrides: RowOptions = {}): string {
    return this.add({ status: 'PENDING', ...normalizeOptions(overrides) });
  }

  addProcessing(overrides: RowOptions = {}): string {
    return this.add({ status: 'PROCESSING', ...normalizeOptions(overrides) });
  }

  row(id: string): ExecutionRow {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`FakeExecutionStore: no row ${id}`);
    }
    return row;
  }

  setStatus(id: string, status: string): void {
    this.row(id).status = status;
  }

  setRecoveryLease(id: string, token: string | null, expiresAt: Date | null): void {
    const row = this.row(id);
    row.recoveryLeaseToken = token;
    row.recoveryLeaseExpiresAt = expiresAt;
  }

  auditEventTypes(): string[] {
    return this.audits.map((a) => a.eventType);
  }

  /** Unmocked findMany body, for tests that need to inject a mid-scan change. */
  realFindMany = async ({ where }: { where: Condition }): Promise<unknown[]> =>
    [...this.rows.values()].filter((row) => matches(row, where));

  readonly findMany = jest.fn(({ where }: { where: Condition }) =>
    this.realFindMany({ where }),
  );

  readonly updateMany = jest.fn(
    ({ where, data }: { where: Condition; data: Record<string, unknown> }) => {
      const matched = [...this.rows.values()].filter((row) => matches(row, where));
      matched.forEach((row) => this.applyData(row, data));
      return Promise.resolve({ count: matched.length });
    },
  );

  readonly findUniqueOrThrow = jest.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve(this.row(where.id)),
  );

  readonly findFirst = jest.fn(({ where }: { where: Condition }) =>
    Promise.resolve(
      [...this.rows.values()].find((row) => matches(row, where)) ?? null,
    ),
  );

  // Both of these return a lazy thenable, mirroring Prisma's PrismaPromise:
  // the write happens when the value is awaited directly (as the sweeper does)
  // OR when array-form $transaction executes it (as the processor does), and
  // exactly once either way.
  readonly update = jest.fn(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      lazyOp(() => {
        this.applyData(this.row(where.id), data);
        return this.row(where.id);
      }),
  );

  readonly createAudit = jest.fn((args: { data: Record<string, unknown> }) =>
    lazyOp(() => {
      this.audits.push({
        eventType: args.data.eventType as string,
        payload: (args.data.payload ?? {}) as Record<string, unknown>,
      });
      return {};
    }),
  );

  private applyData(row: ExecutionRow, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        'increment' in (value as Record<string, unknown>)
      ) {
        const current = (row as unknown as Record<string, number>)[key] ?? 0;
        (row as unknown as Record<string, number>)[key] =
          current + ((value as { increment: number }).increment ?? 0);
        continue;
      }
      (row as unknown as Record<string, unknown>)[key] = value;
    }
    // Mirror Prisma @updatedAt: any write moves it. This is precisely why
    // nothing may use it to decide processing staleness.
    if (!('updatedAt' in data)) {
      row.updatedAt = new Date();
    }
  }

  /**
   * A PrismaService-shaped facade over this store, usable by both the sweeper
   * and the processor so they operate on the same rows.
   */
  asPrismaService() {
    const decisionExecution = {
      findMany: this.findMany,
      findFirst: this.findFirst,
      updateMany: this.updateMany,
      findUniqueOrThrow: this.findUniqueOrThrow,
      update: this.update,
    };
    return {
      decisionExecution,
      auditLog: { create: this.createAudit },
      $transaction: jest.fn((arg: unknown) => {
        if (typeof arg === 'function') {
          // Interactive form: the processor's claim, and its fenced state
          // transitions (which write the row and its audit entry together).
          return (arg as (tx: unknown) => unknown)({
            decisionExecution,
            auditLog: { create: this.createAudit },
          });
        }
        // Array form: execute the queued lazy ops in order.
        return Promise.all((arg as Array<LazyOp<unknown>>).map((op) => op()));
      }),
    };
  }
}
