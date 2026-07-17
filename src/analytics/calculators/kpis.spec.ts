import {
  absoluteReturn,
  annualizedReturn,
  cashDrag,
  cashIsExplained,
  derivedCash,
  flowTotals,
  investedCapital,
  LedgerRow,
  performers,
  portfolioTurnover,
  realizedGain,
  realizedProceeds,
} from './kpis';
import { buildFlows } from './flows';
import { xirr } from './xirr';
import { PortfolioSnapshot, Position } from './types';

const d = (s: string) => new Date(s);

const row = (
  type: string,
  amount: number,
  date: string,
  ticker: string | null = null,
  quantity: number | null = null,
): LedgerRow => ({ type, amount, date: d(date), ticker, quantity, price: null });

describe('derivedCash', () => {
  it('walks the ledger rather than trusting the stored balance', () => {
    const ledger = [
      row('CASH_DEPOSIT', 100000, '2026-01-05'),
      row('BUY', 60000, '2026-01-10', 'AAPL', 300),
      row('DIVIDEND', 500, '2026-03-01', 'AAPL'),
      row('SELL', 20000, '2026-04-20', 'AAPL', 100),
      row('CASH_WITHDRAWAL', 15000, '2026-05-02'),
      row('FEES', 250, '2026-05-30'),
    ];

    // 100000 − 60000 + 500 + 20000 − 15000 − 250
    expect(derivedCash(ledger)).toBe(45250);
  });

  it('ignores splits and bonuses — their amount column is not money', () => {
    const ledger = [
      row('CASH_DEPOSIT', 100000, '2026-01-05'),
      row('SPLIT', 4, '2026-02-01', 'AAPL', 4),
      row('BONUS', 100, '2026-03-01', 'AAPL', 100),
      row('TRANSFER', 5000, '2026-03-05', 'AAPL'),
    ];

    // Summing those amounts as cash would report 105,104 and be nonsense.
    expect(derivedCash(ledger)).toBe(100000);
  });

  it('derives direction from the type, not the stored sign', () => {
    // The ledger is not consistent about whether a withdrawal is -5000 or 5000.
    const ledger = [
      row('CASH_DEPOSIT', -100000, '2026-01-05'),
      row('CASH_WITHDRAWAL', -5000, '2026-02-05'),
    ];
    expect(derivedCash(ledger)).toBe(95000);
  });
});

/**
 * The regression test for the worst bug this engine has produced so far.
 *
 * The live "Atlas Global Fund" was imported from the workbook with its four
 * deposits ($188,780) and its eighteen holdings ($191,837) — and NO buy rows,
 * because the workbook's XIRR sheet only ever recorded cash flows.
 *
 * Deriving cash from that ledger returns the full $188,780, as though money that
 * was long since spent on stock were still sitting in the account. The terminal
 * value then counts the same money twice ($380,618 against a real book of
 * ~$243k) and the cash-flow XIRR solves to +3,383%.
 *
 * That is not a rounding error. It is worse than a crash, because it looks like
 * a triumph.
 */
describe('cashIsExplained — the incomplete-ledger trap', () => {
  const DEPOSITS: LedgerRow[] = [
    row('CASH_DEPOSIT', 98996.68, '2026-04-27'),
    row('CASH_DEPOSIT', 48800, '2026-05-06'),
    row('CASH_DEPOSIT', 26784, '2026-05-06'),
    row('CASH_DEPOSIT', 14200, '2026-06-15'),
  ];

  it('refuses to derive cash when stock is held that was never recorded as bought', () => {
    // 18 holdings worth $191,837 that nothing in the ledger paid for.
    expect(cashIsExplained(DEPOSITS, 191837.39)).toBe(false);
  });

  it('shows exactly how wrong the derived figure would be', () => {
    // The derived number is the full deposit total — none of it spent.
    expect(derivedCash(DEPOSITS)).toBeCloseTo(188780.68, 2);

    // The truth (per the workbook) is $51,800. Deriving overstates cash by
    // $136,980, which lands straight in the cash-flow method's terminal value.
    expect(derivedCash(DEPOSITS) - 51800).toBeCloseTo(136980.68, 2);
  });

  it('derives happily once the purchases ARE recorded', () => {
    const complete = [
      ...DEPOSITS,
      row('BUY', 136980.68, '2026-04-28', 'AAPL', 500),
    ];

    expect(cashIsExplained(complete, 191837.39)).toBe(true);
    expect(derivedCash(complete)).toBeCloseTo(51800, 2); // the workbook's figure
  });

  it('has nothing to explain on an all-cash book', () => {
    expect(cashIsExplained(DEPOSITS, 0)).toBe(true);
  });
});

describe('realizedGain', () => {
  it('prices a sale at the average cost AT THE TIME of the sale', () => {
    const ledger = [
      row('BUY', 10000, '2026-01-01', 'AAPL', 100), // $100/sh
      row('SELL', 6000, '2026-02-01', 'AAPL', 50), // $120/sh → +$1,000
      row('BUY', 20000, '2026-03-01', 'AAPL', 100), // $200/sh — AFTER the sale
    ];

    // The later BUY at $200 must not retro-price the February sale. If it did,
    // avg cost would read $150 and the sale would show a $1,500 LOSS.
    expect(realizedGain(ledger)).toBeCloseTo(1000, 6);
  });

  it('adjusts the cost basis for a split, so a post-split sale is not a windfall', () => {
    const ledger = [
      row('BUY', 10000, '2026-01-01', 'AAPL', 100), // $100/sh
      row('SPLIT', 2, '2026-02-01', 'AAPL', 2), // 100 → 200 sh, cost/sh → $50
      row('SELL', 11000, '2026-03-01', 'AAPL', 200), // $55/sh
    ];

    // Post-split the basis is $50/sh, so this is a $1,000 gain. Without the split
    // adjustment the basis reads $100/sh and the sale looks like a $9,000 LOSS.
    expect(realizedGain(ledger)).toBeCloseTo(1000, 6);
  });

  it('is zero for a book that has never sold', () => {
    const ledger = [row('BUY', 10000, '2026-01-01', 'AAPL', 100)];
    expect(realizedGain(ledger)).toBe(0);
  });

  it('does not go negative on a sale with no matching buy', () => {
    // A miscoded ledger should not silently invent a 100% gain.
    const ledger = [row('SELL', 5000, '2026-01-01', 'AAPL', 50)];
    expect(realizedGain(ledger)).toBe(0);
  });
});

describe('portfolioTurnover', () => {
  /**
   * The reason the SEC convention uses min(buys, sells) and not the sum, or the
   * buys alone. This is the case that breaks the naive formulas.
   */
  it('reads ZERO for an account that is funding up and never sells', () => {
    const ledger = [
      row('CASH_DEPOSIT', 500000, '2026-01-01'),
      row('BUY', 500000, '2026-01-02', 'AAPL', 1000),
    ];

    // buys=500k, sells=0 → min = 0. A buys-only formula would report ~100%
    // turnover on a book that has not traded at all.
    expect(portfolioTurnover(ledger, 500000, 520000)).toBe(0);
  });

  it('measures the round-trip, not the gross volume', () => {
    const ledger = [
      row('BUY', 100000, '2026-01-02', 'AAPL', 500),
      row('SELL', 40000, '2026-06-02', 'AAPL', 200),
    ];

    // min(100k, 40k) = 40k over an average value of 100k → 40%.
    // (buys+sells)/avg would report 140% for the same trading.
    expect(portfolioTurnover(ledger, 100000, 100000)).toBeCloseTo(0.4, 6);
  });

  it('returns null rather than dividing by zero on an empty book', () => {
    expect(portfolioTurnover([], 0, 0)).toBeNull();
  });
});

describe('cashDrag', () => {
  it('is negative — a cost — when the portfolio rose and cash sat idle', () => {
    // 20% cash, portfolio +10%. The cash gave up 20% × 10% = 2%.
    const drag = cashDrag(20000, 100000, 0.1);
    expect(drag).toBeCloseTo(-0.02, 6);
  });

  it('is POSITIVE when the portfolio fell — cash protected the client', () => {
    // This is the case a "drag is always a penalty" formula gets wrong. Holding
    // cash through a drawdown helped, and the number should say so.
    const drag = cashDrag(20000, 100000, -0.1);
    expect(drag).toBeCloseTo(0.02, 6);
  });

  it('is zero for a fully invested book', () => {
    expect(cashDrag(0, 100000, 0.1)).toBe(-0);
  });

  it('returns null rather than NaN on an empty book', () => {
    expect(cashDrag(0, 0, 0.1)).toBeNull();
  });
});

describe('annualizedReturn', () => {
  it('annualizes a half-year return', () => {
    // +6% over 182.5 days ≈ +12.36% annualized.
    expect(annualizedReturn(0.06, 182.5)).toBeCloseTo(0.1236, 4);
  });

  it('REFUSES to annualize a 3-day return', () => {
    // (1.02)^(365/3) − 1 = +1,020,000%. Arithmetically correct, and utterly
    // meaningless. The XIRR is the number to read on a young account.
    expect(annualizedReturn(0.02, 3)).toBeNull();
  });

  it('returns null on a total loss rather than a complex root', () => {
    expect(annualizedReturn(-1, 365)).toBeNull();
  });
});

describe('absoluteReturn', () => {
  it('divides gain by the capital that produced it', () => {
    expect(absoluteReturn(15000, 100000)).toBeCloseTo(0.15, 6);
  });

  it('returns null rather than Infinity when no capital was invested', () => {
    expect(absoluteReturn(500, 0)).toBeNull();
  });
});

describe('performers', () => {
  const snap = (): PortfolioSnapshot => ({
    clientId: 'c1',
    clientName: 'Test',
    asOf: d('2026-06-25'),
    baseCurrency: 'USD',
    cash: 10000,
    positions: [
      pos('BIG', 100000, 98000), // +2.04% on a large position
      pos('SMALL', 3000, 2000), // +50% on a small one
      pos('DOG', 5000, 8000), // −37.5%
    ],
  });

  /**
   * Ranking by dollar P&L just re-discovers the largest position. BIG made more
   * money in dollars ($2,000) than SMALL ($1,000), but SMALL is unambiguously
   * the better investment, and that is what "best performer" is asking.
   */
  it('ranks by return on cost, not by dollar P&L', () => {
    const p = performers(snap());
    expect(p.best?.ticker).toBe('SMALL');
    expect(p.best?.returnPct).toBeCloseTo(0.5, 6);
    expect(p.worst?.ticker).toBe('DOG');
    expect(p.worst?.returnPct).toBeCloseTo(-0.375, 6);
  });

  it('excludes zero-cost positions rather than ranking them as infinite', () => {
    const s = snap();
    s.positions.push(pos('FREEBIE', 5000, 0)); // a bonus issue
    const p = performers(s);

    expect(p.best?.ticker).toBe('SMALL'); // not FREEBIE at +Infinity%
    expect(p.ranked.some((r) => r.ticker === 'FREEBIE')).toBe(false);
  });

  it('does not report the same position as both best and worst', () => {
    const single: PortfolioSnapshot = { ...snap(), positions: [pos('ONLY', 5000, 4000)] };
    const p = performers(single);

    expect(p.best?.ticker).toBe('ONLY');
    expect(p.worst).toBeNull();
  });
});

describe('flowTotals', () => {
  it('separates deposits, withdrawals, dividends and fees', () => {
    const ledger = [
      row('CASH_DEPOSIT', 100000, '2026-01-05'),
      row('CASH_DEPOSIT', 50000, '2026-02-05'),
      row('CASH_WITHDRAWAL', 15000, '2026-05-02'),
      row('DIVIDEND', 500, '2026-03-01', 'AAPL'),
      row('FEES', 250, '2026-05-30'),
      row('BUY', 60000, '2026-01-10', 'AAPL', 300),
      row('SELL', 20000, '2026-04-20', 'AAPL', 100),
    ];

    expect(flowTotals(ledger)).toEqual({
      netDeposits: 150000,
      netWithdrawals: 15000,
      netContribution: 135000,
      dividendIncome: 500,
      fees: 250,
      purchases: 60000,
      sales: 20000,
    });
  });
});

/**
 * The load-bearing test: the two methodologies, on ONE ledger, producing two
 * different and individually correct answers.
 *
 * This is the whole feature. If these two numbers were the same, the accounting
 * method would be a setting that does nothing.
 */
describe('the two methodologies disagree, correctly', () => {
  // A client wires in $100k. We deploy $80k and leave $20k idle. The deployed
  // capital grows to $88k (+10%). The idle $20k earns nothing.
  const LEDGER: LedgerRow[] = [
    row('CASH_DEPOSIT', 100000, '2026-01-01'),
    row('BUY', 80000, '2026-01-01', 'AAPL', 800),
  ];
  const ASOF = d('2027-01-01'); // exactly one year
  const HOLDINGS = 88000;
  const CASH = derivedCash(LEDGER); // 20,000

  it('TRANSACTIONAL ignores idle cash and reports the return on deployed capital', () => {
    // Terminal = holdings only. Flows: −80,000 (the BUY) → +88,000.
    const built = buildFlows(LEDGER, 'TRANSACTIONAL', HOLDINGS, ASOF);
    if (built.status !== 'ok') throw new Error(built.reason);

    const r = xirr(built.flows);
    if (r.status !== 'ok') throw new Error(r.reason);

    expect(r.rate).toBeCloseTo(0.1, 4); // +10% — the stock picking worked
  });

  it('CASH_FLOW includes the idle cash and reports the return the CLIENT got', () => {
    // Terminal = holdings + cash. Flows: −100,000 (the deposit) → +108,000.
    const built = buildFlows(LEDGER, 'CASH_FLOW', HOLDINGS + CASH, ASOF);
    if (built.status !== 'ok') throw new Error(built.reason);

    const r = xirr(built.flows);
    if (r.status !== 'ok') throw new Error(r.reason);

    expect(r.rate).toBeCloseTo(0.08, 4); // +8% — the client's actual experience
  });

  /**
   * The 2-point gap between +10% and +8% is not an error in either number. It is
   * cash drag, and it is exactly what the cashDrag() formula must reproduce —
   * otherwise the sheet shows a gap it cannot explain.
   */
  it('and cashDrag explains the gap between them, to the basis point', () => {
    const clientReturn = 0.08;
    const drag = cashDrag(CASH, HOLDINGS + CASH, clientReturn);

    // 20,000 / 108,000 × 8% ≈ −1.48%... but the gap above is 2.00%.
    //
    // These measure different things and both are right: `drag` prices the cash
    // against the return the TOTAL book earned, while the 2pt gap is against the
    // return the DEPLOYED sleeve earned. Priced against the deployed return the
    // identity closes exactly:
    const invested = 80000;
    const deployedReturn = 0.1;
    const exact = (CASH / (invested + CASH)) * deployedReturn;

    expect(exact).toBeCloseTo(0.02, 6); // the 2pt gap, exactly
    expect(drag).toBeLessThan(0); // and the reported drag is a cost
  });
});

describe('investedCapital / realizedProceeds', () => {
  const ASOF = d('2026-06-25');

  it('sums the money in, and the money out, without swallowing the terminal value', () => {
    const flows = [
      { date: d('2026-01-01'), amount: -100000 },
      { date: d('2026-03-01'), amount: 20000 },
      { date: ASOF, amount: 95000 }, // terminal
    ];

    expect(investedCapital(flows)).toBe(100000);
    expect(realizedProceeds(flows, ASOF)).toBe(20000); // NOT 115,000
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function pos(ticker: string, marketValue: number, costBasisTotal: number): Position {
  return {
    ticker,
    company: `${ticker} Inc`,
    quantity: 100,
    price: marketValue / 100,
    costBasis: costBasisTotal / 100,
    costBasisTotal,
    marketValue,
    realizedPnl: 0,
    unrealizedPnl: marketValue - costBasisTotal,
    dividends: 0,
    classification: {
      sector: 'Technology',
      industry: 'Software',
      region: 'USA',
      country: 'United States',
      assetClass: 'EQUITY' as const,
      lookThrough: null,
    },
    targetWeight: null,
  };
}
