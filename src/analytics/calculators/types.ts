/**
 * The contract between the data layer and the math layer.
 *
 * Every calculator in this directory consumes one of these shapes and nothing
 * else — no Prisma, no clock, no config. That is what makes them testable
 * without infrastructure, and what stops client-level and house-level analytics
 * from drifting apart: they call the same functions with different inputs.
 */

export type AssetClass = 'EQUITY' | 'ETF' | 'FUND' | 'CASH_EQUIV';

export type Dimension = 'sector' | 'industry' | 'region' | 'country' | 'assetClass';

/** Weighted exposure decomposition for one instrument. Weights sum to 1. */
export type LookThroughMap = Partial<Record<Dimension, Array<{ key: string; weight: number }>>>;

export interface Classification {
  sector: string;
  industry: string;
  region: string;
  country: string;
  assetClass: AssetClass;
  lookThrough?: LookThroughMap | null;
}

export interface Position {
  ticker: string;
  company: string;
  quantity: number;
  /** Total cost basis (averageCost * quantity), not per-share. */
  costBasis: number;
  price: number;
  /**
   * ALWAYS quantity * price, derived by the snapshot service.
   *
   * The stored Holding.marketValue / Holding.weight / Client.portfolioValue
   * columns are a display cache for the CRUD UI and are already known to drift
   * (the live client "Dev" has portfolioValue=0 against $40,702 of holdings).
   * Analytics never read them.
   */
  marketValue: number;
  costBasisTotal: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dividends: number;
  classification: Classification;
  /** null = no model assigned. NOT the same as a target of zero — see rebalance.ts. */
  targetWeight: number | null;
}

/** A portfolio as of a single instant. Input to all cross-sectional analytics. */
export interface PortfolioSnapshot {
  clientId: string;
  clientName: string;
  asOf: Date;
  baseCurrency: string;
  cash: number;
  positions: Position[];
}

/** A daily-valued portfolio over time. Input to all time-series analytics. */
export interface ReturnSeries {
  dates: Date[];
  /** NAV, gross of external flows. */
  values: number[];
  /** External contributions (+) / withdrawals (−), aligned by index. */
  flows: number[];
  /** Flow-adjusted daily returns. See returns.ts. */
  returns: number[];
  /** Days where a price was carried forward; excluded from volatility. */
  stale: boolean[];
}

/**
 * "Allocation %" is ambiguous when cash is 21.3% of the book, as it is here.
 * A position that is 5.0% of total assets is 6.4% of securities — concentration
 * limits fire in different places depending on which is meant.
 *
 * TOTAL_ASSETS is the default: it matches the workbook, and it is the only
 * denominator under which the weights of everything owned sum to exactly 1.
 */
export type Denominator = 'TOTAL_ASSETS' | 'SECURITIES_ONLY';

export interface AllocationSlice {
  key: string;
  value: number;
  weight: number;
}

/**
 * Risk metrics are never returned as a bare number.
 *
 * With ~40 trading days of portfolio history, the standard error on a Beta
 * estimate spans roughly 0.5–1.5. Rendering "0.87" implies a precision that does
 * not exist. The engine reports the gap instead, and the UI must render the
 * reason rather than a dash or a zero — both of those read as "we measured this
 * and it's fine".
 */
export type MetricResult<T> =
  | { status: 'ok'; value: T; observations: number; confidence: 'high' | 'moderate' }
  | { status: 'insufficient'; required: number; available: number; reason: string };

export const MIN_OBSERVATIONS = {
  /** ~3 months of daily bars. Below this the standard error dominates the estimate. */
  beta: 60,
  sharpe: 60,
  sortino: 60,
  volatility: 30,
  correlation: 30,
  /** Counted separately for up-periods and down-periods. */
  capture: 12,
  /** Drawdown is a path property, not an estimate, so it tolerates far less data. */
  drawdown: 20,
} as const;

export function ok<T>(value: T, observations: number): MetricResult<T> {
  return {
    status: 'ok',
    value,
    observations,
    confidence: observations >= 120 ? 'high' : 'moderate',
  };
}

export function insufficient<T>(
  required: number,
  available: number,
  what: string,
): MetricResult<T> {
  return {
    status: 'insufficient',
    required,
    available,
    reason: `${what} needs ${required} observations; ${available} available`,
  };
}
