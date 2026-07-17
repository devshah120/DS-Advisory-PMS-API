/**
 * XIRR — money-weighted return over irregular cash flows.
 *
 * Validated against `Portfolio June 2026.xlsx` (`XIRR Calc` sheet):
 *   2026-04-27  -98,996.68   (opening balance)
 *   2026-05-06  -48,800.00   (inflow)
 *   2026-05-06  -26,784.00   (inflow)
 *   2026-06-15  -14,200.00   (inflow)
 *   2026-06-25 +191,837.39   (closing value)
 *   => annualized 0.11999054551124572, interim 0.018486313662314124
 *
 * Those numbers are the fixture. An implementation that does not reproduce them
 * is wrong, and we know that in advance — which is the whole point of having them.
 */

export interface CashFlow {
  date: Date;
  /** Negative = money into the portfolio. Positive = money out / terminal value. */
  amount: number;
}

export type XirrResult =
  | { status: 'ok'; rate: number; iterations: number; method: 'newton' | 'bisection' }
  | { status: 'no-solution'; reason: string };

const DAYS_PER_YEAR = 365;
const MAX_NEWTON_ITERATIONS = 100;
const MAX_BISECTION_ITERATIONS = 200;
const TOLERANCE = 1e-9;

function yearsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * DAYS_PER_YEAR);
}

/** NPV of the flows at rate `r`, discounting from the first flow's date. */
function npv(flows: CashFlow[], r: number, t0: Date): number {
  let acc = 0;
  for (const f of flows) {
    const t = yearsBetween(t0, f.date);
    acc += f.amount / (1 + r) ** t;
  }
  return acc;
}

/** d(NPV)/dr — used by Newton–Raphson. */
function npvDerivative(flows: CashFlow[], r: number, t0: Date): number {
  let acc = 0;
  for (const f of flows) {
    const t = yearsBetween(t0, f.date);
    if (t === 0) continue; // constant term; contributes nothing to the derivative
    acc -= (t * f.amount) / (1 + r) ** (t + 1);
  }
  return acc;
}

/**
 * Newton–Raphson with a bisection fallback.
 *
 * The fallback is not defensive padding: Newton genuinely fails to converge on
 * real cash-flow patterns (multiple sign changes, a large late flow, a
 * near-zero terminal value). A naive implementation then returns NaN, silently
 * returns its initial guess, or spins. Bisection is slower but cannot fail on a
 * bracketed root — and when the root is NOT bracketed we say "no solution"
 * rather than inventing a rate.
 */
export function xirr(flows: CashFlow[], guess = 0.1): XirrResult {
  if (flows.length < 2) {
    return { status: 'no-solution', reason: 'At least two cash flows are required' };
  }

  const sorted = [...flows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const t0 = sorted[0].date;

  // A solvable IRR needs money in AND money out. All-negative or all-positive
  // flows have no root at any rate, and pretending otherwise produces a number
  // that means nothing.
  const hasNegative = sorted.some((f) => f.amount < 0);
  const hasPositive = sorted.some((f) => f.amount > 0);
  if (!hasNegative || !hasPositive) {
    return {
      status: 'no-solution',
      reason: 'Cash flows must include both inflows and outflows',
    };
  }

  // --- Newton–Raphson ---
  let rate = guess;
  for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
    const f = npv(sorted, rate, t0);
    if (Math.abs(f) < TOLERANCE) {
      return { status: 'ok', rate, iterations: i, method: 'newton' };
    }

    const df = npvDerivative(sorted, rate, t0);
    if (!Number.isFinite(df) || Math.abs(df) < 1e-12) break; // flat: Newton cannot step

    const next = rate - f / df;
    if (!Number.isFinite(next) || next <= -1) break; // stepped out of the valid domain

    if (Math.abs(next - rate) < TOLERANCE) {
      return { status: 'ok', rate: next, iterations: i, method: 'newton' };
    }
    rate = next;
  }

  // --- Bisection fallback ---
  // Rate must be > -100% (total loss is the floor). 10 = +1000%/yr upper bracket.
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(sorted, lo, t0);
  let fHi = npv(sorted, hi, t0);

  if (fLo * fHi > 0) {
    return {
      status: 'no-solution',
      reason: 'No sign change in [-99.99%, 1000%]; the cash flows have no IRR in that range',
    };
  }

  for (let i = 0; i < MAX_BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(sorted, mid, t0);

    if (Math.abs(fMid) < TOLERANCE || (hi - lo) / 2 < TOLERANCE) {
      return { status: 'ok', rate: mid, iterations: i, method: 'bisection' };
    }

    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  return { status: 'no-solution', reason: 'Bisection did not converge' };
}

/**
 * The workbook's "Interim Return": the annualized XIRR de-annualized back to the
 * actual holding period.
 *
 *     interim = (1 + xirr) ^ (days / 365) − 1
 *
 * Verified exact against the workbook: (1 + 0.11999054551124572) ^ (59/365) − 1
 * = 0.018486313662314124, to the last digit.
 *
 * This is deliberately NOT `gain / invested` (which gives 1.62% on the same
 * flows, not 1.85%). The distinction matters: because the benchmark figure is
 * computed the same way over the same 59 days, the workbook's "+1.85% portfolio
 * vs +1.92% S&P" is a like-for-like money-weighted comparison. A gain/invested
 * ratio would not be comparable to it.
 */
export function interimReturn(flows: CashFlow[]): number {
  const result = xirr(flows);
  if (result.status !== 'ok') return 0;

  const sorted = [...flows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const days = yearsBetween(sorted[0].date, sorted[sorted.length - 1].date) * DAYS_PER_YEAR;
  if (days <= 0) return 0;

  return (1 + result.rate) ** (days / DAYS_PER_YEAR) - 1;
}

/**
 * Benchmark XIRR by the **unit-purchase** method — the workbook's approach, and
 * the correct one.
 *
 * Each client cash flow notionally buys units of the index at that day's close.
 * This answers the question the client actually asks: *"what if this same money,
 * on these same dates, had gone into the S&P instead?"*
 *
 * A simple index point-to-point return does NOT answer that — it would credit or
 * penalize the benchmark for money that wasn't yet invested. That distinction is
 * why the workbook's comparison is trustworthy: portfolio +1.8486% vs S&P
 * +1.9235%, a 7bp shortfall. A sloppier construction could easily flip the sign
 * of that conclusion.
 */
export function benchmarkXirr(
  flows: CashFlow[],
  /** Index close on each flow date. Must align by index with `flows`. */
  indexCloses: number[],
  terminalIndexClose: number,
  terminalDate: Date,
): XirrResult {
  if (flows.length !== indexCloses.length) {
    return { status: 'no-solution', reason: 'Flow/index-close length mismatch' };
  }

  let totalUnits = 0;
  const synthetic: CashFlow[] = [];

  for (let i = 0; i < flows.length; i++) {
    const close = indexCloses[i];
    if (!close || close <= 0) {
      return {
        status: 'no-solution',
        reason: `Missing index close for ${flows[i].date.toISOString().slice(0, 10)}`,
      };
    }
    // Contribution (negative) buys units; the sign carries through so that a
    // withdrawal correctly sells units.
    totalUnits += flows[i].amount / close;
    synthetic.push({ date: flows[i].date, amount: flows[i].amount });
  }

  // What those units are worth today, had they tracked the index.
  const terminalValue = -totalUnits * terminalIndexClose;
  synthetic.push({ date: terminalDate, amount: terminalValue });

  return xirr(synthetic);
}
