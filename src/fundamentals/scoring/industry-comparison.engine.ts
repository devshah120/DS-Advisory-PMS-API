import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FundamentalSnapshot } from '@prisma/client';

export type IndustryComparisonMetric = 'peRatio' | 'forwardPe' | 'evToEbitda' | 'priceToSales' | 'roe' | 'roic';

const METRIC_LABELS: Record<IndustryComparisonMetric, string> = {
  peRatio: 'PE',
  forwardPe: 'Forward PE',
  evToEbitda: 'EV / EBITDA',
  priceToSales: 'Price / Sales',
  roe: 'ROE',
  roic: 'ROIC',
};

export interface IndustryMetricComparison {
  metric: string;
  company: number | null;
  industryAverage: number | null;
  /** (company - industryAverage) / |industryAverage|, as a percent. Positive = company trades at a premium. */
  premiumDiscountPercent: number | null;
}

export interface IndustryComparisonResult {
  industry: string;
  peerCount: number;
  metrics: IndustryMetricComparison[];
}

/**
 * Computes each company's valuation/profitability multiples against the mean
 * of every OTHER snapshot sharing its `industry` string. Deliberately reads
 * industry averages from FundamentalSnapshot (the engine's own data), not
 * from any external "industry benchmark" feed — the peer set the engine
 * scores a company against is exactly the peer set it has fundamentals for.
 */
@Injectable()
export class IndustryComparisonEngine {
  constructor(private prisma: PrismaService) {}

  async compare(symbol: string): Promise<IndustryComparisonResult | null> {
    const target = await this.prisma.fundamentalSnapshot.findUnique({ where: { symbol } });
    if (!target) return null;

    const peers = await this.prisma.fundamentalSnapshot.findMany({
      where: { industry: target.industry },
    });

    return this.compareAgainst(target, peers);
  }

  /** Same computation, but against an already-fetched peer set — avoids an N+1 when scoring a whole industry in one refresh pass. */
  compareAgainst(target: FundamentalSnapshot, peers: FundamentalSnapshot[]): IndustryComparisonResult {
    const metrics = (Object.keys(METRIC_LABELS) as IndustryComparisonMetric[]).map((key) =>
      this.compareOne(key, target, peers),
    );

    return {
      industry: target.industry,
      peerCount: Math.max(0, peers.length - 1), // excludes the company itself
      metrics,
    };
  }

  private compareOne(
    key: IndustryComparisonMetric,
    target: FundamentalSnapshot,
    peers: FundamentalSnapshot[],
  ): IndustryMetricComparison {
    const company = target[key] as number | null;

    // The company's own row is excluded from its own industry average — a
    // single-stock "industry" of one would otherwise always show 0% premium.
    const peerValues = peers
      .filter((p) => p.symbol !== target.symbol)
      .map((p) => p[key] as number | null)
      .filter((v): v is number => v != null);

    const industryAverage = peerValues.length > 0 ? peerValues.reduce((s, v) => s + v, 0) / peerValues.length : null;

    const premiumDiscountPercent =
      company != null && industryAverage != null && industryAverage !== 0
        ? ((company - industryAverage) / Math.abs(industryAverage)) * 100
        : null;

    return { metric: METRIC_LABELS[key], company, industryAverage, premiumDiscountPercent };
  }
}
