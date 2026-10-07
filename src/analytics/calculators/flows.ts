import { CashFlow } from './xirr';

/**
 * Turning a transaction ledger into an XIRR cash-flow series.
 *
 * XIRR does not care where a number came from — it solves whatever series it is
 * handed. So the ONLY thing that distinguishes a "transactional" client from a
 * "cash-flow" client is which ledger rows become flows, and with what sign. That
 * decision lives here, as a pure function, because it is the decision most likely
 * to be got wrong and the one most worth testing without a database attached.
 *
 * Sign convention (shared with xirr.ts and the workbook):
 *   negative = money INTO the portfolio  (a contribution / a purchase)
 *   positive = money OUT of the portfolio (a withdrawal / a sale / terminal value)
 */

export type AccountingMethod = 'TRANSACTIONAL' | 'CASH_FLOW';

/** The subset of a Transaction row the flow builder needs. */
export interface LedgerEntry {
  type: string;
  amount: number;
  date: Date;
}

/** The subset of a Transaction row `rebaseLedgerToJun30` needs — `LedgerEntry` plus ticker/quantity. */
export interface RebaseLedgerEntry extends LedgerEntry {
  ticker: string | null;
  quantity: number | null;
}

export type FlowBuildResult =
  | { status: 'ok'; flows: CashFlow[] }
  | { status: 'insufficient'; reason: string };

/**
 * 30-June-2026 cost rebasing — the single source of truth for it.
 *
 * Every client's reported performance starts on 1-July-2026, opening on the
 * 30-June-2026 close. This is a house-wide policy, applied to EVERY client:
 *
 *   • For the bulk-imported book it is the only option. The trade ledger was
 *     imported with every BUY stamped 2026-07-01, though the positions were
 *     accumulated over 2–3 prior years we have no history for, and XIRR on a
 *     multi-year gain squeezed into a ~3-week window blew up into thousands of
 *     percent.
 *   • For a client with genuine earlier history (a mandate that began
 *     16-Dec-2025, say) it is a deliberate choice: their pre-July record is
 *     rolled up into an opening position rather than reported, so every book
 *     in the house is measured over the same window from the same base.
 *
 * It is a PURE transform so the two callers that need it — the Performance service
 * and the Clients-list `deriveMetrics` — go through the identical logic and cannot
 * drift apart (they already drifted once, which is the entire reason this lives in
 * one place). Each caller supplies the 30-June closes it has fetched.
 *
 *   • Every pre-baseline row (`isPreBaseline`) is dropped — BUYs, SELLs,
 *     dividends, fees, corporate actions alike. Their effect survives only as
 *     the position they left behind on 30-June.
 *   • Each position held at the 30-June close becomes ONE synthetic BUY on
 *     2026-06-30 at that day's close × the quantity held then; a missing close
 *     falls back to the pre-baseline average purchase cost.
 *   • Every row after the baseline passes through untouched.
 *
 * The result is fed to `buildFlows`, whose existing same-day BUY netting collapses
 * all the synthetic buys into a single inception flow.
 */
export const JUN30_REBASE_DATE = new Date('2026-06-30T00:00:00.000Z');

/**
 * The house inception date. Every client's reported history starts here: the
 * 30-June-2026 portfolio value is the base for since-inception XIRR, and it is
 * also the opening value of the quarter (Q2 CY26 close / Q3 CY26 open), which is
 * why a QTD figure computed today lands on the same base as inception.
 *
 * Aliased to JUN30_REBASE_DATE rather than redeclared: the rebase date and the
 * inception date are the same instant by design, and two constants that must
 * stay equal are two constants that will eventually drift.
 */
export const INCEPTION_DATE = JUN30_REBASE_DATE;

/**
 * The last date carrying bulk-import artifacts.
 *
 * The legacy book was imported with every pre-existing position written as a
 * fresh BUY stamped 2026-07-01, even though those shares had been held for years.
 * They are not trades — they are the opening position wearing a transaction's
 * clothing, and the 30-June baseline already represents them in full.
 *
 * Anything on or before this date is therefore part of INCEPTION, not activity
 * since it. Replaying such a row on top of the baseline books the same purchase
 * twice: once as the baseline's shares, once as a cash outflow that never
 * happened. That is precisely what drove reconstructed cash to −25,596 on a
 * client whose real balance is zero, and — because portfolioValue = holdings +
 * cash — corrupted every weight and the sector allocation computed from it.
 */
export const IMPORT_CUTOVER_DATE = new Date('2026-07-01T23:59:59.999Z');

/**
 * Is this ledger row a bulk-import artifact that the client's baseline already
 * accounts for?
 *
 * Only BUY rows qualify. A SELL, DIVIDEND or FEES row dated in the same window is
 * a real event that the baseline does NOT represent — the baseline is a position
 * snapshot, not a cash history — so those must still replay.
 *
 * The artifact concept only exists for clients swept up in the ORIGINAL bulk
 * import — the ones whose `PortfolioBaseline.baselineDate` is the shared house
 * date (`INCEPTION_DATE`). For any other client — one onboarded afterward with
 * no legacy position, whose baseline is empty and dated at their own first
 * transaction — nothing was ever bulk-imported, so nothing is an artifact:
 * every one of their BUYs is a real trade, no matter what calendar date it
 * happens to fall on.
 *
 * `isHouseBaseline` therefore gates the whole check, not just the cutover
 * date. Passing `false` (or omitting it for a client with a distinct
 * baseline) makes this always return false — the fixed 2026-07-01 date must
 * never be applied to a client whose baseline isn't the one it describes.
 * Getting this backwards is exactly what silently dropped Abhishek Oberoi's
 * ~₹14L of December-2025 purchases: they fell before the house cutover date
 * by coincidence of calendar, not because his baseline represented them.
 */
export function isImportArtifact(
  row: { type: string; date: Date },
  isHouseBaseline = true,
): boolean {
  return isHouseBaseline && row.type === 'BUY' && row.date <= IMPORT_CUTOVER_DATE;
}

/** True when `baselineDate` is the shared house baseline (same instant as INCEPTION_DATE). */
export function isHouseBaselineDate(baselineDate: Date): boolean {
  return baselineDate.getTime() === INCEPTION_DATE.getTime();
}

/**
 * Was this client swept up in the original bulk import — i.e. are their
 * 1-July-2026 BUY rows import artifacts rather than real trades?
 *
 * This no longer decides WHETHER the 30-June rebase applies: it applies to
 * every client (see the doc on JUN30_REBASE_DATE). It decides only how
 * 1-July-2026 itself is read. Rows dated on or before 30-June are pre-baseline
 * for everyone; a BUY stamped 1-July is pre-baseline only for a bulk-import
 * client, whose 1-July BUYs are the opening position wearing a transaction's
 * clothing. For anyone else a 1-July BUY is a real trade made after the
 * baseline, and it stays in the flow series.
 *
 * A client is bulk-import when the house baseline is actually theirs:
 *
 *   • They have a stored `PortfolioBaseline` dated on the house date, or
 *   • They have no stored baseline AND no ledger history predating the house
 *     date, so the synthetic house-dated baseline stands in for them
 *     (PortfolioReconstructionService.syntheticBaselineDate).
 *
 * A client with a stored baseline on their OWN date, or with real transactions
 * before 30-June-2026, is neither: their history was recorded, not imported.
 *
 * Centralised because three call sites need the same answer and MUST agree —
 * the Performance page, the Clients-list `deriveMetrics`, and the period
 * engine. A 1-July BUY counted as a flow on one page and as part of the opening
 * position on another reports two different returns for the same book.
 */
export function isBulkImportClient(input: {
  /** The client's stored `PortfolioBaseline.baselineDate`, if they have one. */
  baselineDate?: Date | null;
  /** The client's earliest transaction date, if they have any ledger at all. */
  firstTransactionDate?: Date | null;
}): boolean {
  if (input.firstTransactionDate && utcDayOf(input.firstTransactionDate) < INCEPTION_DATE) {
    return false;
  }
  if (!input.baselineDate) return true;
  return isHouseBaselineDate(input.baselineDate);
}

/** Midnight-UTC truncation, so a same-day comparison is not decided by a timestamp. */
function utcDayOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The first instant after the baseline: midnight UTC on 1-July-2026. */
const FIRST_POST_BASELINE_DAY = new Date('2026-07-01T00:00:00.000Z');

/**
 * Is this ledger row part of the history the 30-June baseline rolls up?
 *
 * Every row dated on or before 30-June-2026 is, for every client, whatever its
 * type: a December BUY, a March SELL and a May dividend all happened before
 * the house's reporting window opens, and their only surviving effect is the
 * position they left behind at the 30-June close.
 *
 * A 1-July BUY is too, but only for a bulk-import client (`isImportArtifact`)
 * — that is the import date, not a trading date. For any other client a
 * 1-July row is a real trade after the baseline and stays.
 */
export function isPreBaseline(
  row: { type: string; date: Date },
  /** True for a bulk-import client. See `isBulkImportClient`. */
  isHouseBaseline = true,
): boolean {
  return row.date < FIRST_POST_BASELINE_DAY || isImportArtifact(row, isHouseBaseline);
}

/**
 * The change in share count a ledger row makes, mirroring
 * `PortfolioReconstructionService.applyTransaction` — the authority on how a
 * row moves a position. Corporate-action rows store `quantity` as the signed
 * DELTA (a reverse split or a merger's outgoing leg is negative), so they pass
 * through as recorded; a SELL's quantity is stored positive.
 */
function shareDelta(row: { type: string; quantity: number | null }): number {
  if (!row.quantity) return 0;
  switch (row.type) {
    case 'BUY':
    case 'RIGHTS_SUBSCRIPTION':
      return row.quantity;
    case 'SELL':
      return -row.quantity;
    case 'SPLIT':
    case 'BONUS':
    case 'REVERSE_SPLIT':
    case 'SPINOFF':
    case 'MERGER':
    case 'ACQUISITION':
    case 'DELISTING_SETTLEMENT':
      return row.quantity;
    default:
      return 0;
  }
}

/**
 * The 30-June-2026 quantity for every ticker the client held at the close —
 * the shared arithmetic behind both `rebaseLedgerToJun30` (the flow series)
 * and `PerformanceService.rebasePositionCosts` (the cost basis), so the two
 * can never price a different quantity as "the 30-June position" for the
 * same ticker.
 *
 * ── Eligibility: pre-baseline activity, never current holdings ───────────
 * Only a ticker with at least one share-moving row before the baseline can
 * have been held on 30-June. A caller's CURRENT holdings are not evidence of
 * that: a ticker bought fresh in August is `quantity > 0` today, and the
 * market may well have a 30-June close for it — using current holdings as the
 * test priced Karan Raiyani's August purchases of NLCINDIA.NS/GESHIP.NS/
 * ANUP.NS as if he'd held them since 30-June.
 *
 * ── Quantity: rolled back from today, not summed forward ─────────────────
 * Current quantity, minus every share-moving row since the baseline. Mirrors
 * `BaselineService.autoSeed`'s `sharesAddedSince` rollback, and handles every
 * shape a position can take since:
 *
 *   - Added to after 30-June (Shubh Laiwala bought more OKE, VIRT, SNDK and
 *     CRWV): the later shares are subtracted, so they are not priced once at
 *     the 30-June close and again at their own real cost.
 *   - Fully sold after 30-June (Nirav Patel's LYV, `Holding` row long gone):
 *     absent counts as zero held, and adding the later SELL back recovers the
 *     30-June quantity — without it, the SELL's proceeds would have no
 *     matching outflow and the whole sale would read as gain.
 *   - Split or bonus after 30-June: the new shares are subtracted, so the
 *     30-June close (a pre-split price) is multiplied by the pre-split count.
 *   - Inert import noise (Radhika Vaidya's duplicate `INDOSMC.NS` BUY beside
 *     the real `INDOSMC.BO` position — no holding, no later activity): rolls
 *     back to zero and is excluded rather than synthesized as a phantom
 *     152,000-rupee position.
 *
 * `averageCost` is the pre-baseline purchase cost per share — the fallback
 * unit price when no 30-June close exists.
 */
export function jun30Quantities<T extends RebaseLedgerEntry>(
  ledger: T[],
  /** ticker → CURRENT quantity. A ticker absent here is held at zero. */
  currentQuantity: ReadonlyMap<string, number>,
  /** True for a bulk-import client. See `isBulkImportClient`. */
  isHouseBaseline = true,
): Map<string, { quantity: number; averageCost: number }> {
  const heldBefore = new Set<string>();
  const preCost = new Map<string, { quantity: number; cost: number }>();
  const addedSince = new Map<string, number>();

  for (const r of ledger) {
    const delta = shareDelta(r);
    if (!r.ticker || delta === 0) continue;

    if (!isPreBaseline(r, isHouseBaseline)) {
      addedSince.set(r.ticker, (addedSince.get(r.ticker) ?? 0) + delta);
      continue;
    }

    heldBefore.add(r.ticker);
    if (r.type === 'BUY' || r.type === 'RIGHTS_SUBSCRIPTION') {
      const c = preCost.get(r.ticker) ?? { quantity: 0, cost: 0 };
      c.quantity += r.quantity!;
      c.cost += Math.abs(r.amount);
      preCost.set(r.ticker, c);
    }
  }

  const out = new Map<string, { quantity: number; averageCost: number }>();
  for (const ticker of heldBefore) {
    const quantity = (currentQuantity.get(ticker) ?? 0) - (addedSince.get(ticker) ?? 0);
    if (quantity <= 0) continue;

    const c = preCost.get(ticker);
    out.set(ticker, { quantity, averageCost: c && c.quantity > 0 ? c.cost / c.quantity : 0 });
  }
  return out;
}

export function rebaseLedgerToJun30<T extends RebaseLedgerEntry>(
  ledger: T[],
  /** ticker → 30-June-2026 close (the session's actual close, not split-adjusted). */
  jun30Close: Map<string, number>,
  currentQuantity: ReadonlyMap<string, number>,
  /**
   * True for a bulk-import client — decides only whether a 1-July BUY is part
   * of the opening position or a real trade after it. See `isBulkImportClient`.
   * The rebase itself applies to every client either way.
   */
  isHouseBaseline = true,
): LedgerEntry[] {
  const jun30 = jun30Quantities(ledger, currentQuantity, isHouseBaseline);

  const synthetic: LedgerEntry[] = [...jun30.entries()].map(([ticker, pos]) => {
    const unit = jun30Close.get(ticker) ?? pos.averageCost;
    return { type: 'BUY', amount: unit * pos.quantity, date: JUN30_REBASE_DATE };
  });

  /**
   * Everything after the baseline survives exactly as recorded — including an
   * ordinary post-inception purchase. Dropping one is only invisible for a
   * position still held; for a position bought AND fully sold after
   * inception, the SELL's proceeds would survive as pure inflow with no
   * matching outflow. On Keyur Vaidya (DWS0002) that took a ₹13,905.95 real
   * gain on a 30-share STYLAMIND.NS round trip and reported it as
   * ₹111,769.15 — the full sale proceeds.
   */
  const afterBaseline = ledger.filter((r) => !isPreBaseline(r, isHouseBaseline));
  return [...synthetic, ...afterBaseline];
}

/**
 * CASH_FLOW method: only money that genuinely crossed the boundary between the
 * client and the portfolio.
 *
 * A BUY is excluded on purpose. Buying $10k of AAPL moves $10k from the cash
 * sleeve into the equity sleeve; the portfolio is worth exactly what it was worth
 * a second earlier. Count it as a flow and you have told XIRR that the client
 * contributed $10k they never contributed, which drags the computed return toward
 * zero — the more actively the book is traded, the more wrong the number gets.
 *
 * A DIVIDEND is excluded for the mirror-image reason, and this is the one that
 * looks wrong at a glance. A dividend DOES raise this client's return — but it
 * does so through the terminal value, because the cash landed in their balance
 * and is already counted there. Adding it as a positive flow as well would tell
 * XIRR the client WITHDREW that cash, which inflates the reported return on money
 * that never left the portfolio. Same for FEES: the cash already left the balance.
 */
const CASH_FLOW_TYPES = new Set(['CASH_DEPOSIT', 'CASH_WITHDRAWAL']);

/**
 * TRANSACTIONAL method: the deployment of capital into positions IS the flow.
 *
 * This is for the client who never tells us "I gave you $50k" — we only ever see
 * the trades. The return is then measured on capital at work: every BUY is money
 * in, every SELL is money out, and whatever is still held is the terminal value.
 *
 * DIVIDEND and FEES are included because they are real cash that arrived or left
 * and are not captured by any BUY/SELL. SPLIT, BONUS and TRANSFER are excluded:
 * they change the share count, not the money, and their `amount` column is not a
 * cash figure.
 */
const TRANSACTIONAL_TYPES = new Set([
  'BUY',
  'SELL',
  'DIVIDEND',
  'FEES',

  /**
   * ── Corporate-action rows that ARE real cash ─────────────────────────────
   *
   * Added with the Corporate Action Engine. Membership of this set is decided
   * by ONE question: did money actually cross into or out of the portfolio?
   *
   * These three did. A special dividend is a dividend by another name; cash in
   * lieu is a real payment for a fraction that could not be issued; a delisting
   * settlement is the buyout proceeds for a cancelled position. Each is money
   * that arrived and is not captured by any BUY or SELL, which is exactly the
   * test the DIVIDEND and FEES entries above already pass.
   *
   * Every OTHER corporate-action type is deliberately absent — SPLIT,
   * REVERSE_SPLIT, BONUS, SPINOFF, MERGER, TICKER_CHANGE, RIGHTS_ENTITLEMENT,
   * CORPORATE_ACTION. They change share counts or labels, not money, and their
   * processors write `amount: 0` precisely so that including them would be
   * harmless — but they are kept out regardless, because a set that says what
   * it means is worth more than one that relies on the data being right.
   *
   * This is what PART 26/52 of the engine spec reduces to in code: a 2-for-1
   * split generates no flow, so a portfolio that went from 100 x $160 to
   * 200 x $80 reports ~0%, not +100%.
   *
   * RETURN_OF_CAPITAL is the interesting omission. It IS real cash arriving,
   * but it is not a return — it is the client's own capital handed back, and
   * the replay reduces cost basis by the same amount. Counting it as a
   * transactional inflow would report a gain on money that was never earned.
   */
  'SPECIAL_DIVIDEND',
  'CASH_IN_LIEU',
  'DELISTING_SETTLEMENT',

  /**
   * Cash OUT: the client paid the subscription price to take up rights. It is
   * a purchase in all but name, and appears in OUTFLOW_TYPES below to get the
   * negative sign. Both memberships are required — `isFlowType` gates on this
   * set first, so a type listed only as an outflow would be dropped before its
   * sign was ever applied.
   *
   * Note RIGHTS_ENTITLEMENT is NOT here: an unexercised right is an option, and
   * no money has moved.
   */
  'RIGHTS_SUBSCRIPTION',
]);

/** Types whose `amount` represents money leaving the client's pocket. */
const OUTFLOW_TYPES = new Set([
  'CASH_DEPOSIT',
  'BUY',
  'FEES',
  // The client paid the subscription price to take up rights — cash out, in
  // exchange for shares. Economically a purchase, and treated as one.
  'RIGHTS_SUBSCRIPTION',
]);

/**
 * The brief makes dividends and fees OPTIONAL under the transactional method,
 * and the option is worth having: excluding fees gives a gross-of-fee return,
 * which is the figure a manager is measured on, while including them gives the
 * net-of-fee return the client actually received. Both are legitimate; they are
 * answers to different questions, and a system that can only produce one of them
 * cannot be reconciled against a statement that used the other.
 *
 * Both default ON, so the headline number is the one the client experienced.
 *
 * These flags do nothing under the CASH_FLOW method, and that is not an
 * oversight: dividends and fees are already inside the terminal value there,
 * because the cash landed in (or left) the balance. Adding them as flows as well
 * would count them twice. See the CASH_FLOW comment above.
 */
export interface FlowOptions {
  includeDividends?: boolean;
  includeFees?: boolean;
}

const DEFAULTS: Required<FlowOptions> = {
  includeDividends: true,
  includeFees: true,
};

export function isFlowType(
  type: string,
  method: AccountingMethod,
  opts: FlowOptions = {},
): boolean {
  if (method === 'CASH_FLOW') return CASH_FLOW_TYPES.has(type);

  const { includeDividends, includeFees } = { ...DEFAULTS, ...opts };

  if (type === 'DIVIDEND') return includeDividends;
  if (type === 'FEES') return includeFees;

  return TRANSACTIONAL_TYPES.has(type);
}

/**
 * Types that get same-day netting under the transactional method: a client who
 * buys ten $10k positions in one session gave the portfolio one $100k trade,
 * not ten separate cash-flow events. XIRR treats each flow date as one client
 * decision, so ten rows on the same day would overweight that day's trading
 * activity relative to a single $100k buy made on a quieter day.
 *
 * DIVIDEND and FEES are deliberately NOT netted here: they are per-event cash
 * (a dividend per holding, a fee charge), not a batch of orders placed as one
 * trading decision, so each row already represents its own real-world event.
 */
const NETTABLE_TYPES = new Set(['BUY', 'SELL']);

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Turn already flow-eligible ledger rows into signed cash flows, netting same-day
 * BUY/SELL rows into one flow per day (per the NETTABLE_TYPES rationale above).
 * Non-nettable rows (DIVIDEND, FEES) each become their own flow, one per row.
 */
function toNettedCashFlows(eligible: LedgerEntry[]): CashFlow[] {
  const buckets = new Map<string, number>();
  const passthrough: CashFlow[] = [];

  for (const t of eligible) {
    // Magnitude, not the stored sign: the ledger is not consistent about whether
    // a withdrawal is written as -5000 or 5000, and the TYPE is the reliable signal.
    const signedAmount = OUTFLOW_TYPES.has(t.type) ? -Math.abs(t.amount) : Math.abs(t.amount);

    if (!NETTABLE_TYPES.has(t.type)) {
      passthrough.push({ date: t.date, amount: signedAmount });
      continue;
    }

    // Net BUY and SELL against each other within the same day so that a buy and
    // a sell on the same day still produce one flow, signed by which side won.
    const key = dateKey(t.date);
    buckets.set(key, (buckets.get(key) ?? 0) + signedAmount);
  }

  const netted = [...buckets.entries()].map(([key, amount]) => ({
    date: new Date(key),
    amount,
  }));

  return [...passthrough, ...netted];
}

/**
 * Build the XIRR series for a client.
 *
 * `terminalValue` is the book's worth today (securities + cash) and closes the
 * series. Under the transactional method it is what makes an unsold position
 * count at all: a client who bought and never sold has only negative flows, and
 * XIRR has no root in an all-negative series — without the terminal value we
 * would report "no solution" for the most ordinary buy-and-hold account there is.
 */
export function buildFlows(
  ledger: LedgerEntry[],
  method: AccountingMethod,
  terminalValue: number,
  asOf: Date,
  opts: FlowOptions = {},
): FlowBuildResult {
  const eligible = ledger.filter((t) => isFlowType(t.type, method, opts));

  if (eligible.length === 0) {
    return {
      status: 'insufficient',
      reason:
        method === 'CASH_FLOW'
          ? 'No deposits or withdrawals recorded. XIRR on the cash-flow method needs at least one contribution — record the client’s inflows, or switch this client to the transactional method.'
          : 'No trades recorded. XIRR on the transactional method needs at least one buy.',
    };
  }

  // Only the transactional method nets same-day BUY/SELL rows: under CASH_FLOW,
  // trades are not flows at all, so there is nothing here to net.
  const flows =
    method === 'TRANSACTIONAL'
      ? toNettedCashFlows(eligible)
      : eligible.map((t) => ({
          date: t.date,
          amount: OUTFLOW_TYPES.has(t.type) ? -Math.abs(t.amount) : Math.abs(t.amount),
        }));

  flows.sort((a, b) => a.date.getTime() - b.date.getTime());
  flows.push({ date: asOf, amount: terminalValue });

  return { status: 'ok', flows };
}

/** Total money the client put in — the denominator people expect next to a return. */
export function totalContributed(flows: CashFlow[]): number {
  return flows.filter((f) => f.amount < 0).reduce((s, f) => s + -f.amount, 0);
}

/** Money already taken out, excluding the terminal value that closes the series. */
export function totalWithdrawn(flows: CashFlow[]): number {
  return flows.slice(0, -1).filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
}

/**
 * The interior flows of a PERIOD window — the rows that landed strictly between
 * a window's opening and closing valuation.
 *
 * This exists because the period engines (performance-baseline.service.ts and
 * family-performance.service.ts) were each hand-rolling their own version that
 * looked only for CASH_DEPOSIT / CASH_WITHDRAWAL rows. On a CASH_FLOW book that
 * is right. On a TRANSACTIONAL book — which is every Indian mandate, and the
 * schema default — it is silently, catastrophically wrong: such a book has no
 * cash rows at all, so the window saw zero flows, XIRR collapsed to a two-point
 * series, and the "money-weighted, flow-adjusted" headline degenerated into the
 * exact `(close - open) / open` figure the sheet prints beside it as the naive
 * one. A client who deployed ~10 lakh of fresh capital during the quarter had
 * every rupee of it reported as return.
 *
 * So the method decides which rows are flows, exactly as it does for the
 * since-inception series — one rule, one place, both engines.
 *
 * ── Why BUY rows, and why that is not double-counting ─────────────────────
 * Under the transactional method the deployment of capital IS the flow, and the
 * window's opening value already contains whatever was deployed before `from`.
 * A BUY inside the window is therefore new capital arriving at a known date,
 * and pricing it on that date is precisely what stops it being booked as
 * performance. A SELL is the mirror image: money out, not a loss.
 *
 * Import artifacts are dropped (`isImportArtifact`): the bulk-imported BUY rows
 * stamped 2026-07-01 are the opening position wearing a transaction's clothing,
 * and the 30-June baseline already represents them in full. Replaying one on top
 * of the baseline books the same purchase twice — the same defect documented on
 * IMPORT_CUTOVER_DATE, which is why that predicate is reused rather than
 * re-derived.
 *
 * Same-day BUY/SELL netting is inherited from `toNettedCashFlows`, so a window
 * agrees with the since-inception series about what one trading day's flow was.
 *
 * Boundaries are STRICT on both sides (`from < date < to`), matching the
 * previous behaviour: a trade dated on the opening day is already inside the
 * opening valuation, and one dated on the closing day is inside the closing
 * valuation. Counting either again would double-book it.
 */
export function buildWindowFlows(
  ledger: LedgerEntry[],
  method: AccountingMethod,
  from: Date,
  to: Date,
  opts: FlowOptions = {},
  /** True when this client's own baseline is the shared house baseline. See isImportArtifact. */
  isHouseBaseline = true,
): CashFlow[] {
  const eligible = ledger.filter(
    (t) =>
      t.date > from &&
      t.date < to &&
      isFlowType(t.type, method, opts) &&
      !isImportArtifact(t, isHouseBaseline),
  );

  const flows =
    method === 'TRANSACTIONAL'
      ? toNettedCashFlows(eligible)
      : eligible.map((t) => ({
          date: t.date,
          amount: OUTFLOW_TYPES.has(t.type) ? -Math.abs(t.amount) : Math.abs(t.amount),
        }));

  // A netted flow of exactly zero (a buy and a sell of equal value on one day)
  // is not an event: it is two events that cancelled. Dropping it keeps the
  // series honest about how many decisions the window actually contained.
  return flows
    .filter((f) => f.amount !== 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
