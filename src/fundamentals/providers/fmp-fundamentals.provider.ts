import { Injectable, Logger } from '@nestjs/common';
import { FundamentalsProvider, RawFundamentals } from './fundamentals-provider.interface';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const REQUEST_TIMEOUT_MS = 8000;

// A snapshot fans out to 8 endpoint calls per symbol; free-tier FMP rate-limits
// per API key regardless of which symbol or endpoint the calls are for. This
// gate serializes EVERY outbound request (across all symbols, all endpoints)
// behind one shared minimum interval, so refreshing N symbols costs roughly
// N * 8 * MIN_REQUEST_INTERVAL_MS however that fan-out is scheduled upstream —
// RefreshScheduler's inter-symbol sleep is a courtesy on top of this, not the
// only thing standing between the adapter and a 429.
const MIN_REQUEST_INTERVAL_MS = 350;
let nextSlot = 0;

function reserveSlot(): Promise<void> {
  const now = Date.now();
  const runAt = Math.max(now, nextSlot);
  nextSlot = runAt + MIN_REQUEST_INTERVAL_MS;
  const delay = runAt - now;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

/**
 * Financial Modeling Prep adapter. The free tier caps `limit` at 5 and
 * rejects `period=quarter` on `ratios`/`key-metrics` outright (402 Premium),
 * which is why valuation/profitability/financial-strength figures below are
 * sourced from the latest ANNUAL filing. Growth figures (QoQ/YoY) are derived
 * from 5 quarters of `income-statement` directly — QoQ compares the latest
 * quarter to the one before it, YoY compares it to the same quarter a year
 * back — rather than trusted from `financial-growth`, whose quarterly
 * `revenueGrowth`/`netIncomeGrowth` fields are sequential (QoQ) even when
 * read at a glance they look like they might be YoY. Upgrading the plan later
 * only changes the `period`/`limit` arguments in this file — nothing above
 * this adapter needs to know.
 */
@Injectable()
export class FmpFundamentalsProvider implements FundamentalsProvider {
  readonly name = 'fmp';
  private readonly logger = new Logger(FmpFundamentalsProvider.name);
  private readonly apiKey = process.env.FMP_API_KEY;

  async fetchOne(rawSymbol: string): Promise<RawFundamentals | null> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || !this.apiKey) return null;

    const [profile, ratios, keyMetrics, incomeAnnual, incomeQuarterly, earnings, estimates, dividends] =
      await Promise.all([
        this.getFirst(`profile?symbol=${symbol}`),
        this.getFirst(`ratios?symbol=${symbol}&period=annual&limit=1`),
        this.getFirst(`key-metrics?symbol=${symbol}&period=annual&limit=1`),
        this.getList(`income-statement?symbol=${symbol}&period=annual&limit=5`),
        this.getList(`income-statement?symbol=${symbol}&period=quarter&limit=5`),
        this.getList(`earnings?symbol=${symbol}&limit=5`),
        this.getList(`analyst-estimates?symbol=${symbol}&period=annual&limit=2`),
        this.getList(`dividends?symbol=${symbol}&limit=1`),
      ]);

    if (!profile) return null;

    const nextEarnings = earnings.find((e) => e.epsActual == null) ?? null;
    const forwardEstimate = estimates.find((e) => new Date(e.date).getFullYear() > new Date().getFullYear());

    return {
      symbol,
      company: profile.companyName ?? symbol,
      sector: profile.sector || 'Unclassified',
      industry: profile.industry || 'Unclassified',
      marketCap: numberOrNull(profile.marketCap),

      peRatio: numberOrNull(ratios?.priceToEarningsRatio),
      forwardPe: this.forwardPe(profile.price, forwardEstimate?.epsAvg),
      pegRatio: numberOrNull(ratios?.priceToEarningsGrowthRatio),
      evToEbitda: numberOrNull(keyMetrics?.evToEBITDA),
      priceToSales: numberOrNull(ratios?.priceToSalesRatio),
      priceToBook: numberOrNull(ratios?.priceToBookRatio),
      enterpriseValue: numberOrNull(keyMetrics?.enterpriseValue),

      revenueQoqPercent: percentOrNull(this.sequentialGrowth(incomeQuarterly, 'revenue')),
      revenueYoyPercent: percentOrNull(this.yoyGrowth(incomeQuarterly, 'revenue')),
      netProfitQoqPercent: percentOrNull(this.sequentialGrowth(incomeQuarterly, 'netIncome')),
      netProfitYoyPercent: percentOrNull(this.yoyGrowth(incomeQuarterly, 'netIncome')),
      revenueCagr3y: percentOrNull(this.cagr(incomeAnnual, 'revenue', 3)),
      netProfitCagr3y: percentOrNull(this.cagr(incomeAnnual, 'netIncome', 3)),

      roe: percentOrNull(keyMetrics?.returnOnEquity),
      roic: percentOrNull(keyMetrics?.returnOnInvestedCapital),
      grossMargin: percentOrNull(ratios?.grossProfitMargin),
      operatingMargin: percentOrNull(ratios?.operatingProfitMargin),
      netMargin: percentOrNull(ratios?.netProfitMargin),

      debtToEquity: numberOrNull(ratios?.debtToEquityRatio),
      currentRatio: numberOrNull(ratios?.currentRatio),
      interestCoverage: numberOrNull(ratios?.interestCoverageRatio),
      freeCashFlow: numberOrNull(keyMetrics?.freeCashFlowToFirm),

      lastFourEarningsBeatPercent: this.earningsBeatPercent(earnings),
      nextEarningsDate: nextEarnings ? new Date(nextEarnings.date) : null,

      dividendYield: percentOrNull(ratios?.dividendYieldPercentage),
      dividendPerShare: numberOrNull(ratios?.dividendPerShare),
      exDividendDate: dividends[0] ? new Date(dividends[0].date) : null,
      paymentDate: dividends[0]?.paymentDate ? new Date(dividends[0].paymentDate) : null,
    };
  }

  /** price / next fiscal year's average analyst EPS estimate. */
  private forwardPe(price: unknown, forwardEps: unknown): number | null {
    const p = numberOrNull(price);
    const eps = numberOrNull(forwardEps);
    if (p == null || eps == null || eps === 0) return null;
    return p / eps;
  }

  /** Compound annual growth rate across the oldest-to-newest span available, capped at `years`. */
  private cagr(income: any[], field: 'revenue' | 'netIncome', years: number): number | null {
    if (income.length < 2) return null;
    const span = Math.min(years, income.length - 1);
    const latest = numberOrNull(income[0]?.[field]);
    const base = numberOrNull(income[span]?.[field]);
    if (latest == null || base == null || base <= 0 || latest <= 0) return null;
    return (latest / base) ** (1 / span) - 1;
  }

  /** Latest reported quarter vs. the immediately preceding quarter (sequential/QoQ). */
  private sequentialGrowth(quarters: any[], field: 'revenue' | 'netIncome'): number | null {
    if (quarters.length < 2) return null;
    return this.growthBetween(quarters[0]?.[field], quarters[1]?.[field]);
  }

  /** Latest reported quarter vs. the same quarter one year earlier — true YoY, not sequential. */
  private yoyGrowth(quarters: any[], field: 'revenue' | 'netIncome'): number | null {
    if (quarters.length === 0) return null;
    const latest = quarters[0];
    const latestPeriod = `${latest?.period}`;
    const latestYear = Number(latest?.fiscalYear);
    const yearAgo = quarters.find(
      (q) => `${q.period}` === latestPeriod && Number(q.fiscalYear) === latestYear - 1,
    );
    // Five quarters back covers "same quarter, prior year" exactly when limit=5 starts
    // at the latest quarter; fall back to index 4 if fiscalYear/period didn't line up
    // (e.g. a fiscal-year company where the labels don't match calendar quarters).
    const fallback = quarters.length >= 5 ? quarters[4] : null;
    const comparison = yearAgo ?? fallback;
    if (!comparison) return null;
    return this.growthBetween(latest?.[field], comparison[field]);
  }

  private growthBetween(latest: unknown, prior: unknown): number | null {
    const l = numberOrNull(latest);
    const p = numberOrNull(prior);
    if (l == null || p == null || p === 0) return null;
    return (l - p) / Math.abs(p);
  }

  /**
   * Average surprise across up to the last 4 REPORTED quarters (epsActual
   * present), as a percent of the estimate. FMP's dedicated
   * earnings-surprises endpoints are gated on this plan; `earnings` carries
   * both actual and estimate per quarter, which is the same data.
   */
  private earningsBeatPercent(earnings: any[]): number | null {
    const reported = earnings.filter((e) => e.epsActual != null && e.epsEstimated).slice(0, 4);
    if (reported.length === 0) return null;
    const surprises = reported.map((e) => ((e.epsActual - e.epsEstimated) / Math.abs(e.epsEstimated)) * 100);
    return surprises.reduce((s, v) => s + v, 0) / surprises.length;
  }

  private async getFirst(path: string): Promise<any | null> {
    const list = await this.getList(path);
    return list[0] ?? null;
  }

  private async getList(path: string): Promise<any[]> {
    await reserveSlot();
    const sep = path.includes('?') ? '&' : '?';
    try {
      const response = await fetch(`${FMP_BASE}/${path}${sep}apikey=${this.apiKey}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`FMP request failed (${response.status}): ${path}`);
        return [];
      }
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      this.logger.warn(`FMP request errored (${path}): ${(error as Error).message}`);
      return [];
    }
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** FMP reports ratios like margins/ROE/growth as decimals (0.25); the engine and UI work in percent points (25). */
function percentOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n == null ? null : n * 100;
}
