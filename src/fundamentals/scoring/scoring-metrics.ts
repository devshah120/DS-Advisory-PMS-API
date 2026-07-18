/**
 * The full set of metric names the ScoringEngine understands, grouped by
 * pillar. This is the ONLY place a metric name is spelled out in code — it
 * exists so ScoringRule rows (DB data) and MetricInputs keys (code) can't
 * silently drift apart, and so IndustryComparisonEngine and the pillar
 * calculators share one vocabulary. Adding a metric to the model still means
 * touching this file (to compute the input value and register the key) plus
 * inserting ScoringRule rows — but it never means adding an if/switch that
 * decides a SCORE. Scoring itself stays 100% table-driven.
 */
export const GROWTH_METRICS = ['Revenue YoY', 'Profit YoY', 'Revenue CAGR 3Y', 'Profit CAGR 3Y'] as const;

export const PROFITABILITY_METRICS = ['ROE', 'ROIC', 'Operating Margin', 'Net Margin'] as const;

export const FINANCIAL_STRENGTH_METRICS = [
  'Debt / Equity',
  'Interest Coverage',
  'Current Ratio',
  'Free Cash Flow',
] as const;

export const VALUATION_METRICS = [
  'PE vs Industry',
  'PEG Ratio',
  'EV / EBITDA vs Industry',
  'Price / Sales vs Industry',
] as const;

export const MOMENTUM_METRICS = ['Revenue QoQ', 'Profit QoQ', 'Last Four Earnings Beat %'] as const;

export type GrowthMetric = (typeof GROWTH_METRICS)[number];
export type ProfitabilityMetric = (typeof PROFITABILITY_METRICS)[number];
export type FinancialStrengthMetric = (typeof FINANCIAL_STRENGTH_METRICS)[number];
export type ValuationMetric = (typeof VALUATION_METRICS)[number];
export type MomentumMetric = (typeof MOMENTUM_METRICS)[number];

export type MetricName =
  | GrowthMetric
  | ProfitabilityMetric
  | FinancialStrengthMetric
  | ValuationMetric
  | MomentumMetric;

export type Pillar = 'growth' | 'profitability' | 'financialStrength' | 'valuation' | 'momentum';

export const PILLAR_METRICS: Record<Pillar, readonly MetricName[]> = {
  growth: GROWTH_METRICS,
  profitability: PROFITABILITY_METRICS,
  financialStrength: FINANCIAL_STRENGTH_METRICS,
  valuation: VALUATION_METRICS,
  momentum: MOMENTUM_METRICS,
};

export const ALL_METRICS: readonly MetricName[] = [
  ...GROWTH_METRICS,
  ...PROFITABILITY_METRICS,
  ...FINANCIAL_STRENGTH_METRICS,
  ...VALUATION_METRICS,
  ...MOMENTUM_METRICS,
];
