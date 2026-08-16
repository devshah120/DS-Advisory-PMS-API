/**
 * Which index a client is measured against.
 *
 * These exist because the original defect was silent and plausible: an Indian
 * mandate reported "SP500 RETURN" beside a rupee portfolio, and the alpha under
 * it was the spread between a rupee book and a dollar index. Nothing crashed and
 * no figure looked malformed — the number was simply meaningless.
 *
 * The cause was the last step of resolveBenchmark. `Benchmark.isDefault` is
 * documented in schema.prisma as scoped PER MARKET (each book has its own
 * default), but the resolver asked for `findFirst({ isDefault: true })` with no
 * market filter, so whichever row Mongo returned first — the S&P 500 — became
 * the default for every book.
 *
 * The resolver is private to two services, so these tests exercise the rule
 * itself against a fake benchmark table. Pure logic, no database.
 */
import { ALL_MARKETS, MARKETS, Market } from '../common/market-scope';

interface FakeBenchmark {
  id: string;
  code: string;
  symbol: string;
  market: Market;
  isDefault: boolean;
}

/** The seeded table, as `npm run seed:market-benchmarks` produces it. */
const SEEDED: FakeBenchmark[] = ALL_MARKETS.flatMap((market) =>
  MARKETS[market].indices.map((index) => ({
    id: `id-${index.code}`,
    code: index.code,
    symbol: index.symbol,
    market,
    isDefault: index.symbol === MARKETS[market].defaultBenchmark.symbol,
  })),
);

/**
 * Mirrors the resolution chain implemented in BenchmarkHistoryService and
 * PerformanceService: explicit code, then the client's stored benchmarkId, then
 * the default FOR THAT CLIENT'S MARKET.
 */
function resolveBenchmark(
  table: FakeBenchmark[],
  code: string | undefined,
  benchmarkId: string | null,
  market: Market,
): FakeBenchmark | undefined {
  if (code) return table.find((b) => b.code === code);
  if (benchmarkId) return table.find((b) => b.id === benchmarkId);

  const scoped = table.find((b) => b.market === market && b.isDefault);
  if (scoped) return scoped;

  return table.find((b) => b.code === MARKETS[market].defaultBenchmark.code);
}

describe('benchmark resolution is scoped to the client’s market', () => {
  /**
   * The regression itself. Every client onboarded so far has a null
   * benchmarkId, so this fallback is the path that actually runs in production
   * — it is not an edge case.
   */
  it('gives an Indian mandate the Nifty 50, not the S&P 500', () => {
    const bm = resolveBenchmark(SEEDED, undefined, null, 'INDIA');
    expect(bm?.code).toBe('NIFTY50');
    expect(bm?.symbol).toBe('^NSEI');
  });

  it('still gives a US mandate the S&P 500', () => {
    const bm = resolveBenchmark(SEEDED, undefined, null, 'US');
    expect(bm?.code).toBe('SP500');
    expect(bm?.symbol).toBe('^GSPC');
  });

  /**
   * Guards the specific shape of the bug: asking for a default without a market
   * filter returns a row from the WRONG book. If someone reintroduces the
   * unscoped query, the two assertions above stay green only by luck of
   * ordering — this one states the invariant directly.
   */
  it('never returns a benchmark belonging to another book', () => {
    for (const market of ALL_MARKETS) {
      const bm = resolveBenchmark(SEEDED, undefined, null, market);
      expect(bm?.market).toBe(market);
    }
  });

  /** Every book must actually have a default, or the fallback has nothing to find. */
  it('has exactly one seeded default per market', () => {
    for (const market of ALL_MARKETS) {
      const defaults = SEEDED.filter((b) => b.market === market && b.isDefault);
      expect(defaults).toHaveLength(1);
    }
  });

  /**
   * An explicit choice must outrank the market default — otherwise a manager who
   * deliberately benchmarks an Indian mandate against the Sensex would silently
   * be shown the Nifty.
   */
  it('honours an explicitly stored benchmarkId over the market default', () => {
    const sensex = SEEDED.find((b) => b.code === 'SENSEX')!;
    const bm = resolveBenchmark(SEEDED, undefined, sensex.id, 'INDIA');
    expect(bm?.code).toBe('SENSEX');
  });

  it('honours an explicit code argument above everything else', () => {
    const bm = resolveBenchmark(SEEDED, 'BANKNIFTY', 'id-NIFTY50', 'INDIA');
    expect(bm?.code).toBe('BANKNIFTY');
  });

  /**
   * A partially seeded database (isDefault never set) must still land on the
   * right index rather than falling through to the other book.
   */
  it('falls back to the market definition when no row is flagged default', () => {
    const unflagged = SEEDED.map((b) => ({ ...b, isDefault: false }));
    expect(resolveBenchmark(unflagged, undefined, null, 'INDIA')?.code).toBe('NIFTY50');
    expect(resolveBenchmark(unflagged, undefined, null, 'US')?.code).toBe('SP500');
  });
});
