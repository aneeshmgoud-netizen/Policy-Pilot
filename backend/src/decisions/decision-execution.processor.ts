import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  DECISION_EXECUTION_QUEUE,
  PROCESSING_LEASE_DURATION_MS,
} from './decision-execution.constants';
import { ExecutionAdapter } from './execution-adapter.service';
import {
  classifyExecutionError,
  EXECUTION_BOOKKEEPING_FAILED_CODE,
  EXECUTION_CLAIM_FAILED_CODE,
  executionErrorMessage,
  NonRetryableExecutionError,
  OPERATIONAL_ERROR_CODES,
  SanitizedRetryableExecutionError,
} from './execution-error.util';

export interface DecisionExecutionJobData {
  executionId: string;
}

const EXECUTION_ACTOR = 'system:decision-execution-worker';

type ClaimedExecution = Prisma.DecisionExecutionGetPayload<{
  include: { humanDecision: { include: { accessRequest: true } } };
}> & {
  // The fencing token written by the claim that produced this value. Required
  // by every subsequent state write for this row — see fencedTransition.
  leaseToken: string;
};

// Consumes the execution outbox: one job per DecisionExecution row, enqueued
// by DecisionsService (and, for the crash-recovery case, re-enqueued by
// DecisionExecutionSweeperService) with a stable jobId equal to the row's id.
//
// This is what actually completes the outbox pattern DecisionsService only
// starts: the row is created PENDING inside the human-decision transaction,
// and everything from here on — claiming it, calling the downstream adapter,
// and recording the outcome — happens asynchronously and outside that
// transaction, so a crash can never leave "decision committed, but we don't
// know if it executed" without a PENDING/PROCESSING row that a later run can
// find and safely retry.
//
// Rate-limited to the same ~60 jobs/minute downstream-system constraint as
// AccessRequestProcessor, since this queue is the one that actually calls
// the downstream system.
@Processor(DECISION_EXECUTION_QUEUE, { limiter: { max: 60, duration: 60_000 } })
export class DecisionExecutionProcessor extends WorkerHost {
  private readonly logger = new Logger(DecisionExecutionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionAdapter: ExecutionAdapter,
  ) {
    super();
  }

  async process(job: Job<DecisionExecutionJobData>): Promise<void> {
    const { executionId } = job.data;

    let claim: ClaimedExecution | null;
    try {
      claim = await this.claim(executionId);
    } catch {
      // A Prisma/DB failure during claim() never leaves the row claimed (the
      // transaction rolled back), so it's still safely re-claimable later —
      // this only needs to be retried. The caught value is deliberately not
      // inspected at all: see classifyExecutionError for why no exception
      // text reaches logs, the database, audit payloads, or BullMQ.
      this.logger.error(
        `Execution ${executionId} failed while claiming: ` +
          `${EXECUTION_CLAIM_FAILED_CODE} — ` +
          `${executionErrorMessage(EXECUTION_CLAIM_FAILED_CODE)}`,
      );
      throw new SanitizedRetryableExecutionError(EXECUTION_CLAIM_FAILED_CODE);
    }

    if (!claim) {
      // Not claimable: either already SUCCEEDED/FAILED (a duplicate job
      // delivery, or a sweeper re-enqueue of a row that finished in the
      // meantime), currently PROCESSING by another worker and not yet
      // stale, or the id doesn't exist. In every case there is nothing safe
      // to do — never execute a row we can't prove we're the sole owner of.
      this.logger.log(
        `Execution ${executionId} was not claimable (already resolved, ` +
          `claimed elsewhere, or unknown) — skipping as a safe no-op.`,
      );
      return;
    }

    try {
      // The idempotency key (this row's id) is what makes a crash here safe
      // to replay: if the process dies after the adapter call succeeds but
      // before handleSuccess() commits, the row stays PROCESSING (reclaimed
      // as stale below), the job is retried or re-enqueued, and the adapter
      // receives the *same* key — so a real downstream system dedupes it
      // instead of granting/denying twice. This mock adapter demonstrates
      // that dedup in-process; it does not by itself prove a real downstream
      // system would honor it.
      await this.executionAdapter.execute({
        idempotencyKey: claim.id,
        outcome: claim.outcome,
        employeeId: claim.humanDecision.accessRequest.employeeId,
        targetSystem: claim.humanDecision.accessRequest.targetSystem,
        entitlementKey: claim.humanDecision.accessRequest.entitlementKey,
      });
    } catch (err) {
      try {
        await this.handleFailure(job, claim, err);
      } catch {
        // Recording the failure itself failed (e.g. a Prisma outage). The
        // transaction rolled back, so the row is still PROCESSING and will
        // be picked up as stale by a later claim() or the sweeper — this
        // must be retried. As everywhere else here, the caught value's body
        // is never read (see classifyExecutionError).
        this.logger.error(
          `Execution ${claim.id} failed to record failure state: ` +
            `${EXECUTION_BOOKKEEPING_FAILED_CODE} — ` +
            `${executionErrorMessage(EXECUTION_BOOKKEEPING_FAILED_CODE)}`,
        );
        throw new SanitizedRetryableExecutionError(EXECUTION_BOOKKEEPING_FAILED_CODE);
      }
      if (err instanceof NonRetryableExecutionError) {
        // Terminal by classification, not by attempt count — don't spend
        // BullMQ's retry budget on something that will never succeed.
        return;
      }
      // Let BullMQ's attempts/backoff decide whether to retry, but never hand
      // it the original adapter/downstream exception — BullMQ's own
      // failedReason/stacktrace persist in Redis verbatim.
      const { code } = classifyExecutionError(err);
      throw new SanitizedRetryableExecutionError(code);
    }

    try {
      await this.handleSuccess(claim);
    } catch {
      // The downstream effect already happened; only recording it failed.
      // The row stays PROCESSING (transaction rolled back) and is safely
      // recoverable — by a retry's claim() once past the stale threshold, or
      // by the sweeper — since the adapter call is idempotent on replay.
      this.logger.error(
        `Execution ${claim.id} succeeded downstream but failed to record success: ` +
          `${EXECUTION_BOOKKEEPING_FAILED_CODE} — ` +
          `${executionErrorMessage(EXECUTION_BOOKKEEPING_FAILED_CODE)}`,
      );
      throw new SanitizedRetryableExecutionError(EXECUTION_BOOKKEEPING_FAILED_CODE);
    }
  }

  /**
   * Compare-and-swap claim against the explicit processing lease. Succeeds
   * only if the row is PENDING (nobody holds it), or PROCESSING with a lease
   * that has expired or was never written — i.e. a worker claimed it and
   * died. `updatedAt` is deliberately NOT consulted: it is @updatedAt record
   * metadata that any unrelated write moves, so using it here previously let
   * a sweeper's own recovery bookkeeping make a stale row look freshly
   * claimed and block the recovery it had just enqueued.
   *
   * The single atomic update also:
   *  - writes a fresh lease, so this worker's ownership is explicit and
   *    self-expiring rather than inferred;
   *  - clears any recovery ownership, since the handoff the sweeper was
   *    holding the row for has now happened;
   *  - increments attempts *before* the external call, so a crash between
   *    claim and adapter still counts as a real attempt rather than a
   *    silently lost one.
   */
  private async claim(executionId: string): Promise<ClaimedExecution | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const leaseToken = randomUUID();
      const claimed = await tx.decisionExecution.updateMany({
        where: {
          id: executionId,
          OR: [
            { status: 'PENDING' },
            { status: 'PROCESSING', processingLeaseExpiresAt: { lte: now } },
            // A PROCESSING row with no lease at all can only mean the lease
            // was never written (it is set in the same update as the status),
            // so nothing holds it — treat it as reclaimable rather than
            // stranding it forever.
            { status: 'PROCESSING', processingLeaseExpiresAt: null },
          ],
        },
        data: {
          status: 'PROCESSING',
          processingLeaseExpiresAt: new Date(
            now.getTime() + PROCESSING_LEASE_DURATION_MS,
          ),
          // Fresh fencing token: every state write this worker later makes
          // must present it, so a previous owner that stalled past its lease
          // can no longer commit anything for this row.
          processingLeaseToken: leaseToken,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        return null;
      }
      const row = await tx.decisionExecution.findUniqueOrThrow({
        where: { id: executionId },
        include: { humanDecision: { include: { accessRequest: true } } },
      });
      // Carry the token we just wrote rather than re-reading the row's value:
      // this is the token this worker owns, by construction.
      return { ...row, leaseToken };
    });
  }

  /**
   * The only path that writes a state transition for a claimed row, and the
   * only place the fencing token is applied.
   *
   * The row update and its audit entry happen in one interactive transaction
   * conditioned on `id + status = PROCESSING + processingLeaseToken`. If this
   * worker's lease was reclaimed while it was stalled, the update matches zero
   * rows and the audit is never written — so a superseded worker cannot
   * contradict the new owner's outcome, and cannot leave an audit trail
   * describing an outcome that was never committed. Resolves false when
   * fenced out.
   */
  private async fencedTransition(
    claim: ClaimedExecution,
    data: Prisma.DecisionExecutionUpdateManyMutationInput,
    audit: { eventType: string; payload: Prisma.InputJsonValue },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const written = await tx.decisionExecution.updateMany({
        where: {
          id: claim.id,
          status: 'PROCESSING',
          processingLeaseToken: claim.leaseToken,
        },
        data,
      });
      if (written.count === 0) {
        return false;
      }
      await tx.auditLog.create({
        data: {
          accessRequestId: claim.humanDecision.accessRequestId,
          eventType: audit.eventType,
          actor: EXECUTION_ACTOR,
          payload: audit.payload,
        },
      });
      return true;
    });
  }

  private logFencedOut(claim: ClaimedExecution, attemptedStatus: string): void {
    this.logger.warn(
      `Execution ${claim.id}: refused to write ${attemptedStatus} — ` +
        `${OPERATIONAL_ERROR_CODES.EXECUTION_LEASE_LOST}. This worker's ` +
        `processing lease was reclaimed by another worker, which now owns the ` +
        `outcome. Nothing was written.`,
    );
  }

  private async handleSuccess(claim: ClaimedExecution): Promise<void> {
    const written = await this.fencedTransition(
      claim,
      {
        status: 'SUCCEEDED',
        executedAt: new Date(),
        lastError: null,
        errorCode: null,
        // Terminal: release the lease and its token so nothing can look
        // claimed forever and no stale token can ever match again.
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
      },
      {
        eventType: 'EXECUTION_SUCCEEDED',
        payload: {
          executionId: claim.id,
          outcome: claim.outcome,
          attempts: claim.attempts,
        },
      },
    );

    if (!written) {
      this.logFencedOut(claim, 'SUCCEEDED');
      return;
    }

    this.logger.log(
      `Execution ${claim.id} succeeded on attempt ${claim.attempts} ` +
        `(accessRequestId=${claim.humanDecision.accessRequestId}).`,
    );
  }

  private async handleFailure(
    job: Job<DecisionExecutionJobData>,
    claim: ClaimedExecution,
    err: unknown,
  ): Promise<void> {
    const attempt = claim.attempts; // already incremented in claim()
    const maxAttempts = job.opts?.attempts ?? 1;
    const nonRetryable = err instanceof NonRetryableExecutionError;
    const isFinalAttempt = nonRetryable || attempt >= maxAttempts;
    // Code + fixed message only — `err`'s own message/stack/cause are never
    // read, so nothing exception-derived can reach `last_error`, the audit
    // payload, or the log line below.
    const { code, message } = classifyExecutionError(err);

    const written = await this.fencedTransition(
      claim,
      {
        // Not final: reset to PENDING (not left at PROCESSING) so the
        // retried job's own claim() call can re-claim it — leaving it at
        // PROCESSING here would make every retry silently no-op forever.
        status: isFinalAttempt ? 'FAILED' : 'PENDING',
        lastError: message,
        errorCode: code,
        executedAt: new Date(),
        // Leaving PROCESSING either way (to terminal FAILED or back to
        // PENDING for a retry), so this worker's lease and token are both
        // released. A PENDING row is claimable unconditionally, so the retry's
        // own claim() does not have to wait for any lease to expire.
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
      },
      {
        eventType: 'EXECUTION_FAILED',
        payload: {
          executionId: claim.id,
          attempt,
          maxAttempts,
          finalAttempt: isFinalAttempt,
          errorCode: code,
          error: message,
        },
      },
    );

    if (!written) {
      // Fenced out: another worker reclaimed and resolved this row while this
      // one was stalled. Critically this must not resurrect the row — writing
      // PENDING here would un-terminalize an execution the new owner already
      // completed, and emit a contradictory EXECUTION_FAILED audit entry.
      this.logFencedOut(claim, isFinalAttempt ? 'FAILED' : 'PENDING');
      return;
    }

    this.logger.error(
      `Execution ${claim.id} failed (attempt ${attempt}/${maxAttempts}, ` +
        `final=${isFinalAttempt}): ${code} ${message}`,
    );
  }
}
