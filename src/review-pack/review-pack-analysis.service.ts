import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { FamilyPerformanceService } from '../portfolio-reconstruction/family-performance.service';
import { BenchmarkHistoryService } from '../portfolio-reconstruction/benchmark-history.service';
import { ResolvedPeriod } from '../portfolio-reconstruction/periods';
import { Actor, assertCanAccessClient, assertOwns } from '../common/ownership-scope';
import { Market, currencyForMarket } from '../common/market-scope';
import { ReconstructedPosition } from '../portfolio-reconstruction/types';
import {
  CommentaryInput,
  ContributorRow,
  MATERIALITY_THRESHOLDS,
  PortfolioAnalysis,
  PositionChange,
  ReviewSubjectKind,
  SectorRow,
} from './review-pack.types';

interface SubjectMeta {
  id: string;
  name: string;
  market: Market;
  currency: string;
  ownerId: string | null;
}

/**
 * Assembles the verified PortfolioAnalysis for one subject/period.
 *
 * Every number here is either read directly from PerformanceEngine
 * (PortfolioHistoryService / FamilyPerformanceService / BenchmarkHistoryService)
 * or computed by simple arithmetic over the SAME position snapshots those
 * services already produce (ReconstructedPosition). Nothing here recomputes
 * XIRR, TWRR, alpha or portfolio value — see spec §9/§107.
 */
@Injectable()
export class ReviewPackAnalysisService {
  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
    private familyPerformance: FamilyPerformanceService,
    private benchmarkHistory: BenchmarkHistoryService,
  ) {}

  async analyse(
    subjectType: ReviewSubjectKind,
    subjectId: string,
    resolved: ResolvedPeriod,
    actor: Actor,
  ): Promise<PortfolioAnalysis> {
    return subjectType === 'family'
      ? this.analyseFamily(subjectId, resolved, actor)
      : this.analyseClient(subjectId, resolved, actor);
  }

  // ── CLIENT ──────────────────────────────────────────────────────────────

  private async analyseClient(
    clientId: string,
    resolved: ResolvedPeriod,
    actor: Actor,
  ): Promise<PortfolioAnalysis> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, market: true, currency: true, ownerId: true, benchmarkId: true },
    });
    assertCanAccessClient(actor, client, 'Client');
    if (!client) throw new NotFoundException('Client not found');

    const subject: SubjectMeta = {
      id: client.id,
      name: client.name,
      market: client.market as Market,
      currency: client.currency || currencyForMarket(client.market as Market),
      ownerId: client.ownerId,
    };

    const [openPortfolio, closePortfolio] = await Promise.all([
      this.history.getPortfolioAsOf(clientId, resolved.from),
      this.history.getPortfolioAsOf(clientId, resolved.to),
    ]);

    // Reuses the same window-flow construction the client's own Performance
    // page is measured on, so the return quoted here is the return that page
    // shows — never a re-derivation. See analytics/calculators/flows.ts.
    const { buildWindowFlows } = await import('../analytics/calculators/flows');
    const { xirr } = await import('../analytics/calculators/xirr');
    const txns = await this.prisma.transaction.findMany({
      where: { clientId, date: { gt: resolved.from, lt: resolved.to } },
      orderBy: { date: 'asc' },
    });
    const clientRow = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { accountingMethod: true, includeDividends: true, includeFees: true },
    });
    const interior = buildWindowFlows(
      txns,
      (clientRow?.accountingMethod ?? 'TRANSACTIONAL') as 'TRANSACTIONAL' | 'CASH_FLOW',
      resolved.from,
      resolved.to,
      { includeDividends: clientRow?.includeDividends, includeFees: clientRow?.includeFees },
    );
    const flows = [
      { date: resolved.from, amount: -openPortfolio.portfolioValue },
      ...interior,
      { date: resolved.to, amount: closePortfolio.portfolioValue },
    ];

    const periodDays = Math.max(1, Math.round((resolved.to.getTime() - resolved.from.getTime()) / 86_400_000));
    const solved = xirr(flows);
    const annualized = solved.status === 'ok' ? solved.rate : null;
    const portfolioReturnPct =
      annualized !== null ? (1 + annualized) ** (periodDays / 365) - 1 : null;
    const returnUnavailableReason = solved.status === 'no-solution' ? solved.reason : undefined;

    const benchmark = await this.benchmarkHistory.windowReturn(
      undefined,
      client.benchmarkId,
      flows,
      resolved.to,
      subject.market,
    );

    return this.buildAnalysis(
      'client',
      subject,
      resolved,
      openPortfolio.positions,
      closePortfolio.positions,
      openPortfolio.portfolioValue,
      closePortfolio.portfolioValue,
      closePortfolio.cash,
      portfolioReturnPct,
      returnUnavailableReason,
      benchmark,
      txns,
    );
  }

  // ── FAMILY ──────────────────────────────────────────────────────────────

  private async analyseFamily(
    familyId: string,
    resolved: ResolvedPeriod,
    actor: Actor,
  ): Promise<PortfolioAnalysis> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: { clients: { select: { id: true } } },
    });
    assertOwns(actor, family, 'Family');
    if (!family) throw new NotFoundException('Family not found');

    // The verified household return — one XIRR over merged flows, never an
    // average of members. See FamilyPerformanceService's own doc comment.
    const familyReturn = await this.familyPerformance.periodReturn(familyId, resolved, actor);

    const subject: SubjectMeta = {
      id: family.id,
      name: family.name,
      market: familyReturn.market,
      currency: familyReturn.currency,
      ownerId: family.ownerId,
    };

    // Aggregate member positions at both ends of the window by symbol — spec
    // §60: "aggregate holdings by symbol, sector, market value, P&L,
    // contribution... do not sum individual percentage returns."
    const memberIds = family.clients.map((c) => c.id);
    const [openPositions, closePositions, txns] = await Promise.all([
      this.aggregateMemberPositions(memberIds, resolved.from),
      this.aggregateMemberPositions(memberIds, resolved.to),
      this.prisma.transaction.findMany({
        where: { clientId: { in: memberIds }, date: { gt: resolved.from, lt: resolved.to } },
        orderBy: { date: 'asc' },
      }),
    ]);

    return this.buildAnalysis(
      'family',
      subject,
      resolved,
      openPositions,
      closePositions,
      familyReturn.openingValue,
      familyReturn.closingValue,
      // Household cash isn't directly on FamilyPeriodReturn; derive it as
      // closing value minus invested (closing positions' market value).
      Math.max(0, familyReturn.closingValue - closePositions.reduce((s, p) => s + p.marketValue, 0)),
      familyReturn.returnPct,
      familyReturn.returnReason,
      familyReturn.benchmark,
      txns,
    );
  }

  /** Sums every member's positions at `date` into one symbol-keyed book. */
  private async aggregateMemberPositions(
    memberIds: string[],
    date: Date,
  ): Promise<ReconstructedPosition[]> {
    if (memberIds.length === 0) return [];

    const perMember = await Promise.all(
      memberIds.map((id) => this.history.getPortfolioAsOf(id, date)),
    );

    const bySymbol = new Map<string, ReconstructedPosition & { costBasisTotal: number }>();
    for (const portfolio of perMember) {
      for (const p of portfolio.positions) {
        const existing = bySymbol.get(p.ticker);
        if (!existing) {
          bySymbol.set(p.ticker, { ...p });
          continue;
        }
        const qty = existing.quantity + p.quantity;
        const costBasisTotal = existing.costBasisTotal + p.costBasisTotal;
        existing.quantity = qty;
        existing.marketValue += p.marketValue;
        existing.costBasisTotal = costBasisTotal;
        existing.averageCost = qty > 0 ? costBasisTotal / qty : existing.averageCost;
        existing.unrealizedGain += p.unrealizedGain;
      }
    }

    const total = [...bySymbol.values()].reduce((s, p) => s + p.marketValue, 0) || 1;
    return [...bySymbol.values()].map((p) => ({ ...p, weight: p.marketValue / total }));
  }

  // ── SHARED ANALYSIS ─────────────────────────────────────────────────────

  private async buildAnalysis(
    subjectType: ReviewSubjectKind,
    subject: SubjectMeta,
    resolved: ResolvedPeriod,
    openPositions: ReconstructedPosition[],
    closePositions: ReconstructedPosition[],
    portfolioValueStart: number,
    portfolioValueEnd: number,
    cashValue: number,
    portfolioReturnPct: number | null,
    returnUnavailableReason: string | undefined,
    benchmark: { name: string; interim: number | null } | null,
    txns: Array<{ type: string; amount: number; ticker: string | null; date: Date }>,
  ): Promise<PortfolioAnalysis> {
    const warnings: string[] = [];

    const benchmarkReturnPct = benchmark?.interim ?? null;
    const differencePct =
      portfolioReturnPct !== null && benchmarkReturnPct !== null
        ? portfolioReturnPct - benchmarkReturnPct
        : null;

    const openBySymbol = new Map(openPositions.map((p) => [p.ticker, p]));
    const closeBySymbol = new Map(closePositions.map((p) => [p.ticker, p]));
    const allSymbols = new Set([...openBySymbol.keys(), ...closeBySymbol.keys()]);

    // ── Contribution to return: P&L over the window / opening portfolio
    // value. NOT ranked by the holding's own percentage return — spec §11/§59.
    const contributions: ContributorRow[] = [];
    for (const symbol of allSymbols) {
      const open = openBySymbol.get(symbol);
      const close = closeBySymbol.get(symbol);
      const openValue = open?.marketValue ?? 0;
      const closeValue = close?.marketValue ?? 0;

      // Net trading cash flow for this symbol inside the window (buys negative
      // contribution to P&L, sells positive) — so a position that was partly
      // sold isn't misread as a loss purely because its market value shrank.
      const symbolFlow = txns
        .filter((t) => t.ticker === symbol && (t.type === 'BUY' || t.type === 'SELL'))
        .reduce((s, t) => s + (t.type === 'BUY' ? t.amount : -t.amount), 0);

      const pnlContribution = closeValue - openValue - symbolFlow;
      if (portfolioValueStart <= 0) continue;

      const portfolioContributionPct = pnlContribution / portfolioValueStart;
      const returnPct =
        open && open.marketValue > 0
          ? (closeValue - openValue - symbolFlow) / open.marketValue
          : null;

      contributions.push({
        symbol,
        company: close?.ticker ?? open?.ticker ?? symbol,
        returnPct,
        pnlContribution,
        portfolioContributionPct,
        weight: close?.weight ?? 0,
      });
    }

    const topContributors = contributions
      .filter((c) => c.pnlContribution > 0)
      .sort((a, b) => b.portfolioContributionPct - a.portfolioContributionPct)
      .slice(0, 3);
    const topDetractors = contributions
      .filter((c) => c.pnlContribution < 0)
      .sort((a, b) => a.portfolioContributionPct - b.portfolioContributionPct)
      .slice(0, 3);

    // ── Sector allocation and changes.
    const sectorAllocation = this.sectorRows(openPositions, closePositions, portfolioValueEnd);
    const topSectors = [...sectorAllocation].sort((a, b) => b.weight - a.weight).slice(0, 3);
    const sectorMoves = sectorAllocation.filter(
      (s) => s.changePct !== null && Math.abs(s.changePct) >= MATERIALITY_THRESHOLDS.sectorChangePct,
    );
    const largestSectorIncrease =
      sectorMoves.filter((s) => (s.changePct ?? 0) > 0).sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))[0] ??
      null;
    const largestSectorDecrease =
      sectorMoves.filter((s) => (s.changePct ?? 0) < 0).sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0))[0] ??
      null;

    // ── Material position changes.
    const { newPositions, exitedPositions, majorAdditions, majorReductions } = this.positionChanges(
      openBySymbol,
      closeBySymbol,
    );

    // ── Concentration.
    const sortedByWeight = [...closePositions].sort((a, b) => b.marketValue - a.marketValue);
    const top = (n: number) =>
      portfolioValueEnd > 0
        ? sortedByWeight.slice(0, n).reduce((s, p) => s + p.marketValue, 0) / portfolioValueEnd
        : 0;
    const sectorSet = new Set(closePositions.map((p) => p.sector || 'Unclassified'));

    // ── Dividends.
    const dividendTotal = txns.filter((t) => t.type === 'DIVIDEND').reduce((s, t) => s + t.amount, 0);
    const dividends =
      portfolioValueStart > 0
        ? { totalAmount: dividendTotal, isMaterial: dividendTotal / portfolioValueStart >= MATERIALITY_THRESHOLDS.pnlContributionPct }
        : null;

    // ── Corporate actions in-period, for held symbols.
    const corporateActions = await this.corporateActionsInPeriod(
      subjectType,
      subject.id,
      resolved.from,
      resolved.to,
    );

    const cashWeight = portfolioValueEnd > 0 ? cashValue / portfolioValueEnd : 0;

    // ── Data quality.
    let dataQuality: PortfolioAnalysis['dataQuality'] = 'HIGH';
    if (portfolioReturnPct === null) {
      dataQuality = 'LOW';
      warnings.push(returnUnavailableReason ?? 'Portfolio return could not be measured for this period.');
    } else if (benchmarkReturnPct === null) {
      dataQuality = 'MEDIUM';
      warnings.push('Benchmark return could not be measured for this period.');
    }

    return {
      subjectType,
      subjectId: subject.id,
      subjectName: subject.name,
      market: subject.market,
      currency: subject.currency,

      periodCode: resolved.period,
      periodLabel: resolved.label,
      periodStart: resolved.from,
      periodEnd: resolved.to,
      openPeriod: resolved.openPeriod,

      portfolioValueStart,
      portfolioValueEnd,

      portfolioReturnPct,
      returnUnavailableReason,

      benchmarkName: benchmark?.name ?? null,
      benchmarkReturnPct,
      differencePct,

      investmentGainLoss:
        portfolioReturnPct !== null ? portfolioValueEnd - portfolioValueStart : null,

      cashWeight,
      cashValue,

      topHoldings: sortedByWeight
        .slice(0, 5)
        .map((p) => ({ symbol: p.ticker, company: p.ticker, weight: p.weight })),
      topContributors,
      topDetractors,

      sectorAllocation,
      topSectors,
      largestSectorIncrease,
      largestSectorDecrease,

      newPositions,
      exitedPositions,
      majorAdditions,
      majorReductions,

      concentration: {
        numberOfHoldings: closePositions.length,
        numberOfSectors: sectorSet.size,
        top1WeightPct: top(1),
        top5WeightPct: top(5),
        top10WeightPct: top(10),
      },

      dividends,
      corporateActions,

      dataQuality,
      warnings,
    };
  }

  private sectorRows(
    openPositions: ReconstructedPosition[],
    closePositions: ReconstructedPosition[],
    portfolioValueEnd: number,
  ): SectorRow[] {
    const openTotal = openPositions.reduce((s, p) => s + p.marketValue, 0) || 1;
    const openBySector = new Map<string, number>();
    for (const p of openPositions) {
      const key = p.sector || 'Unclassified';
      openBySector.set(key, (openBySector.get(key) ?? 0) + p.marketValue);
    }

    const closeBySector = new Map<string, number>();
    for (const p of closePositions) {
      const key = p.sector || 'Unclassified';
      closeBySector.set(key, (closeBySector.get(key) ?? 0) + p.marketValue);
    }

    const allSectors = new Set([...openBySector.keys(), ...closeBySector.keys()]);
    const rows: SectorRow[] = [];
    for (const sector of allSectors) {
      const closeValue = closeBySector.get(sector) ?? 0;
      const openValue = openBySector.get(sector);
      const weight = portfolioValueEnd > 0 ? closeValue / portfolioValueEnd : 0;
      const previousWeight = openValue !== undefined ? openValue / openTotal : null;
      rows.push({
        sector,
        weight,
        previousWeight,
        changePct: previousWeight !== null ? weight - previousWeight : null,
        portfolioContributionPct: null,
      });
    }
    return rows.sort((a, b) => b.weight - a.weight);
  }

  private positionChanges(
    openBySymbol: Map<string, ReconstructedPosition>,
    closeBySymbol: Map<string, ReconstructedPosition>,
  ): {
    newPositions: PositionChange[];
    exitedPositions: PositionChange[];
    majorAdditions: PositionChange[];
    majorReductions: PositionChange[];
  } {
    const newPositions: PositionChange[] = [];
    const exitedPositions: PositionChange[] = [];
    const majorAdditions: PositionChange[] = [];
    const majorReductions: PositionChange[] = [];

    const allSymbols = new Set([...openBySymbol.keys(), ...closeBySymbol.keys()]);
    for (const symbol of allSymbols) {
      const open = openBySymbol.get(symbol);
      const close = closeBySymbol.get(symbol);
      const previousWeight = open?.weight ?? 0;
      const currentWeight = close?.weight ?? 0;
      const weightChangePct = currentWeight - previousWeight;

      if (!open && close) {
        if (currentWeight >= MATERIALITY_THRESHOLDS.newPositionMinWeight) {
          newPositions.push({ symbol, company: close.ticker, kind: 'NEW_POSITION', previousWeight, currentWeight, weightChangePct });
        }
        continue;
      }
      if (open && !close) {
        exitedPositions.push({ symbol, company: open.ticker, kind: 'EXITED_POSITION', previousWeight, currentWeight, weightChangePct });
        continue;
      }
      if (!open || !close) continue;

      if (weightChangePct >= MATERIALITY_THRESHOLDS.positionWeightChangePct) {
        majorAdditions.push({ symbol, company: close.ticker, kind: 'MAJOR_ADDITION', previousWeight, currentWeight, weightChangePct });
      } else if (weightChangePct <= -MATERIALITY_THRESHOLDS.positionWeightChangePct) {
        majorReductions.push({ symbol, company: close.ticker, kind: 'MAJOR_REDUCTION', previousWeight, currentWeight, weightChangePct });
      }
    }

    return { newPositions, exitedPositions, majorAdditions, majorReductions };
  }

  /**
   * Corporate actions affecting currently- or previously-held symbols within
   * the window. Reads CorporateActionLedger (spec §19) — never mentions a
   * split/bonus as investment gain, since this only surfaces the event, not a
   * P&L figure for it.
   */
  private async corporateActionsInPeriod(
    subjectType: ReviewSubjectKind,
    subjectId: string,
    from: Date,
    to: Date,
  ): Promise<PortfolioAnalysis['corporateActions']> {
    const clientIds =
      subjectType === 'client'
        ? [subjectId]
        : (
            await this.prisma.family.findUnique({
              where: { id: subjectId },
              select: { clients: { select: { id: true } } },
            })
          )?.clients.map((c) => c.id) ?? [];

    if (clientIds.length === 0) return [];

    const rows = await this.prisma.corporateActionLedger.findMany({
      where: {
        clientId: { in: clientIds },
        corporateAction: { effectiveDate: { gte: from, lte: to } },
      },
      include: { corporateAction: { select: { actionType: true, effectiveDate: true } } },
      distinct: ['symbol'],
    });

    return rows.map((r) => ({
      symbol: r.symbol,
      company: r.symbol,
      actionType: r.corporateAction.actionType,
      effectiveDate: r.corporateAction.effectiveDate,
    }));
  }

  /** Shapes the verified analysis into the compact, AI-facing input. */
  buildCommentaryInput(analysis: PortfolioAnalysis): CommentaryInput {
    return {
      subjectType: analysis.subjectType,
      subjectName: analysis.subjectName,
      marketRegion: analysis.market,
      currency: analysis.currency,

      periodStart: analysis.periodStart.toISOString().slice(0, 10),
      periodEnd: analysis.periodEnd.toISOString().slice(0, 10),

      portfolioValueStart: analysis.portfolioValueStart,
      portfolioValueEnd: analysis.portfolioValueEnd,
      portfolioReturn: analysis.portfolioReturnPct,
      benchmarkName: analysis.benchmarkName,
      benchmarkReturn: analysis.benchmarkReturnPct,
      performanceDifference: analysis.differencePct,

      numberOfHoldings: analysis.concentration.numberOfHoldings,
      numberOfSectors: analysis.concentration.numberOfSectors,
      cashWeight: analysis.cashWeight,

      topHoldings: analysis.topHoldings,
      topContributors: analysis.topContributors.map((c) => ({
        symbol: c.symbol,
        company: c.company,
        portfolioContributionPct: c.portfolioContributionPct,
        weight: c.weight,
      })),
      topDetractors: analysis.topDetractors.map((c) => ({
        symbol: c.symbol,
        company: c.company,
        portfolioContributionPct: c.portfolioContributionPct,
        weight: c.weight,
      })),

      sectorAllocation: analysis.topSectors.map((s) => ({ sector: s.sector, weight: s.weight })),
      sectorChanges: [analysis.largestSectorIncrease, analysis.largestSectorDecrease]
        .filter((s): s is SectorRow => s !== null)
        .map((s) => ({ sector: s.sector, changePct: s.changePct ?? 0 })),

      newPositions: analysis.newPositions.map((p) => p.company),
      exitedPositions: analysis.exitedPositions.map((p) => p.company),
      majorAdditions: analysis.majorAdditions.map((p) => p.company),
      majorReductions: analysis.majorReductions.map((p) => p.company),

      dividendsMaterial: analysis.dividends?.isMaterial ?? false,
      corporateActions: analysis.corporateActions.map((c) => ({ company: c.company, actionType: c.actionType })),

      concentration: analysis.concentration,

      macroData: [],
      macroEvents: [],

      dataQuality: analysis.dataQuality,
      warnings: analysis.warnings,
    };
  }
}
