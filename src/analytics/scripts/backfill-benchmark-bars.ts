/**
 * Backfill daily index bars for every configured Benchmark from Yahoo.
 *
 * WHY THIS EXISTS
 * ---------------
 * The benchmark series was loaded from the workbook, which carried only ~weekly
 * samples and stopped at 2026-06-25. That silently produced a 0.00% benchmark:
 *
 *   · Flows are rebased to a synthetic 2026-06-30 BUY (see PerformanceService).
 *   · `closesOn` finds no ^GSPC bar on 06-30 and falls back to the last prior
 *     bar — 06-25, close 7357.
 *   · `latestClose` returns the newest bar in the table — ALSO 06-25, ALSO 7357.
 *   · So the benchmark bought units at 7357 and valued them at 7357. Terminal
 *     value came back exactly equal to the amount invested: zero gain, XIRR
 *     0.00%, interim 0.00%.
 *
 * Alpha then degenerated into "Portfolio XIRR − 0", i.e. it just echoed the
 * portfolio return back and was not a comparison at all. The real S&P move over
 * that window is negative, so the sign of the conclusion was wrong, not merely
 * the magnitude — exactly the failure mode the benchmarkXirr comment warns about.
 *
 * The fix is data, not math: give the table real daily bars so the two lookups
 * land on genuinely different dates.
 *
 * Idempotent — upserts on (symbol, date), so re-running only fills gaps and
 * refreshes existing rows. Safe to run on a schedule to keep the series current.
 *
 * Run with:
 *   npm run backfill:benchmark-bars
 *   npm run backfill:benchmark-bars -- --from 2024-01-01
 */
import { PrismaClient } from '@prisma/client';

const YAHOO = 'https://query2.finance.yahoo.com';

/** Yahoo rejects requests that don't look like a browser. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * Default start. Two years of history is what the risk calculators want for
 * beta/volatility, and it comfortably covers the workbook's own 2024-06 origin.
 */
const DEFAULT_FROM = '2024-06-01';

interface Bar {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number;
  volume: number | null;
}

/**
 * An index bar is dated by its UTC calendar day at midnight, because that is how
 * PriceBar rows are keyed everywhere else (JUN30_REBASE_DATE is a bare UTC
 * midnight). Yahoo timestamps are the session open in exchange-local time, so
 * slicing the ISO date and re-parsing is what keeps the 30-June lookup matching
 * the 30-June bar instead of missing it by a few hours.
 */
function utcMidnight(epochSeconds: number): Date {
  return new Date(`${new Date(epochSeconds * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function fetchBars(symbol: string, from: string): Promise<Bar[]> {
  const period1 = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url =
    `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d`;

  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${symbol}`);

  const data = (await res.json()) as any;
  const result = data?.chart?.result?.[0];
  const timestamps: number[] | undefined = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  const adjcloses: Array<number | null> | undefined =
    result?.indicators?.adjclose?.[0]?.adjclose;

  if (!timestamps || !quote?.close) {
    throw new Error(`No price history returned for ${symbol}`);
  }

  const bars: Bar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quote.close[i];
    // Yahoo emits a null bar for the still-open current session; a null close
    // would poison both the unit purchase and the terminal valuation.
    if (close == null) continue;

    bars.push({
      date: utcMidnight(timestamps[i]),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close,
      // An index has no dividend/split adjustment of its own, so Yahoo returns
      // adjclose === close for ^GSPC. Prefer it anyway: returns are always
      // computed from adjClose (see the schema note), and a benchmark that is a
      // total-return ETF rather than a raw index WOULD differ here.
      adjClose: adjcloses?.[i] ?? close,
      volume: quote.volume?.[i] ?? null,
    });
  }
  return bars;
}

async function main() {
  const fromArg = process.argv.indexOf('--from');
  const from = fromArg !== -1 ? process.argv[fromArg + 1] : DEFAULT_FROM;

  const prisma = new PrismaClient();
  try {
    const benchmarks = await prisma.benchmark.findMany();
    if (benchmarks.length === 0) {
      console.log('No benchmarks configured — nothing to backfill.');
      return;
    }

    for (const bm of benchmarks) {
      const before = await prisma.priceBar.count({ where: { symbol: bm.symbol } });
      let bars: Bar[];

      try {
        bars = await fetchBars(bm.symbol, from);
      } catch (err) {
        // One bad symbol must not abort the rest — a half-filled series is still
        // better than none, and the log says exactly which one to chase.
        console.error(`  ✗ ${bm.code} (${bm.symbol}): ${(err as Error).message}`);
        continue;
      }

      for (const bar of bars) {
        await prisma.priceBar.upsert({
          where: { symbol_date: { symbol: bm.symbol, date: bar.date } },
          create: { symbol: bm.symbol, source: 'yahoo', ...bar },
          // Overwrite workbook-sourced rows: Yahoo is the authority for an index
          // close, and leaving a stale hand-entered value next to fresh bars is
          // how a series starts disagreeing with itself.
          update: { source: 'yahoo', ...bar },
        });
      }

      const after = await prisma.priceBar.count({ where: { symbol: bm.symbol } });
      const newest = bars[bars.length - 1];
      console.log(
        `  ✓ ${bm.code} (${bm.symbol}): ${bars.length} bars from ${from} → ` +
          `${before} rows became ${after}. Latest ${newest.date.toISOString().slice(0, 10)} = ${newest.adjClose.toFixed(2)}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
