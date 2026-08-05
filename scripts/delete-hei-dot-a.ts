/**
 * Deletes the 4 legacy `HEI.A` transactions, keeping their `HEI-A` twins.
 *
 * Each target is verified to have an exact `HEI-A` counterpart (same client,
 * quantity, price, date) BEFORE deletion — if a twin is missing, that row is
 * skipped rather than deleted, so a non-duplicate position can never be lost.
 *
 * Backs up every deleted row to JSON first. Pass --apply to actually delete;
 * without it the script is a dry run.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const EPS = 1e-6;
const near = (a: number | null, b: number | null) =>
  a != null && b != null && Math.abs(a - b) < EPS;

async function main() {
  const clients = await prisma.client.findMany({
    select: { id: true, name: true },
  });
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const dotA = await prisma.transaction.findMany({
    where: { ticker: 'HEI.A' },
  });
  const dashA = await prisma.transaction.findMany({
    where: { ticker: 'HEI-A' },
  });

  console.log(`Found ${dotA.length} HEI.A and ${dashA.length} HEI-A transactions.\n`);

  const toDelete: typeof dotA = [];

  for (const row of dotA) {
    const twin = dashA.find(
      (d) =>
        d.clientId === row.clientId &&
        d.type === row.type &&
        near(d.quantity, row.quantity) &&
        near(d.price, row.price) &&
        d.date.getTime() === row.date.getTime(),
    );

    const who = clientName.get(row.clientId) ?? row.clientId;
    if (twin) {
      console.log(
        `KEEP-TWIN  ${who}: HEI.A ${row.quantity}@${row.price} ` +
          `-> twin HEI-A id=${twin.id}  => DELETE ${row.id}`,
      );
      toDelete.push(row);
    } else {
      console.log(
        `SKIP       ${who}: HEI.A ${row.quantity}@${row.price} ` +
          `has NO HEI-A twin — not deleting (would lose a real position).`,
      );
    }
  }

  if (!toDelete.length) {
    console.log('\nNothing to delete.');
    return;
  }

  if (!APPLY) {
    console.log(
      `\nDRY RUN — would delete ${toDelete.length} row(s). Re-run with --apply.`,
    );
    return;
  }

  // Backup before destroying anything.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(
    __dirname,
    '..',
    `hei-dot-a-deleted-backup-${stamp}.json`,
  );
  fs.writeFileSync(backup, JSON.stringify(toDelete, null, 2));
  console.log(`\nBackup written: ${backup}`);

  const result = await prisma.transaction.deleteMany({
    where: { id: { in: toDelete.map((r) => r.id) } },
  });
  console.log(`Deleted ${result.count} HEI.A transaction(s).`);

  const remaining = await prisma.transaction.count({
    where: { ticker: 'HEI.A' },
  });
  console.log(`Remaining HEI.A transactions: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
