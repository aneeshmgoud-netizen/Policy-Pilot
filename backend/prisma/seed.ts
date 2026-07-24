import { PrismaClient } from '@prisma/client';
import { ENTITLEMENTS } from './fixtures/entitlement-registry.fixtures';

const prisma = new PrismaClient();

// entitlement_registry is modeled as a pre-existing external table (see
// schema.prisma) with no unique constraint beyond registry_id, so idempotency
// here is enforced in application code: look up by the natural key
// (employee_id, system_name, entitlement_key) and create-or-update rather
// than relying on a DB-level upsert.
const naturalKey = (r: {
  employeeId: string;
  systemName: string;
  entitlementKey: string;
}) => `${r.employeeId}|${r.systemName}|${r.entitlementKey}`;

async function seedEntitlementRegistry() {
  let created = 0;
  let updated = 0;

  // Load existing rows once and index by natural key rather than issuing a
  // findFirst per fixture row (N+1). The registry has no DB-level unique
  // constraint on the natural key, so idempotency stays in application code.
  const existingRows = await prisma.entitlementRegistry.findMany();
  const existingByKey = new Map(
    existingRows.map((row) => [naturalKey(row), row]),
  );

  for (const [index, row] of ENTITLEMENTS.entries()) {
    const existing = existingByKey.get(naturalKey(row));
    const grantedDate = new Date(row.grantedDate);

    if (existing) {
      await prisma.entitlementRegistry.update({
        where: { registryId: existing.registryId },
        data: { grantedDate, isActive: row.isActive },
      });
      updated += 1;
    } else {
      await prisma.entitlementRegistry.create({
        data: {
          registryId: BigInt(1000 + index),
          employeeId: row.employeeId,
          systemName: row.systemName,
          entitlementKey: row.entitlementKey,
          grantedDate,
          isActive: row.isActive,
        },
      });
      created += 1;
    }
  }

  console.log(`entitlement_registry: ${created} created, ${updated} updated`);
}

async function main() {
  await seedEntitlementRegistry();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
