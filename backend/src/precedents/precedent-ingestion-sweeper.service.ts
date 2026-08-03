import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { runContentFree } from '../common/operational-error.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRECEDENT_INGESTION_JOB_NAME,
  PRECEDENT_INGESTION_QUEUE,
} from './precedent-ingestion.constants';
import { PrecedentIngestionJobData } from './precedent-ingestion.processor';

export const PRECEDENT_SWEEP_INTERVAL_MS = 5 * 60_000;
// Only sweep nominations old enough that the original enqueue has certainly
// either succeeded or failed. Without this the sweeper would race the
// in-flight job it is meant to recover, and re-enqueue work already running.
export const PRECEDENT_INGESTION_GRACE_MS = 2 * 60_000;
export const PRECEDENT_SWEEP_BATCH_SIZE = 50;

const SWEEP_FAILED_CODE = 'PRECEDENT_INGESTION_SWEEP_FAILED';

/**
 * Recovers precedent nominations whose ingestion never happened.
 *
 * `DecisionsService.recordDecision` commits the reviewer's nomination to
 * Postgres and then enqueues ingestion. If that enqueue fails — Redis briefly
 * unavailable, the job lost, the worker exhausting its retries — the row was
 * previously left stranded forever, and the code said so: "No sweeper recovers
 * this yet... this case will not become retrievable precedent unless
 * re-enqueued manually." That is a silent hole in the learning loop: a
 * reviewer is told their decision was captured for future use, and it never
 * becomes available.
 *
 * The recovery predicate is deliberately derived from durable state rather
 * than from any queue bookkeeping: a DecisionFeedback row that is
 * precedent-eligible and has no PrecedentRecord is, by definition, ingestion
 * that has not completed. That makes this safe to run repeatedly and safe to
 * run alongside the original job — re-enqueueing uses the feedback id as the
 * BullMQ jobId (the same key DecisionsService uses), so a duplicate resolves
 * to the same job, and PrecedentIngestionService is itself idempotent via a
 * unique constraint on decisionFeedbackId.
 *
 * Simpler than DecisionExecutionSweeperService on purpose. That one needs
 * leases and fencing tokens because a duplicate execution would double-apply
 * an entitlement change downstream. Losing or duplicating a precedent
 * ingestion has no external side effect, so ordinary idempotency is enough.
 */
@Injectable()
export class PrecedentIngestionSweeperService {
  private readonly logger = new Logger(PrecedentIngestionSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(PRECEDENT_INGESTION_QUEUE)
    private readonly queue: Queue<PrecedentIngestionJobData>,
  ) {}

  /** Returns the feedback ids re-enqueued by this pass. */
  async sweep(): Promise<string[]> {
    const stranded = await this.prisma.decisionFeedback.findMany({
      where: {
        precedentEligible: true,
        precedent: null,
        createdAt: { lt: new Date(Date.now() - PRECEDENT_INGESTION_GRACE_MS) },
      },
      // Oldest first: a nomination stranded longest is the one most likely to
      // be genuinely lost rather than merely in flight.
      orderBy: { createdAt: 'asc' },
      take: PRECEDENT_SWEEP_BATCH_SIZE,
      select: { id: true },
    });

    const reEnqueued: string[] = [];
    for (const feedback of stranded) {
      const result = await runContentFree(SWEEP_FAILED_CODE, () =>
        this.queue.add(
          PRECEDENT_INGESTION_JOB_NAME,
          { decisionFeedbackId: feedback.id },
          // Same jobId the original enqueue used, so this can never create a
          // second job for the same nomination.
          { jobId: feedback.id },
        ),
      );
      if (result.ok) {
        reEnqueued.push(feedback.id);
      } else {
        // Content-free: a Redis/BullMQ exception body can carry connection
        // strings and internal hostnames. Only the stable code is logged; the
        // row stays eligible and the next pass will retry it.
        this.logger.warn(
          `Could not re-enqueue precedent ingestion for decisionFeedbackId=${feedback.id}: ` +
            `${result.code}. It remains eligible for the next sweep.`,
        );
      }
    }

    if (reEnqueued.length > 0) {
      this.logger.log(
        `Re-enqueued ${reEnqueued.length} stranded precedent nomination(s): ` +
          `${reEnqueued.join(', ')}.`,
      );
    }
    return reEnqueued;
  }

  @Interval(PRECEDENT_SWEEP_INTERVAL_MS)
  async scheduledSweep(): Promise<void> {
    // @Interval invokes this unawaited, so a dependency failure must not
    // become an unhandled rejection or leak exception text into scheduler logs.
    const result = await runContentFree(SWEEP_FAILED_CODE, () => this.sweep());
    if (!result.ok) {
      this.logger.warn(`Scheduled precedent ingestion sweep failed: ${result.code}.`);
    }
  }
}
