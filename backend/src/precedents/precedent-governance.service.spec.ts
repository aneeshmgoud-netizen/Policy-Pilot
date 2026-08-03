import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrecedentGovernanceService } from './precedent-governance.service';

const CREATED_AT = new Date('2026-07-30T12:00:00.000Z');
const APPROVED_AT = new Date('2026-07-30T13:00:00.000Z');

function precedentRow(
  status: 'PROPOSED' | 'ACTIVE' | 'REVOKED',
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'precedent-1',
    status,
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    department: 'Finance',
    costCenter: 'CC-FIN-12',
    summary: 'A reviewed finance data-access case.',
    policyVersionSnapshot: [
      { documentName: 'POL-DATA-001', version: '3.4.1' },
    ],
    accessRequestId: 'ar-1',
    decisionFeedbackId: 'fb-1',
    approvedBy: status === 'ACTIVE' ? 'governance:prior' : null,
    approvedAt: status === 'ACTIVE' ? APPROVED_AT : null,
    revokedReason: status === 'REVOKED' ? 'Superseded' : null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function makeHarness(
  existing: ReturnType<typeof precedentRow> | null,
  updated: ReturnType<typeof precedentRow> = precedentRow('ACTIVE', {
    approvedBy: 'governance:priya',
  }),
) {
  const tx = {
    precedentRecord: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(updated),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    precedentRecord: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findMany: jest.fn().mockResolvedValue(existing ? [existing] : []),
    },
    $transaction: jest
      .fn()
      .mockImplementation((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    __tx: tx,
  } as unknown as PrismaService & {
    __tx: typeof tx;
    $transaction: jest.Mock;
  };

  return {
    service: new PrecedentGovernanceService(prisma),
    prisma,
  };
}

describe('PrecedentGovernanceService.list', () => {
  it('lists every precedent newest first when no status is supplied', async () => {
    const proposed = precedentRow('PROPOSED');
    const { service, prisma } = makeHarness(proposed);

    await expect(service.list()).resolves.toEqual([proposed]);
    expect(prisma.precedentRecord.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters the list by a valid status', async () => {
    const active = precedentRow('ACTIVE');
    const { service, prisma } = makeHarness(active);

    await expect(service.list('ACTIVE')).resolves.toEqual([active]);
    expect(prisma.precedentRecord.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('rejects an invalid status before querying the database', async () => {
    const { service, prisma } = makeHarness(null);

    await expect(service.list('PENDING')).rejects.toThrow(BadRequestException);
    expect(prisma.precedentRecord.findMany).not.toHaveBeenCalled();
  });
});

describe('PrecedentGovernanceService.approve', () => {
  it('activates a PROPOSED precedent and writes a joinable audit entry', async () => {
    const existing = precedentRow('PROPOSED');
    const updated = precedentRow('ACTIVE', {
      approvedBy: 'governance:priya',
      approvedAt: APPROVED_AT,
    });
    const { service, prisma } = makeHarness(existing, updated);

    await expect(
      service.approve('precedent-1', 'governance:priya'),
    ).resolves.toEqual(updated);

    expect(prisma.__tx.precedentRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'precedent-1', status: 'PROPOSED' },
      data: {
        status: 'ACTIVE',
        approvedBy: 'governance:priya',
        approvedAt: expect.any(Date),
      },
    });
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        eventType: 'GOVERNANCE_PRECEDENT_APPROVED',
        actor: 'governance:priya',
        accessRequestId: 'ar-1',
        payload: {
          precedentRecordId: 'precedent-1',
          decisionFeedbackId: 'fb-1',
          targetSystem: 'DATA_WAREHOUSE',
          entitlementKey: 'FIN_DATASET_READ',
        },
      },
    });
  });

  it.each(['ACTIVE', 'REVOKED'] as const)(
    'rejects approval when the existing status is %s',
    async (status) => {
      const { service, prisma } = makeHarness(precedentRow(status));
      prisma.__tx.precedentRecord.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve('precedent-1', 'governance:priya'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the precedent does not exist', async () => {
    const { service, prisma } = makeHarness(null);

    await expect(
      service.approve('missing', 'governance:priya'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('surfaces the losing side of a concurrent double-approve race as 409', async () => {
    const existing = precedentRow('PROPOSED');
    const updated = precedentRow('ACTIVE', {
      approvedBy: 'governance:priya',
      approvedAt: APPROVED_AT,
    });
    const { service, prisma } = makeHarness(existing, updated);
    prisma.__tx.precedentRecord.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      service.approve('precedent-1', 'governance:priya'),
    ).resolves.toEqual(updated);
    await expect(
      service.approve('precedent-1', 'governance:priya'),
    ).rejects.toThrow(ConflictException);
  });
});

describe('PrecedentGovernanceService.revoke', () => {
  it('revokes a PROPOSED nomination and records its previous status', async () => {
    const updated = precedentRow('REVOKED', {
      revokedReason: 'Nomination was not sufficiently supported',
    });
    const { service, prisma } = makeHarness(
      precedentRow('PROPOSED'),
      updated,
    );

    await expect(
      service.revoke(
        'precedent-1',
        { revokedReason: 'Nomination was not sufficiently supported' },
        'governance:priya',
      ),
    ).resolves.toEqual(updated);

    expect(prisma.__tx.precedentRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'precedent-1',
        status: { in: ['PROPOSED', 'ACTIVE'] },
      },
      data: {
        status: 'REVOKED',
        revokedReason: 'Nomination was not sufficiently supported',
      },
    });
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accessRequestId: 'ar-1',
          payload: expect.objectContaining({
            previousStatus: 'PROPOSED',
            revokedReason: 'Nomination was not sufficiently supported',
          }),
        }),
      }),
    );
  });

  it('revokes an ACTIVE precedent while preserving its approval history', async () => {
    const existing = precedentRow('ACTIVE');
    const updated = precedentRow('REVOKED', {
      approvedBy: existing.approvedBy,
      approvedAt: existing.approvedAt,
      revokedReason: 'Policy changed',
    });
    const { service, prisma } = makeHarness(existing, updated);

    const result = await service.revoke(
      'precedent-1',
      { revokedReason: 'Policy changed' },
      'governance:priya',
    );

    expect(result.approvedBy).toBe('governance:prior');
    expect(result.approvedAt).toBe(APPROVED_AT);
    expect(prisma.__tx.precedentRecord.updateMany.mock.calls[0][0].data).toEqual(
      {
        status: 'REVOKED',
        revokedReason: 'Policy changed',
      },
    );
    expect(prisma.__tx.auditLog.create.mock.calls[0][0].data.payload).toMatchObject(
      { previousStatus: 'ACTIVE', revokedReason: 'Policy changed' },
    );
  });

  it('rejects an already REVOKED precedent with 409', async () => {
    const { service, prisma } = makeHarness(precedentRow('REVOKED'));
    prisma.__tx.precedentRecord.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.revoke(
        'precedent-1',
        { revokedReason: 'Duplicate request' },
        'governance:priya',
      ),
    ).rejects.toThrow(ConflictException);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows only one side of a double-revoke race to transition or audit', async () => {
    const updated = precedentRow('REVOKED', {
      revokedReason: 'Policy changed',
    });
    const { service, prisma } = makeHarness(precedentRow('ACTIVE'), updated);
    prisma.__tx.precedentRecord.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      service.revoke(
        'precedent-1',
        { revokedReason: 'Policy changed' },
        'governance:priya',
      ),
    ).resolves.toEqual(updated);
    await expect(
      service.revoke(
        'precedent-1',
        { revokedReason: 'Duplicate revoke' },
        'governance:priya',
      ),
    ).rejects.toThrow(ConflictException);

    expect(prisma.__tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'GOVERNANCE_PRECEDENT_REVOKED',
        }),
      }),
    );
  });
});
