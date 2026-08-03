import { PrismaService } from '../prisma/prisma.service';
import { EntitlementLookupService } from './entitlement-lookup.service';
import { SOD_CONFLICT_PAIRS } from './sod-conflict-pairs.constant';

function makePrismaMock(rows: unknown[]) {
  return {
    entitlementRegistry: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  } as unknown as PrismaService & {
    entitlementRegistry: { findMany: jest.Mock };
  };
}

function row(systemName: string, entitlementKey: string, isActive = true) {
  return {
    registryId: BigInt(1),
    employeeId: 'EMP-52190',
    systemName,
    entitlementKey,
    grantedDate: new Date('2025-01-01T00:00:00.000Z'),
    isActive,
  };
}

describe('EntitlementLookupService', () => {
  it('returns the current active entitlements for an employee', async () => {
    const rows = [
      row('DATA_WAREHOUSE', 'FIN_DATASET_READ'),
      row('REPORTING_ENV', 'RESTRICTED_REPORTING_TEMP'),
    ];
    const prisma = makePrismaMock(rows);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-52190',
      'DATA_WAREHOUSE',
      'FIN_DATASET_EDIT',
    );

    expect(result.currentActiveEntitlements).toEqual([
      {
        systemName: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        grantedDate: rows[0].grantedDate,
      },
      {
        systemName: 'REPORTING_ENV',
        entitlementKey: 'RESTRICTED_REPORTING_TEMP',
        grantedDate: rows[1].grantedDate,
      },
    ]);
  });

  it('only queries active entitlements — the DB predicate that must never regress', async () => {
    const prisma = makePrismaMock([]);
    const service = new EntitlementLookupService(prisma);

    await service.lookup('EMP-95527', 'DEPLOY_PIPELINE', 'PROD_DEPLOYER');

    expect(prisma.entitlementRegistry.findMany).toHaveBeenCalledWith({
      where: { employeeId: 'EMP-95527', isActive: true },
    });
  });

  it('flags alreadyHasRequestedEntitlement when an active row exactly matches', async () => {
    const prisma = makePrismaMock([row('DATA_WAREHOUSE', 'FIN_DATASET_READ')]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-52190',
      'DATA_WAREHOUSE',
      'FIN_DATASET_READ',
    );

    expect(result.alreadyHasRequestedEntitlement).toBe(true);
  });

  it('does not flag alreadyHasRequestedEntitlement when nothing matches', async () => {
    const prisma = makePrismaMock([row('DATA_WAREHOUSE', 'FIN_DATASET_READ')]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-52190',
      'DATA_WAREHOUSE',
      'FIN_DATASET_EDIT',
    );

    expect(result.alreadyHasRequestedEntitlement).toBe(false);
  });

  it('returns empty holdings for an employee with no active entitlements', async () => {
    const prisma = makePrismaMock([]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-10873',
      'DATA_WAREHOUSE',
      'FIN_DATASET_READ',
    );

    expect(result).toEqual({
      currentActiveEntitlements: [],
      alreadyHasRequestedEntitlement: false,
      sodConflicts: [],
    });
  });

  describe.each(SOD_CONFLICT_PAIRS)(
    '$ruleId ($a.entitlementKey <-> $b.entitlementKey)',
    ({ a, b, ruleId }) => {
      it(`flags a conflict when the employee holds ${a.entitlementKey} and requests ${b.entitlementKey}`, async () => {
        const prisma = makePrismaMock([row(a.systemName, a.entitlementKey)]);
        const service = new EntitlementLookupService(prisma);

        const result = await service.lookup(
          'EMP-90118',
          b.systemName,
          b.entitlementKey,
        );

        expect(result.sodConflicts).toEqual([
          {
            ruleId,
            conflictingEntitlementKey: a.entitlementKey,
            description: expect.any(String),
          },
        ]);
      });

      it(`flags a conflict in the reverse direction (holds ${b.entitlementKey}, requests ${a.entitlementKey})`, async () => {
        const prisma = makePrismaMock([row(b.systemName, b.entitlementKey)]);
        const service = new EntitlementLookupService(prisma);

        const result = await service.lookup(
          'EMP-90118',
          a.systemName,
          a.entitlementKey,
        );

        expect(result.sodConflicts).toEqual([
          {
            ruleId,
            conflictingEntitlementKey: b.entitlementKey,
            description: expect.any(String),
          },
        ]);
      });

      it(`does not flag a conflict when the employee holds neither ${a.entitlementKey} nor ${b.entitlementKey}`, async () => {
        const prisma = makePrismaMock([]);
        const service = new EntitlementLookupService(prisma);

        const result = await service.lookup(
          'EMP-90118',
          b.systemName,
          b.entitlementKey,
        );

        expect(result.sodConflicts).toEqual([]);
      });
    },
  );

  it('flags SoD-SEC-02 when the two held/requested entitlements are on different systems', async () => {
    const prisma = makePrismaMock([
      row('CLOUD_CONSOLE', 'PROD_SECRETS_ADMIN'),
    ]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-11029',
      'DEPLOY_PIPELINE',
      'PROD_DEPLOYER',
    );

    expect(result.sodConflicts).toEqual([
      {
        ruleId: 'SoD-SEC-02',
        conflictingEntitlementKey: 'PROD_SECRETS_ADMIN',
        description: expect.any(String),
      },
    ]);
  });

  it('does not flag SoD-SEC-02 when PROD_SECRETS_ADMIN is held on the wrong system', async () => {
    // Same entitlement key on a system the pair doesn't reference must not
    // cross-trigger — the cross-system pair still requires an exact
    // (systemName, entitlementKey) match on both sides.
    const prisma = makePrismaMock([
      row('SOME_OTHER_SYSTEM', 'PROD_SECRETS_ADMIN'),
    ]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-11029',
      'DEPLOY_PIPELINE',
      'PROD_DEPLOYER',
    );

    expect(result.sodConflicts).toEqual([]);
  });

  it('does not flag a conflict for a system the SoD pair does not apply to', async () => {
    // Same entitlement key coincidence across systems must not cross-trigger.
    const prisma = makePrismaMock([row('SOME_OTHER_SYSTEM', 'PAYMENT_CREATE')]);
    const service = new EntitlementLookupService(prisma);

    const result = await service.lookup(
      'EMP-61304',
      'VENDOR_PAYMENTS',
      'PAYMENT_APPROVE',
    );

    expect(result.sodConflicts).toEqual([]);
  });
});
