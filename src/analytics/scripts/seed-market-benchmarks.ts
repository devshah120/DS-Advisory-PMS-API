/**
 * Seeds the Benchmark rows for every market defined in common/market-scope.ts.
 *
 * Client.benchmarkId is what analytics actually joins on (the free-text
 * `benchmark` column cannot be joined to a price series — see the note in
 * schema.prisma), so an Indian mandate needs a real Nifty/Sensex row to point
 * at. Without this the Indian book has no benchmark to measure against and the
 * Performance page's comparison series comes back empty.
 *
 * Idempotent: upserts on the unique `code`, so re-running refreshes the name and
 * market of an existing row rather than inserting a duplicate.
 *
 * Run with:
 *   npm run seed:market-benchmarks
 */
import { PrismaClient } from '@prisma/client';
import { ALL_MARKETS, MARKETS } from '../../common/market-scope';

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const market of ALL_MARKETS) {
      const def = MARKETS[market];
      for (const index of def.indices) {
        // isDefault is scoped per market: each book has exactly one default
        // (S&P 500 / Nifty 50), so both can be true without conflicting.
        const isDefault = index.symbol === def.defaultBenchmark.symbol;

        await prisma.benchmark.upsert({
          where: { code: index.code },
          create: {
            code: index.code,
            name: index.label,
            symbol: index.symbol,
            market,
            isDefault,
          },
          update: {
            name: index.label,
            symbol: index.symbol,
            market,
            isDefault,
          },
        });

        console.log(
          `  · ${market.padEnd(5)} ${index.code.padEnd(12)} ${index.symbol.padEnd(12)} ${
            isDefault ? '(default)' : ''
          }`,
        );
      }
    }

    console.log('\nBenchmark seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
