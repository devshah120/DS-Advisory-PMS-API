import { ReturnSeries } from './types';
import { TRADING_DAYS_PER_YEAR, compound, mean, stddev } from './statistics';

/**
 * Flow-adjusted returns — the foundation every time-series metric sits on.
 *
 * Get this wrong and Beta, Sharpe, drawdown and attribution are all wrong
 * together, because they are all functions of this one series.
 *
 *                V_t − V_{t−1} − F_t
 *      r_t  =  ───────────────────────
 *                     V_{t−1}
 *
 * Why it matters, in this book's actual numbers: on 2026-05-06 the portfolio took
 * in $48,800 + $26,784 = $75,584 against a book of roughly $150k. The naive
 * (V_t − V_{t−1}) / V_{t−1} records that day as a **+50% return**. Feed that in and:
 *
 *   - volatility explodes (one fake 50% day dominates the whole stddev)
 *   - beta collapses toward zero (the S&P did not move 50% that day)
 *   - max drawdown silently misses real drawdowns (the fake spike resets the peak)
 *   - sharpe is corrupted in numerator and denominator simultaneously
 *
 * The client did not *earn* 50% that day; someone sent a wire.
 */

/** End-of-day convention (Modified Dietz with w=0): money arriving today did not
 *  earn today's return. */
export function flowAdjustedReturn(
  navToday: number,
  navYesterday: number,
  flowToday: number,
): number {
  if (navYesterday <= 0) return 0;
  return (navToday - navYesterday - flowToday) / navYesterday;
}

export function buildReturnSeries(
  points: Array<{ date: Date; nav: number; flow: number; stale?: boolean }>,
): ReturnSeries {
  const sorted = [...points].sort((a, b) => a.date.getTime() - b.date.getTime());

  const dates: Date[] = [];
  const values: number[] = [];
  const flows: number[] = [];
  const returns: number[] = [];
  const stale: boolean[] = [];

  for (let i = 0; i < sorted.length; i++) {
    dates.push(sorted[i].date);
    values.push(sorted[i].nav);
    flows.push(sorted[i].flow);
    stale.push(sorted[i].stale ?? false);

    // Day 0 has no prior NAV, so it has no return. It is not a 0% day — treating
    // it as one would drag the mean and understate volatility.
    returns.push(
      i === 0
        ? 0
        : flowAdjustedReturn(sorted[i].nav, sorted[i - 1].nav, sorted[i].flow),
    );
  }

  return { dates, values, flows, returns, stale };
}

/**
 * The returns actually fed to risk calculations.
 *
 * Drops day 0 (no prior NAV) and any day flagged stale. A stale price makes a
 * position look like it did not move, which makes volatility read artificially
 * LOW — and understating risk is the direction that hurts.
 */
export function usableReturns(series: ReturnSeries): number[] {
  return series.returns.filter((_, i) => i > 0 && !series.stale[i]);
}

/**
 * Time-Weighted Return: Π(1 + rᵢ) − 1.
 *
 * TWR measures MANAGER skill, because it is immune to the timing and size of
 * client cash flows — the manager did not choose when the wire arrived. This is
 * the correct basis for benchmark comparison.
 *
 * XIRR (see xirr.ts) is the money-weighted counterpart and answers the CLIENT's
 * question. Both are needed and they are not substitutes; with flows as large as
 * this book's they can differ by hundreds of basis points.
 */
export function timeWeightedReturn(series: ReturnSeries): number {
  return compound(usableReturns(series));
}

export function annualizedVolatility(returns: number[]): number {
  return stddev(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function annualizedMean(returns: number[]): number {
  return mean(returns) * TRADING_DAYS_PER_YEAR;
}

/** Returns over a window, aligned to a period boundary (MTD / QTD / YTD). */
export function periodReturn(series: ReturnSeries, from: Date): number {
  const idx = series.dates.findIndex((d) => d >= from);
  if (idx < 0) return 0;

  const window: ReturnSeries = {
    dates: series.dates.slice(idx),
    values: series.values.slice(idx),
    flows: series.flows.slice(idx),
    returns: series.returns.slice(idx),
    stale: series.stale.slice(idx),
  };
  return compound(window.returns.filter((_, i) => i > 0 && !window.stale[i]));
}

export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function startOfQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

export function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

/**
 * Aligns two return series on the trading days they SHARE.
 *
 * Never union-with-zeros: fabricating flat days for whichever series is missing
 * a bar biases correlation toward zero and understates beta. If a day is missing
 * from either series, it is not an observation.
 */
export function alignSeries(
  a: ReturnSeries,
  b: ReturnSeries,
): { a: number[]; b: number[]; dates: Date[] } {
  const key = (d: Date) => d.toISOString().slice(0, 10);

  const bByDate = new Map<string, number>();
  b.dates.forEach((d, i) => {
    if (i > 0 && !b.stale[i]) bByDate.set(key(d), b.returns[i]);
  });

  const outA: number[] = [];
  const outB: number[] = [];
  const dates: Date[] = [];

  a.dates.forEach((d, i) => {
    if (i === 0 || a.stale[i]) return;
    const match = bByDate.get(key(d));
    if (match === undefined) return;

    outA.push(a.returns[i]);
    outB.push(match);
    dates.push(d);
  });

  return { a: outA, b: outB, dates };
}
