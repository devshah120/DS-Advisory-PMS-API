/**
 * One-off normalization: rewrite every client still stored as CASH_FLOW to
 * TRANSACTIONAL.
 *
 * The cash-flow method has been retired from the product (see the note on
 * Client.accountingMethod in schema.prisma, ClientsService which forces
 * TRANSACTIONAL on every write, and PerformanceService which now ignores the
 * stored value). Code already treats every client as transactional, so this
 * script does not change any reported number — it exists only to remove the
 * stale CASH_FLOW rows so the database matches the behaviour, and so a future
 * reader is not misled into thinking any live client is still on the old method.
 *
 * Idempotent: running it twice is a no-op the second time.
 *
 * Run with:
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/normalize-accounting-method.ts
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const stale = await prisma.client.findMany({
      where: { accountingMethod: 'CASH_FLOW' },
      select: { id: true, name: true },
    });

    if (stale.length === 0) {
      console.log('Nothing to do — no client is stored as CASH_FLOW.');
      return;
    }

    console.log(`Found ${stale.length} client(s) stored as CASH_FLOW:`);
    for (const c of stale) console.log(`  · ${c.name} (${c.id})`);

    const { count } = await prisma.client.updateMany({
      where: { accountingMethod: 'CASH_FLOW' },
      data: { accountingMethod: 'TRANSACTIONAL' },
    });

    console.log(`Normalized ${count} client(s) to TRANSACTIONAL.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
