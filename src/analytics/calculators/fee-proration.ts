import { isImportArtifact } from './flows';

/**
 * Prorating a quarterly management fee over capital deployed mid-quarter.
 *
 * THE PROBLEM THIS SOLVES. The original basis was a single number: quarter-end
 * NAV x rate/4, prorated only by the mandate's inception date. A client who
 * deployed fresh capital on the last day of the quarter was billed a FULL
 * quarter's fee on it, because quarter-end NAV cannot express how long the
 * money was actually there. On a 2% mandate a 50L deployment made on 11-Sep of
 * a 92-day quarter was billed ~25,000 instead of ~5,435 - a ~19,500 overcharge
 * on one trade.
 *
 * THE BASIS. Fees follow the same ledger rows the client's XIRR follows: BUY
 * and SELL, the TRANSACTIONAL method. This is deliberate and it is the firm's
 * stated methodology - the client is billed on capital AT WORK, measured the
 * same way the manager's own return is measured. Cash handed over but not yet
 * deployed is not billed; it starts billing on the day it is put to work.
 *
 *   fee = openingValue x (rate/4) x inceptionDays/daysInQuarter
 *       + SUM over flows [ netAmount x (rate/4) x daysRemaining/daysInQuarter ]
 *
 * Equivalent to splitting the quarter into segments at each flow date and
 * billing each segment for its own days, but expressed as a base plus
 * increments so that the pre-existing inception proration stays the FIRST TERM
 * of the same sum rather than a special case bolted alongside it.
 *
 * WHY PURE. No database, no clock, no Prisma types. The fee is the number a
 * client disputes, so the arithmetic has to be testable on its own - the same
 * reasoning that put the flow-building rules in flows.ts as a pure function.
 */

/** The subset of a Transaction row the fee proration needs. */
export interface FeeLedgerEntry {
  type: string;
  amount: number;
  date: Date;
}

/**
 * One billed component of a fee: the opening book, or one day's net deployment.
 *
 * Persisted alongside the frozen fee so a closed invoice can still be explained
 * line by line months later. A fee the client cannot have broken down for them
 * is a fee they cannot be argued out of disputing.
 */
export interface FeeSegment {
  /** ISO date this component started billing from. */
  from: string;
  /** 'opening' for the book carried into the quarter, 'flow' for a deployment. */
  kind: 'opening' | 'flow';
  /**
   * The capital this component bills on. Negative for a net SELL day, which
   * REDUCES the fee for the remainder of the quarter.
   */
  amount: number;
  /** Days from `from` through the billing end, inclusive. */
  days: number;
  /** amount x (rate/100/4) x days/daysInQuarter. */
  fee: number;
}

export interface ProratedFee {
  /** The sum of every segment's fee. May be 0, never negative. */
  feeAmount: number;
  /** The opening book the first segment billed on. */
  openingValue: number;
  /**
   * Capital the fee was ultimately charged against: opening plus net flows.
   * This is the figure the fee table shows as "portfolio value" - what the
   * client ended the period with, in billing terms.
   */
  billableValue: number;
  segments: FeeSegment[];
  /** Days the OPENING book was billed for - the mandate-inception proration. */
  daysBilled: number;
  daysInQuarter: number;
}

export interface ProrationInput {
  /** Portfolio value at the quarter's start, before any of this quarter's flows. */
  openingValue: number;
  /** This quarter's ledger rows. Filtered and netted internally. */
  ledger: FeeLedgerEntry[];
  /** Annual fee rate as a percent, e.g. 2 for 2%. */
  feeRatePercent: number;
  quarterStart: Date;
  quarterEnd: Date;
  /** The mandate's start. Bills from the later of this and quarterStart. */
  inceptionDate: Date;
  /**
   * Last day to bill. Quarter end for a closed quarter; today for an open one,
   * so a running estimate never bills days that have not happened yet.
   */
  billingEnd: Date;
}

/**
 * BUY deploys capital, SELL returns it. Nothing else moves the billable base.
 *
 * DIVIDEND and FEES are deliberately absent even though flows.ts counts them
 * for XIRR. They are cash arriving or leaving as a CONSEQUENCE of the book, not
 * the client deciding to put capital to work or take it off the table - and
 * billing a client for the dividend their own holdings paid, then again next
 * quarter through the higher NAV, double-dips. The corporate-action cash types
 * are out for the same reason.
 */
const DEPLOYMENT_TYPES = new Set(['BUY', 'SELL']);

/** Money leaving the deployed book reduces the base it is billed on. */
const SIGN: Record<string, number> = { BUY: +1, SELL: -1 };

/**
 * Drops the part of each BUY that merely spends cash the client had already
 * handed over before the quarter began.
 *
 * WHY THIS IS NEEDED. The opening value is the whole portfolio — securities
 * AND uninvested cash. So a client who funded in advance and deployed inside
 * the quarter is represented twice: once as opening cash, once as the BUY that
 * spends it. Billing both charges the same rupee twice.
 *
 * Buys are absorbed oldest-first, because that is the order the cash is
 * actually spent in. Only the excess over the opening cash is new capital and
 * bills as a flow. A BUY that lands exactly on the opening cash contributes
 * nothing, which is correct: that money was already billed in the opening book.
 *
 * SELLs pass through untouched. A sale returns money to the cash sleeve rather
 * than drawing it down, and the opening book it reduces was billed in full — so
 * absorbing it would quietly re-bill capital the client no longer has invested.
 *
 * Pure, and separate from `computeProratedFee`, because "which rupees are new"
 * is a different question from "how many days was each rupee at work", and the
 * first is the one most likely to need revisiting.
 */
export function absorbPrefundedCash<T extends FeeLedgerEntry>(
  ledger: T[],
  openingCash: number,
): FeeLedgerEntry[] {
  if (!(openingCash > 0)) return ledger;

  let remaining = openingCash;
  const ordered = [...ledger].sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: FeeLedgerEntry[] = [];

  for (const row of ordered) {
    if (row.type !== 'BUY' || remaining <= 0) {
      out.push(row);
      continue;
    }

    const spent = Math.abs(row.amount);
    const absorbed = Math.min(spent, remaining);
    remaining -= absorbed;

    const excess = spent - absorbed;
    if (excess > 0) out.push({ ...row, amount: excess });
  }

  return out;
}

export function computeProratedFee(input: ProrationInput): ProratedFee {
  const {
    openingValue,
    ledger,
    feeRatePercent,
    quarterStart,
    quarterEnd,
    inceptionDate,
    billingEnd,
  } = input;

  const daysInQuarter = diffDays(quarterStart, quarterEnd) + 1;
  const quarterlyRate = feeRatePercent / 100 / 4;

  // Bill from the later of (quarter start, inception): a mandate that began
  // mid-quarter owes only the days it actually existed for. Preserved verbatim
  // from the original single-NAV basis - it was correct, it was just the only
  // proration there was.
  const day = (d: Date) => utcDay(d);
  const billingStart =
    day(inceptionDate) > quarterStart ? day(inceptionDate) : quarterStart;
  const end = day(billingEnd);

  const daysBilled = clamp(diffDays(billingStart, end) + 1, 0, daysInQuarter);

  const segments: FeeSegment[] = [];

  if (openingValue !== 0 && daysBilled > 0) {
    segments.push({
      from: toIsoDate(billingStart),
      kind: 'opening',
      amount: openingValue,
      days: daysBilled,
      fee: openingValue * quarterlyRate * (daysBilled / daysInQuarter),
    });
  }

  for (const flow of netDailyFlows(ledger, billingStart, end)) {
    // Inclusive of the flow date itself: capital deployed on the 11th is at
    // work on the 11th.
    const days = clamp(diffDays(flow.date, end) + 1, 0, daysInQuarter);
    if (days === 0) continue;

    segments.push({
      from: toIsoDate(flow.date),
      kind: 'flow',
      amount: flow.amount,
      days,
      fee: flow.amount * quarterlyRate * (days / daysInQuarter),
    });
  }

  const feeAmount = segments.reduce((sum, s) => sum + s.fee, 0);
  const billableValue = segments.reduce((sum, s) => sum + s.amount, 0);

  return {
    // A book sold down harder than it opened can drive the arithmetic negative.
    // The firm does not invoice a negative fee, and it does not carry the
    // credit forward either - it bills nothing.
    feeAmount: Math.max(0, feeAmount),
    openingValue,
    billableValue,
    segments,
    daysBilled,
    daysInQuarter,
  };
}

/**
 * Ledger rows to one signed amount per day.
 *
 * Same-day netting is what makes a REBALANCE billing-neutral: selling 10L of A
 * and buying 10L of B on one day nets to zero, so a manager reshuffling the
 * book never generates a fee. Without netting, the BUY would bill and the SELL
 * would credit at the same rate - arithmetically identical here, but only
 * because both land on the same day. Netting states the intent rather than
 * relying on the cancellation.
 *
 * Rows outside [billingStart, end] are dropped: a trade made before the mandate
 * began, or after the billing cutoff, is not this quarter's business.
 */
function netDailyFlows(
  ledger: FeeLedgerEntry[],
  billingStart: Date,
  end: Date,
): Array<{ date: Date; amount: number }> {
  const byDay = new Map<number, number>();

  for (const row of ledger) {
    if (!DEPLOYMENT_TYPES.has(row.type)) continue;

    /**
     * The 1-July bulk-import artifacts are NOT trades.
     *
     * The legacy book was imported with every pre-existing position written as
     * a fresh BUY stamped 2026-07-01 - shares actually accumulated over years
     * before that. Q3-CY26 starts 1 July, so those rows land inside the current
     * quarter and would read as the entire book being deployed on day one, on
     * top of the opening value that already represents them. Reusing flows.ts's
     * predicate rather than restating the cutoff date: these two must agree,
     * and two copies of a date eventually will not.
     */
    if (isImportArtifact(row)) continue;

    const d = utcDay(row.date);
    if (d < billingStart || d > end) continue;

    const signed = Math.abs(row.amount) * (SIGN[row.type] ?? 0);
    byDay.set(d.getTime(), (byDay.get(d.getTime()) ?? 0) + signed);
  }

  return [...byDay.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([time, amount]) => ({ date: new Date(time), amount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

const MS_PER_DAY = 86_400_000;

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function diffDays(from: Date, to: Date): number {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / MS_PER_DAY);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
