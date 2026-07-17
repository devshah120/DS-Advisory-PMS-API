/**
 * Statistical primitives. Pure, no I/O.
 *
 * Every function here guards its degenerate cases explicitly, because the inputs
 * are real portfolios: empty books, single-position books, all-cash books, and
 * series with zero variance all occur, and each one is a division by zero
 * somewhere if it isn't handled.
 */

export const TRADING_DAYS_PER_YEAR = 252;

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample variance (n−1). Population variance understates risk on finite samples. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

export function stddev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/** Sample covariance (n−1), consistent with `variance` above. */
export function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (xs[i] - mx) * (ys[i] - my);
  return acc / (n - 1);
}

/** Pearson correlation. Returns 0 when either series is flat (undefined, not 0). */
export function correlation(xs: number[], ys: number[]): number {
  const sx = stddev(xs);
  const sy = stddev(ys);
  if (sx === 0 || sy === 0) return 0;
  return covariance(xs, ys) / (sx * sy);
}

/**
 * Herfindahl–Hirschman index: Σ wᵢ².
 *
 * 1 = everything in one position; 1/n = perfectly even. Used as (1 − HHI) in the
 * diversification score, because it penalizes a few DOMINANT names rather than
 * merely a small number of names.
 */
export function herfindahl(weights: number[]): number {
  return sum(weights.map((w) => w * w));
}

/**
 * Normalized Shannon entropy, 0–1.
 *
 * This is the load-bearing choice in the diversification score. A portfolio with
 * 10 sectors where one is 91% is NOT diversified, but a naive "count of distinct
 * sectors" scores it identically to an evenly-spread book. Entropy separates them.
 */
export function normalizedEntropy(weights: number[]): number {
  const positive = weights.filter((w) => w > 0);
  if (positive.length <= 1) return 0;

  const total = sum(positive);
  if (total <= 0) return 0;

  const h = -sum(positive.map((w) => {
    const p = w / total;
    return p * Math.log(p);
  }));

  // ln(n) is the maximum possible entropy for n buckets — normalizes to 0–1.
  return h / Math.log(positive.length);
}

/** Linear ramp to 1.0 at `target`, then flat. */
export function saturate(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(1, Math.max(0, value / target));
}

/** OLS slope + intercept of y on x. Slope is Beta; intercept is (unannualized) Alpha. */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const varX = variance(xs);
  if (varX === 0) return { slope: 0, intercept: mean(ys), r2: 0 };

  const slope = covariance(xs, ys) / varX;
  const intercept = mean(ys) - slope * mean(xs);
  const r = correlation(xs, ys);

  return { slope, intercept, r2: r * r };
}

/** Compounds a return series: Π(1 + rᵢ) − 1. This is the Time-Weighted Return. */
export function compound(returns: number[]): number {
  return returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Scales a cumulative return to an annual rate over `days` calendar days. */
export function annualize(totalReturn: number, days: number): number {
  if (days <= 0) return 0;
  const years = days / 365;
  // Sub-year periods would otherwise extrapolate wildly (a 2% gain over 3 days
  // annualizes to something absurd). Guard the exponent.
  if (years < 1 / 365) return 0;
  return (1 + totalReturn) ** (1 / years) - 1;
}

export function groupSum(
  items: Array<{ key: string; value: number }>,
): Array<{ key: string; value: number }> {
  const acc = new Map<string, number>();
  for (const { key, value } of items) {
    acc.set(key, (acc.get(key) ?? 0) + value);
  }
  return [...acc.entries()].map(([key, value]) => ({ key, value }));
}
