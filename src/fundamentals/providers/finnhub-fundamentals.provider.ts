import { Injectable, Logger } from '@nestjs/common';
import { FundamentalsProvider, RawFundamentals } from './fundamentals-provider.interface';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const REQUEST_TIMEOUT_MS = 8000;

// Finnhub's free tier rate-limits per API key (60 req/min). A snapshot fans out
// to 3 endpoint calls per symbol; this gate serializes EVERY outbound request
// behind one shared minimum interval so a batch refresh can't trip the limit.
// 1100ms keeps well under 60/min even with the scheduler running symbols back
// to back.
const MIN_REQUEST_INTERVAL_MS = 1100;
let nextSlot = 0;

function reserveSlot(): Promise<void> {
  const now = Date.now();
  const runAt = Math.max(now, nextSlot);
  nextSlot = runAt + MIN_REQUEST_INTERVAL_MS;
  const delay = runAt - now;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

/**
 * Finnhub adapter. Unlike FMP's free tier — which whitelists a handful of
 * mega-cap US symbols for its statement/ratio endpoints and 402s everything
 * else — Finnhub's free `stock/metric` returns fundamentals for the whole
 * ordinary-equity universe, which is why this is the primary provider.
 *
 * Three free endpoints per symbol:
 *   profile2       — company, marketCap, industry (ETFs return {} → skipped)
 *   metric=all     — valuation / profitability / strength / growth ratios
 *   earnings       — surprise history for lastFourEarningsBeatPercent
 *
 * Fields Finnhub's free tier does not expose (forwardPe, evToEbitda,
 * enterpriseValue, sequential QoQ growth, freeCashFlow) are returned null.
 * The scoring engine handles a null metric per-pillar, so those simply don't
 * contribute rather than zeroing a score — and CompositeFundamentalsProvider
 * backfills them from FMP for the symbols FMP is allowed to serve.
 *
 * Finnhub already reports margins/ROE/growth in PERCENT POINTS (25, not 0.25),
 * so — unlike the FMP adapter — those values are passed straight through with
 * no *100 conversion.
 */
@Injectable()
export class FinnhubFundamentalsProvider implements FundamentalsProvider {
  readonly name = 'finnhub';
  private readonly logger = new Logger(FinnhubFundamentalsProvider.name);
  private readonly apiKey = process.env.FINNHUB_API_KEY;

  async fetchOne(rawSymbol: string): Promise<RawFundamentals | null> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || !this.apiKey) return null;

    const [profile, metricResp, earnings] = await Promise.all([
      this.getJson(`stock/profile2?symbol=${symbol}`),
      this.getJson(`stock/metric?symbol=${symbol}&metric=all`),
      this.getJson(`stock/earnings?symbol=${symbol}`),
    ]);

    // An empty profile2 means Finnhub has no company behind this symbol — an
    // ETF/fund (EWQ, URNM, MCHI) or a bad ticker. Either way there are no
    // company fundamentals to score, so skip it rather than persist a row of
    // nulls that renders as a 0.
    if (!profile || Object.keys(profile).length === 0) return null;

    const m = (metricResp?.metric ?? {}) as Record<string, unknown>;

    return {
      symbol,
      company: str(profile.name) ?? symbol,
      // Finnhub gives one "finnhubIndustry" bucket, not a separate sector; use it
      // for both. IndustryComparisonEngine groups on `industry`, which is what
      // matters for peer sets.
      sector: str(profile.finnhubIndustry) || 'Unclassified',
      industry: str(profile.finnhubIndustry) || 'Unclassified',
      // profile2.marketCapitalization is in MILLIONS; normalize to absolute.
      marketCap: mul(num(profile.marketCapitalization), 1_000_000),

      peRatio: num(m.peTTM),
      forwardPe: null, // not on free tier — backfilled by FMP where allowed
      pegRatio: num(m.pegTTM),
      evToEbitda: null, // not on free tier
      priceToSales: num(m.psTTM),
      priceToBook: num(m.pbQuarterly),
      enterpriseValue: null, // not on free tier

      revenueQoqPercent: null, // Finnhub free exposes YoY only, not sequential
      revenueYoyPercent: num(m.revenueGrowthQuarterlyYoy),
      netProfitQoqPercent: null,
      // EPS growth as the net-profit proxy — the metric Finnhub free exposes.
      netProfitYoyPercent: num(m.epsGrowthQuarterlyYoy),
      revenueCagr3y: num(m.revenueGrowth3Y),
      netProfitCagr3y: num(m.epsGrowth3Y),

      roe: num(m.roeTTM),
      roic: num(m.roiTTM), // ROI ~ ROIC; closest the free tier offers
      grossMargin: num(m.grossMarginTTM),
      operatingMargin: num(m.operatingMarginTTM),
      netMargin: num(m.netProfitMarginTTM),

      debtToEquity: num(m['totalDebt/totalEquityQuarterly']),
      currentRatio: num(m.currentRatioQuarterly),
      interestCoverage: num(m.netInterestCoverageTTM),
      freeCashFlow: null, // free tier gives per-share only; left to FMP

      lastFourEarningsBeatPercent: this.earningsBeatPercent(earnings),
      nextEarningsDate: null, // requires earnings-calendar; left null for now

      dividendYield: num(m.dividendYieldIndicatedAnnual),
      dividendPerShare: num(m.dividendPerShareTTM),
      exDividendDate: null,
      paymentDate: null,
    };
  }

  /**
   * Average surprisePercent across up to the last 4 reported quarters.
   * Finnhub's `earnings` reports surprisePercent as points already (0.34 = a
   * 0.34% beat), so it maps straight onto lastFourEarningsBeatPercent.
   */
  private earningsBeatPercent(earnings: unknown): number | null {
    if (!Array.isArray(earnings)) return null;
    const surprises = earnings
      .map((e) => num((e as any)?.surprisePercent))
      .filter((v): v is number => v != null)
      .slice(0, 4);
    if (surprises.length === 0) return null;
    return surprises.reduce((s, v) => s + v, 0) / surprises.length;
  }

  private async getJson(path: string): Promise<any | null> {
    await reserveSlot();
    const sep = path.includes('?') ? '&' : '?';
    try {
      const response = await fetch(`${FINNHUB_BASE}/${path}${sep}token=${this.apiKey}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Finnhub request failed (${response.status}): ${path}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn(`Finnhub request errored (${path}): ${(error as Error).message}`);
      return null;
    }
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mul(value: number | null, factor: number): number | null {
  return value == null ? null : value * factor;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
