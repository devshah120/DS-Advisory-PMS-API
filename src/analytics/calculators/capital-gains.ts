import { Market, fiscalYearOf, fiscalYearRange, fiscalYearLabel } from '../../common/market-scope';
import { RealizedGainRow } from './tax-lots';

/**
 * Capital-gains aggregation — the shape a client's tax statement takes.
 *
 * The lot engine (tax-lots.ts) answers "what was realized"; this file answers
 * "in which reporting year, and under which head". Kept separate because the
 * FIFO replay is statute-independent while the PERIODS are not: the US book is
 * cut on the calendar year and the Indian book on the April–March financial
 * year, and that boundary is already the single source of truth in
 * market-scope.ts. Re-deriving it here would be a second definition of the year.
 *
 * The realization date is the SALE date, never the acquisition date. A lot
 * bought in FY24 and sold in FY26 is FY26 income — obvious when stated, and the
 * single most consequential line in this file, because bucketing by acquisition
 * would file gains against years the client has already closed.
 */

export interface GainBucket {
  /** Gross gains, before netting losses. */
  gains: number;
  /** Losses as a POSITIVE magnitude — see netGain for the signed figure. */
  losses: number;
  /** gains − losses. The figure that carries to the return. */
  net: number;
  proceeds: number;
  costBasis: number;
  /** Number of report lines, not number of shares. */
  transactions: number;
}

export interface CapitalGainsSummary {
  market: Market;
  fiscalYear: number;
  label: string;
  periodStart: Date;
  periodEnd: Date;
  shortTerm: GainBucket;
  longTerm: GainBucket;
  /** Short + long, netted. Not a taxable figure on its own — see the note below. */
  total: GainBucket;
  rows: RealizedGainRow[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const emptyBucket = (): GainBucket => ({
  gains: 0,
  losses: 0,
  net: 0,
  proceeds: 0,
  costBasis: 0,
  transactions: 0,
});

/**
 * Accumulate one gain row into a bucket.
 *
 * Gains and losses are tracked SEPARATELY rather than as a running net, because
 * set-off rules treat them differently and a report that only carries the net
 * cannot reconstruct them. Under Indian s.74 a short-term capital loss may be
 * set off against either short- or long-term gains, while a long-term loss may
 * only be set off against long-term gains — so the gross figures are what a CA
 * actually needs, and the net is a convenience on top.
 */
function accumulate(bucket: GainBucket, row: RealizedGainRow): void {
  if (row.gain >= 0) bucket.gains += row.gain;
  else bucket.losses += -row.gain;

  bucket.net += row.gain;
  bucket.proceeds += row.proceeds;
  bucket.costBasis += row.costBasis;
  bucket.transactions += 1;
}

/**
 * Bucket realized gains into one fiscal year, by SALE date.
 *
 * The period comes from `fiscalYearRange`, so an Indian client's FY27 runs
 * 1-Apr-2026 → 31-Mar-2027 and a US client's CY26 runs 1-Jan → 31-Dec-2026,
 * with no date arithmetic duplicated here.
 */
export function capitalGainsForFiscalYear(
  allGains: RealizedGainRow[],
  fiscalYear: number,
  market: Market,
): CapitalGainsSummary {
  const { start, end } = fiscalYearRange(fiscalYear, market);

  /**
   * `fiscalYearRange` returns the last DAY, at midnight. A sale timestamped
   * later on that same day (any real trade time) would fall outside a naive
   * `<= end` comparison and vanish from the year entirely — landing in no
   * bucket at all, since the next year starts the following day. Comparing
   * against the instant before the next year opens closes that gap.
   */
  const endExclusive = new Date(end.getTime() + MS_PER_DAY);

  const rows = allGains
    .filter((g) => g.soldOn >= start && g.soldOn < endExclusive)
    .sort((a, b) => a.soldOn.getTime() - b.soldOn.getTime());

  const shortTerm = emptyBucket();
  const longTerm = emptyBucket();
  const total = emptyBucket();

  for (const row of rows) {
    accumulate(row.term === 'SHORT' ? shortTerm : longTerm, row);
    accumulate(total, row);
  }

  return {
    market,
    fiscalYear,
    label: fiscalYearLabel(fiscalYear, market),
    periodStart: start,
    periodEnd: end,
    shortTerm,
    longTerm,
    total,
    rows,
  };
}

/**
 * Every fiscal year the ledger actually touches, newest first.
 *
 * Derived from the data rather than from a fixed range, so a book with ten years
 * of history and one with three months both produce exactly the years they have.
 */
export function fiscalYearsCovered(allGains: RealizedGainRow[], market: Market): number[] {
  const years = new Set(allGains.map((g) => fiscalYearOf(g.soldOn, market)));
  return [...years].sort((a, b) => b - a);
}

/** Per-year summaries for the whole ledger, newest year first. */
export function capitalGainsByYear(
  allGains: RealizedGainRow[],
  market: Market,
): CapitalGainsSummary[] {
  return fiscalYearsCovered(allGains, market).map((fy) =>
    capitalGainsForFiscalYear(allGains, fy, market),
  );
}
