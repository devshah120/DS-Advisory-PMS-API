import { Injectable, Logger } from '@nestjs/common';
import { FundamentalsProvider, RawFundamentals } from './fundamentals-provider.interface';
import { FinnhubFundamentalsProvider } from './finnhub-fundamentals.provider';
import { FmpFundamentalsProvider } from './fmp-fundamentals.provider';

// Fields FMP's statement-level endpoints add on top of what Finnhub's free tier
// exposes. Only these are ever backfilled — the primary (Finnhub) owns
// everything else, so a value present from Finnhub is never overwritten.
const FMP_ENRICHED_FIELDS = [
  'forwardPe',
  'evToEbitda',
  'enterpriseValue',
  'revenueQoqPercent',
  'netProfitQoqPercent',
  'freeCashFlow',
] as const satisfies readonly (keyof RawFundamentals)[];

/**
 * Finnhub-primary, FMP-fallback provider.
 *
 * Finnhub covers the whole ordinary-equity universe on its free tier, so it is
 * the source of record for every symbol. FMP's free tier only serves its
 * statement/ratio endpoints for a mega-cap whitelist (JPM, AAPL, ...), but for
 * those symbols it carries a few figures Finnhub's free tier does not
 * (EV/EBITDA, sequential QoQ growth, free cash flow). This provider takes the
 * Finnhub snapshot and, ONLY where a field is still null AND FMP is allowed to
 * serve that symbol, fills it in from FMP.
 *
 * A symbol FMP blocks (the common case) costs nothing extra beyond a single
 * cheap `profile` probe inside FmpFundamentalsProvider that returns null — the
 * Finnhub snapshot stands on its own. Nothing downstream knows two providers
 * were involved; the source stamp is "finnhub+fmp" for auditability.
 */
@Injectable()
export class CompositeFundamentalsProvider implements FundamentalsProvider {
  readonly name = 'finnhub+fmp';
  private readonly logger = new Logger(CompositeFundamentalsProvider.name);

  constructor(
    private readonly finnhub: FinnhubFundamentalsProvider,
    private readonly fmp: FmpFundamentalsProvider,
  ) {}

  async fetchOne(symbol: string): Promise<RawFundamentals | null> {
    const primary = await this.finnhub.fetchOne(symbol);
    // No Finnhub snapshot means no company behind the symbol (ETF/fund/bad
    // ticker). FMP can't rescue that — it has no fundamentals for funds either —
    // so skip, matching the Finnhub provider's own contract.
    if (!primary) return null;

    // Only reach out to FMP if there's actually something for it to fill.
    const missing = FMP_ENRICHED_FIELDS.filter((f) => primary[f] == null);
    if (missing.length === 0) return primary;

    let secondary: RawFundamentals | null = null;
    try {
      secondary = await this.fmp.fetchOne(symbol);
    } catch (err) {
      this.logger.warn(`FMP enrichment failed for ${symbol}: ${(err as Error).message}`);
    }
    if (!secondary) return primary;

    const enriched: RawFundamentals = { ...primary };
    for (const field of missing) {
      const value = secondary[field];
      if (value != null) {
        // `field` is a numeric enriched field; assign through its own key so the
        // assignment stays type-checked rather than widening to unknown.
        (enriched[field] as number | null) = value as number;
      }
    }
    return enriched;
  }
}
