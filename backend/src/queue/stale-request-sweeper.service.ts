import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AccessRequestJobData } from './access-request.processor';
import { ACCESS_REQUEST_QUEUE } from './queue.constants';

export const SWEEP_INTERVAL_MS = 60_000;
// Comfortably longer than normal enqueue -> pickup latency, even under the
// worker's 60/min rate limit, so a request that's just legitimately still
// waiting its turn is never mistaken for orphaned.
export const STALE_THRESHOLD_MS = 2 * 60_000;

const SWEEPER_ACTOR = 'system:stale-request-sweeper';

/**
 * Recovery half of the dual-write gap fix (see ingestion.service.ts's `ingest`
 * method): IngestionService commits the AccessRequest row to Postgres, then
 * enqueues its BullMQ job as a separate step. A crash between those two steps
 * leaves the row permanently PENDING with no job ever created. This sweeper
 * periodically finds PENDING rows older than STALE_THRESHOLD_MS and re-calls
 * the same enqueue with the same deterministic `jobId: accessRequest.id`.
 *
 * That jobId is what makes this safe rather than racy: BullMQ dedupes by
 * jobId (it checks Redis key existence before creating a job), so calling
 * add() again for a row that's actually just legitimately queued/rate-limited
 * (not orphaned) is a no-op — it resolves to the existing job instead of
 * creating a duplicate. Only a genuinely missing job (the true crash
 * scenario) results in a new one being created here.
 */
@Injectable()
export class StaleRequestSweeperService {
  private readonly logger = new Logger(StaleRequestSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ACCESS_REQUEST_QUEUE)
    private readonly accessRequestQueue: Queue<AccessRequestJobData>,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);
    const staleRequests = await this.prisma.accessRequest.findMany({
      where: { status: 'PENDING', createdAt: { lt: staleBefore } },
      select: { id: true, requestId: true, createdAt: true },
    });

    for (const request of staleRequests) {
      await this.accessRequestQueue.add(
        'process-access-request',
        { accessRequestId: request.id, requestId: request.requestId },
        { jobId: request.id },
      );

      await this.prisma.auditLog.create({
        data: {
          accessRequestId: request.id,
          eventType: 'STALE_REQUEST_REQUEUED',
          actor: SWEEPER_ACTOR,
          payload: { staleForMs: Date.now() - request.createdAt.getTime() },
        },
      });

      this.logger.warn(
        `Re-enqueued stale PENDING request ${request.requestId} ` +
          `(accessRequestId=${request.id}): no active job was found after ` +
          `${STALE_THRESHOLD_MS}ms, indicating a crash between the Postgres ` +
          `commit and the original enqueue call.`,
      );
    }
  }
}
