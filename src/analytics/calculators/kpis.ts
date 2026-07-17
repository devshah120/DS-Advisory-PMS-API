import { CashFlow } from './xirr';
import { PortfolioSnapshot } from './types';

/**
 * The KPI set that sits on the Performance sheet.
 *
 * Pure, like everything else in this directory: a ledger and a snapshot in, a
 * number out. No Prisma, no clock. The clock in particular is an argument
 * (`asOf`), because "recompute last quarter's factsheet and get bit-identical
 * output" is a hard requirement for anything a client has already been shown.
 *
 * Two things here are worth reading before trusting the numbers:
 *
 *  1. Cash is DERIVED from the ledger, never read from `Client.cashBalance`.
 *     The stored scalar is a display cache maintained by the CRUD write path and
 *     it is already known to drift — the live client "Dev" carried
 *     portfolioValue = 0 against $40,702 of holdings. Cash Drag and the
 *     cash-flow method's terminal value both depend on this figure, so trusting
 *     the stored one would put drift directly into a headline return.
 *
 *  2. Realized gain is taken from the ledger too, not from `Holding.realizedPnL`,
 *     for the same reason and with the same consequence.
 */

export interface LedgerRow {
  type: string;
  ticker: string | null;
  quantity: number | null;
  price: number | null;
  amount: number;
  date: Date;
}

/**
 * Cash movements, by sign, as the ledger sees them.
 *
 * A BUY takes cash out of the sleeve and a SELL puts it back. A DIVIDEND lands
 * in cash; a FEE leaves it. SPLIT / BONUS / TRANSFER move shares, not money —
 * their `amount` column is not a cash figure and must not be summed as one.
 */
const CASH_EFFECT: Record<string, 1 | -1> = {
  CASH_DEPOSIT: +1,
  SELL: +1,
  DIVIDEND: +1,
  CASH_WITHDRAWAL: -1,
  BUY: -1,
  FEES: -1,
};

/**
 * Cash balance, derived from the ledger.
 *
 * This is the number the cash-flow method's terminal value is built on
 * (Final CF = Holdings Value + Cash Balance), so it has to be right rather than
 * merely available.
 *
 * It is only correct when the ledger is COMPLETE — see `cashIsExplained` below.
 * Deriving cash from a ledger that records the deposits but not the buys they
 * funded reports money that has already been spent as though it were still
 * sitting in the account, and the error lands directly in a headline return.
 */
export function derivedCash(ledger: LedgerRow[]): number {
  return ledger.reduce((acc, t) => {
    const sign = CASH_EFFECT[t.type];
    return sign ? acc + sign * Math.abs(t.amount) : acc;
  }, 0);
}

/**
 * Can this ledger explain the book?
 *
 * "Derive, never trust the stored scalar" is the right rule — but it assumes the
 * ledger is complete, and the live data proves that assumption can fail. The
 * workbook import loaded the client's four deposits ($188,780) and their 18
 * holdings ($191,837), and NO buy transactions: the workbook's XIRR sheet only
 * ever recorded the cash flows. Derive cash from that ledger and you get
 * $188,780 of "cash" that was in fact spent on the stock years ago — so the
 * terminal value counts the same money twice and XIRR solves to +3,383%.
 *
 * A number that wrong is not a rounding problem, and it is worse than a crash
 * because it looks like a triumph.
 *
 * So the rule gets a precondition rather than an exception: derive when the
 * ledger CAN explain the book, and refuse to guess when it cannot. Holdings that
 * exist with no purchase ever recorded mean the ledger is not the whole story,
 * and neither the derived figure nor the stored one can be trusted silently.
 */
export function cashIsExplained(ledger: LedgerRow[], holdingsValue: number): boolean {
  if (holdingsValue <= 0) return true; // nothing to explain

  const hasPurchases = ledger.some((t) => t.type === 'BUY' || t.type === 'TRANSFER');
  return hasPurchases;
}

function sumWhere(ledger: LedgerRow[], type: string): number {
  return ledger
    .filter((t) => t.type === type)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
}

/**
 * Realized gain, from the ledger, using average cost.
 *
 * A SELL's realized gain is `proceeds − (avg cost at the time of sale × qty)`.
 * The average cost has to be tracked as the ledger is walked, because it moves
 * with every subsequent BUY — computing it from today's `Holding.averageCost`
 * would price a 2024 sale at a 2026 cost basis.
 *
 * FIFO would be the other defensible choice and would give a different number
 * on a book with multiple lots. Average cost is used because it is what
 * `Holding.averageCost` already represents, so the two cannot disagree.
 */
export function realizedGain(ledger: LedgerRow[]): number {
  const lots = new Map<string, { qty: number; cost: number }>();
  let realized = 0;

  const sorted = [...ledger].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const t of sorted) {
    if (!t.ticker) continue;
    const lot = lots.get(t.ticker) ?? { qty: 0, cost: 0 };

    if (t.type === 'BUY' && t.quantity) {
      lot.qty += t.quantity;
      lot.cost += Math.abs(t.amount);
      lots.set(t.ticker, lot);
    }

    if (t.type === 'SELL' && t.quantity && lot.qty > 0) {
      const avgCost = lot.cost / lot.qty;
      const sold = Math.min(t.quantity, lot.qty);

      realized += Math.abs(t.amount) - avgCost * sold;

      lot.qty -= sold;
      lot.cost -= avgCost * sold;
      lots.set(t.ticker, lot);
    }

    // A split multiplies the share count and leaves the total cost alone, so the
    // per-share average cost falls. Skipping this makes a post-split sale look
    // like a windfall.
    if (t.type === 'SPLIT' && t.quantity && lot.qty > 0) {
      lot.qty *= t.quantity;
      lots.set(t.ticker, lot);
    }
  }

  return realized;
}

/**
 * Portfolio turnover, SEC / mutual-fund convention:
 *
 *     turnover = min(purchases, sales) / average portfolio value
 *
 * The `min` is the whole point. Using purchases alone — or purchases + sales —
 * makes a client who is simply funding a new account read as a frantic trader:
 * deposit $500k, buy $500k of stock, never sell, and a naive formula reports
 * 100% turnover on a book that has not traded at all. Taking the lesser of the
 * two measures round-trips, which is what turnover is actually asking about.
 *
 * The denominator is the average of beginning and ending value. A daily-average
 * NAV would be more precise, but it needs the valuation series, and this figure
 * does not warrant gating on it.
 */
export function portfolioTurnover(
  ledger: LedgerRow[],
  beginningValue: number,
  endingValue: number,
): number | null {
  const purchases = sumWhere(ledger, 'BUY');
  const sales = sumWhere(ledger, 'SELL');

  const avgValue = (beginningValue + endingValue) / 2;
  if (avgValue <= 0) return null;

  return Math.min(purchases, sales) / avgValue;
}

export interface PerformerRow {
  ticker: string;
  company: string;
  unrealizedPnl: number;
  /** Return on cost. Null when cost basis is zero — a bonus issue, typically. */
  returnPct: number | null;
  marketValue: number;
}

/**
 * Best and worst performer, ranked by return on cost rather than by dollar P&L.
 *
 * Ranking by dollars just re-discovers the largest position: a 2% gain on a
 * $100k holding beats a 40% gain on a $3k one, and calling the former the "best
 * performer" tells the reader nothing they did not already know from the
 * weights. Percentage is the honest answer to "what worked".
 *
 * Positions with no cost basis are excluded rather than ranked as infinite.
 */
export function performers(snap: PortfolioSnapshot): {
  best: PerformerRow | null;
  worst: PerformerRow | null;
  ranked: PerformerRow[];
} {
  const rows: PerformerRow[] = snap.positions.map((p) => ({
    ticker: p.ticker,
    company: p.company,
    unrealizedPnl: p.unrealizedPnl,
    returnPct: p.costBasisTotal > 0 ? p.unrealizedPnl / p.costBasisTotal : null,
    marketValue: p.marketValue,
  }));

  const rankable = rows
    .filter((r) => r.returnPct !== null)
    .sort((a, b) => b.returnPct! - a.returnPct!);

  return {
    best: rankable[0] ?? null,
    worst: rankable.length > 1 ? rankable[rankable.length - 1] : null,
    ranked: rankable,
  };
}

/**
 * Cash drag: the return given up by holding cash instead of being invested.
 *
 *     drag = cashWeight × (portfolioReturn − cashReturn)
 *
 * Reported as a NEGATIVE number when cash cost the client money, which is the
 * ordinary case in a rising market — the sign should tell the reader which way
 * it went without them having to remember a convention.
 *
 * Note that drag is POSITIVE when the portfolio fell: cash protected the client,
 * and a "cash drag" that helped is a real and worth-showing outcome. A formula
 * that only ever reports a penalty is not measuring, it is editorialising.
 *
 * `cashReturn` defaults to 0 rather than to a T-bill yield. Idle brokerage cash
 * genuinely earns nothing in most of these accounts, and quietly crediting it
 * with 5% would understate the drag — the direction that flatters.
 */
export function cashDrag(
  cash: number,
  totalAssets: number,
  portfolioReturn: number,
  cashReturn = 0,
): number | null {
  if (totalAssets <= 0) return null;
  const cashWeight = cash / totalAssets;
  return -cashWeight * (portfolioReturn - cashReturn);
}

export interface FlowTotals {
  netDeposits: number;
  netWithdrawals: number;
  /** deposits − withdrawals: the money the client is actually out of pocket. */
  netContribution: number;
  dividendIncome: number;
  fees: number;
  purchases: number;
  sales: number;
}

export function flowTotals(ledger: LedgerRow[]): FlowTotals {
  const netDeposits = sumWhere(ledger, 'CASH_DEPOSIT');
  const netWithdrawals = sumWhere(ledger, 'CASH_WITHDRAWAL');

  return {
    netDeposits,
    netWithdrawals,
    netContribution: netDeposits - netWithdrawals,
    dividendIncome: sumWhere(ledger, 'DIVIDEND'),
    fees: sumWhere(ledger, 'FEES'),
    purchases: sumWhere(ledger, 'BUY'),
    sales: sumWhere(ledger, 'SELL'),
  };
}

/**
 * Absolute return: total gain over the capital that produced it.
 *
 * This is deliberately NOT the same as the XIRR-derived interim return, and the
 * two will disagree — often by a lot. Absolute return ignores WHEN the money
 * arrived; XIRR does not. A client who wired in most of their capital last week
 * has a small absolute return and can still have a large annualized XIRR, and
 * both statements are true.
 *
 * Both are shown on the sheet, labelled, because showing only one invites the
 * reader to assume it answers the other's question.
 */
export function absoluteReturn(totalGain: number, investedCapital: number): number | null {
  if (investedCapital <= 0) return null;
  return totalGain / investedCapital;
}

/**
 * Annualized return from the absolute return and the holding period.
 *
 *     annualized = (1 + absolute) ^ (365 / days) − 1
 *
 * Returns null below 30 days. Annualizing a 3-day return extrapolates a week's
 * noise into a yearly rate and produces figures like "+840% annualized" that are
 * arithmetically correct and completely meaningless. The XIRR is the number to
 * read on a young account, and it is reported alongside.
 */
export function annualizedReturn(absolute: number, days: number): number | null {
  if (days < 30) return null;
  if (absolute <= -1) return null; // total loss: no real root
  return (1 + absolute) ** (365 / days) - 1;
}

/** Sum of the negative (money-in) flows — the capital the client put to work. */
export function investedCapital(flows: CashFlow[]): number {
  return flows.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0);
}

/** Realized proceeds: the positive flows, EXCLUDING the terminal value. */
export function realizedProceeds(flows: CashFlow[], asOf: Date): number {
  return flows
    .filter((f) => f.amount > 0 && f.date.getTime() !== asOf.getTime())
    .reduce((s, f) => s + f.amount, 0);
}
