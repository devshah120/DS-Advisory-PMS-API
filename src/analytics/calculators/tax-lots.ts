import { Market } from '../../common/market-scope';

/**
 * FIFO tax-lot accounting — the engine behind the capital-gains report.
 *
 * Pure, like everything else in this directory: a ledger in, gain rows out. No
 * Prisma, no clock, no config beyond the market code.
 *
 * WHY FIFO AND NOT AVERAGE COST
 *
 * `kpis.realizedGain()` used to compute realized gain on weighted average cost,
 * on the reasoning that it could then never disagree with `Holding.averageCost`.
 * That is a fine property for an internal KPI and the wrong answer for anything
 * a client files a return on:
 *
 *   • India — s.45 read with the depository delivery rules requires FIFO for
 *     listed equity held in demat. Average cost is not an available election.
 *   • US — FIFO is the broker default under Treas. Reg. §1.1012-1(c) absent a
 *     specific-lot election made at the time of sale.
 *
 * So a report built on average cost cannot tie to a contract note, a broker
 * statement, or an ITR. That is the whole purpose of this file, and it is why
 * the FIFO number REPLACES the average-cost one rather than sitting beside it —
 * two realized-gain figures in one system is precisely the drift this codebase
 * keeps warning about.
 *
 * WHAT A LOT IS
 *
 * Each BUY opens a lot carrying its own acquisition date and its own cost. A
 * SELL consumes the OLDEST open lot first, and splits across lots when the
 * quantity spans several: selling 150 against lots of 100 and 100 produces TWO
 * gain rows, not one. That per-lot granularity is what makes the output tie to
 * a broker statement line by line, and it is why the lots cannot be collapsed
 * into a single {qty, cost} blob per ticker.
 */

/** The subset of a Transaction row the lot engine reads. */
export interface LotLedgerRow {
  type: string;
  ticker: string | null;
  quantity: number | null;
  price: number | null;
  amount: number;
  date: Date;
}

/** An open (or partly consumed) parcel of shares, at one cost and one date. */
export interface OpenLot {
  ticker: string;
  /** Shares still unsold in this lot. */
  quantity: number;
  /** Per-share cost. Total cost is always quantity × unitCost — see splits. */
  unitCost: number;
  /**
   * When the holding period STARTS for this lot.
   *
   * Not merely provenance: this single field decides short vs. long term, and
   * therefore the tax rate. A split must preserve it (the clock does not restart
   * when shares subdivide); a bonus issue must NOT inherit it (those shares are
   * acquired on the bonus date and start their own clock).
   */
  acquiredOn: Date;
  /** True for zero-cost shares from a bonus issue. Carried into the gain row. */
  fromBonus: boolean;
}

export type GainTerm = 'SHORT' | 'LONG';

/**
 * One depletion of one lot by one sale — a single line of the capital-gains
 * report, and the unit that ties to a broker statement.
 */
export interface RealizedGainRow {
  ticker: string;
  /** Shares taken out of this particular lot by this sale. */
  quantity: number;
  acquiredOn: Date;
  soldOn: Date;
  /** Days held, used to classify the term. */
  holdingDays: number;
  term: GainTerm;
  /** Per-share figures, so the row reconciles by inspection. */
  costPerShare: number;
  proceedsPerShare: number;
  /** quantity × costPerShare, after any grandfathering substitution. */
  costBasis: number;
  /** quantity × proceedsPerShare. */
  proceeds: number;
  /** proceeds − costBasis. */
  gain: number;
  fromBonus: boolean;
  /** True when s.112A grandfathering raised the basis. See grandfatheredCost. */
  grandfathered: boolean;
  /** The actual cost before grandfathering, kept for the audit trail. */
  originalCostPerShare: number;
}

export interface LotEngineResult {
  gains: RealizedGainRow[];
  /** Lots still open at the end of the replay — the unrealized side. */
  openLots: OpenLot[];
  /**
   * Sales that found no open lot to consume, in whole or in part.
   *
   * NOT silently dropped. A sale with no matching purchase means the ledger is
   * incomplete (the bulk import loaded holdings with no buy history, which is a
   * documented condition of this book — see flows.IMPORT_CUTOVER_DATE). Reporting
   * a gain computed against a basis we do not have would put a fabricated number
   * on a tax statement, so the shortfall is surfaced instead.
   */
  unmatchedSales: Array<{ ticker: string; quantity: number; date: Date; proceeds: number }>;
}

/**
 * The long-term threshold, in days, for listed equity.
 *
 * Both books use 12 months — India under s.2(42A) proviso for listed equity, the
 * US under §1222 — but they are kept as separate entries rather than one shared
 * constant because they are separate statutes that happen to agree today. A
 * change to one must not silently move the other.
 *
 * 365 days is the operative test in both, and the comparison is STRICTLY greater
 * than: exactly 12 months is still short-term. India's s.2(42A) says "not more
 * than twelve months", and the US §1222 test is "more than one year", so a lot
 * bought 1-Jan and sold the following 1-Jan is short-term in both. Getting this
 * boundary backwards is a one-day error that moves the whole rate.
 */
const LONG_TERM_DAYS: Record<Market, number> = {
  INDIA: 365,
  US: 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calendar days between two instants, floored.
 *
 * UTC-based subtraction rather than local-time date arithmetic: the ledger
 * stores UTC, and a DST transition in a local-time implementation shifts a
 * boundary-case holding period by a day — which flips the term, and the rate.
 */
export function holdingDaysBetween(acquiredOn: Date, soldOn: Date): number {
  return Math.floor((soldOn.getTime() - acquiredOn.getTime()) / MS_PER_DAY);
}

export function classifyTerm(holdingDays: number, market: Market): GainTerm {
  return holdingDays > LONG_TERM_DAYS[market] ? 'LONG' : 'SHORT';
}

/**
 * Section 112A grandfathering — India only.
 *
 * For listed equity ACQUIRED on or before 31-Jan-2018 and sold after 31-Mar-2018,
 * the cost of acquisition is the HIGHER of the actual cost and the fair market
 * value on 31-Jan-2018 — but that substituted value is then CAPPED at the sale
 * consideration, so the rule can never manufacture a loss that did not happen.
 *
 * Formally: cost = max(actual, min(FMV_31Jan2018, saleConsideration)).
 *
 * The cap is the half that is easy to miss. Without it, a share bought at ₹100,
 * peaking at ₹500 on 31-Jan-2018 and sold at ₹300 would report a ₹200 LOSS
 * against a real ₹200 GAIN — an error that flows straight onto a return.
 *
 * Applied per share, on the per-share figures, so it composes with a partial
 * lot depletion without further adjustment.
 */
export const GRANDFATHER_CUTOFF = new Date('2018-01-31T00:00:00.000Z');
export const GRANDFATHER_SALE_FLOOR = new Date('2018-03-31T23:59:59.999Z');

export function grandfatheredCost(
  actualCostPerShare: number,
  fmv31Jan2018: number | undefined,
  proceedsPerShare: number,
  acquiredOn: Date,
  soldOn: Date,
  market: Market,
): { costPerShare: number; grandfathered: boolean } {
  const eligible =
    market === 'INDIA' &&
    fmv31Jan2018 !== undefined &&
    acquiredOn <= GRANDFATHER_CUTOFF &&
    soldOn > GRANDFATHER_SALE_FLOOR;

  if (!eligible) return { costPerShare: actualCostPerShare, grandfathered: false };

  const substituted = Math.max(
    actualCostPerShare,
    Math.min(fmv31Jan2018!, proceedsPerShare),
  );

  return {
    costPerShare: substituted,
    grandfathered: substituted !== actualCostPerShare,
  };
}

export interface LotEngineOptions {
  market: Market;
  /**
   * ticker → fair market value per share on 31-Jan-2018, for s.112A. Absent
   * entries simply disable grandfathering for that ticker rather than guessing:
   * a wrong FMV understates the client's cost and overstates their tax.
   */
  fmv31Jan2018?: Map<string, number>;
}

/**
 * Per-share cost of a ledger row.
 *
 * `amount` is the authoritative total (it is what the cash calculations use), so
 * unit cost is derived from it rather than trusting `price`, which is nullable
 * and, on imported rows, frequently absent. Falling back to `price` only when
 * amount is unusable keeps a partially-populated row from producing a zero basis
 * — a zero basis makes the entire proceeds taxable, which is the direction that
 * hurts the client.
 */
function unitCostOf(row: LotLedgerRow, quantity: number): number {
  if (quantity <= 0) return 0;
  const fromAmount = Math.abs(row.amount) / quantity;
  if (Number.isFinite(fromAmount) && fromAmount > 0) return fromAmount;
  return row.price ?? 0;
}

/**
 * Same-day ordering rank.
 *
 * A corporate action dated the same day as a sale must be applied to the lots
 * BEFORE the sale consumes them, or the sale prices shares that had not yet
 * subdivided. Ties beyond that keep input order (Array.sort is stable), which
 * matches the ledger's own insertion sequence.
 */
const SAME_DAY_RANK: Record<string, number> = {
  SPLIT: 0,
  BONUS: 1,
  BUY: 2,
  TRANSFER: 2,
  SELL: 3,
};

/**
 * Replay a ledger through FIFO lots.
 */
export function replayLots(
  ledger: LotLedgerRow[],
  opts: LotEngineOptions,
): LotEngineResult {
  const { market, fmv31Jan2018 } = opts;

  const sorted = [...ledger].sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) return byDate;
    return (SAME_DAY_RANK[a.type] ?? 9) - (SAME_DAY_RANK[b.type] ?? 9);
  });

  /** ticker → open lots, oldest first. FIFO consumes from the front. */
  const book = new Map<string, OpenLot[]>();
  const gains: RealizedGainRow[] = [];
  const unmatchedSales: LotEngineResult['unmatchedSales'] = [];

  const lotsFor = (ticker: string): OpenLot[] => {
    const existing = book.get(ticker);
    if (existing) return existing;
    const created: OpenLot[] = [];
    book.set(ticker, created);
    return created;
  };

  for (const row of sorted) {
    if (!row.ticker) continue;
    const ticker = row.ticker;
    const qty = row.quantity ?? 0;

    // A TRANSFER in is an acquisition like any other: it opens a lot at its
    // stated cost. Excluded from CASH flows (it moves no money) but very much
    // included here, because the shares it brought in have a basis and a date.
    if ((row.type === 'BUY' || row.type === 'TRANSFER') && qty > 0) {
      lotsFor(ticker).push({
        ticker,
        quantity: qty,
        unitCost: unitCostOf(row, qty),
        acquiredOn: row.date,
        fromBonus: false,
      });
      continue;
    }

    /**
     * A split multiplies the share count and leaves TOTAL cost untouched, so the
     * per-share cost falls by the same ratio. Applied per lot, and each lot KEEPS
     * its original acquisition date: subdividing a share does not restart its
     * holding period. Treating split shares as newly acquired would reclassify a
     * long-term holding as short-term and roughly double the rate.
     *
     * `quantity` here is the ratio (2 for a 2-for-1), matching how the existing
     * reconstruction service and kpis.ts already read this column.
     */
    if (row.type === 'SPLIT' && qty > 0) {
      for (const lot of lotsFor(ticker)) {
        lot.quantity *= qty;
        lot.unitCost /= qty;
      }
      continue;
    }

    /**
     * A bonus issue hands over shares at NO cost, and — unlike a split — those
     * shares are acquired ON THE BONUS DATE. They start their own holding-period
     * clock, so they open a distinct zero-cost lot rather than diluting the
     * parent lots' basis.
     *
     * This is the case a naive implementation gets wrong in the client's
     * disfavour twice over: fold bonus shares into the parent lot and they
     * inherit an older date (understating tax on a quick sale), while spreading
     * the parent's cost across them understates the gain on the parent.
     *
     * `quantity` is the number of bonus shares received.
     */
    if (row.type === 'BONUS' && qty > 0) {
      lotsFor(ticker).push({
        ticker,
        quantity: qty,
        unitCost: 0,
        acquiredOn: row.date,
        fromBonus: true,
      });
      continue;
    }

    if (row.type === 'SELL' && qty > 0) {
      const lots = lotsFor(ticker);
      const proceedsPerShare = unitCostOf(row, qty);
      let remaining = qty;

      // FIFO: drain the oldest lot, then the next, until the sale is filled.
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const taken = Math.min(remaining, lot.quantity);

        const holdingDays = holdingDaysBetween(lot.acquiredOn, row.date);
        const { costPerShare, grandfathered } = grandfatheredCost(
          lot.unitCost,
          fmv31Jan2018?.get(ticker),
          proceedsPerShare,
          lot.acquiredOn,
          row.date,
          market,
        );

        const costBasis = costPerShare * taken;
        const proceeds = proceedsPerShare * taken;

        gains.push({
          ticker,
          quantity: taken,
          acquiredOn: lot.acquiredOn,
          soldOn: row.date,
          holdingDays,
          term: classifyTerm(holdingDays, market),
          costPerShare,
          proceedsPerShare,
          costBasis,
          proceeds,
          gain: proceeds - costBasis,
          fromBonus: lot.fromBonus,
          grandfathered,
          originalCostPerShare: lot.unitCost,
        });

        lot.quantity -= taken;
        remaining -= taken;

        // Floating-point depletion: a lot drained by repeated subtraction can
        // land on 1e-15 rather than 0 and linger as a phantom lot that later
        // sales match against. The epsilon is relative to the lot's own size so
        // it holds for both 10-share and 10,000,000-share parcels.
        if (lot.quantity <= Math.max(1e-9, taken * 1e-12)) lots.shift();
      }

      // Whatever the open lots could not cover has no basis we can defend.
      if (remaining > 0) {
        unmatchedSales.push({
          ticker,
          quantity: remaining,
          date: row.date,
          proceeds: proceedsPerShare * remaining,
        });
      }
    }
  }

  const openLots = [...book.values()].flat().filter((l) => l.quantity > 0);

  return { gains, openLots, unmatchedSales };
}

/** Total realized gain — the FIFO replacement for the average-cost figure. */
export function totalRealizedGain(gains: RealizedGainRow[]): number {
  return gains.reduce((s, g) => s + g.gain, 0);
}
