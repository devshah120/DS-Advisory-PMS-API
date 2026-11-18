import { buildFlows } from '../analytics/calculators/flows';
import {
  asPaidPerShare,
  calculateClientDividends,
  EntitlementLedgerRow,
  settle,
  sharesHeldOnEve,
  SplitEvent,
  tradeDay,
} from './dividend-entitlement';

const row = (type: string, ticker: string, quantity: number, date: string): EntitlementLedgerRow => ({
  ticker,
  type,
  quantity,
  date: new Date(date),
});
const buy = (ticker: string, quantity: number, date: string) => row('BUY', ticker, quantity, date);
const sell = (ticker: string, quantity: number, date: string) => row('SELL', ticker, quantity, date);
const splitRow = (ticker: string, delta: number, date: string) => row('SPLIT', ticker, delta, date);

/** A Thursday. Its eve is Wednesday 2-Sep. */
const EX = new Date('2026-09-03T00:00:00Z');

describe('tradeDay', () => {
  it('reads UTC-midnight and IST-midnight entries as the same trade date', () => {
    for (const market of ['US', 'INDIA'] as const) {
      expect(tradeDay(new Date('2026-09-03T00:00:00Z'), market)).toBe('2026-09-03');
      expect(tradeDay(new Date('2026-09-02T18:30:00Z'), market)).toBe('2026-09-03');
    }
  });

  it('reads a real US fill on the New York clock, not the IST one', () => {
    // 15:45 EDT on 2-Sep is 19:45Z, which is already 01:15 IST on 3-Sep.
    expect(tradeDay(new Date('2026-09-02T19:45:00Z'), 'US')).toBe('2026-09-02');
  });

  it('reads a real Indian fill on the IST clock', () => {
    // 09:30 IST on 3-Sep is 04:00Z.
    expect(tradeDay(new Date('2026-09-03T04:00:00Z'), 'INDIA')).toBe('2026-09-03');
  });
});

describe('sharesHeldOnEve: who held at the close before the ex-date', () => {
  const eve = (rows: EntitlementLedgerRow[]) =>
    sharesHeldOnEve({ rows, ticker: 'AAPL', exDate: EX, market: 'US' });

  it('counts a buy before the ex-date and not one on it', () => {
    expect(eve([buy('AAPL', 100, '2026-09-02')]).shares).toBe(100);
    expect(eve([buy('AAPL', 100, '2026-09-03')]).shares).toBe(0);
  });

  it('lets a seller on the ex-date keep the dividend', () => {
    expect(eve([buy('AAPL', 100, '2026-08-01'), sell('AAPL', 100, '2026-09-03')]).shares).toBe(100);
  });

  it('does not count an IST-midnight buy dated ON the ex-date', () => {
    // Stored as 2-Sep 18:30Z. Comparing raw UTC days would read it as 2-Sep and pay it.
    const rows = [buy('RELIANCE.NS', 50, '2026-09-02T18:30:00Z')];
    const result = sharesHeldOnEve({ rows, ticker: 'RELIANCE.NS', exDate: EX, market: 'INDIA' });
    expect(result.shares).toBe(0);
  });

  it('replays the running balance, ignoring other tickers and later trades', () => {
    const rows = [
      buy('AAPL', 100, '2026-07-10'),
      sell('AAPL', 40, '2026-08-20'),
      buy('MSFT', 500, '2026-08-21'),
      buy('AAPL', 50, '2026-09-10'),
    ];
    expect(eve(rows)).toEqual({ shares: 60, status: 'OK', notes: [] });
  });

  it('blocks a ledger that sells more than it bought', () => {
    const result = eve([buy('AAPL', 10, '2026-07-10'), sell('AAPL', 30, '2026-08-20')]);
    expect(result.status).toBe('BLOCKED');
    expect(result.notes.join(' ')).toMatch(/more sold than bought/);
  });
});

describe('sharesHeldOnEve: splits come from the ledger; provider events only check it', () => {
  const APH_SPLIT: SplitEvent = { ticker: 'APH', exDate: new Date('2026-09-03'), multiplier: 2 };
  const eve = (rows: EntitlementLedgerRow[], exDate = new Date('2026-09-16')) =>
    sharesHeldOnEve({ rows, ticker: 'APH', exDate, market: 'US', splits: [APH_SPLIT] });

  it('passes through a recorded split exactly once: 200 shares, not 400', () => {
    const result = eve([buy('APH', 100, '2026-07-01'), splitRow('APH', 100, '2026-09-03')]);
    expect(result).toEqual({ shares: 200, status: 'OK', notes: [] });
  });

  it('blocks a client who held through a split the ledger never recorded', () => {
    const result = eve([buy('APH', 100, '2026-07-01')]);
    expect(result.status).toBe('BLOCKED');
    // Still the pre-split count, which is exactly why it must not be paid.
    expect(result.shares).toBe(100);
    expect(result.notes.join(' ')).toMatch(/no SPLIT or BONUS row records it/);
  });

  it('ignores a split the client bought in after', () => {
    expect(eve([buy('APH', 80, '2026-09-10')])).toEqual({ shares: 80, status: 'OK', notes: [] });
  });

  it('ignores a split that comes after the ex-date', () => {
    const rows = [buy('APH', 100, '2026-07-01'), splitRow('APH', 100, '2026-09-03')];
    expect(eve(rows, new Date('2026-08-15')).shares).toBe(100);
  });

  it('flags, without blocking, a split row of the wrong size', () => {
    const result = eve([buy('APH', 100, '2026-07-01'), splitRow('APH', 300, '2026-09-03')]);
    expect(result.status).toBe('OK');
    expect(result.notes.join(' ')).toMatch(/implies 100/);
  });

  it('accepts a bonus row stamped on the allotment date, after the ex-date', () => {
    const bonus: SplitEvent = { ticker: 'RELIANCE.NS', exDate: new Date('2026-08-28'), multiplier: 2 };
    const rows = [
      buy('RELIANCE.NS', 50, '2026-07-01'),
      row('BONUS', 'RELIANCE.NS', 50, '2026-09-01'),
    ];
    const result = sharesHeldOnEve({
      rows,
      ticker: 'RELIANCE.NS',
      exDate: new Date('2026-09-20'),
      market: 'INDIA',
      splits: [bonus],
    });
    expect(result).toEqual({ shares: 100, status: 'OK', notes: [] });
  });
});

describe('sharesHeldOnEve: anchored on today’s holding', () => {
  it('pays a former holder (0 held today) on the shares they sold after the ex-date', () => {
    const rows = [buy('AAPL', 100, '2026-07-01'), sell('AAPL', 100, '2026-09-10')];
    const result = sharesHeldOnEve({ rows, ticker: 'AAPL', exDate: EX, market: 'US', anchorQuantity: 0 });
    expect(result).toEqual({ shares: 100, status: 'OK', notes: [] });
  });

  it('subtracts a split that came after the ex-date when working back from a post-split holding', () => {
    const rows = [buy('APH', 100, '2026-07-01'), splitRow('APH', 100, '2026-09-03')];
    const result = sharesHeldOnEve({
      rows,
      ticker: 'APH',
      exDate: new Date('2026-08-15'),
      market: 'US',
      splits: [{ ticker: 'APH', exDate: new Date('2026-09-03'), multiplier: 2 }],
      anchorQuantity: 200,
      anchorDate: new Date('2026-11-18'),
    });
    expect(result).toEqual({ shares: 100, status: 'OK', notes: [] });
  });

  it('blocks when a split after the ex-date reached the holding without a ledger row', () => {
    // Applied to the Holding by hand: 200 today, but nothing in the ledger to take 100 back out.
    const result = sharesHeldOnEve({
      rows: [buy('APH', 100, '2026-07-01')],
      ticker: 'APH',
      exDate: new Date('2026-08-15'),
      market: 'US',
      splits: [{ ticker: 'APH', exDate: new Date('2026-09-03'), multiplier: 2 }],
      anchorQuantity: 200,
      anchorDate: new Date('2026-11-18'),
    });
    expect(result.status).toBe('BLOCKED');
  });

  it('ignores a split announced for after the anchor date', () => {
    const result = sharesHeldOnEve({
      rows: [buy('APH', 100, '2026-07-01')],
      ticker: 'APH',
      exDate: new Date('2026-08-15'),
      market: 'US',
      splits: [{ ticker: 'APH', exDate: new Date('2026-12-01'), multiplier: 2 }],
      anchorQuantity: 100,
      anchorDate: new Date('2026-11-18'),
    });
    expect(result).toEqual({ shares: 100, status: 'OK', notes: [] });
  });

  it('does not block over untracked shares the ledger never carried into a split', () => {
    // Ledger starts after the split; the holding has 30 shares the ledger does not explain.
    const result = sharesHeldOnEve({
      rows: [buy('APH', 50, '2026-09-10')],
      ticker: 'APH',
      exDate: new Date('2026-09-16'),
      market: 'US',
      splits: [{ ticker: 'APH', exDate: new Date('2026-09-03'), multiplier: 2 }],
      anchorQuantity: 80,
      anchorDate: new Date('2026-11-18'),
    });
    expect(result.status).toBe('OK');
    expect(result.shares).toBe(80);
  });

  it('works back from the holding when the ledger does not add up to it, and says so', () => {
    // The ledger has 120 (a duplicated import row, say); the holding is 80, and 20 came after the ex-date.
    const rows = [buy('AAPL', 100, '2026-07-01'), buy('AAPL', 20, '2026-09-10')];
    const result = sharesHeldOnEve({ rows, ticker: 'AAPL', exDate: EX, market: 'US', anchorQuantity: 80 });
    expect(result.shares).toBe(60);
    expect(result.notes.join(' ')).toMatch(/add up to 120 shares but the holding is 80/);
  });
});

describe('asPaidPerShare', () => {
  const AAPL_2020: SplitEvent[] = [{ ticker: 'AAPL', exDate: new Date('2020-08-31'), multiplier: 4 }];

  it('restates Yahoo’s split-adjusted dividend as what was actually paid', () => {
    // Yahoo lists AAPL's Feb-2020 dividend as 0.1925. What was paid was 0.77, before the 4-for-1.
    const event = { ticker: 'AAPL', exDate: new Date('2020-02-07'), perShare: 0.1925, basis: 'SPLIT_ADJUSTED' as const };
    expect(asPaidPerShare(event, AAPL_2020, 'US')).toBe(0.77);
  });

  it('leaves an as-paid amount, and a dividend after the split, alone', () => {
    const asPaid = { ticker: 'AAPL', exDate: new Date('2020-02-07'), perShare: 0.77 };
    const later = { ticker: 'AAPL', exDate: new Date('2020-11-06'), perShare: 0.205, basis: 'SPLIT_ADJUSTED' as const };
    expect(asPaidPerShare(asPaid, AAPL_2020, 'US')).toBe(0.77);
    expect(asPaidPerShare(later, AAPL_2020, 'US')).toBe(0.205);
  });
});

describe('settle: withholding at source', () => {
  it('withholds the rate and books the net', () => {
    expect(settle(400, 0.25, 0.25)).toEqual({ gross: 100, withheld: 25, net: 75 });
  });

  it('rounds each figure to the cent so gross = withheld + net', () => {
    // 58.1561 x 0.165 = 9.5958...
    expect(settle(58.1561, 0.165, 0.25)).toEqual({ gross: 9.6, withheld: 2.4, net: 7.2 });
  });

  it('rejects a percent passed where a fraction belongs', () => {
    expect(() => settle(100, 1, 25)).toThrow(RangeError);
  });
});

describe('calculateClientDividends', () => {
  const history = [
    buy('AAPL', 100, '2026-07-01'),
    sell('AAPL', 100, '2026-08-12'), // after AAPL went ex, before it paid
    buy('MSFT', 10, '2026-07-01'),
  ];
  const dividends = [
    { ticker: 'MSFT', exDate: new Date('2026-08-20'), payDate: new Date('2026-09-10'), perShare: 0.83 },
    { ticker: 'AAPL', exDate: new Date('2026-08-11'), payDate: new Date('2026-08-14'), perShare: 0.26 },
    { ticker: 'AAPL', exDate: new Date('2026-09-08'), payDate: new Date('2026-09-11'), perShare: 0.26 },
    { ticker: 'MSFT', exDate: new Date('2026-09-17'), payDate: new Date('2026-10-08'), perShare: 0.83 },
  ];
  const run = () =>
    calculateClientDividends(history, new Date('2026-07-01'), new Date('2026-09-30'), {
      market: 'US',
      dividends,
      withholdingTaxRate: 0.25,
    });

  it('pays on ex-date shares, skips names not held, and leaves out cash paid after the window', () => {
    const { entitlements } = run();

    expect(entitlements.map((e) => [e.ticker, e.eligibleShares, e.gross, e.withheld, e.net])).toEqual([
      // Sold the day after it went ex: still owed.
      ['AAPL', 100, 26, 6.5, 19.5],
      ['MSFT', 10, 8.3, 2.08, 6.22],
      // The September AAPL dividend is absent (nothing held), and so is the
      // MSFT dividend that pays in October.
    ]);
  });

  it('emits DIVIDEND rows that buildFlows treats as money returned to the client', () => {
    const { cashFlows } = run();
    expect(cashFlows).toEqual([
      { type: 'DIVIDEND', amount: 19.5, date: new Date('2026-08-14') },
      { type: 'DIVIDEND', amount: 6.22, date: new Date('2026-09-10') },
    ]);

    const built = buildFlows(
      [{ type: 'BUY', amount: 30000, date: new Date('2026-07-01') }, ...cashFlows],
      'TRANSACTIONAL',
      31000,
      new Date('2026-09-30'),
    );
    if (built.status !== 'ok') throw new Error(built.reason);

    // Positive: out of the portfolio, so it adds to the return. A contribution would be negative.
    const dividendFlow = built.flows.find((f) => f.date.getTime() === new Date('2026-08-14').getTime());
    expect(dividendFlow?.amount).toBe(19.5);
  });

  it('keeps a BLOCKED entitlement visible but out of the cash flows', () => {
    const result = calculateClientDividends(
      [buy('APH', 100, '2026-07-01')],
      new Date('2026-07-01'),
      new Date('2026-09-30'),
      {
        market: 'US',
        dividends: [
          { ticker: 'APH', exDate: new Date('2026-09-16'), payDate: new Date('2026-09-30'), perShare: 0.165 },
        ],
        splits: [{ ticker: 'APH', exDate: new Date('2026-09-03'), multiplier: 2 }],
      },
    );

    expect(result.entitlements.map((e) => e.status)).toEqual(['BLOCKED']);
    expect(result.cashFlows).toEqual([]);
  });
});
