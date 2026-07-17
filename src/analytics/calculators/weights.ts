import {
  AllocationSlice,
  Denominator,
  Dimension,
  PortfolioSnapshot,
  Position,
} from './types';
import { groupSum, mean, median, sum } from './statistics';

/**
 * Weights and allocation.
 *
 * There is exactly ONE grouping function here. Sector allocation, industry
 * allocation, geographic allocation, house-level allocation and the entropy
 * inputs to the diversification score all call it. That is deliberate: the same
 * quantity is asked for at six different altitudes, and six implementations
 * would eventually disagree with each other.
 */

export function securitiesValue(snap: PortfolioSnapshot): number {
  return sum(snap.positions.map((p) => p.marketValue));
}

export function totalAssets(snap: PortfolioSnapshot): number {
  return securitiesValue(snap) + snap.cash;
}

/**
 * The denominator is explicit because it has to be: cash is 21.3% of this book.
 * A position worth 5.0% of total assets is 6.4% of securities, and a 5%
 * concentration limit therefore fires in a different place depending on which is
 * meant. Every API response echoes back the denominator it used.
 */
export function denominatorValue(
  snap: PortfolioSnapshot,
  d: Denominator = 'TOTAL_ASSETS',
): number {
  return d === 'TOTAL_ASSETS' ? totalAssets(snap) : securitiesValue(snap);
}

export function weightOf(
  marketValue: number,
  snap: PortfolioSnapshot,
  d: Denominator = 'TOTAL_ASSETS',
): number {
  const base = denominatorValue(snap, d);
  return base > 0 ? marketValue / base : 0; // empty or all-cash book must not divide by zero
}

export function positionWeights(
  snap: PortfolioSnapshot,
  d: Denominator = 'TOTAL_ASSETS',
): number[] {
  return snap.positions.map((p) => weightOf(p.marketValue, snap, d));
}

/**
 * Explodes ETFs into their true underlying exposures.
 *
 * This is a correctness requirement, not a refinement. The book holds MCHI
 * (China), EWQ (France), URNM, ICLN, CPER. Yahoo reports every one of them as
 * domiciled in the United States, because the *fund* is a US-listed instrument.
 * Group by country naively and China exposure reads 0% while MCHI is held, and
 * US exposure is overstated by the value of every regional ETF in the book.
 *
 * Positions with no look-through map are reported under their own classification
 * and counted in `unclassified` — surfaced to the caller rather than silently
 * swept into an "Unknown" bucket that looks like a real answer.
 */
export function decomposeLookThrough(
  positions: Position[],
  dim: Dimension,
): { exposures: Array<{ key: string; value: number }>; unclassifiedValue: number } {
  const exposures: Array<{ key: string; value: number }> = [];
  let unclassifiedValue = 0;

  for (const p of positions) {
    const map = p.classification.lookThrough?.[dim];

    if (!map || map.length === 0) {
      const key = p.classification[dim];
      exposures.push({ key: String(key), value: p.marketValue });

      // An ETF with no look-through map is a hole in the data, and the caller
      // needs to know its size. A single stock resolving to itself is not.
      if (p.classification.assetClass === 'ETF' || p.classification.assetClass === 'FUND') {
        unclassifiedValue += p.marketValue;
      }
      continue;
    }

    // MCHI @ $10k -> { China: $10k }. A world ETF -> { USA: $6k, Europe: $2k, ... }
    for (const { key, weight } of map) {
      exposures.push({ key, value: p.marketValue * weight });
    }
  }

  return { exposures, unclassifiedValue };
}

export interface AllocationResult {
  slices: AllocationSlice[];
  denominator: Denominator;
  /** Fraction of the book whose look-through is unmapped. Surface it, don't bury it. */
  unclassifiedWeight: number;
}

/**
 * The one grouping function. `dim` selects sector / industry / region / country /
 * assetClass; `lookThrough` decides whether ETFs are exploded into constituents.
 */
export function allocationBy(
  snap: PortfolioSnapshot,
  dim: Dimension,
  opts: { lookThrough?: boolean; denominator?: Denominator } = {},
): AllocationResult {
  const denominator = opts.denominator ?? 'TOTAL_ASSETS';

  const { exposures, unclassifiedValue } = opts.lookThrough
    ? decomposeLookThrough(snap.positions, dim)
    : {
        exposures: snap.positions.map((p) => ({
          key: String(p.classification[dim]),
          value: p.marketValue,
        })),
        unclassifiedValue: 0,
      };

  // Cash is a real allocation line — 21.3% of this book, larger than any single
  // position. It is not a residual to be left out of the pie.
  const rows = [...exposures];
  if (denominator === 'TOTAL_ASSETS' && snap.cash > 0) {
    rows.push({ key: 'Cash', value: snap.cash });
  }

  const base = denominatorValue(snap, denominator);

  const slices = groupSum(rows)
    .map(({ key, value }) => ({
      key,
      value,
      weight: base > 0 ? value / base : 0,
    }))
    .sort((a, b) => b.value - a.value); // ranked: largest/smallest fall out for free

  return {
    slices,
    denominator,
    unclassifiedWeight: base > 0 ? unclassifiedValue / base : 0,
  };
}

export interface ExposureProfile {
  totalValue: number;
  securitiesValue: number;
  cash: number;
  positionCount: number;

  topHoldings: Array<Position & { weight: number }>;
  largestPosition: (Position & { weight: number }) | null;
  top5Weight: number;
  top10Weight: number;

  averagePositionWeight: number;
  medianPositionWeight: number;

  stockWeight: number;
  etfWeight: number;
  cashWeight: number;
}

export function exposureProfile(
  snap: PortfolioSnapshot,
  d: Denominator = 'TOTAL_ASSETS',
): ExposureProfile {
  const ranked = [...snap.positions]
    .map((p) => ({ ...p, weight: weightOf(p.marketValue, snap, d) }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const weights = ranked.map((p) => p.weight);
  const base = denominatorValue(snap, d);

  const weightOfClass = (cls: string) =>
    base > 0
      ? sum(
          snap.positions
            .filter((p) => p.classification.assetClass === cls)
            .map((p) => p.marketValue),
        ) / base
      : 0;

  return {
    totalValue: totalAssets(snap),
    securitiesValue: securitiesValue(snap),
    cash: snap.cash,
    positionCount: snap.positions.length,

    topHoldings: ranked.slice(0, 10),
    largestPosition: ranked[0] ?? null,
    top5Weight: sum(weights.slice(0, 5)),
    top10Weight: sum(weights.slice(0, 10)),

    // Reporting both is a deliberate diagnostic: when the median sits well below
    // the mean, the book is barbelled — a few large convictions carrying a long
    // tail of small positions. A single "average position size" hides that shape.
    averagePositionWeight: mean(weights),
    medianPositionWeight: median(weights),

    stockWeight: weightOfClass('EQUITY'),
    etfWeight: weightOfClass('ETF'),
    cashWeight: base > 0 ? snap.cash / base : 0,
  };
}
