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

    // Every series a benchmark reads: the index itself and, for a converted
    // benchmark (S&P 500 in INR), its exchange rate — without those FX bars the
    // benchmark has no close to multiply by. Deduplicated because 'SP500' and
    // 'SP500_INR' share '^GSPC', and fetching it twice only doubles the writes.
    const series = new Map<string, string>(); // symbol -> label for the log
    for (const bm of benchmarks) {
      if (!series.has(bm.symbol)) series.set(bm.symbol, bm.code);
      if (bm.fxSymbol && !series.has(bm.fxSymbol)) series.set(bm.fxSymbol, `${bm.code} FX`);
    }

    const failed: string[] = [];
    for (const [symbol, label] of series) {
      const before = await prisma.priceBar.count({ where: { symbol } });
      let bars: Bar[];

      try {
        bars = await fetchBars(symbol, from);
      } catch (err) {
        // One bad symbol must not abort the rest — a half-filled series is still
        // better than none, and the log says exactly which one to chase.
        failed.push(label);
        console.error(`  ✗ ${label} (${symbol}): ${(err as Error).message}`);
        continue;
      }

      try {
        for (const bar of bars) {
          await prisma.priceBar.upsert({
            where: { symbol_date: { symbol, date: bar.date } },
            create: { symbol, source: 'yahoo', ...bar },
            // Overwrite workbook-sourced rows: Yahoo is the authority for an index
            // close, and leaving a stale hand-entered value next to fresh bars is
            // how a series starts disagreeing with itself.
            update: { source: 'yahoo', ...bar },
          });
        }
      } catch (err) {
        // A write failure is as local as a fetch failure. Before this, one bad
        // row in ^DJI (an ObjectId-keyed bar Prisma can't update — see
        // repair-price-bar-ids.ts) aborted the run, and every series after it,
        // the Nifty 50 included, silently stopped refreshing for months.
        failed.push(label);
        console.error(`  ✗ ${label} (${symbol}): write failed — ${(err as Error).message.split('\n').pop()}`);
        continue;
      }

      const after = await prisma.priceBar.count({ where: { symbol } });
      const newest = bars[bars.length - 1];
      console.log(
        `  ✓ ${label} (${symbol}): ${bars.length} bars from ${from} → ` +
          `${before} rows became ${after}. Latest ${newest.date.toISOString().slice(0, 10)} = ${newest.adjClose.toFixed(2)}`,
      );
    }

    // Continuing past a failure must not read as success: a scheduled run
    // that exits 0 with a dead series is how the last one went unnoticed.
    if (failed.length) {
      console.error(`\n${failed.length} series failed: ${failed.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
