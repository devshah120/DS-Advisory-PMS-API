/**
 * One-off backfill: stamp `market` onto the records that predate the Indian book.
 *
 * MongoDB does not rewrite existing documents when a Prisma field gains a
 * default, so every client/instrument/benchmark created before `market` existed
 * has NO market key at all. Prisma reads such a document back as the schema
 * default (US), which is the right answer — but the field is absent on disk, so
 * a `where: { market: 'US' }` filter does NOT match it. That is the bug this
 * script exists to prevent: without it the dashboard's US book would silently
 * report zero clients while the records sit there unmatched.
 *
 * What it writes:
 *   · Client            → US for every row missing the field. Correct by
 *                         definition: every existing mandate predates the
 *                         Indian book, and new Indian clients are created
 *                         through the form with market already set.
 *   · InstrumentProfile → derived from the symbol's suffix (marketForSymbol),
 *                         so an already-imported '.NS' name lands in the Indian
 *                         book rather than being mislabelled US.
 *   · Benchmark         → same derivation, so '^NSEI' is Indian and '^GSPC' US.
 *
 * Idempotent: it only touches documents where the field is missing, so running
 * it twice is a no-op the second time and it can never overwrite a market that
 * someone has deliberately set.
 *
 * Run with:
 *   npm run backfill:market
 */
import { PrismaClient } from '@prisma/client';
import { marketForSymbol } from '../../common/market-scope';

/**
 * Documents in `collection` that have no `market` key at all.
 *
 * Prisma's `isSet` filter is not available on a REQUIRED enum field (it is
 * offered only for optional ones), and "has no key" is exactly the state that
 * needs finding here — so this drops to a raw find. Reading through Prisma
 * instead would be actively misleading: it materialises the schema default, so
 * every one of these rows would read back as `market: 'US'` and look done.
 */
async function withoutMarket(
  prisma: PrismaClient,
  collection: string,
  projection: Record<string, 1>,
): Promise<any[]> {
  const res: any = await prisma.$runCommandRaw({
    find: collection,
    filter: { market: { $exists: false } },
    projection,
    batchSize: 1000,
  });
  return res?.cursor?.firstBatch ?? [];
}

/** Sets `market` on one document by _id, via a raw update. */
async function stamp(
  prisma: PrismaClient,
  collection: string,
  id: string,
  market: string,
): Promise<void> {
  await prisma.$runCommandRaw({
    update: collection,
    updates: [{ q: { _id: id }, u: { $set: { market } } }],
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    // ── Clients ──────────────────────────────────────────────────────────────
    const clients = await withoutMarket(prisma, 'clients', { name: 1 });

    if (clients.length === 0) {
      console.log('Clients: nothing to do — every client already carries a market.');
    } else {
      console.log(`Clients: found ${clients.length} without a market:`);
      for (const c of clients) console.log(`  · ${c.name} (${c._id})`);
      // Every pre-existing mandate belongs to the US book by definition: the
      // Indian book did not exist when they were created.
      const res: any = await prisma.$runCommandRaw({
        update: 'clients',
        updates: [{ q: { market: { $exists: false } }, u: { $set: { market: 'US' } }, multi: true }],
      });
      console.log(`Clients: stamped ${res?.nModified ?? res?.n ?? 0} as US.`);
    }

    // ── Instrument profiles ──────────────────────────────────────────────────
    // Derived per symbol rather than bulk-set, because the collection may
    // already hold '.NS' names imported before this field existed.
    const instruments = await withoutMarket(prisma, 'instrument_profiles', { symbol: 1 });

    if (instruments.length === 0) {
      console.log('Instruments: nothing to do.');
    } else {
      let us = 0;
      let india = 0;
      for (const row of instruments) {
        const market = marketForSymbol(row.symbol);
        await stamp(prisma, 'instrument_profiles', row._id, market);
        market === 'INDIA' ? india++ : us++;
      }
      console.log(`Instruments: stamped ${us} as US and ${india} as INDIA.`);
    }

    // ── Benchmarks ───────────────────────────────────────────────────────────
    const benchmarks = await withoutMarket(prisma, 'benchmarks', { symbol: 1, code: 1 });

    if (benchmarks.length === 0) {
      console.log('Benchmarks: nothing to do.');
    } else {
      for (const b of benchmarks) {
        const market = marketForSymbol(b.symbol);
        await stamp(prisma, 'benchmarks', b._id, market);
        console.log(`  · ${b.code} (${b.symbol}) → ${market}`);
      }
      console.log(`Benchmarks: stamped ${benchmarks.length}.`);
    }

    console.log('\nBackfill complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
