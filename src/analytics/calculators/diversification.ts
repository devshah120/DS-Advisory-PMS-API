import { PortfolioSnapshot } from './types';
import { allocationBy, positionWeights, totalAssets } from './weights';
import { herfindahl, normalizedEntropy, saturate, sum } from './statistics';

/**
 * Diversification score, 0–100.
 *
 * Any composite score is a judgment encoded as arithmetic, so the weights are
 * stated explicitly and made configurable rather than buried in the code. And
 * the component breakdown is ALWAYS returned alongside the score: "you scored 62"
 * is not actionable, while "you scored 62, and 18 of the 38 points you lost are
 * geographic concentration" is. A composite that cannot be decomposed is a black
 * box, and nobody should trust a black box that grades their portfolio.
 */

export interface ScoreWeights {
  positionCount: number;
  concentration: number;
  sector: number;
  industry: number;
  geography: number;
  cash: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  positionCount: 15,
  concentration: 25,
  sector: 20,
  industry: 15,
  geography: 15,
  cash: 10,
};

/** Past ~30 holdings the marginal diversification benefit flattens out. */
const HOLDINGS_TARGET = 30;

/**
 * Cash scoring. 0% is fragile (no buffer, forced selling to meet a withdrawal);
 * above ~25% the book is uninvested rather than diversified, and that is a
 * different problem than concentration.
 */
export function cashBufferScore(cashWeight: number): number {
  if (cashWeight < 0.02) return cashWeight / 0.02;        // ramp up to the band
  if (cashWeight <= 0.10) return 1;                        // the healthy band
  if (cashWeight >= 0.30) return 0;                        // sitting in cash
  return 1 - (cashWeight - 0.10) / 0.20;                   // taper off
}

export type ScoreBand = 'Poor' | 'Fair' | 'Good' | 'Excellent';

export function band(score: number): ScoreBand {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  return 'Poor';
}

export interface DiversificationScore {
  score: number;
  band: ScoreBand;
  components: Record<keyof ScoreWeights, { earned: number; available: number }>;
  drivers: string[];
}

export function diversificationScore(
  snap: PortfolioSnapshot,
  cfg: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): DiversificationScore {
  const total = totalAssets(snap);
  const cashWeight = total > 0 ? snap.cash / total : 0;

  // Concentration is measured over SECURITIES only. Including cash would make a
  // large cash pile look like diversification, which it is not.
  const secWeights = positionWeights(snap, 'SECURITIES_ONLY');

  const sectorSlices = allocationBy(snap, 'sector', { denominator: 'SECURITIES_ONLY' }).slices;
  const industrySlices = allocationBy(snap, 'industry', { denominator: 'SECURITIES_ONLY' }).slices;
  const regionSlices = allocationBy(snap, 'region', {
    denominator: 'SECURITIES_ONLY',
    lookThrough: true, // meaningless without it — see weights.ts
  }).slices;

  const raw = {
    positionCount: saturate(snap.positions.length, HOLDINGS_TARGET),
    // (1 − HHI) penalizes a few DOMINANT names, not merely a small count.
    concentration: snap.positions.length > 0 ? 1 - herfindahl(secWeights) : 0,
    sector: normalizedEntropy(sectorSlices.map((s) => s.weight)),
    industry: normalizedEntropy(industrySlices.map((s) => s.weight)),
    geography: normalizedEntropy(regionSlices.map((s) => s.weight)),
    cash: cashBufferScore(cashWeight),
  };

  const components = {} as DiversificationScore['components'];
  for (const k of Object.keys(cfg) as Array<keyof ScoreWeights>) {
    components[k] = {
      earned: Math.round(raw[k] * cfg[k] * 10) / 10,
      available: cfg[k],
    };
  }

  const score = Math.round(
    sum((Object.keys(cfg) as Array<keyof ScoreWeights>).map((k) => raw[k] * cfg[k])),
  );

  // The biggest point losses, named. This is the actionable part.
  const drivers = (Object.keys(cfg) as Array<keyof ScoreWeights>)
    .map((k) => ({ k, lost: cfg[k] - components[k].earned }))
    .filter((d) => d.lost > 1)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 3)
    .map((d) => `${d.k}: −${d.lost.toFixed(1)} pts`);

  return { score, band: band(score), components, drivers };
}
