import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RevokePrecedentDto } from './dto/revoke-precedent.dto';

export interface PrecedentGovernanceView {
  id: string;
  status: string;
  targetSystem: string;
  entitlementKey: string;
  department: string | null;
  costCenter: string | null;
  summary: string;
  policyVersionSnapshot: unknown;
  accessRequestId: string;
  decisionFeedbackId: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
}

export const PRECEDENT_STATUSES = ['PROPOSED', 'ACTIVE', 'REVOKED'] as const;
type PrecedentStatusValue = (typeof PRECEDENT_STATUSES)[number];

function toGovernanceView(
  record: PrecedentGovernanceView,
): PrecedentGovernanceView {
  return {
    id: record.id,
    status: record.status,
    targetSystem: record.targetSystem,
    entitlementKey: record.entitlementKey,
    department: record.department,
    costCenter: record.costCenter,
    summary: record.summary,
    policyVersionSnapshot: record.policyVersionSnapshot,
    accessRequestId: record.accessRequestId,
    decisionFeedbackId: record.decisionFeedbackId,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    revokedReason: record.revokedReason,
    createdAt: record.createdAt,
  };
}

@Injectable()
export class PrecedentGovernanceService {
  constructor(private readonly prisma: PrismaService) {}

  async list(status?: string): Promise<PrecedentGovernanceView[]> {
    if (
      status &&
      !PRECEDENT_STATUSES.includes(status as PrecedentStatusValue)
    ) {
      throw new BadRequestException(
        `status must be one of: ${PRECEDENT_STATUSES.join(', ')}`,
      );
    }

    const records = await this.prisma.precedentRecord.findMany({
      where: status ? { status: status as PrecedentStatusValue } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return records.map(toGovernanceView);
  }

  async approve(
    id: string,
    governanceActorId: string,
  ): Promise<PrecedentGovernanceView> {
    const existing = await this.prisma.precedentRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Precedent ${id} not found`);
    }

    const record = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.precedentRecord.updateMany({
        where: { id, status: 'PROPOSED' },
        data: {
          status: 'ACTIVE',
          approvedBy: governanceActorId,
          approvedAt: new Date(),
        },
      });
      if (transitioned.count === 0) {
        throw new ConflictException(
          `Precedent ${id} is not awaiting approval (status=${existing.status})`,
        );
      }

      const updated = await tx.precedentRecord.findUniqueOrThrow({
        where: { id },
      });
      await tx.auditLog.create({
        data: {
          eventType: 'GOVERNANCE_PRECEDENT_APPROVED',
          actor: governanceActorId,
          accessRequestId: updated.accessRequestId,
          payload: {
            precedentRecordId: updated.id,
            decisionFeedbackId: updated.decisionFeedbackId,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
          },
        },
      });
      return updated;
    });

    return toGovernanceView(record);
  }

  async revoke(
    id: string,
    dto: RevokePrecedentDto,
    governanceActorId: string,
  ): Promise<PrecedentGovernanceView> {
    const existing = await this.prisma.precedentRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Precedent ${id} not found`);
    }

    const record = await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.precedentRecord.updateMany({
        where: { id, status: { in: ['PROPOSED', 'ACTIVE'] } },
        data: {
          status: 'REVOKED',
          revokedReason: dto.revokedReason,
        },
      });
      if (transitioned.count === 0) {
        throw new ConflictException(
          `Precedent ${id} cannot be revoked (status=${existing.status})`,
        );
      }

      const updated = await tx.precedentRecord.findUniqueOrThrow({
        where: { id },
      });
      await tx.auditLog.create({
        data: {
          eventType: 'GOVERNANCE_PRECEDENT_REVOKED',
          actor: governanceActorId,
          accessRequestId: updated.accessRequestId,
          payload: {
            precedentRecordId: updated.id,
            decisionFeedbackId: updated.decisionFeedbackId,
            targetSystem: updated.targetSystem,
            entitlementKey: updated.entitlementKey,
            previousStatus: existing.status,
            revokedReason: dto.revokedReason,
          },
        },
      });
      return updated;
    });

    return toGovernanceView(record);
  }
}
