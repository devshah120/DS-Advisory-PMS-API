/**
 * Dividend entitlement: who is owed what on a cash distribution, measured on
 * the shares each client actually held when the stock went ex.
 *
 * This replaces DividendProcessor's old rule of paying on today's Holding
 * quantity. That rule was wrong for anyone who traded between the ex-date and
 * processing. The scheduler processes on the action's effective date, and FMP
 * sets a dividend's effective date to its PAY date, usually two to four weeks
 * after the ex-date. So that gap exists for every dividend, not just stale ones.
 *
 * ── Who is entitled ─────────────────────────────────────────────────────────
 *
 * Whoever held the shares at the close of the last session before the ex-date.
 * Under T+1 settlement (India since 2023, the US since May 2024) the ex-date is
 * the record date, so that means: shares bought on a trade date BEFORE the
 * ex-date, minus shares sold before it. A seller ON the ex-date keeps the
 * dividend; a buyer on it does not get it.
 *
 * The test is `tradeDay < exDay` on calendar days rather than "the day before".
 * The eve of a Monday ex-date is the previous Friday, and a calendar-day rule
 * gets that right without a holiday table.
 *
 * ── Splits ──────────────────────────────────────────────────────────────────
 *
 * The ledger already holds every processed split and bonus as a SPLIT, BONUS
 * or REVERSE_SPLIT row carrying the share DELTA. The running balance passes
 * through a split by replaying that row. Multiplying by a provider's split
 * factor as well would apply the split twice. So provider split events are
 * used to CHECK the ledger, never to adjust it. If a client held through a
 * split and no row records it, either the split was never processed (the
 * holding is still pre-split) or it was applied to the holding by hand. Either
 * way the share count is unreliable, so the entitlement is BLOCKED instead of
 * being paid at half (or double).
 *
 * ── Anchoring ───────────────────────────────────────────────────────────────
 *
 * A forward replay from zero assumes the ledger is complete, and on this book
 * it is not always: some positions' ledgers do not add up to their Holding
 * (duplicate import rows, hand-edited lots). When the caller passes today's
 * quantity, the balance is worked backwards from it: eve = today minus every
 * row on or after the ex-date. On a clean ledger that gives the same answer as
 * a forward replay. On a dirty one it depends only on rows since the ex-date.
 * `jun30Quantities` in flows.ts uses the same convention.
 */
import type { Market } from '@prisma/client';
import { LedgerEntry, shareDelta } from '../analytics/calculators/flows';
import { istDay } from '../holdings/ledger-replay';
import { normalize } from './ratio';

/** A calendar day, `YYYY-MM-DD`, in the trading calendar of the client's market. */
export type DayKey = string;

const MS_PER_DAY = 86_400_000;
/** IST midnight, as milliseconds into the UTC day before it (18:30Z). */
const IST_MIDNIGHT_AS_UTC_MS = (18 * 60 + 30) * 60 * 1000;
const SHARE_EPSILON = 1e-9;

/** Row types a split can be recorded as. The desk keys bonus issues as SPLIT and vice versa, so any of the three counts. */
const SPLIT_ROW_TYPES = new Set(['SPLIT', 'BONUS', 'REVERSE_SPLIT']);

/**
 * How far a split's ledger row may be from the split's ex-date and still count
 * as that split's row. The engine stamps rows with the action's effective
 * date, and for an Indian bonus that can be the allotment date, a few sessions
 * after the ex-date.
 */
const SPLIT_MATCH_DAYS = 10;

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The trading day a stored instant belongs to.
 *
 * Date-only entries are stored either at UTC midnight or at IST midnight
 * (18:30Z the evening before), and `istDay` maps both to the intended date.
 * Comparing raw UTC days instead would move every IST-midnight buy dated ON
 * the ex-date to the day before, making it wrongly eligible. Any other instant
 * is a real timestamp, so it is read in the exchange's own timezone: a US fill
 * at 15:45 New York time is 01:15 IST the next day.
 */
export function tradeDay(date: Date, market: Market): DayKey {
  const intoUtcDay = ((date.getTime() % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const dateOnly = intoUtcDay === 0 || intoUtcDay === IST_MIDNIGHT_AS_UTC_MS;
  return dateOnly || market === 'INDIA' ? istDay(date) : NEW_YORK_DAY.format(date);
}

// ── Eligible shares ─────────────────────────────────────────────────────────

/** The subset of a Transaction row the replay needs. */
export interface EntitlementLedgerRow {
  ticker: string | null;
  type: string;
  quantity: number | null;
  date: Date;
}

export interface SplitEvent {
  ticker: string;
  exDate: Date;
  /**
   * Shares after, per share before: 2 for a 2-for-1 split or a 1:1 bonus, 0.1
   * for a 1-for-10 reverse split. Null when the source gives no usable ratio:
   * the split must still be found in the ledger, there is just nothing to
   * check the row's size against.
   */
  multiplier: number | null;
}

export interface Eligibility {
  /** Shares held at the close before the ex-date. */
  shares: number;
  /** BLOCKED when the ledger cannot support the figure; nothing may be paid on it. */
  status: 'OK' | 'BLOCKED';
  notes: string[];
}

export function sharesHeldOnEve(input: {
  /** The client's rows. Other tickers are ignored. */
  rows: readonly EntitlementLedgerRow[];
  ticker: string;
  exDate: Date;
  market: Market;
  /** Provider split and bonus events for the ticker. Used to check the ledger, never to adjust it. */
  splits?: readonly SplitEvent[];
  /** Shares held today (0 for a former holder). Omit to replay forward from the first row. */
  anchorQuantity?: number;
  /** The date `anchorQuantity` is as of. Defaults to now. */
  anchorDate?: Date;
}): Eligibility {
  const { ticker, market } = input;
  const exDay = tradeDay(input.exDate, market);
  const anchored = input.anchorQuantity !== undefined;
  const anchorDay = tradeDay(input.anchorDate ?? new Date(), market);

  const moves = input.rows
    .filter((r) => r.ticker === ticker)
    .map((r) => ({ type: r.type, day: tradeDay(r.date, market), delta: shareDelta(r) }))
    .filter((m) => m.delta !== 0);

  const ledgerTotal = sum(moves.map((m) => m.delta));
  const drift = anchored ? input.anchorQuantity! - ledgerTotal : 0;
  const ledgerBefore = (day: DayKey) => sum(moves.filter((m) => m.day < day).map((m) => m.delta));
  const heldBefore = (day: DayKey) => drift + ledgerBefore(day);

  const notes: string[] = [];
  let blocked = false;

  if (Math.abs(drift) > 1e-6) {
    notes.push(
      `Ledger rows add up to ${fmt(ledgerTotal)} shares but the holding is ${fmt(input.anchorQuantity!)}; ` +
        'entitlement is worked back from the holding.',
    );
  }

  for (const split of input.splits ?? []) {
    if (split.ticker !== ticker) continue;
    const splitDay = tradeDay(split.exDate, market);
    // Replayed forward, the eve is built from the first row up, so only a split
    // before the ex-date affects it. Worked back from today, it is today's
    // holding minus every later row, so a split after the ex-date matters just
    // as much: its row is what takes the post-split shares back out.
    if (anchored ? splitDay > anchorDay : splitDay >= exDay) continue;

    const recorded = moves.filter(
      (m) => SPLIT_ROW_TYPES.has(m.type) && Math.abs(daysBetween(m.day, splitDay)) <= SPLIT_MATCH_DAYS,
    );
    // Shares the ledger's own rows carried into the split, minus the split's
    // row if that was stamped early. Untracked shares (the drift) are left out:
    // nothing is known about when they were bought, so they cannot show that a
    // split row is missing.
    const early = sum(recorded.filter((m) => m.day < splitDay).map((m) => m.delta));
    const carried = ledgerBefore(splitDay) - early;
    if (carried <= SHARE_EPSILON) continue;

    if (recorded.length === 0) {
      blocked = true;
      notes.push(
        `Held ${fmt(carried)} shares into the split on ${splitDay}, but no SPLIT or BONUS row records it, ` +
          'so the ledger and the holding cannot both be right about the share count. Process the split ' +
          'first, then this dividend.',
      );
      continue;
    }

    if (split.multiplier === null) continue;
    // Not a block: ROUND_DOWN and CASH_IN_LIEU legitimately issue less than a share short.
    const before = carried + drift;
    const expected = before * (split.multiplier - 1);
    const got = sum(recorded.map((m) => m.delta));
    if (Math.abs(got - expected) >= 1) {
      notes.push(
        `The split row near ${splitDay} adds ${fmt(got)} shares; ${fmt(before)} held × ${fmt(split.multiplier)} ` +
          `implies ${fmt(expected)}. Check the split before relying on this figure.`,
      );
    }
  }

  let shares = normalize(heldBefore(exDay));
  if (Math.abs(shares) < SHARE_EPSILON) shares = 0;
  if (shares < 0) {
    blocked = true;
    notes.push(`The ledger shows ${fmt(shares)} shares on the eve of ${exDay}: more sold than bought. A row is missing.`);
  }

  return { shares, status: blocked ? 'BLOCKED' : 'OK', notes };
}

// ── Per-share amount and cash ───────────────────────────────────────────────

/**
 * AS_PAID: the amount actually declared per share on the ex-date (FMP's
 * `dividend`, and every CorporateAction row).
 * SPLIT_ADJUSTED: restated for splits that came later (Yahoo's chart
 * `events.div`, FMP's `adjDividend`). Yahoo lists AAPL's Feb-2020 dividend as
 * 0.1925, which is the real 0.77 divided by the 4-for-1 split that August.
 */
export type DpsBasis = 'AS_PAID' | 'SPLIT_ADJUSTED';

/**
 * Converts a per-share amount to what was actually paid per share held on the
 * ex-date. A split-adjusted figure is multiplied back up by every split AFTER
 * the ex-date. Yahoo applies all later splits but only returns the split
 * events inside the requested window, so `splits` must run through today.
 */
export function asPaidPerShare(
  event: { ticker: string; exDate: Date; perShare: number; basis?: DpsBasis },
  splits: readonly SplitEvent[],
  market: Market,
): number {
  if ((event.basis ?? 'AS_PAID') === 'AS_PAID') return event.perShare;
  const exDay = tradeDay(event.exDate, market);
  let dps = event.perShare;
  for (const s of splits) {
    if (s.ticker !== event.ticker || tradeDay(s.exDate, market) <= exDay) continue;
    if (s.multiplier === null) {
      throw new RangeError(
        `${event.ticker}: cannot restate a split-adjusted dividend through a split with no ratio.`,
      );
    }
    dps *= s.multiplier;
  }
  return normalize(dps);
}

export interface Settlement {
  gross: number;
  withheld: number;
  /** The cash that actually arrives. */
  net: number;
}

/**
 * Gross, tax withheld at source and net, each rounded to the cent or paisa
 * actually credited. Net is gross minus withheld, so the three always add up
 * on a statement.
 */
export function settle(shares: number, perShare: number, withholdingRate = 0): Settlement {
  if (!Number.isFinite(perShare) || perShare < 0) {
    throw new RangeError(`Dividend per share must be a non-negative amount; got ${perShare}.`);
  }
  if (!Number.isFinite(withholdingRate) || withholdingRate < 0 || withholdingRate >= 1) {
    throw new RangeError(`Withholding rate is a fraction in [0, 1); got ${withholdingRate}.`);
  }
  const gross = money(shares * perShare);
  const withheld = money(gross * withholdingRate);
  return { gross, withheld, net: money(gross - withheld) };
}

// ── One client, many events ─────────────────────────────────────────────────

export interface DividendEvent {
  ticker: string;
  exDate: Date;
  /** When the cash lands. Falls back to the ex-date when the source gives none (Yahoo gives none). */
  payDate?: Date | null;
  perShare: number;
  /** Defaults to AS_PAID. */
  basis?: DpsBasis;
}

export interface DividendEntitlement {
  ticker: string;
  exDate: Date;
  payDate: Date;
  eligibleShares: number;
  /** As paid, after undoing any split adjustment. */
  perShare: number;
  withholdingRate: number;
  gross: number;
  withheld: number;
  net: number;
  status: 'PAYABLE' | 'BLOCKED';
  notes: string[];
}

export interface ClientDividendOptions {
  dividends: readonly DividendEvent[];
  market: Market;
  /** Every split and bonus for these tickers. Must run through today if any event is SPLIT_ADJUSTED. */
  splits?: readonly SplitEvent[];
  /** Fraction withheld at source (0.25 = 25%). Default 0. */
  withholdingTaxRate?: number;
  /**
   * ticker → shares held today. When given, each balance is worked back from
   * this figure (see Anchoring above), and a ticker missing from the map counts
   * as zero held. Omit it to replay forward from the client's first row.
   */
  currentQuantities?: ReadonlyMap<string, number>;
}

export interface ClientDividendResult {
  /** Every event paid inside the window that the client was entitled to, sorted by pay date. */
  entitlements: DividendEntitlement[];
  /**
   * The PAYABLE entitlements as ledger entries, ready to sit beside the rest of
   * the ledger in `buildFlows` / `buildWindowFlows`.
   *
   * The type is DIVIDEND, not a new CASH_DIVIDEND. `isFlowType` only knows
   * DIVIDEND, so any other type would be silently left out of every XIRR series.
   *
   * The amount is NET cash, dated on the pay date, and positive. In flows.ts a
   * positive amount is money going OUT of the portfolio to the client. A
   * dividend is not a contribution: recorded as one, it would subtract itself
   * from the return under both XIRR and Modified Dietz.
   */
  cashFlows: LedgerEntry[];
}

/**
 * What a client was owed on every dividend PAID between `startDate` and
 * `endDate` inclusive. The window is keyed on pay date because that is when the
 * cash moves. Eligibility is still measured on the eve of each ex-date, which
 * may be before the window opens.
 */
export function calculateClientDividends(
  transactionHistory: readonly EntitlementLedgerRow[],
  startDate: Date,
  endDate: Date,
  options: ClientDividendOptions,
): ClientDividendResult {
  const { market, splits = [], withholdingTaxRate = 0 } = options;
  const from = tradeDay(startDate, market);
  const to = tradeDay(endDate, market);

  const entitlements: DividendEntitlement[] = [];

  for (const event of options.dividends) {
    const payDate = event.payDate ?? event.exDate;
    const payDay = tradeDay(payDate, market);
    if (payDay < from || payDay > to) continue;

    const eligibility = sharesHeldOnEve({
      rows: transactionHistory,
      ticker: event.ticker,
      exDate: event.exDate,
      market,
      splits,
      anchorQuantity: options.currentQuantities
        ? (options.currentQuantities.get(event.ticker) ?? 0)
        : undefined,
    });
    // No shares, nothing owed: no zero-amount row for every report to skip over.
    if (eligibility.status === 'OK' && eligibility.shares === 0) continue;

    const perShare = asPaidPerShare(event, splits, market);
    const { gross, withheld, net } = settle(eligibility.shares, perShare, withholdingTaxRate);

    entitlements.push({
      ticker: event.ticker,
      exDate: event.exDate,
      payDate,
      eligibleShares: eligibility.shares,
      perShare,
      withholdingRate: withholdingTaxRate,
      gross,
      withheld,
      net,
      status: eligibility.status === 'OK' ? 'PAYABLE' : 'BLOCKED',
      notes: eligibility.notes,
    });
  }

  entitlements.sort(
    (a, b) =>
      a.payDate.getTime() - b.payDate.getTime() ||
      a.exDate.getTime() - b.exDate.getTime() ||
      a.ticker.localeCompare(b.ticker),
  );

  const cashFlows: LedgerEntry[] = entitlements
    .filter((e) => e.status === 'PAYABLE')
    .map((e) => ({ type: 'DIVIDEND', amount: e.net, date: e.payDate }));

  return { entitlements, cashFlows };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_DAY);
}

/** Rounded to the cent. Goes through toFixed first so 1.005 rounds up to 1.01, not down to 1.00. */
function money(value: number): number {
  return Math.round(Number((value * 100).toFixed(6))) / 100;
}

function fmt(n: number): string {
  return String(normalize(n));
}
