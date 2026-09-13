/**
 * Read-only inspection: find every family name duplicated within its own
 * market, and report enough about each row for a human to decide whether it
 * is a genuine accidental duplicate (should be merged) or two households that
 * legitimately share a name (should be renamed to disambiguate).
 *
 * This is what surfaced `families_market_name_key` failing to build during a
 * `prisma db push` — the schema's `@@unique([market, name])` on Family cannot
 * be created while two "Vaidya Family" rows exist in the same market. See the
 * Family model's own doc comment in schema.prisma for why the index is scoped
 * to market rather than global.
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

    const groups = new Map<string, typeof families>();
    for (const f of families) {
      const key = `${f.market}::${f.name}`;
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }

    const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);

    if (duplicates.length === 0) {
      console.log('\n  No duplicate family names within any market. Nothing to resolve.\n');
      return;
    }

    console.log(`\n  Found ${duplicates.length} family name(s) duplicated within their market:\n`);

    for (const [key, rows] of duplicates) {
      const [market, name] = key.split('::');
      console.log(`  ── "${name}" [${market}] — ${rows.length} rows ──────────────────────────`);

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
      '  Decide, per group, whether these are one household split by accident (merge — move every\n' +
        '  member client onto a single Family id, then delete the empty one) or two real households that\n' +
        '  happen to share a name (rename one, e.g. "Vaidya Family (2)"). Nothing has been changed.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
