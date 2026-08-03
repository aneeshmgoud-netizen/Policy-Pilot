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

    const sodConflicts: SodConflictFinding[] = SOD_CONFLICT_PAIRS.map(
      (pair) => {
        // Each pair has two independent (system, entitlement) sides so a
        // rule can span two different systems (e.g. SoD-SEC-02), not just
        // two entitlements within one system. Figure out which side (if
        // either) the requested entitlement matches, then check whether the
        // *other* side is currently held anywhere in the employee's active
        // rows — not scoped to targetSystem, since the other side may be on
        // a different system entirely.
        const matchesA =
          pair.a.systemName === targetSystem &&
          pair.a.entitlementKey === entitlementKey;
        const matchesB =
          pair.b.systemName === targetSystem &&
          pair.b.entitlementKey === entitlementKey;
        if (!matchesA && !matchesB) {
          return null;
        }
        const other = matchesA ? pair.b : pair.a;
        const holdsOther = activeRows.some(
          (row) =>
            row.systemName === other.systemName &&
            row.entitlementKey === other.entitlementKey,
        );
        return holdsOther
          ? {
              ruleId: pair.ruleId,
              conflictingEntitlementKey: other.entitlementKey,
              description: pair.description,
            }
          : null;
      },
    ).filter((finding): finding is SodConflictFinding => finding !== null);

    return {
      currentActiveEntitlements,
      alreadyHasRequestedEntitlement,
      sodConflicts,
    };
  }
}
