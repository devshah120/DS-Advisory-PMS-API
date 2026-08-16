/**
 * Points every client at a real Benchmark row for its own market.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Client.benchmark` was captured by a free-text input, so the column holds
 * whatever was typed: "S&P500" for the US book, and literal placeholder strings
 * ("qaa", "aaaaaaaaaaaa") for the Indian mandates onboarded first. None of those
 * can be joined to a price series — the join key is `Client.benchmarkId` ->
 * `Benchmark.id` — and `benchmarkId` was never set on any client.
 *
 * With no benchmarkId, analytics fell through to the last step of
 * resolveBenchmark, which used to be an unscoped `findFirst({ isDefault: true })`
 * and therefore returned the S&P 500 for EVERY client. That is why an Indian
 * portfolio reported "SP500 RETURN" beside it, and why the alpha under it was
 * the spread between a rupee book and a dollar index — not a meaningful number.
 *
 * The resolution bug is fixed in code (resolveBenchmark is now market-scoped),
 * so this script is about the DATA: give each client an explicit benchmarkId so
 * the figure no longer depends on a fallback at all.
 *
 * RULES
 * -----
 *   · A stored `benchmark` that matches a real Benchmark.code is honoured — an
 *     explicit choice is never overridden.
 *   · Anything else (blank, junk, or a code from the other book) is replaced
 *     with that client's MARKET DEFAULT: S&P 500 for the US, Nifty 50 for India.
 *   · `benchmark` is rewritten to the canonical code alongside `benchmarkId`, so
 *     the display column and the join key cannot drift apart again.
 *
 * Idempotent — re-running changes nothing once every client resolves.
 *
 * Run with:
 *   npm run repair:client-benchmarks
 *   npm run repair:client-benchmarks -- --dry-run
 */
import { PrismaClient } from '@prisma/client';
import { ALL_MARKETS, MARKETS, Market } from '../../common/market-scope';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();

  try {
    const benchmarks = await prisma.benchmark.findMany();
    if (benchmarks.length === 0) {
      console.error('No Benchmark rows found. Run `npm run seed:market-benchmarks` first.');
      process.exitCode = 1;
      return;
    }

    const byCode = new Map(benchmarks.map((b) => [b.code, b]));

    // The default row for each book, resolved the same way the services do.
    const defaultFor = new Map<Market, (typeof benchmarks)[number]>();
    for (const market of ALL_MARKETS) {
      const scoped =
        benchmarks.find((b) => b.market === market && b.isDefault) ??
        byCode.get(MARKETS[market].defaultBenchmark.code);
      if (scoped) defaultFor.set(market, scoped);
    }

    const clients = await prisma.client.findMany();
    let changed = 0;
    let alreadyCorrect = 0;

    for (const client of clients) {
      const market = (client.market ?? 'US') as Market;

      // An explicitly-stored valid code wins; otherwise take the book default.
      const target = (client.benchmark && byCode.get(client.benchmark)) || defaultFor.get(market);

      if (!target) {
        console.error(
          `  ! ${client.name}: no benchmark available for market ${market} — skipped.`,
        );
        continue;
      }

      if (client.benchmarkId === target.id && client.benchmark === target.code) {
        alreadyCorrect++;
        continue;
      }

      console.log(
        `  · ${client.name.padEnd(20)} ${market.padEnd(6)} ` +
          `"${client.benchmark ?? ''}" -> ${target.code} (${target.symbol})`,
      );

      if (!dryRun) {
        await prisma.client.update({
          where: { id: client.id },
          data: { benchmarkId: target.id, benchmark: target.code },
        });
      }
      changed++;
    }

    console.log(
      `\n${dryRun ? '[dry run] would update' : 'Updated'} ${changed} client(s); ` +
        `${alreadyCorrect} already correct.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
