import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SOD_CONFLICT_PAIRS } from './sod-conflict-pairs.constant';

export interface EntitlementSnapshotRow {
  systemName: string;
  entitlementKey: string;
  grantedDate: Date;
}

export interface SodConflictFinding {
  ruleId: string;
  conflictingEntitlementKey: string;
  description: string;
}

export interface EntitlementLookupResult {
  currentActiveEntitlements: EntitlementSnapshotRow[];
  alreadyHasRequestedEntitlement: boolean;
  sodConflicts: SodConflictFinding[];
}

@Injectable()
export class EntitlementLookupService {
  constructor(private readonly prisma: PrismaService) {}

  // Computes structured facts only — no APPROVE/DENY/ESCALATE judgment here.
  // The recommendation agent (Phase 5) consumes this alongside retrieved
  // policy text to produce and ground its decision.
  async lookup(
    employeeId: string,
    targetSystem: string,
    entitlementKey: string,
  ): Promise<EntitlementLookupResult> {
    const activeRows = await this.prisma.entitlementRegistry.findMany({
      where: { employeeId, isActive: true },
    });

    const currentActiveEntitlements: EntitlementSnapshotRow[] = activeRows.map(
      (row) => ({
        systemName: row.systemName,
        entitlementKey: row.entitlementKey,
        grantedDate: row.grantedDate,
      }),
    );

    const alreadyHasRequestedEntitlement = activeRows.some(
      (row) =>
        row.systemName === targetSystem && row.entitlementKey === entitlementKey,
    );

    const sodConflicts: SodConflictFinding[] = SOD_CONFLICT_PAIRS.filter(
      (pair) =>
        pair.systemName === targetSystem &&
        pair.entitlementKeys.includes(entitlementKey),
    )
      .map((pair) => {
        const conflictingKey = pair.entitlementKeys.find(
          (key) => key !== entitlementKey,
        )!;
        const holdsConflictingKey = activeRows.some(
          (row) =>
            row.systemName === targetSystem &&
            row.entitlementKey === conflictingKey,
        );
        return holdsConflictingKey
          ? {
              ruleId: pair.ruleId,
              conflictingEntitlementKey: conflictingKey,
              description: pair.description,
            }
          : null;
      })
      .filter((finding): finding is SodConflictFinding => finding !== null);

    return {
      currentActiveEntitlements,
      alreadyHasRequestedEntitlement,
      sodConflicts,
    };
  }
}
