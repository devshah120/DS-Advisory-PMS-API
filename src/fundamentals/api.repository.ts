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

  /** `source` records which provider produced this snapshot (e.g. "finnhub+fmp"); the caller passes the active provider's name so provenance stays honest. */
  upsertSnapshot(raw: RawFundamentals, source = 'fmp'): Promise<FundamentalSnapshot> {
    const data = { ...raw, source, refreshedAt: new Date() };
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

  /**
   * Every ticker the engine is allowed to score: the unique set across ALL
   * clients' holdings, plus every watchlist slot.
   *
   * This is the single definition of the symbol universe. Both the WRITE path
   * (RefreshScheduler deciding what to fetch and what to prune) and the READ
   * path (FundamentalService.list scoping what the table may show) call this,
   * so the Fundamentals table cannot drift from the book the way it did when
   * the read path served an unfiltered `findMany` — that is what let symbols
   * nobody owned (MSFT, CAT) and pre-Finnhub ETF rows keep rendering.
   *
   * ETFs are NOT filtered here: this is the requested universe, and a symbol
   * leaves it by the provider declining to serve it (see isFundVehicle), which
   * prunes the snapshot. Filtering funds here too would only hide them while
   * leaving the row in the database.
   */
  async listUniverseSymbols(): Promise<string[]> {
    const [holdings, watchlist] = await Promise.all([
      this.prisma.holding.findMany({ select: { ticker: true } }),
      this.prisma.watchlist.findMany({ select: { ticker: true } }),
    ]);
    const symbols = new Set<string>(
      [...holdings, ...watchlist]
        .map((row) => row.ticker?.trim().toUpperCase())
        .filter((t): t is string => !!t),
    );
    return [...symbols];
  }

  /**
   * Removes snapshots (and their scores) for symbols outside `keep`.
   *
   * Deleting the score alongside the snapshot is required, not tidiness:
   * FundamentalScore is keyed by symbol with no relation to cascade from, so an
   * orphaned score would keep being served for a symbol that has no snapshot.
   */
  async pruneSnapshotsOutside(keep: string[]): Promise<string[]> {
    const keepUpper = keep.map((s) => s.toUpperCase());
    const orphans = await this.prisma.fundamentalSnapshot.findMany({
      where: { symbol: { notIn: keepUpper } },
      select: { symbol: true },
    });
    if (orphans.length === 0) return [];

    const symbols = orphans.map((o) => o.symbol);
    await this.prisma.fundamentalScore.deleteMany({ where: { symbol: { in: symbols } } });
    await this.prisma.fundamentalSnapshot.deleteMany({ where: { symbol: { in: symbols } } });
    return symbols;
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
