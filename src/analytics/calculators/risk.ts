import { MIN_OBSERVATIONS, MetricResult, ReturnSeries, insufficient, ok } from './types';
import { alignSeries, annualizedMean, annualizedVolatility } from './returns';
import {
  TRADING_DAYS_PER_YEAR,
  correlation,
  linearRegression,
  mean,
  stddev,
  sum,
  variance,
} from './statistics';

/**
 * Risk metrics.
 *
 * ── The most important thing in this file ────────────────────────────────────
 *
 * Nothing here returns a bare number. Every metric returns MetricResult<T>, which
 * is either { status: 'ok', value } or { status: 'insufficient', required,
 * available }.
 *
 * This is not defensive over-engineering. This book has ~40 trading days of
 * history against two years of benchmark. The standard error on a Beta estimated
 * from 40 daily observations is large enough that the confidence interval
 * comfortably spans 0.5 to 1.5 — the estimate is indistinguishable from noise.
 * Rendering "0.87" on a client factsheet implies a precision that does not exist,
 * and a client who acts on it is acting on a coin flip presented as a measurement.
 *
 * The UI must render the REASON ("insufficient history: 40/60 days"), not a dash
 * and not a zero. Both of those read as "we measured this, and it's fine."
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface RiskInputs {
  portfolio: ReturnSeries;
  benchmark: ReturnSeries;
  /** Annual risk-free rate, e.g. 0.045. From config — never hardcoded. */
  riskFreeRate: number;
  /** Minimum acceptable return for Sortino. Defaults to the risk-free rate. */
  mar?: number;
}

export interface RiskMetrics {
  beta: MetricResult<number>;
  alpha: MetricResult<number>;
  standardDeviation: MetricResult<number>;
  volatility: MetricResult<number>;
  sharpe: MetricResult<number>;
  sortino: MetricResult<number>;
  treynor: MetricResult<number>;
  trackingError: MetricResult<number>;
  informationRatio: MetricResult<number>;
  correlation: MetricResult<number>;
  rSquared: MetricResult<number>;
  upsideCapture: MetricResult<number>;
  downsideCapture: MetricResult<number>;
  observations: number;
}

export function riskMetrics(inputs: RiskInputs): RiskMetrics {
  const { riskFreeRate } = inputs;
  const mar = inputs.mar ?? riskFreeRate;

  // Intersecting trading days only. See alignSeries — union-with-zeros would
  // fabricate flat days and bias correlation toward zero.
  const { a: rp, b: rb } = alignSeries(inputs.portfolio, inputs.benchmark);
  const n = rp.length;

  const dailyRf = riskFreeRate / TRADING_DAYS_PER_YEAR;
  const dailyMar = mar / TRADING_DAYS_PER_YEAR;

  // ── Beta / Alpha / R² : one regression, three outputs ──────────────────────
  const canRegress = n >= MIN_OBSERVATIONS.beta;
  const reg = canRegress ? linearRegression(rb, rp) : null;

  const beta: MetricResult<number> = reg
    ? ok(reg.slope, n)
    : insufficient(MIN_OBSERVATIONS.beta, n, 'Beta');

  // Jensen's alpha, annualized: r̄ₚ − [r_f + β(r̄_b − r_f)]
  const alpha: MetricResult<number> = reg
    ? ok(
        annualizedMean(rp) -
          (riskFreeRate + reg.slope * (annualizedMean(rb) - riskFreeRate)),
        n,
      )
    : insufficient(MIN_OBSERVATIONS.beta, n, 'Alpha');

  const rSquared: MetricResult<number> = reg
    ? ok(reg.r2, n)
    : insufficient(MIN_OBSERVATIONS.beta, n, 'R-squared');

  // ── Dispersion ─────────────────────────────────────────────────────────────
  const canVol = n >= MIN_OBSERVATIONS.volatility;

  const standardDeviation: MetricResult<number> = canVol
    ? ok(stddev(rp), n)
    : insufficient(MIN_OBSERVATIONS.volatility, n, 'Standard deviation');

  const volatility: MetricResult<number> = canVol
    ? ok(annualizedVolatility(rp), n)
    : insufficient(MIN_OBSERVATIONS.volatility, n, 'Volatility');

  // ── Risk-adjusted returns ──────────────────────────────────────────────────
  const canSharpe = n >= MIN_OBSERVATIONS.sharpe;
  const sigma = stddev(rp);

  const sharpe: MetricResult<number> =
    !canSharpe
      ? insufficient(MIN_OBSERVATIONS.sharpe, n, 'Sharpe ratio')
      : sigma === 0
        ? insufficient(MIN_OBSERVATIONS.sharpe, n, 'Sharpe ratio (zero volatility)')
        : ok(
            ((mean(rp) - dailyRf) / sigma) * Math.sqrt(TRADING_DAYS_PER_YEAR),
            n,
          );

  // Downside deviation: only returns BELOW the MAR contribute. This is the whole
  // point of Sortino — upside volatility is not risk.
  const downside = rp.filter((r) => r < dailyMar);
  const downsideDev = downside.length
    ? Math.sqrt(sum(downside.map((r) => (r - dailyMar) ** 2)) / downside.length)
    : 0;

  const sortino: MetricResult<number> =
    !canSharpe
      ? insufficient(MIN_OBSERVATIONS.sortino, n, 'Sortino ratio')
      : downsideDev === 0
        ? insufficient(MIN_OBSERVATIONS.sortino, n, 'Sortino ratio (no downside periods)')
        : ok(
            ((mean(rp) - dailyRf) / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR),
            n,
          );

  // Treynor divides by beta, so a near-zero beta makes it explode. A portfolio
  // with beta 0.02 does not have a Treynor ratio of 40 — it has an undefined one.
  const treynor: MetricResult<number> =
    !reg
      ? insufficient(MIN_OBSERVATIONS.beta, n, 'Treynor ratio')
      : Math.abs(reg.slope) < 0.1
        ? insufficient(MIN_OBSERVATIONS.beta, n, 'Treynor ratio (|beta| < 0.1; ratio undefined)')
        : ok((annualizedMean(rp) - riskFreeRate) / reg.slope, n);

  // ── Active risk ────────────────────────────────────────────────────────────
  const active = rp.map((r, i) => r - rb[i]);
  const te = stddev(active) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const trackingError: MetricResult<number> = canVol
    ? ok(te, n)
    : insufficient(MIN_OBSERVATIONS.volatility, n, 'Tracking error');

  const informationRatio: MetricResult<number> =
    !canVol
      ? insufficient(MIN_OBSERVATIONS.volatility, n, 'Information ratio')
      : te < 1e-9
        ? insufficient(MIN_OBSERVATIONS.volatility, n, 'Information ratio (zero tracking error)')
        : ok((annualizedMean(rp) - annualizedMean(rb)) / te, n);

  const corr: MetricResult<number> =
    n >= MIN_OBSERVATIONS.correlation
      ? ok(correlation(rp, rb), n)
      : insufficient(MIN_OBSERVATIONS.correlation, n, 'Correlation');

  // ── Capture ratios ─────────────────────────────────────────────────────────
  // Up- and down-periods are counted SEPARATELY: a series can have 60 total
  // observations but only 8 down-days, and an 8-observation downside capture is
  // not a measurement.
  const upIdx = rb.map((r, i) => (r > 0 ? i : -1)).filter((i) => i >= 0);
  const downIdx = rb.map((r, i) => (r < 0 ? i : -1)).filter((i) => i >= 0);

  const capture = (idx: number[], label: string): MetricResult<number> => {
    if (idx.length < MIN_OBSERVATIONS.capture) {
      return insufficient(MIN_OBSERVATIONS.capture, idx.length, label);
    }
    const benchSum = sum(idx.map((i) => rb[i]));
    if (Math.abs(benchSum) < 1e-12) {
      return insufficient(MIN_OBSERVATIONS.capture, idx.length, `${label} (benchmark flat)`);
    }
    return ok(sum(idx.map((i) => rp[i])) / benchSum, idx.length);
  };

  return {
    beta,
    alpha,
    standardDeviation,
    volatility,
    sharpe,
    sortino,
    treynor,
    trackingError,
    informationRatio,
    correlation: corr,
    rSquared,
    upsideCapture: capture(upIdx, 'Upside capture'),
    downsideCapture: capture(downIdx, 'Downside capture'),
    observations: n,
  };
}
