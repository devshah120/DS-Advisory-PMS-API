import { PortfolioSnapshot, Position, Classification } from './types';
import { allocationBy, exposureProfile, totalAssets, weightOf } from './weights';
import { concentrationReport } from './concentration';
import { diversificationScore } from './diversification';

/**
 * Fixtures are the real book from `Portfolio June 2026.xlsx`:
 * 18 positions, $191,837.39 in securities, $51,800 cash, $243,637.39 total.
 */

const eq = (sector: string, industry: string): Classification => ({
  sector,
  industry,
  region: 'USA',
  country: 'United States',
  assetClass: 'EQUITY',
  lookThrough: null,
});

/** A regional/thematic ETF. Yahoo says it is US-domiciled — the look-through is
 *  what stops that from being reported as US exposure. */
const etf = (region: string, sector: string): Classification => ({
  sector,
  industry: 'Exchange Traded Fund',
  region: 'USA',            // <- deliberately WRONG-looking: this is what Yahoo returns
  country: 'United States', // <- the fund's domicile, not its exposure
  assetClass: 'ETF',
  lookThrough: {
    region: [{ key: region, weight: 1 }],
    sector: [{ key: sector, weight: 1 }],
  },
});

const pos = (
  ticker: string,
  marketValue: number,
  costBasis: number,
  classification: Classification,
): Position => ({
  ticker,
  company: ticker,
  quantity: 100,
  price: marketValue / 100,
  costBasis: costBasis / 100,
  costBasisTotal: costBasis,
  marketValue,
  realizedPnl: 0,
  unrealizedPnl: marketValue - costBasis,
  dividends: 0,
  classification,
  targetWeight: null,
});

const BOOK: PortfolioSnapshot = {
  clientId: 'c1',
  clientName: 'Test Book',
  asOf: new Date('2026-06-25'),
  baseCurrency: 'USD',
  cash: 51800,
  positions: [
    pos('CAT',  12381.82, 10204.07, eq('Industrials', 'Farm & Heavy Construction Machinery')),
    pos('AEP',  11655.41, 11399.85, eq('Utilities', 'Utilities - Regulated Electric')),
    pos('IR',   11000.00, 10500.00, eq('Industrials', 'Specialty Industrial Machinery')),
    pos('JPM',  10800.00, 9800.00,  eq('Financial Services', 'Banks - Diversified')),
    pos('NSC',  10500.00, 10100.00, eq('Industrials', 'Railroads')),
    pos('ANET', 10400.00, 9000.00,  eq('Technology', 'Computer Hardware')),
    pos('HWM',  10300.00, 8900.00,  eq('Industrials', 'Aerospace & Defense')),
    pos('STT',  10200.00, 9900.00,  eq('Financial Services', 'Asset Management')),
    pos('NUE',  10100.00, 10300.00, eq('Basic Materials', 'Steel')),
    pos('BKR',  10000.00, 9500.00,  eq('Energy', 'Oil & Gas Equipment & Services')),
    pos('GM',    9900.00, 9600.00,  eq('Consumer Cyclical', 'Auto Manufacturers')),
    pos('COST',  9800.00, 9200.00,  eq('Consumer Defensive', 'Discount Stores')),
    pos('VIRT',  9700.00, 9400.00,  eq('Financial Services', 'Capital Markets')),
    // The ETFs. Every one is US-listed; none is US exposure.
    pos('EWQ',   9600.00, 9300.00,  etf('Europe', 'Diversified')),
    pos('MCHI',  9500.00, 9100.00,  etf('China', 'Diversified')),
    pos('URNM',  9400.00, 8800.00,  etf('Global', 'Energy')),
    pos('ICLN',  9300.00, 9700.00,  etf('Global', 'Utilities')),
    pos('CPER',  17300.16, 15000.00, etf('Global', 'Basic Materials')),
  ],
};

const SECURITIES = 191837.39;
const CASH = 51800;
const TOTAL = 243637.39;

describe('the denominator (cash is 21.3% of this book)', () => {
  it('totals match the workbook', () => {
    expect(totalAssets(BOOK)).toBeCloseTo(TOTAL, 0);
  });

  it('cash is 21.3% of total assets — larger than any single position', () => {
    const cashWeight = CASH / TOTAL;
    expect(cashWeight).toBeCloseTo(0.2126, 3);

    const largest = Math.max(...BOOK.positions.map((p) => p.marketValue));
    expect(CASH).toBeGreaterThan(largest);
  });

  it('weights sum to 1 under TOTAL_ASSETS, including cash', () => {
    const { slices } = allocationBy(BOOK, 'sector');
    const total = slices.reduce((s, x) => s + x.weight, 0);
    expect(total).toBeCloseTo(1.0, 6);
  });

  it('securities-only weights sum to 0.787 — the missing 21.3% IS the cash', () => {
    const { slices } = allocationBy(BOOK, 'sector', { denominator: 'SECURITIES_ONLY' });
    const hasCash = slices.some((s) => s.key === 'Cash');
    expect(hasCash).toBe(false);

    // Same positions, different denominator, different answer. This is exactly
    // why every response echoes back which one it used.
    const catTotal = weightOf(12381.82, BOOK, 'TOTAL_ASSETS');
    const catSec = weightOf(12381.82, BOOK, 'SECURITIES_ONLY');
    expect(catTotal).toBeCloseTo(0.0508, 3); // matches the workbook's %alloc column
    expect(catSec).toBeCloseTo(0.0645, 3);
    expect(catSec).toBeGreaterThan(catTotal);
  });
});

describe('ETF look-through — the China-reads-zero bug', () => {
  it('WITHOUT look-through, China exposure is 0% while MCHI is held', () => {
    const { slices } = allocationBy(BOOK, 'region', { lookThrough: false });
    const china = slices.find((s) => s.key === 'China');

    // This is the bug. MCHI is in the book, and China reads zero.
    expect(china).toBeUndefined();

    // ...and US exposure is overstated by the value of every regional ETF.
    const usa = slices.find((s) => s.key === 'USA');
    expect(usa!.value).toBeCloseTo(SECURITIES, 0); // ALL of it, wrongly
  });

  it('WITH look-through, China exposure is correctly reported', () => {
    const { slices } = allocationBy(BOOK, 'region', { lookThrough: true });

    const china = slices.find((s) => s.key === 'China');
    expect(china).toBeDefined();
    expect(china!.value).toBeCloseTo(9500, 0);       // the MCHI position
    expect(china!.weight).toBeCloseTo(9500 / TOTAL, 4);

    const europe = slices.find((s) => s.key === 'Europe');
    expect(europe!.value).toBeCloseTo(9600, 0);      // EWQ

    // And US exposure drops to only the actual US equities.
    const usa = slices.find((s) => s.key === 'USA');
    expect(usa!.value).toBeLessThan(SECURITIES);
    expect(usa!.value).toBeCloseTo(136737.23, 0);
  });

  it('look-through preserves total value — no double counting', () => {
    const { slices } = allocationBy(BOOK, 'region', { lookThrough: true });
    const total = slices.reduce((s, x) => s + x.value, 0);
    expect(total).toBeCloseTo(TOTAL, 0);
  });
});

describe('exposure profile', () => {
  const profile = exposureProfile(BOOK);

  it('reports cash weight as a first-class number', () => {
    expect(profile.cashWeight).toBeCloseTo(0.2126, 3);
  });

  it('separates ETF weight from stock weight', () => {
    expect(profile.etfWeight).toBeCloseTo(55100.16 / TOTAL, 3);
    expect(profile.stockWeight).toBeCloseTo(136737.23 / TOTAL, 3);
    // Stocks + ETFs + cash accounts for the whole book.
    expect(profile.stockWeight + profile.etfWeight + profile.cashWeight).toBeCloseTo(1, 4);
  });

  it('reports average AND median position weight', () => {
    // Both, because when the median sits well below the mean the book is
    // barbelled, and a single "average position size" hides that.
    expect(profile.averagePositionWeight).toBeGreaterThan(0);
    expect(profile.medianPositionWeight).toBeGreaterThan(0);
  });
});

describe('concentration', () => {
  it('escalates severity by size, and reports the worst breach first', () => {
    const report = concentrationReport(BOOK);
    const positionBreaches = report.breaches.filter((b) => b.kind === 'position');

    // CPER is 17,300/243,637 = 7.1% -> 'high' (crosses the 7% band).
    // CAT is 12,382/243,637 = 5.1% -> 'warn' (crosses 5% but not 7%).
    // Breaches are sorted worst-first, so CPER leads.
    expect(positionBreaches[0].key).toBe('CPER');
    expect(positionBreaches[0].severity).toBe('high');

    const cat = positionBreaches.find((b) => b.key === 'CAT');
    expect(cat!.severity).toBe('warn');

    // A 7.1% position is ONE 'high' breach, not stacked breaches at 5% and 7%.
    expect(positionBreaches.filter((b) => b.key === 'CPER')).toHaveLength(1);

    // Nothing here is over 10%.
    expect(positionBreaches.some((b) => b.severity === 'critical')).toBe(false);
  });

  it('does not treat the 21% cash balance as a sector concentration breach', () => {
    const report = concentrationReport(BOOK);
    const cashBreach = report.breaches.find((b) => b.key === 'Cash');
    expect(cashBreach).toBeUndefined();
  });

  it('flags Industrials as a sector breach only if it exceeds 30%', () => {
    const report = concentrationReport(BOOK);
    // Industrials = CAT+IR+NSC+HWM = 44,181.82 / 243,637 = 18.1%. Under the limit.
    expect(report.largestSector!.key).toBe('Industrials');
    expect(report.largestSector!.weight).toBeCloseTo(0.1813, 3);

    const sectorBreaches = report.breaches.filter((b) => b.kind === 'sector');
    expect(sectorBreaches).toHaveLength(0);
  });
});

describe('diversification score', () => {
  const result = diversificationScore(BOOK);

  it('returns a score with its component breakdown, always', () => {
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);

    // The breakdown is the actionable part. A score without it is a black box.
    expect(Object.keys(result.components)).toEqual(
      expect.arrayContaining(['positionCount', 'concentration', 'sector', 'industry', 'geography', 'cash']),
    );
  });

  it('scores an evenly-spread book above a 1-position book', () => {
    const concentrated: PortfolioSnapshot = {
      ...BOOK,
      cash: 0,
      positions: [pos('ONE', 191837, 150000, eq('Technology', 'Software'))],
    };
    expect(diversificationScore(BOOK).score).toBeGreaterThan(
      diversificationScore(concentrated).score,
    );
  });

  it('uses entropy, not sector count: 10 sectors at 91/1/1/... is NOT diversified', () => {
    const lopsided: PortfolioSnapshot = {
      ...BOOK,
      cash: 0,
      positions: [
        pos('BIG', 91000, 91000, eq('Technology', 'Software')),
        ...Array.from({ length: 9 }, (_, i) =>
          pos(`S${i}`, 1000, 1000, eq(`Sector${i}`, `Ind${i}`)),
        ),
      ],
    };

    const even: PortfolioSnapshot = {
      ...BOOK,
      cash: 0,
      positions: Array.from({ length: 10 }, (_, i) =>
        pos(`S${i}`, 10000, 10000, eq(`Sector${i}`, `Ind${i}`)),
      ),
    };

    // Both have exactly 10 sectors. A naive "count distinct sectors" metric
    // scores them identically; entropy correctly separates them.
    const lopsidedSector = diversificationScore(lopsided).components.sector.earned;
    const evenSector = diversificationScore(even).components.sector.earned;

    expect(evenSector).toBeGreaterThan(lopsidedSector);
  });
});
