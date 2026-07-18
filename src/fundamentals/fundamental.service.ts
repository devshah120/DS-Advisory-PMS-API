import { Injectable, NotFoundException } from '@nestjs/common';
import { FundamentalSnapshot } from '@prisma/client';
import { ApiRepository } from './api.repository';
import { ScoringEngine, MetricInput } from './scoring/scoring-engine';
import { IndustryComparisonEngine, IndustryComparisonResult } from './scoring/industry-comparison.engine';
import { ExplanationEngine } from './scoring/explanation.engine';

const DEFAULT_STRATEGY = 'GARP';

export interface FundamentalView {
  symbol: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number | null;
  strategy: string;

  overallScore: number;
  growthScore: number;
  profitabilityScore: number;
  financialStrengthScore: number;
  valuationScore: number;
  momentumScore: number;
  breakdown: unknown;
  explanation: { strengths: string[]; weaknesses: string[] };
  industryComparison: IndustryComparisonResult | null;

  snapshot: FundamentalSnapshot;
  computedAt: Date;
}

/**
 * The Fundamentals Engine's single entry point. Orchestrates
 * IndustryComparisonEngine -> ScoringEngine -> ExplanationEngine for one
 * symbol (or a whole peer set at once, for the refresh job) and persists the
 * result via ApiRepository. Nothing outside this file decides HOW a score is
 * computed — RefreshScheduler and FundamentalsController both call through
 * here rather than assembling the pipeline themselves, so there is exactly
 * one place that pipeline can drift.
 */
@Injectable()
export class FundamentalService {
  constructor(
    private repository: ApiRepository,
    private scoringEngine: ScoringEngine,
    private industryEngine: IndustryComparisonEngine,
    private explanationEngine: ExplanationEngine,
  ) {}

  async getBySymbol(symbol: string, strategy = DEFAULT_STRATEGY): Promise<FundamentalView> {
    const snapshot = await this.repository.getSnapshot(symbol);
    if (!snapshot) {
      throw new NotFoundException(`No fundamentals snapshot for "${symbol.toUpperCase()}" — run a refresh first`);
    }

    const cached = await this.repository.getScore(symbol, strategy);
    if (cached) {
      return this.toView(snapshot, strategy, cached);
    }

    // No cached score yet for this symbol/strategy pair (e.g. a strategy just
    // authored in ScoringRule) — compute it on demand rather than 404ing.
    const peers = await this.repository.listSnapshotsByIndustry(snapshot.industry);
    return this.computeAndPersist(snapshot, peers, strategy);
  }

  async list(strategy = DEFAULT_STRATEGY, symbols?: string[]): Promise<FundamentalView[]> {
    const snapshots = await this.repository.listSnapshots(symbols);
    const scores = await this.repository.listScores(
      strategy,
      symbols,
    );
    const scoreBySymbol = new Map(scores.map((s) => [s.symbol, s]));

    return Promise.all(
      snapshots.map(async (snapshot) => {
        const cached = scoreBySymbol.get(snapshot.symbol);
        if (cached) return this.toView(snapshot, strategy, cached);
        const peers = await this.repository.listSnapshotsByIndustry(snapshot.industry);
        return this.computeAndPersist(snapshot, peers, strategy);
      }),
    );
  }

  /** Recomputes and persists the score for one snapshot against its already-fetched peer set. Used by both on-demand lookups and RefreshScheduler's batch pass. */
  async computeAndPersist(
    snapshot: FundamentalSnapshot,
    peers: FundamentalSnapshot[],
    strategy = DEFAULT_STRATEGY,
  ): Promise<FundamentalView> {
    const industryComparison = this.industryEngine.compareAgainst(snapshot, peers);
    const inputs = this.toMetricInputs(snapshot, industryComparison);
    const result = await this.scoringEngine.score(strategy, inputs);
    const explanation = this.explanationEngine.explain(snapshot, result.breakdown, industryComparison);

    await this.repository.upsertScore(snapshot.symbol, strategy, result, industryComparison, explanation);

    return {
      symbol: snapshot.symbol,
      company: snapshot.company,
      sector: snapshot.sector,
      industry: snapshot.industry,
      marketCap: snapshot.marketCap,
      strategy,
      overallScore: result.overallScore,
      growthScore: result.pillars.growth.score,
      profitabilityScore: result.pillars.profitability.score,
      financialStrengthScore: result.pillars.financialStrength.score,
      valuationScore: result.pillars.valuation.score,
      momentumScore: result.pillars.momentum.score,
      breakdown: result.breakdown,
      explanation,
      industryComparison,
      snapshot,
      computedAt: new Date(),
    };
  }

  /**
   * Maps a snapshot + its industry comparison onto the metric vocabulary the
   * ScoringEngine understands. This is the one function that would grow if a
   * new metric were added to FundamentalSnapshot — it does not decide any
   * SCORE, only which raw number represents which named metric.
   */
  private toMetricInputs(snapshot: FundamentalSnapshot, industry: IndustryComparisonResult): MetricInput[] {
    const industryBy = new Map(industry.metrics.map((m) => [m.metric, m]));

    return [
      { metric: 'Revenue YoY', value: snapshot.revenueYoyPercent },
      { metric: 'Profit YoY', value: snapshot.netProfitYoyPercent },
      { metric: 'Revenue CAGR 3Y', value: snapshot.revenueCagr3y },
      { metric: 'Profit CAGR 3Y', value: snapshot.netProfitCagr3y },

      { metric: 'ROE', value: snapshot.roe },
      { metric: 'ROIC', value: snapshot.roic },
      { metric: 'Operating Margin', value: snapshot.operatingMargin },
      { metric: 'Net Margin', value: snapshot.netMargin },

      { metric: 'Debt / Equity', value: snapshot.debtToEquity },
      { metric: 'Interest Coverage', value: snapshot.interestCoverage },
      { metric: 'Current Ratio', value: snapshot.currentRatio },
      { metric: 'Free Cash Flow', value: snapshot.freeCashFlow },

      // "vs Industry" valuation metrics are scored on the PREMIUM/DISCOUNT
      // percent, not the raw multiple — a 40x PE is fine for a company whose
      // industry trades at 45x and expensive for one whose industry trades
      // at 15x, so the raw number alone can't be banded meaningfully.
      { metric: 'PE vs Industry', value: industryBy.get('PE')?.premiumDiscountPercent ?? null },
      { metric: 'PEG Ratio', value: snapshot.pegRatio },
      { metric: 'EV / EBITDA vs Industry', value: industryBy.get('EV / EBITDA')?.premiumDiscountPercent ?? null },
      { metric: 'Price / Sales vs Industry', value: industryBy.get('Price / Sales')?.premiumDiscountPercent ?? null },

      { metric: 'Revenue QoQ', value: snapshot.revenueQoqPercent },
      { metric: 'Profit QoQ', value: snapshot.netProfitQoqPercent },
      { metric: 'Last Four Earnings Beat %', value: snapshot.lastFourEarningsBeatPercent },
    ];
  }

  private toView(snapshot: FundamentalSnapshot, strategy: string, cached: any): FundamentalView {
    return {
      symbol: snapshot.symbol,
      company: snapshot.company,
      sector: snapshot.sector,
      industry: snapshot.industry,
      marketCap: snapshot.marketCap,
      strategy,
      overallScore: cached.overallScore,
      growthScore: cached.growthScore,
      profitabilityScore: cached.profitabilityScore,
      financialStrengthScore: cached.financialStrengthScore,
      valuationScore: cached.valuationScore,
      momentumScore: cached.momentumScore,
      breakdown: cached.breakdown,
      explanation: cached.explanation as { strengths: string[]; weaknesses: string[] },
      industryComparison: cached.industryComparison as IndustryComparisonResult | null,
      snapshot,
      computedAt: cached.computedAt,
    };
  }
}
