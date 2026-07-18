/**
 * The shape every data provider (FMP today; Finnhub/AlphaVantage/Polygon
 * tomorrow) must fill in. Nothing in FundamentalService, ScoringEngine,
 * IndustryComparisonEngine, or ExplanationEngine imports a provider directly
 * or knows FMP exists — they depend on this interface and on
 * FundamentalSnapshot (the Prisma model), never on a provider's response
 * shape. Swapping providers means writing one new class that implements this
 * interface and pointing FundamentalsModule at it; no other file changes.
 */
export interface RawFundamentals {
  symbol: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number | null;

  peRatio: number | null;
  forwardPe: number | null;
  pegRatio: number | null;
  evToEbitda: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  enterpriseValue: number | null;

  revenueQoqPercent: number | null;
  revenueYoyPercent: number | null;
  netProfitQoqPercent: number | null;
  netProfitYoyPercent: number | null;
  revenueCagr3y: number | null;
  netProfitCagr3y: number | null;

  roe: number | null;
  roic: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;

  debtToEquity: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
  freeCashFlow: number | null;

  lastFourEarningsBeatPercent: number | null;
  nextEarningsDate: Date | null;

  dividendYield: number | null;
  dividendPerShare: number | null;
  exDividendDate: Date | null;
  paymentDate: Date | null;
}

export interface FundamentalsProvider {
  /** Provider identity, stamped onto FundamentalSnapshot.source for auditability. */
  readonly name: string;

  /**
   * Fetches everything FundamentalSnapshot needs for one symbol. Returns null
   * (never throws) when the symbol can't be resolved at all, so a bad ticker
   * in a batch doesn't take the rest of the batch down with it — the caller
   * (RefreshScheduler) decides how to handle a miss.
   */
  fetchOne(symbol: string): Promise<RawFundamentals | null>;
}
