import {
  classifyTerm,
  grandfatheredCost,
  holdingDaysBetween,
  LotLedgerRow,
  replayLots,
  totalRealizedGain,
} from './tax-lots';
import { capitalGainsForFiscalYear, capitalGainsByYear } from './capital-gains';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const row = (
  type: string,
  ticker: string | null,
  quantity: number | null,
  amount: number,
  date: string,
): LotLedgerRow => ({ type, ticker, quantity, amount, date: d(date), price: null });

const INDIA = { market: 'INDIA' as const };
const US = { market: 'US' as const };

describe('replayLots — FIFO ordering', () => {
  it('consumes the OLDEST lot first, not the cheapest', () => {
    // The distinction that matters: the older lot is the EXPENSIVE one here, so
    // average cost and "cheapest first" would both report a larger gain.
    const ledger = [
      row('BUY', 'RELIANCE.NS', 100, 100_000, '2024-01-10'), // ₹1000/sh
      row('BUY', 'RELIANCE.NS', 100, 50_000, '2024-06-10'), //  ₹500/sh
      row('SELL', 'RELIANCE.NS', 100, 120_000, '2025-08-10'), // ₹1200/sh
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(1);
    expect(gains[0].costPerShare).toBe(1000); // the OLD lot, not the cheap one
    expect(gains[0].gain).toBe(20_000);
    // Average cost would have said (1000+500)/2 = 750 → a ₹45,000 gain.
    expect(gains[0].gain).not.toBe(45_000);
  });

  it('splits one sale across several lots, emitting a row per lot', () => {
    // 150 shares sold against lots of 100 and 100: this is the case that ties
    // to a broker statement, which itemises the same way.
    const ledger = [
      row('BUY', 'TCS.NS', 100, 300_000, '2024-01-10'), // ₹3000/sh
      row('BUY', 'TCS.NS', 100, 400_000, '2024-02-10'), // ₹4000/sh
      row('SELL', 'TCS.NS', 150, 675_000, '2025-06-10'), // ₹4500/sh
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(2);

    // First lot fully consumed: 100 @ 3000 → 4500
    expect(gains[0].quantity).toBe(100);
    expect(gains[0].costPerShare).toBe(3000);
    expect(gains[0].gain).toBe(150_000);

    // Second lot partially consumed: 50 @ 4000 → 4500
    expect(gains[1].quantity).toBe(50);
    expect(gains[1].costPerShare).toBe(4000);
    expect(gains[1].gain).toBe(25_000);

    expect(totalRealizedGain(gains)).toBe(175_000);
  });

  it('leaves the remainder of a partly-sold lot open', () => {
    const ledger = [
      row('BUY', 'INFY.NS', 100, 150_000, '2024-01-10'),
      row('SELL', 'INFY.NS', 30, 54_000, '2025-01-10'),
    ];

    const { openLots } = replayLots(ledger, INDIA);

    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(70);
    expect(openLots[0].unitCost).toBe(1500);
    // The remaining lot keeps the ORIGINAL acquisition date — its clock did not
    // restart because part of the parcel was sold.
    expect(openLots[0].acquiredOn).toEqual(d('2024-01-10'));
  });

  it('reports sales it cannot match rather than inventing a basis', () => {
    // The documented condition of this book: holdings imported with no buys.
    const ledger = [row('SELL', 'WIPRO.NS', 50, 20_000, '2025-01-10')];

    const { gains, unmatchedSales } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(0);
    expect(unmatchedSales).toHaveLength(1);
    expect(unmatchedSales[0]).toMatchObject({ ticker: 'WIPRO.NS', quantity: 50 });
  });

  it('keeps each ticker in its own FIFO queue', () => {
    const ledger = [
      row('BUY', 'A.NS', 10, 1_000, '2024-01-01'),
      row('BUY', 'B.NS', 10, 5_000, '2024-02-01'),
      row('SELL', 'B.NS', 10, 6_000, '2025-03-01'),
    ];

    const { gains, openLots } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(1);
    expect(gains[0].ticker).toBe('B.NS');
    expect(gains[0].gain).toBe(1_000);
    expect(openLots.map((l) => l.ticker)).toEqual(['A.NS']);
  });
});

describe('replayLots — holding period and term', () => {
  it('treats exactly 365 days as SHORT term', () => {
    // "More than twelve months" — the boundary is strictly greater than.
    expect(classifyTerm(365, 'INDIA')).toBe('SHORT');
    expect(classifyTerm(366, 'INDIA')).toBe('LONG');
    expect(classifyTerm(365, 'US')).toBe('SHORT');
    expect(classifyTerm(366, 'US')).toBe('LONG');
  });

  it('classifies a one-year-and-a-day hold as long term', () => {
    const ledger = [
      row('BUY', 'HDFCBANK.NS', 10, 15_000, '2024-01-01'),
      row('SELL', 'HDFCBANK.NS', 10, 18_000, '2025-01-02'),
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains[0].holdingDays).toBe(367); // 2024 is a leap year
    expect(gains[0].term).toBe('LONG');
  });

  it('measures the holding period per lot, so one sale can span both terms', () => {
    // The old lot is long-term, the new one short-term, in a single sale. A
    // per-ticker average would have to pick one and would be wrong for half.
    const ledger = [
      row('BUY', 'ITC.NS', 100, 20_000, '2023-01-10'),
      row('BUY', 'ITC.NS', 100, 30_000, '2025-06-01'),
      row('SELL', 'ITC.NS', 200, 80_000, '2025-09-01'),
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(2);
    expect(gains[0].term).toBe('LONG');
    expect(gains[1].term).toBe('SHORT');
  });

  it('computes holding days in UTC so a DST shift cannot flip the term', () => {
    // A local-time implementation can be an hour short across a DST boundary and
    // floor to 364 — moving the rate on a boundary-case sale.
    const acquired = new Date('2024-03-01T00:00:00.000Z');
    const sold = new Date('2025-03-01T00:00:00.000Z');
    expect(holdingDaysBetween(acquired, sold)).toBe(365);
  });
});

describe('replayLots — corporate actions', () => {
  it('a split rebases cost per share and PRESERVES the acquisition date', () => {
    // 2-for-1: 100 shares at ₹1000 become 200 at ₹500. Total cost unchanged.
    const ledger = [
      row('BUY', 'RELIANCE.NS', 100, 100_000, '2023-01-10'),
      row('SPLIT', 'RELIANCE.NS', 2, 0, '2024-01-10'),
      row('SELL', 'RELIANCE.NS', 200, 140_000, '2025-01-10'),
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(1);
    expect(gains[0].quantity).toBe(200);
    expect(gains[0].costPerShare).toBe(500);
    expect(gains[0].costBasis).toBe(100_000); // total cost survived the split
    expect(gains[0].gain).toBe(40_000);
    // The clock did NOT restart at the split: still measured from 2023.
    expect(gains[0].acquiredOn).toEqual(d('2023-01-10'));
    expect(gains[0].term).toBe('LONG');
  });

  it('a bonus issue opens a ZERO-cost lot dated the bonus day', () => {
    // The case a naive implementation gets wrong twice: bonus shares must not
    // inherit the parent's date, and must not dilute the parent's basis.
    const ledger = [
      row('BUY', 'INFY.NS', 100, 150_000, '2023-01-10'),
      row('BONUS', 'INFY.NS', 100, 0, '2025-06-01'),
    ];

    const { openLots } = replayLots(ledger, INDIA);

    expect(openLots).toHaveLength(2);

    const parent = openLots.find((l) => !l.fromBonus)!;
    const bonus = openLots.find((l) => l.fromBonus)!;

    expect(parent.unitCost).toBe(1500); // undiluted
    expect(bonus.unitCost).toBe(0);
    expect(bonus.acquiredOn).toEqual(d('2025-06-01')); // its own clock
  });

  it('taxes a quickly-sold bonus share as SHORT term on full proceeds', () => {
    const ledger = [
      row('BUY', 'INFY.NS', 100, 150_000, '2020-01-10'),
      row('BONUS', 'INFY.NS', 100, 0, '2025-06-01'),
      // Sell 150: 100 from the old parent lot, then 50 bonus shares.
      row('SELL', 'INFY.NS', 150, 300_000, '2025-09-01'),
    ];

    const { gains } = replayLots(ledger, INDIA);

    expect(gains).toHaveLength(2);

    const parentRow = gains[0];
    expect(parentRow.quantity).toBe(100);
    expect(parentRow.term).toBe('LONG');

    const bonusRow = gains[1];
    expect(bonusRow.quantity).toBe(50);
    expect(bonusRow.fromBonus).toBe(true);
    expect(bonusRow.costBasis).toBe(0);
    expect(bonusRow.gain).toBe(100_000); // entire proceeds are gain
    expect(bonusRow.term).toBe('SHORT'); // 3 months, not 5 years
  });

  it('applies a same-day split BEFORE the sale that follows it', () => {
    // Ordering bug guard: sell 200 on the day of a 2-for-1. If the sale ran
    // first it would find only 100 shares and report 100 as unmatched.
    const ledger = [
      row('SELL', 'TCS.NS', 200, 140_000, '2025-01-10'),
      row('SPLIT', 'TCS.NS', 2, 0, '2025-01-10'),
      row('BUY', 'TCS.NS', 100, 100_000, '2023-01-10'),
    ];

    const { gains, unmatchedSales } = replayLots(ledger, INDIA);

    expect(unmatchedSales).toHaveLength(0);
    expect(gains[0].quantity).toBe(200);
    expect(gains[0].costPerShare).toBe(500);
  });

  it('opens a lot for a TRANSFER in, since those shares carry a basis', () => {
    const ledger = [
      row('TRANSFER', 'AAPL', 10, 1_500, '2024-01-10'),
      row('SELL', 'AAPL', 10, 2_000, '2025-06-10'),
    ];

    const { gains, unmatchedSales } = replayLots(ledger, US);

    expect(unmatchedSales).toHaveLength(0);
    expect(gains[0].costPerShare).toBe(150);
    expect(gains[0].gain).toBe(500);
  });
});

describe('grandfatheredCost — India s.112A', () => {
  const acquired = d('2015-06-01');
  const sold = d('2025-06-01');

  it('substitutes the higher 31-Jan-2018 FMV for actual cost', () => {
    const { costPerShare, grandfathered } = grandfatheredCost(
      100, // actual cost
      250, // FMV on 31-Jan-2018
      400, // sale price
      acquired,
      sold,
      'INDIA',
    );

    expect(costPerShare).toBe(250);
    expect(grandfathered).toBe(true);
  });

  it('CAPS the substituted cost at the sale price, so it cannot create a loss', () => {
    // Bought ₹100, peaked ₹500 on 31-Jan-2018, sold ₹300. The real gain is ₹200.
    // Without the cap this reports a ₹200 LOSS.
    const { costPerShare } = grandfatheredCost(100, 500, 300, acquired, sold, 'INDIA');

    expect(costPerShare).toBe(300); // capped at proceeds → gain of exactly 0
  });

  it('keeps actual cost when it exceeds the 31-Jan-2018 FMV', () => {
    const { costPerShare, grandfathered } = grandfatheredCost(
      400,
      250,
      500,
      acquired,
      sold,
      'INDIA',
    );

    expect(costPerShare).toBe(400);
    expect(grandfathered).toBe(false);
  });

  it('does not apply to shares acquired after 31-Jan-2018', () => {
    const { costPerShare, grandfathered } = grandfatheredCost(
      100,
      250,
      400,
      d('2018-02-01'),
      sold,
      'INDIA',
    );

    expect(costPerShare).toBe(100);
    expect(grandfathered).toBe(false);
  });

  it('does not apply to the US book', () => {
    const { costPerShare } = grandfatheredCost(100, 250, 400, acquired, sold, 'US');
    expect(costPerShare).toBe(100);
  });

  it('flows through a full replay when an FMV map is supplied', () => {
    const ledger = [
      row('BUY', 'RELIANCE.NS', 100, 10_000, '2015-06-01'), // ₹100/sh
      row('SELL', 'RELIANCE.NS', 100, 40_000, '2025-06-01'), // ₹400/sh
    ];

    const { gains } = replayLots(ledger, {
      market: 'INDIA',
      fmv31Jan2018: new Map([['RELIANCE.NS', 250]]),
    });

    expect(gains[0].costPerShare).toBe(250);
    expect(gains[0].originalCostPerShare).toBe(100); // audit trail preserved
    expect(gains[0].gain).toBe(15_000); // not 30,000
    expect(gains[0].grandfathered).toBe(true);
  });
});

describe('capital gains by fiscal year', () => {
  // Sold in Feb-2026 (FY26 for India: Apr-25 → Mar-26) and Jun-2026 (FY27).
  const ledger = [
    row('BUY', 'A.NS', 100, 100_000, '2020-01-10'),
    row('BUY', 'B.NS', 100, 100_000, '2025-12-01'),
    row('SELL', 'A.NS', 100, 150_000, '2026-02-10'), // FY26, long, +50k
    row('SELL', 'B.NS', 100, 80_000, '2026-06-10'), // FY27, short, −20k
  ];

  it('buckets by the SALE date, not the acquisition date', () => {
    const { gains } = replayLots(ledger, INDIA);
    const fy26 = capitalGainsForFiscalYear(gains, 2026, 'INDIA');

    // The FY26 sale is of a lot bought in FY20 — it belongs to FY26 regardless.
    expect(fy26.rows).toHaveLength(1);
    expect(fy26.rows[0].ticker).toBe('A.NS');
    expect(fy26.longTerm.net).toBe(50_000);
    expect(fy26.shortTerm.net).toBe(0);
  });

  it('cuts the Indian year on the April–March boundary', () => {
    const { gains } = replayLots(ledger, INDIA);
    const fy27 = capitalGainsForFiscalYear(gains, 2027, 'INDIA');

    // 10-Jun-2026 falls in FY27 (Apr-2026 → Mar-2027).
    expect(fy27.periodStart).toEqual(d('2026-04-01'));
    expect(fy27.rows).toHaveLength(1);
    expect(fy27.rows[0].ticker).toBe('B.NS');
    expect(fy27.shortTerm.net).toBe(-20_000);
  });

  it('cuts the US year on the calendar boundary, putting both sales in CY26', () => {
    const { gains } = replayLots(ledger, US);
    const cy26 = capitalGainsForFiscalYear(gains, 2026, 'US');

    // Same trades, one calendar year: Feb and Jun 2026 are both CY26.
    expect(cy26.rows).toHaveLength(2);
    expect(cy26.total.net).toBe(30_000);
  });

  it('tracks gains and losses separately for set-off purposes', () => {
    const { gains } = replayLots(ledger, US);
    const cy26 = capitalGainsForFiscalYear(gains, 2026, 'US');

    // s.74-style set-off needs the gross figures, not just the net.
    expect(cy26.total.gains).toBe(50_000);
    expect(cy26.total.losses).toBe(20_000);
    expect(cy26.total.net).toBe(30_000);
    expect(cy26.total.transactions).toBe(2);
  });

  it('enumerates only the years the ledger actually touches', () => {
    const { gains } = replayLots(ledger, INDIA);
    expect(capitalGainsByYear(gains, 'INDIA').map((s) => s.fiscalYear)).toEqual([2027, 2026]);
  });

  it('keeps a sale timed late on the final day inside its fiscal year', () => {
    // 31-Mar is the last day of an Indian FY, and a real trade carries a time of
    // day. Comparing against the range end (midnight) would drop this sale from
    // FY26 without it appearing in FY27 either — it would vanish from the report.
    const lateSale = [
      row('BUY', 'C.NS', 10, 1_000, '2024-01-01'),
      { ...row('SELL', 'C.NS', 10, 2_000, '2026-03-31'), date: new Date('2026-03-31T15:30:00.000Z') },
    ];

    const { gains } = replayLots(lateSale, INDIA);
    const fy26 = capitalGainsForFiscalYear(gains, 2026, 'INDIA');

    expect(fy26.rows).toHaveLength(1);
    expect(fy26.total.net).toBe(1_000);
  });

  it('labels the Indian year for the calendar year it ENDS in', () => {
    const { gains } = replayLots(ledger, INDIA);
    expect(capitalGainsForFiscalYear(gains, 2027, 'INDIA').label).toBe('FY27');
  });
});
