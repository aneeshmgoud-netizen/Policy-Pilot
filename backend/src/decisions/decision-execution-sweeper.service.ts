import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  DECISION_EXECUTION_JOB_NAME,
  DECISION_EXECUTION_QUEUE,
  RECOVERY_LEASE_DURATION_MS,
  STALE_PENDING_THRESHOLD_MS,
  SWEEP_INTERVAL_MS,
} from './decision-execution.constants';
import { DecisionExecutionJobData } from './decision-execution.processor';
import {
  OPERATIONAL_ERROR_CODES,
  OperationalErrorCode,
  runContentFree,
} from './execution-error.util';

const SWEEPER_ACTOR = 'system:decision-execution-sweeper';

// States in which a BullMQ job is genuinely runnable — i.e. some worker will
// still pick it up on its own. Never touch (remove or duplicate) a job in
// one of these states.
const RUNNABLE_JOB_STATES = new Set([
  'active',
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
]);

interface RecoverableExecution {
  id: string;
  status: string;
  humanDecisionId: string;
  humanDecision: { accessRequestId: string };
}

/**
 * The complete definition of "this row needs recovery", as a single reusable
 * predicate. Built once and applied to BOTH the eligibility scan and the
 * ownership CAS — that is the point, not a convenience.
 *
 * When the CAS carried only a subset of these conditions, a worker could
 * legitimately claim the row (writing a fresh processing lease) in the window
 * between scan and CAS, and the sweeper would still win ownership and enqueue
 * "recovery" for a row that was actively being processed. The enqueued job
 * would no-op against the live lease, so execution state stayed correct, but
 * the STALE_EXECUTION_REQUEUED audit entry asserted an intervention that never
 * happened — and in a system whose purpose is defensible access decisions, an
 * audit trail that misdescribes what the system did is the actual defect.
 */
function recoverableConditions(now: Date, pendingStaleBefore: Date) {
  return [
    // Orphaned: committed but seemingly never enqueued. Nobody holds a PENDING
    // row, so age is the only signal available — and safe here, because the
    // claim CAS accepts PENDING unconditionally rather than comparing
    // timestamps.
    { status: 'PENDING' as const, updatedAt: { lt: pendingStaleBefore } },
    // Abandoned mid-flight: the worker's explicit lease lapsed.
    { status: 'PROCESSING' as const, processingLeaseExpiresAt: { lte: now } },
    // Defensive: PROCESSING with no lease at all can only mean it was never
    // written, so nothing holds the row. The claim CAS accepts this case too,
    // so recovering it terminates.
    { status: 'PROCESSING' as const, processingLeaseExpiresAt: null },
  ];
}

/** No sweeper replica currently holds a live recovery lease on the row. */
function unownedConditions(now: Date) {
  return [
    { recoveryLeaseExpiresAt: null },
    { recoveryLeaseExpiresAt: { lte: now } },
  ];
}

/**
 * Recovery for the Postgres -> Redis dual-write gap in the execution outbox:
 * DecisionsService commits the DecisionExecution row, then enqueues its BullMQ
 * job as a separate step. A crash between those two leaves the row permanently
 * PENDING with no job. A worker crash *during* processing leaves it PROCESSING
 * with a lease nobody will ever resolve. This sweeper finds both and
 * re-enqueues them under the same deterministic `jobId: execution.id`.
 *
 * Two distinct concurrency problems are handled by two distinct mechanisms,
 * which is the whole point of the design:
 *
 *  - **Is this row actually abandoned?** Answered only by
 *    `processingLeaseExpiresAt`, the worker's explicit lease. Never by
 *    `updatedAt`: that is `@updatedAt` record metadata which moves on *any*
 *    write, so an earlier version of this sweeper — which advanced it to mark
 *    its own progress — made stale rows look freshly claimed and blocked the
 *    recovery it had just enqueued. Nothing here writes the processing lease.
 *
 *  - **Which replica gets to do the recovery?** Answered by a separate
 *    `recoveryLeaseToken`/`recoveryLeaseExpiresAt` CAS, taken before any Redis
 *    access. Without it, two replicas would both see no job, both `add()`
 *    (the loser silently deduping against the winner's job), and both write
 *    STALE_EXECUTION_REQUEUED — double-counting one recovery. Redis dedup
 *    cannot arbitrate that; only the database can. Ownership is held until the
 *    worker claims the row (claim() clears it) or the lease expires.
 *
 * A retained *terminal* BullMQ job needs handling too: `add()` only dedupes
 * against runnable jobs, but a completed/failed job still reserves its jobId
 * and makes `add()` a silent no-op. The queue's removeOnComplete/removeOnFail
 * settings prevent that going forward; the lease winner also removes any such
 * job left over from before those settings existed.
 *
 * Every fallible step — each Prisma query, the CAS, getJob, getState, remove,
 * add, and the audit insert — goes through runContentFree, so no exception
 * body can reach the logs, the database, or the scheduler, and one bad row
 * can never abort the rest of the sweep.
 */
@Injectable()
export class DecisionExecutionSweeperService {
  private readonly logger = new Logger(DecisionExecutionSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(DECISION_EXECUTION_QUEUE)
    private readonly executionQueue: Queue<DecisionExecutionJobData>,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    // Outermost guard: @Interval invokes this unawaited, so an escaping
    // rejection would become an unhandled promise rejection carrying the raw
    // exception straight into the scheduler's own logging.
    const swept = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_SWEEP_FAILED,
      () => this.sweepRecoverableExecutions(),
    );
    if (!swept.ok) {
      this.logFailure(swept.code);
    }
  }

  private async sweepRecoverableExecutions(): Promise<void> {
    const now = new Date();
    const pendingStaleBefore = new Date(
      now.getTime() - STALE_PENDING_THRESHOLD_MS,
    );

    const scan = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_SCAN_FAILED,
      () =>
        this.prisma.decisionExecution.findMany({
          where: {
            AND: [
              { OR: unownedConditions(now) },
              { OR: recoverableConditions(now, pendingStaleBefore) },
            ],
          },
          select: {
            id: true,
            status: true,
            humanDecisionId: true,
            humanDecision: { select: { accessRequestId: true } },
          },
        }),
    );

    if (!scan.ok) {
      this.logFailure(scan.code);
      return;
    }

    for (const execution of scan.value) {
      // Per-row guard: a failure recovering one row must never prevent
      // recovery of the next one.
      const recovered = await runContentFree(
        OPERATIONAL_ERROR_CODES.RECOVERY_ROW_FAILED,
        () => this.recoverExecution(execution),
      );
      if (!recovered.ok) {
        this.logFailure(recovered.code, execution.id);
      }
    }
  }

  private async recoverExecution(execution: RecoverableExecution): Promise<void> {
    // Step 1 — win recovery ownership in the database before touching Redis.
    // A loser does nothing at all: no job inspection, no removal, no enqueue,
    // no audit, no recovery log.
    const owned = await this.acquireRecoveryOwnership(execution.id);
    if (!owned.ok) {
      this.logFailure(owned.code, execution.id);
      return;
    }
    const recoveryToken = owned.value;
    if (recoveryToken === null) {
      // Either another replica owns recovery, or the row stopped being
      // recoverable between the scan and the CAS (a worker claimed it, or it
      // resolved). Either way: nothing to do, and nothing to record.
      return;
    }

    // Step 2 — only the owner may inspect/remove the deterministic job.
    const cleared = await this.clearBlockingTerminalJob(execution.id);
    if (!cleared.ok) {
      this.logFailure(cleared.code, execution.id);
      return;
    }
    if (!cleared.value) {
      return; // still runnable, or an unknown state / lost remove() race
    }

    // Step 3 — create the recovery work. Ownership is deliberately NOT
    // released on failure: it simply expires, so the row is retried by a
    // later sweep rather than immediately re-contended.
    const enqueued = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_ENQUEUE_FAILED,
      () =>
        this.executionQueue.add(
          DECISION_EXECUTION_JOB_NAME,
          { executionId: execution.id },
          { jobId: execution.id },
        ),
    );
    if (!enqueued.ok) {
      this.logFailure(enqueued.code, execution.id);
      return;
    }

    // Step 4 — confirm this replica still owns the recovery and the row is
    // still recoverable before claiming credit for the intervention.
    const stillOwned = await this.stillOwnsRecovery(execution.id, recoveryToken);
    if (!stillOwned.ok) {
      this.logFailure(stillOwned.code, execution.id);
      return;
    }
    if (!stillOwned.value) {
      this.logFailure(
        OPERATIONAL_ERROR_CODES.RECOVERY_OWNERSHIP_LOST,
        execution.id,
      );
      return;
    }

    // Step 5 — runnable work now exists and is ours, so record it exactly once.
    const audited = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_AUDIT_FAILED,
      () =>
        this.prisma.auditLog.create({
          data: {
            accessRequestId: execution.humanDecision.accessRequestId,
            eventType: 'STALE_EXECUTION_REQUEUED',
            actor: SWEEPER_ACTOR,
            payload: {
              executionId: execution.id,
              humanDecisionId: execution.humanDecisionId,
              statusAtSweep: execution.status,
            },
          },
        }),
    );
    if (!audited.ok) {
      this.logFailure(audited.code, execution.id);
      return;
    }

    this.logger.warn(
      `Re-enqueued stale ${execution.status} decision execution ${execution.id}: ` +
        `no runnable job and no live processing lease, indicating either a crash ` +
        `between the Postgres commit and the original enqueue, or a worker that ` +
        `died mid-claim.`,
    );
  }

  /**
   * Single-winner recovery ownership. Concurrent replicas all attempt the same
   * conditional update; PostgreSQL serializes them, so exactly one matches a
   * row and every other sees `count === 0`.
   *
   * Crucially this writes ONLY the recovery-lease columns. It never touches
   * `processingLeaseExpiresAt`, so acquiring ownership cannot extend or reset
   * processing staleness — the worker this sweep is about to enqueue will
   * still find the row immediately claimable. (`updatedAt` does move, as it
   * does on any write, which is exactly why nothing reads it to decide
   * PROCESSING staleness any more.)
   *
   * The status condition also covers the row resolving mid-sweep: a row that
   * reached SUCCEEDED/FAILED no longer matches, so no misleading recovery is
   * enqueued or audited.
   */
  private async acquireRecoveryOwnership(
    executionId: string,
  ): Promise<
    | { ok: true; value: string | null }
    | { ok: false; code: OperationalErrorCode }
  > {
    const now = new Date();
    const pendingStaleBefore = new Date(
      now.getTime() - STALE_PENDING_THRESHOLD_MS,
    );
    const token = randomUUID();
    const result = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_CAS_FAILED,
      () =>
        this.prisma.decisionExecution.updateMany({
          where: {
            id: executionId,
            AND: [
              { OR: unownedConditions(now) },
              // The FULL recoverability predicate, re-evaluated atomically.
              // Re-checking here is what closes the scan-to-CAS window: if a
              // worker claimed the row in the meantime it now holds a live
              // processing lease, this no longer matches, and the sweeper
              // correctly declines ownership.
              { OR: recoverableConditions(now, pendingStaleBefore) },
            ],
          },
          data: {
            recoveryLeaseToken: token,
            recoveryLeaseExpiresAt: new Date(
              now.getTime() + RECOVERY_LEASE_DURATION_MS,
            ),
          },
        }),
    );
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: result.value.count === 1 ? token : null };
  }

  /**
   * Re-verifies, immediately before the audit write, that this replica still
   * holds the recovery token it acquired AND that the row is still recoverable.
   * Between the CAS and the enqueue the row can legitimately move on — a
   * worker may claim it, or the lease may have lapsed and been taken by
   * another replica. Auditing a recovery in that case would describe an
   * intervention this replica did not actually own.
   */
  private async stillOwnsRecovery(
    executionId: string,
    token: string,
  ): Promise<{ ok: true; value: boolean } | { ok: false; code: OperationalErrorCode }> {
    const now = new Date();
    const pendingStaleBefore = new Date(
      now.getTime() - STALE_PENDING_THRESHOLD_MS,
    );
    const found = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_CAS_FAILED,
      () =>
        this.prisma.decisionExecution.findFirst({
          where: {
            id: executionId,
            recoveryLeaseToken: token,
            recoveryLeaseExpiresAt: { gt: now },
            OR: recoverableConditions(now, pendingStaleBefore),
          },
          select: { id: true },
        }),
    );
    if (!found.ok) {
      return found;
    }
    return { ok: true, value: found.value !== null };
  }

  /**
   * Called only by the recovery-ownership winner. Resolves true if a fresh job
   * can now be added — there either was no Redis job, or a genuinely terminal
   * one that has just been removed. Resolves false, having mutated nothing, if
   * a job with this id is still runnable, is in an unrecognized state, or if
   * removal lost a race: creating competing work in any of those cases would
   * be wrong regardless of what the database says.
   */
  private async clearBlockingTerminalJob(
    executionId: string,
  ): Promise<{ ok: true; value: boolean } | { ok: false; code: OperationalErrorCode }> {
    const found = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_JOB_INSPECT_FAILED,
      () => this.executionQueue.getJob(executionId),
    );
    if (!found.ok) {
      return found;
    }
    const existingJob = found.value;
    if (!existingJob) {
      return { ok: true, value: true };
    }

    const state = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_JOB_INSPECT_FAILED,
      () => existingJob.getState(),
    );
    if (!state.ok) {
      return state;
    }
    if (RUNNABLE_JOB_STATES.has(state.value)) {
      // Some worker will still process this on its own — never remove an
      // active job, and never create a duplicate for one still waiting.
      return { ok: true, value: false };
    }
    if (state.value !== 'completed' && state.value !== 'failed') {
      // Unknown/unrecognized state — be conservative and leave it alone.
      return { ok: true, value: false };
    }

    const removed = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_JOB_REMOVE_FAILED,
      () => existingJob.remove(),
    );
    if (!removed.ok) {
      // Lost a race — e.g. the job became active and got locked between
      // getState() and remove(). Treated the same as "still runnable": don't
      // create competing work. The recovery lease expires and a later sweep
      // re-evaluates if the row is genuinely stuck.
      this.logFailure(removed.code, executionId);
      return { ok: true, value: false };
    }
    return { ok: true, value: true };
  }

  /**
   * The only failure-logging path in this service. Emits a stable code plus,
   * where applicable, the execution id — both safe, non-sensitive values.
   * Nothing derived from an exception is available to log here by
   * construction: runContentFree never surfaces one (see its `catch`).
   */
  private logFailure(code: OperationalErrorCode, executionId?: string): void {
    this.logger.error(
      executionId
        ? `Stale-execution recovery step failed for ${executionId}: ${code}. ` +
            `The row remains recoverable and a later sweep will retry it.`
        : `Stale-execution recovery sweep failed: ${code}. ` +
            `Recoverable rows are retried on the next sweep interval.`,
    );
  }
}
