import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { ReconstructedPortfolio } from './types';

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Reads and writes the historical snapshot store (PortfolioValuation +
 * HoldingSnapshot). This is the ONLY place that decides "cached row, or
 * reconstruct" (PART 7) — a caller (a future Reports export, a Performance
 * baseline lookup) never has to know which one actually answered it.
 *
 * Writing is always upsert-by-[clientId, date] plus a full
 * delete-and-reinsert of that date's HoldingSnapshot children, matching the
 * idempotent-and-safely-re-runnable convention PriceBar already uses
 * elsewhere in this codebase. A snapshot is immutable to *callers* (nothing
 * exposes an edit endpoint), but the write path itself must tolerate being
 * re-run — e.g. the scheduler retrying after a partial failure.
 */
@Injectable()
export class PortfolioHistoryService {
  private readonly logger = new Logger(PortfolioHistoryService.name);

  constructor(
    private prisma: PrismaService,
    private reconstruction: PortfolioReconstructionService,
    private benchmarkHistory: BenchmarkHistoryService,
  ) {}

  /** Exact-date lookup only — no fallback. Used by getPortfolioAsOf and PerformanceBaselineService. */
  async getSnapshot(clientId: string, date: Date) {
    return this.prisma.portfolioValuation.findUnique({
      where: { clientId_date: { clientId, date: utcDay(date) } },
      include: { holdings: true },
    });
  }

  /**
   * PART 7: snapshot-first, reconstruction-fallback, same output shape
   * either way.
   */
  async getPortfolioAsOf(clientId: string, date: Date): Promise<ReconstructedPortfolio> {
    const snapshot = await this.getSnapshot(clientId, date);
    if (snapshot) return this.fromSnapshotRow(clientId, snapshot);
    return this.reconstruction.reconstruct(clientId, date);
  }

  /**
   * Builds and persists one day's snapshot for a client. Always reconstructs
   * — even for "today" — so the stored row and an on-demand reconstruction
   * for the same date can never disagree (they are, literally, produced by
   * the same code path).
   */
  async writeSnapshot(
    clientId: string,
    date: Date,
    opts: { isQuarterEnd?: boolean } = {},
  ): Promise<void> {
    const day = utcDay(date);
    const portfolio = await this.reconstruction.reconstruct(clientId, day);
    const benchmarkValue = await this.benchmarkValueFor(clientId, portfolio.baselineDate, day, portfolio);

    const valuation = await this.prisma.portfolioValuation.upsert({
      where: { clientId_date: { clientId, date: day } },
      create: {
        clientId,
        date: day,
        securitiesValue: portfolio.holdingsValue,
        cashValue: portfolio.cash,
        totalValue: portfolio.portfolioValue,
        totalCost: portfolio.totalCost,
        unrealizedPnL: portfolio.unrealizedGain,
        realizedPnL: portfolio.realizedGain,
        benchmarkValue,
        positionCount: portfolio.positions.length,
        isQuarterEnd: opts.isQuarterEnd ?? false,
        source: 'snapshot-scheduler',
      },
      update: {
        securitiesValue: portfolio.holdingsValue,
        cashValue: portfolio.cash,
        totalValue: portfolio.portfolioValue,
        totalCost: portfolio.totalCost,
        unrealizedPnL: portfolio.unrealizedGain,
        realizedPnL: portfolio.realizedGain,
        benchmarkValue,
        positionCount: portfolio.positions.length,
        // Re-running the daily job must not un-flag a quarter-end snapshot
        // that already ran for the same date; only turn it on, never off.
        isQuarterEnd: opts.isQuarterEnd ? true : undefined,
      },
    });

    // Idempotent child rewrite: drop and reinsert rather than diff, so a
    // retried run can never leave stale positions mixed with fresh ones.
    await this.prisma.holdingSnapshot.deleteMany({ where: { snapshotId: valuation.id } });

    if (portfolio.positions.length > 0) {
      await this.prisma.holdingSnapshot.createMany({
        data: portfolio.positions.map((p) => ({
          snapshotId: valuation.id,
          ticker: p.ticker,
          quantity: p.quantity,
          averageCost: p.averageCost,
          closingPrice: p.closingPrice,
          marketValue: p.marketValue,
          allocation: p.weight,
          sector: p.sector,
          industry: p.industry,
          country: p.country,
          assetClass: p.assetClass,
        })),
      });
    }

    this.logger.log(
      `Snapshot written: client=${clientId} date=${day.toISOString().slice(0, 10)} ` +
        `value=${portfolio.portfolioValue.toFixed(2)} quarterEnd=${opts.isQuarterEnd ?? false}`,
    );
  }

  /**
   * Benchmark units notionally bought at the baseline date with the
   * baseline's opening value, valued at this snapshot's date — gives every
   * stored snapshot its own "what if this had been the index instead"
   * comparison point without a live recompute later. Returns null (not an
   * error) when the client has no benchmark set or price coverage is
   * missing — a snapshot must still write successfully either way.
   */
  private async benchmarkValueFor(
    clientId: string,
    baselineDate: Date,
    snapshotDate: Date,
    portfolio: ReconstructedPortfolio,
  ): Promise<number | undefined> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return undefined;

    const baseline = await this.prisma.portfolioBaseline.findUnique({ where: { clientId } });
    const openingValue = baseline?.openingPortfolioValue ?? portfolio.portfolioValue;

    const value = await this.benchmarkHistory.notionalValue(
      undefined,
      client.benchmarkId,
      openingValue,
      baselineDate,
      snapshotDate,
    );
    return value ?? undefined;
  }

  private fromSnapshotRow(
    clientId: string,
    row: Awaited<ReturnType<PortfolioHistoryService['getSnapshot']>>,
  ): ReconstructedPortfolio {
    if (!row) throw new Error('fromSnapshotRow called with a null row');

    const positions = row.holdings.map((h) => ({
      ticker: h.ticker,
      quantity: h.quantity,
      averageCost: h.averageCost,
      closingPrice: h.closingPrice,
      marketValue: h.marketValue,
      costBasisTotal: h.averageCost * h.quantity,
      unrealizedGain: h.marketValue - h.averageCost * h.quantity,
      sector: h.sector,
      industry: h.industry,
      country: h.country,
      assetClass: h.assetClass,
      weight: h.allocation,
    }));

    // Cash is a real allocation line everywhere else in this codebase
    // (weights.ts#allocationBy) — included here too so a snapshot-served
    // breakdown matches a reconstructed one exactly, not just for holdings.
    const total = row.totalValue || 1;
    const group = (key: (p: (typeof positions)[number]) => string) => {
      const byKey = new Map<string, number>();
      for (const p of positions) byKey.set(key(p), (byKey.get(key(p)) ?? 0) + p.marketValue);
      if (row.cashValue > 0) byKey.set('Cash', (byKey.get('Cash') ?? 0) + row.cashValue);

      const slices = [...byKey.entries()]
        .map(([k, value]) => ({ key: k, value, weight: value / total }))
        .sort((a, b) => b.value - a.value);

      return { slices, denominator: 'TOTAL_ASSETS' as const, unclassifiedWeight: 0 };
    };

    return {
      clientId,
      asOfDate: row.date,
      baselineDate: row.date, // not tracked per-row; not needed for a snapshot-served read
      cash: row.cashValue,
      holdingsValue: row.securitiesValue,
      portfolioValue: row.totalValue,
      totalCost: row.totalCost,
      unrealizedGain: row.unrealizedPnL,
      realizedGain: row.realizedPnL,
      positions,
      sectorAllocation: group((p) => p.sector),
      countryAllocation: group((p) => p.country),
      assetAllocation: group((p) => p.assetClass),
      source: 'snapshot',
    };
  }
}
