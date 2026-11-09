/**
 * Re-keys price_bars rows whose `_id` is a Mongo ObjectId onto a string `_id`.
 *
 * WHY THIS EXISTS
 * ---------------
 * PriceBar's id is `String @id @default(cuid())`, and every row Prisma writes
 * has a string `_id`. 3,141 index bars (^NSEI, ^BSESN, ^NSEBANK, ^NSEMDCP50,
 * ^DJI, ^RUT — 2024-06 to 2026-08-14) were inserted by something outside
 * Prisma and carry an ObjectId instead.
 *
 * Prisma can READ those rows, which is why nothing looked wrong. It cannot
 * UPDATE them: `priceBar.upsert` finds the row by (symbol, date), then issues
 * the update filtered on `_id` as a string, matches nothing, and throws
 * "upsertOnePriceBar is required to return data, but found no record(s)".
 * `backfill:benchmark-bars` died on the first such row it touched, so every
 * series after it — the Nifty 50 among them — stopped refreshing on 14 Aug.
 *
 * WHAT IT DOES
 * ------------
 * `_id` is immutable, so each row is deleted and re-inserted with
 * `_id: <the ObjectId's hex>` — still unique, and traceable to the original.
 * Every other field is copied as stored. Delete-then-insert (not the reverse)
 * because (symbol, date) is uniquely indexed and the copy would collide with
 * its own original. Each batch's documents are written to a recovery file
 * before they are deleted, so an interrupted run loses nothing.
 *
 * Idempotent: a second run finds no ObjectId rows and does nothing.
 *
 * Run with:
 *   npm run repair:price-bar-ids -- --dry-run
 *   npm run repair:price-bar-ids
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const BATCH = 200;

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();
  try {
    const summary: any = await prisma.$runCommandRaw({
      aggregate: 'price_bars',
      pipeline: [
        { $match: { _id: { $type: 'objectId' } } },
        { $group: { _id: '$symbol', n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      cursor: {},
    });
    const groups: Array<{ _id: string; n: number }> = summary.cursor.firstBatch;
    const total = groups.reduce((s, g) => s + g.n, 0);

    if (total === 0) {
      console.log('No ObjectId-keyed price bars — nothing to repair.');
      return;
    }
    for (const g of groups) console.log(`  · ${String(g._id).padEnd(14)} ${g.n} rows`);
    console.log(`  ${total} rows to re-key.`);

    if (dryRun) {
      console.log('\n--dry-run: no changes written.');
      return;
    }

    const recoveryDir = join(process.cwd(), 'repair-backups');
    mkdirSync(recoveryDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    let done = 0;
    for (let batchNo = 0; ; batchNo++) {
      // Always the first page: each pass removes the ObjectId rows it read, so
      // the next query naturally returns the following ones.
      const page: any = await prisma.$runCommandRaw({
        find: 'price_bars',
        filter: { _id: { $type: 'objectId' } },
        limit: BATCH,
      });
      const docs: any[] = page.cursor.firstBatch;
      if (docs.length === 0) break;

      const recoveryFile = join(recoveryDir, `price-bars-${stamp}-${batchNo}.json`);
      writeFileSync(recoveryFile, JSON.stringify(docs));

      const oids = docs.map((d) => d._id); // EJSON { $oid } — matches the stored ObjectId
      const del: any = await prisma.$runCommandRaw({
        delete: 'price_bars',
        deletes: [{ q: { _id: { $in: oids } }, limit: 0 }],
      });
      if (del.n !== docs.length) {
        throw new Error(
          `Deleted ${del.n} of ${docs.length} rows in batch ${batchNo}; stopping. Originals saved in ${recoveryFile}.`,
        );
      }

      const ins: any = await prisma.$runCommandRaw({
        insert: 'price_bars',
        documents: docs.map((d) => ({ ...d, _id: d._id.$oid })),
      });
      if (ins.n !== docs.length || ins.writeErrors?.length) {
        throw new Error(
          `Re-inserted ${ins.n} of ${docs.length} rows in batch ${batchNo}: ${JSON.stringify(ins.writeErrors ?? [])}. ` +
            `Originals saved in ${recoveryFile} — restore them before re-running.`,
        );
      }

      done += docs.length;
      console.log(`  ✓ ${done}/${total}`);
    }

    const left: any = await prisma.$runCommandRaw({
      count: 'price_bars',
      query: { _id: { $type: 'objectId' } },
    });
    console.log(`\nRe-keyed ${done} rows; ${left.n} ObjectId rows remain. Recovery files in ${recoveryDir}.`);
    console.log('Next: npm run backfill:benchmark-bars');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
