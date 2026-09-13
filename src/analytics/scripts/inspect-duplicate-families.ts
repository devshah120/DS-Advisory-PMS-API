/**
 * Read-only inspection: find every family name duplicated within the SAME
 * manager's book (same ownerId and market) — the case the current
 * `@@unique([ownerId, market, name])` on Family actually forbids. Two
 * different managers naming a household the same thing (e.g. two unrelated
 * "Vaidya Family" mandates) is expected and allowed; this script does not
 * flag that.
 *
 * This surfaced the original `families_market_name_key` (back when the index
 * was firm-wide, `@@unique([market, name])`) failing to build against two
 * real "Vaidya Family" households under different managers — which is exactly
 * why the index was narrowed to include ownerId. See the Family model's own
 * doc comment in schema.prisma for the full history.
 *
 * WRITES NOTHING. Prints each duplicate group with:
 *   - both Family document ids, ownerId, createdAt
 *   - each one's member clients (name, id, ownerId, createdAt)
 *   - each member's holding and transaction counts, as a proxy for "which one
 *     actually has activity" — a row with zero clients and zero activity is
 *     the far more likely accidental duplicate to delete or rename away.
 *
 * This script does NOT merge or rename anything. Once you've read the output
 * and decided which family should be kept, renamed, or merged, either do it by
 * hand in the app (rename via the Families UI, or move members between
 * households) or ask for a targeted follow-up script for the specific action.
 *
 * Run with:
 *   npm run inspect:duplicate-families
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const families = await prisma.family.findMany({
      select: {
        id: true,
        name: true,
        market: true,
        ownerId: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        clients: {
          select: { id: true, name: true, ownerId: true, createdAt: true, cashBalance: true },
        },
      },
      orderBy: [{ market: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
    });

    // Grouped by (ownerId, market, name) — the exact key the current unique
    // index enforces. Two different managers sharing a household name is
    // expected and intentionally excluded from this report.
    const groups = new Map<string, typeof families>();
    for (const f of families) {
      const key = `${f.ownerId ?? '(unowned)'}::${f.market}::${f.name}`;
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }

    const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);

    if (duplicates.length === 0) {
      console.log('\n  No duplicate family names within any single manager\'s book. Nothing to resolve.\n');
      return;
    }

    console.log(`\n  Found ${duplicates.length} family name(s) duplicated within the SAME manager's book:\n`);

    for (const [key, rows] of duplicates) {
      const [ownerId, market, name] = key.split('::');
      console.log(`  ── "${name}" [${market}, owner ${ownerId}] — ${rows.length} rows ──────────────────────────`);

      for (const f of rows) {
        const clientIds = f.clients.map((c) => c.id);
        const [holdingCount, txnCount] = await Promise.all([
          clientIds.length ? prisma.holding.count({ where: { clientId: { in: clientIds } } }) : 0,
          clientIds.length ? prisma.transaction.count({ where: { clientId: { in: clientIds } } }) : 0,
        ]);

        console.log('');
        console.log(`    Family id   : ${f.id}`);
        console.log(`    ownerId     : ${f.ownerId ?? '(unowned)'}`);
        console.log(`    createdAt   : ${f.createdAt.toISOString()}`);
        console.log(`    notes       : ${f.notes ?? '(none)'}`);
        console.log(`    members     : ${f.clients.length}`);
        for (const c of f.clients) {
          console.log(
            `        · ${c.name}  [client ${c.id}]  owner=${c.ownerId ?? '(unowned)'}  cash=${c.cashBalance}  created=${c.createdAt.toISOString().slice(0, 10)}`,
          );
        }
        console.log(`    holdings    : ${holdingCount} rows across members`);
        console.log(`    transactions: ${txnCount} rows across members`);
      }
      console.log('');
    }

    console.log(
      '  Each group above shares BOTH an owner and a name — almost certainly one household\n' +
        '  duplicated by accident within a single manager\'s book (e.g. created twice). Decide whether to\n' +
        '  merge (move every member client onto a single Family id, then delete the empty one) or rename\n' +
        '  one. Nothing has been changed.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
