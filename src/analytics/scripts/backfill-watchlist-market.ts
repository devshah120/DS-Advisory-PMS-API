/**
 * Backfills `market` onto watchlist rows written before the book split, and
 * rebuilds the indexes those two models now declare.
 *
 * Two things need doing, and only the first is optional:
 *
 *   1. Existing rows carry no `market` field at all. Prisma's `@default(US)`
 *      applies to WRITES, not to documents already in the collection, so a
 *      market-scoped read (`where: { market: 'US' }`) would match none of them
 *      and the watchlist would read empty. This sets the field explicitly.
 *
 *      Rows are classified by their own ticker rather than blanket-set to US:
 *      anything already entered as 'RELIANCE.NS' is an Indian name and belongs
 *      on the Indian book, even though it predates the field.
 *
 *   2. The unique index moved from [slot, ticker] to [market, slot, ticker]
 *      (and folders from [slot] to [market, slot]). Mongo does not drop the old
 *      index when the schema changes, and while it stands, the same ticker
 *      cannot exist on both books' slot 1 — exactly what the split is for.
 *
 * Safe to re-run: the update is idempotent, and a missing index is not an error.
 *
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/backfill-watchlist-market.ts
 */
import { PrismaClient } from '@prisma/client';
import { marketForSymbol } from '../../common/market-scope';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.watchlist.findMany({
    select: { id: true, ticker: true, market: true },
  });

  let updated = 0;
  for (const row of rows) {
    const derived = marketForSymbol(row.ticker);
    // Only touch rows that are absent or disagree, so a re-run is a no-op.
    if (row.market === derived) continue;
    await prisma.watchlist.update({
      where: { id: row.id },
      data: { market: derived },
    });
    updated += 1;
  }

  console.log(`Watchlist rows scanned: ${rows.length}, market set on: ${updated}`);

  const folders = await prisma.watchlistFolder.findMany({ select: { id: true, market: true } });
  console.log(`Watchlist folders present: ${folders.length} (defaulting to the US book)`);

  // Drop the superseded unique indexes. Prisma has no API for this, so it goes
  // through the raw Mongo command; an index that was never created (a fresh
  // database) raises IndexNotFound, which is a success case here.
  for (const [collection, index] of [
    ['watchlists', 'slot_ticker'],
    ['watchlist_folders', 'slot'],
  ] as const) {
    try {
      await prisma.$runCommandRaw({ dropIndexes: collection, index });
      console.log(`Dropped stale index ${collection}.${index}`);
    } catch (error) {
      const message = (error as Error).message;
      if (/IndexNotFound|index not found|ns not found/i.test(message)) {
        console.log(`No stale index ${collection}.${index} to drop`);
      } else {
        console.warn(`Could not drop ${collection}.${index}: ${message}`);
      }
    }
  }

  console.log(
    'Done. Run `npx prisma db push` afterwards so the new compound indexes are created.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
