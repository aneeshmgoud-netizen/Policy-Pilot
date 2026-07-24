import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { IngestionService } from './ingestion.service';

const VALID_DTO = plainToInstance(CreateAccessRequestDto, {
  request_id: 'req_access_2026_44821',
  employee_id: 'EMP-52190',
  request_type: 'GRANT_ENTITLEMENT',
  timestamp: '2026-07-01T09:15:00Z',
  requester: {
    title: 'Data Analyst',
    department: 'Finance Analytics',
    cost_center: 'CC-FIN-07',
  },
  target: {
    system_name: 'DATA_WAREHOUSE',
    entitlement_key: 'FIN_DATASET_EDIT',
    justification: 'Need to build quarterly revenue models.',
  },
});

function makeTxMock(createdAccessRequest: unknown) {
  return {
    accessRequest: { create: jest.fn().mockResolvedValue(createdAccessRequest) },
    idempotencyKey: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('IngestionService', () => {
  it('creates the access request, logs INGESTED, and enqueues a job when nothing matches', async () => {
    const createdAccessRequest = {
      id: 'ar-1',
      requestId: VALID_DTO.request_id,
      employeeId: 'EMP-52190',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_EDIT',
      requesterCostCenter: 'CC-FIN-07',
      status: 'PENDING',
    };
    const tx = makeTxMock(createdAccessRequest);
    const prisma = {
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
      auditLog: { create: jest.fn() },
    };
    const idempotencyService = { findExisting: jest.fn().mockResolvedValue(null) };
    const queue = { add: jest.fn().mockResolvedValue({}) };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );
    const result = await service.ingest(VALID_DTO, 'idem-key-1');

    expect(result).toEqual({
      requestId: VALID_DTO.request_id,
      status: 'PENDING',
      duplicate: false,
    });
    expect(tx.accessRequest.create).toHaveBeenCalledTimes(1);
    expect(tx.idempotencyKey.create).toHaveBeenCalledWith({
      data: { key: 'idem-key-1', accessRequestId: 'ar-1' },
    });
    // Full-shape assertion: the audit payload must carry exactly these fields,
    // with employee_id and cost_center masked (never raw PII).
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        accessRequestId: 'ar-1',
        eventType: 'INGESTED',
        actor: 'system:ingestion-webhook',
        payload: {
          requestId: VALID_DTO.request_id,
          employeeId: 'EMP-***90',
          targetSystem: 'DATA_WAREHOUSE',
          entitlementKey: 'FIN_DATASET_EDIT',
          requesterCostCenter: 'CC-****07',
        },
      },
    });
    // jobId: 'ar-1' makes the enqueue idempotent for the stale-request
    // sweeper (see stale-request-sweeper.service.ts) — retrying the same
    // accessRequestId is a safe no-op rather than a duplicate job.
    expect(queue.add).toHaveBeenCalledWith(
      'process-access-request',
      { accessRequestId: 'ar-1', requestId: VALID_DTO.request_id },
      { jobId: 'ar-1' },
    );
  });

  it('skips creating an idempotency-key row when no key is provided', async () => {
    const createdAccessRequest = {
      id: 'ar-2',
      requestId: VALID_DTO.request_id,
      status: 'PENDING',
    };
    const tx = makeTxMock(createdAccessRequest);
    const prisma = {
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
      auditLog: { create: jest.fn() },
    };
    const idempotencyService = { findExisting: jest.fn().mockResolvedValue(null) };
    const queue = { add: jest.fn().mockResolvedValue({}) };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );
    const result = await service.ingest(VALID_DTO, undefined);

    expect(result.duplicate).toBe(false);
    expect(tx.accessRequest.create).toHaveBeenCalledTimes(1);
    // The idempotencyKey.create branch is skipped entirely when no key is sent.
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does not create a row or enqueue a job when a duplicate is found', async () => {
    const existing = {
      id: 'ar-existing',
      requestId: VALID_DTO.request_id,
      status: 'RECOMMENDED',
    };
    const prisma = {
      $transaction: jest.fn(),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const idempotencyService = { findExisting: jest.fn().mockResolvedValue(existing) };
    const queue = { add: jest.fn() };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );
    const result = await service.ingest(VALID_DTO, undefined);

    expect(result).toEqual({
      requestId: existing.requestId,
      status: existing.status,
      duplicate: true,
      message:
        'This request was already received and is being processed. No new processing was triggered.',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'DUPLICATE_REJECTED',
          accessRequestId: 'ar-existing',
        }),
      }),
    );
  });

  it('treats a unique-constraint race as a duplicate instead of throwing', async () => {
    const raceWinner = {
      id: 'ar-race',
      requestId: VALID_DTO.request_id,
      status: 'PENDING',
    };
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '5.22.0' },
    );
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(uniqueViolation),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const idempotencyService = {
      findExisting: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raceWinner),
    };
    const queue = { add: jest.fn() };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );
    const result = await service.ingest(VALID_DTO, 'idem-key-race');

    expect(result.duplicate).toBe(true);
    expect(result.requestId).toBe(raceWinner.requestId);
    expect(queue.add).not.toHaveBeenCalled();
    expect(idempotencyService.findExisting).toHaveBeenCalledTimes(2);
  });

  it('re-throws the P2002 when the race re-query finds no winner', async () => {
    // Narrow window: a unique-constraint violation fires, but the follow-up
    // findExisting returns null (e.g. the winning row was removed between the
    // violation and the re-query). We must surface the original error rather
    // than pretend it was a clean duplicate.
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '5.22.0' },
    );
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(uniqueViolation),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const idempotencyService = {
      findExisting: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const queue = { add: jest.fn() };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );

    await expect(service.ingest(VALID_DTO, 'idem-key-race')).rejects.toThrow(
      'Unique constraint failed',
    );
    expect(idempotencyService.findExisting).toHaveBeenCalledTimes(2);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('re-throws errors that are not unique-constraint violations', async () => {
    const boom = new Error('database is on fire');
    const prisma = { $transaction: jest.fn().mockRejectedValue(boom), auditLog: { create: jest.fn() } };
    const idempotencyService = { findExisting: jest.fn().mockResolvedValue(null) };
    const queue = { add: jest.fn() };

    const service = new IngestionService(
      prisma as any,
      idempotencyService as any,
      queue as any,
    );

    await expect(service.ingest(VALID_DTO, undefined)).rejects.toThrow(
      'database is on fire',
    );
  });
});
