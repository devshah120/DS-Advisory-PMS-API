import { Injectable } from '@nestjs/common';
import { FundamentalSnapshot } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RawFundamentals } from './providers/fundamentals-provider.interface';
import { FundamentalScoreResult } from './scoring/scoring-engine';
import { IndustryComparisonResult } from './scoring/industry-comparison.engine';
import { Explanation } from './scoring/explanation.engine';

/**
 * The only class in the Fundamentals Engine that touches Prisma. Every other
 * service (FundamentalService, ScoringEngine, IndustryComparisonEngine,
 * RefreshScheduler) either takes plain objects as arguments or goes through
 * this repository — so the persistence layer (Mongo via Prisma today) can
 * change without the scoring/explanation logic ever knowing.
 */
@Injectable()
export class ApiRepository {
  constructor(private prisma: PrismaService) {}

  upsertSnapshot(raw: RawFundamentals): Promise<FundamentalSnapshot> {
    const data = { ...raw, source: 'fmp', refreshedAt: new Date() };
    return this.prisma.fundamentalSnapshot.upsert({
      where: { symbol: raw.symbol },
      create: data,
      update: data,
    });
  }

  getSnapshot(symbol: string): Promise<FundamentalSnapshot | null> {
    return this.prisma.fundamentalSnapshot.findUnique({ where: { symbol: symbol.toUpperCase() } });
  }

  listSnapshots(symbols?: string[]): Promise<FundamentalSnapshot[]> {
    return this.prisma.fundamentalSnapshot.findMany({
      where: symbols ? { symbol: { in: symbols.map((s) => s.toUpperCase()) } } : undefined,
    });
  }

  listSnapshotsByIndustry(industry: string): Promise<FundamentalSnapshot[]> {
    return this.prisma.fundamentalSnapshot.findMany({ where: { industry } });
  }

  async upsertScore(
    symbol: string,
    strategy: string,
    result: FundamentalScoreResult,
    industryComparison: IndustryComparisonResult | null,
    explanation: Explanation,
  ) {
    const data = {
      symbol,
      strategy,
      overallScore: result.overallScore,
      growthScore: result.pillars.growth.score,
      profitabilityScore: result.pillars.profitability.score,
      financialStrengthScore: result.pillars.financialStrength.score,
      valuationScore: result.pillars.valuation.score,
      momentumScore: result.pillars.momentum.score,
      breakdown: result.breakdown as any,
      explanation: explanation as any,
      industryComparison: industryComparison as any,
      computedAt: new Date(),
    };
    return this.prisma.fundamentalScore.upsert({
      where: { symbol_strategy: { symbol, strategy } },
      create: data,
      update: data,
    });
  }

  getScore(symbol: string, strategy: string) {
    return this.prisma.fundamentalScore.findUnique({
      where: { symbol_strategy: { symbol: symbol.toUpperCase(), strategy } },
    });
  }

  listScores(strategy: string, symbols?: string[]) {
    return this.prisma.fundamentalScore.findMany({
      where: {
        strategy,
        ...(symbols ? { symbol: { in: symbols.map((s) => s.toUpperCase()) } } : {}),
      },
    });
  }

  listStrategies(): Promise<string[]> {
    return this.prisma.scoringRule
      .findMany({ distinct: ['strategy'], select: { strategy: true } })
      .then((rows) => rows.map((r) => r.strategy));
  }
}
