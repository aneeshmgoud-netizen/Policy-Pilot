import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { maskCostCenter, maskEmployeeId } from '../common/pii.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessRequestJobData,
} from '../queue/access-request.processor';
import { ACCESS_REQUEST_QUEUE } from '../queue/queue.constants';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { IdempotencyService } from './idempotency.service';

const INGESTION_ACTOR = 'system:ingestion-webhook';

function isUniqueConstraintViolation(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

@Injectable()
export class IngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
    @InjectQueue(ACCESS_REQUEST_QUEUE)
    private readonly accessRequestQueue: Queue<AccessRequestJobData>,
  ) {}

  async ingest(dto: CreateAccessRequestDto, idempotencyKey?: string) {
    const existing = await this.idempotencyService.findExisting(
      dto.request_id,
      idempotencyKey,
    );

    if (existing) {
      await this.recordDuplicateRejected(existing.id, dto.request_id);
      return this.toDuplicateResponse(existing);
    }

    try {
      const created = await this.createAccessRequest(dto, idempotencyKey);

      // Enqueued after the transaction commits: BullMQ writes to Redis, not
      // Postgres, so it can't participate in that transaction. This leaves a
      // small window where the row exists but the job hasn't been enqueued
      // yet if the process crashes right here (the classic dual-write gap).
      // `jobId: created.id` makes this enqueue call idempotent — BullMQ
      // dedupes by jobId, so if a job with this ID already exists (e.g. the
      // StaleRequestSweeperService retries the same row), this is a safe
      // no-op rather than a duplicate job. See stale-request-sweeper.service.ts
      // for the recovery half of this fix.
      await this.accessRequestQueue.add(
        'process-access-request',
        { accessRequestId: created.id, requestId: created.requestId },
        { jobId: created.id },
      );

      return {
        requestId: created.requestId,
        status: created.status,
        duplicate: false as const,
      };
    } catch (err) {
      // Two concurrent deliveries of the same request can both pass the
      // findExisting check above before either has committed. The DB's
      // unique constraints (request_id, idempotency_key) are the real
      // guarantee; if we lose this race, treat it the same as a duplicate
      // found up front rather than surfacing a 500.
      if (isUniqueConstraintViolation(err)) {
        const raceWinner = await this.idempotencyService.findExisting(
          dto.request_id,
          idempotencyKey,
        );
        if (raceWinner) {
          await this.recordDuplicateRejected(raceWinner.id, dto.request_id);
          return this.toDuplicateResponse(raceWinner);
        }
      }
      throw err;
    }
  }

  private async createAccessRequest(
    dto: CreateAccessRequestDto,
    idempotencyKey?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const accessRequest = await tx.accessRequest.create({
        data: {
          requestId: dto.request_id,
          idempotencyKey: idempotencyKey ?? null,
          employeeId: dto.employee_id,
          requestType: dto.request_type,
          targetSystem: dto.target.system_name,
          entitlementKey: dto.target.entitlement_key,
          justification: dto.target.justification,
          requesterTitle: dto.requester.title,
          requesterDepartment: dto.requester.department,
          requesterCostCenter: dto.requester.cost_center,
          submittedAt: new Date(dto.timestamp),
        },
      });

      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: { key: idempotencyKey, accessRequestId: accessRequest.id },
        });
      }

      await tx.auditLog.create({
        data: {
          accessRequestId: accessRequest.id,
          eventType: 'INGESTED',
          actor: INGESTION_ACTOR,
          // PII (employee_id, cost_center) is masked before it reaches the
          // audit payload per CLAUDE.md. The access_request_id FK stays
          // unmasked so the row remains joinable back to the authoritative
          // (unmasked) values on the access_requests row.
          payload: {
            requestId: accessRequest.requestId,
            employeeId: maskEmployeeId(accessRequest.employeeId),
            targetSystem: accessRequest.targetSystem,
            entitlementKey: accessRequest.entitlementKey,
            requesterCostCenter: maskCostCenter(
              accessRequest.requesterCostCenter,
            ),
          },
        },
      });

      return accessRequest;
    });
  }

  private async recordDuplicateRejected(
    accessRequestId: string,
    requestIdFromBody: string,
  ) {
    await this.prisma.auditLog.create({
      data: {
        accessRequestId,
        eventType: 'DUPLICATE_REJECTED',
        actor: INGESTION_ACTOR,
        payload: { requestIdFromBody },
      },
    });
  }

  private toDuplicateResponse(existing: { requestId: string; status: string }) {
    return {
      requestId: existing.requestId,
      status: existing.status,
      duplicate: true as const,
      message:
        'This request was already received and is being processed. No new processing was triggered.',
    };
  }
}
