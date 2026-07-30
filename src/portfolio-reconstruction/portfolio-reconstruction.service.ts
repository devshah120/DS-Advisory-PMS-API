import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BaselineService } from '../legacy-baseline/baseline.service';
import { HistoricalPriceService } from './historical-price.service';
import { allocationBy } from '../analytics/calculators/weights';
import { Classification, PortfolioSnapshot, Position } from '../analytics/calculators/types';
import { ReconstructedPortfolio, ReconstructedPosition } from './types';

interface WorkingPosition {
  ticker: string;
  quantity: number;
  /** Total cost basis, not per-share — updated on every BUY, untouched on SELL. */
  costBasisTotal: number;
  currency: string;
  sector: string;
  industry: string;
}

/**
 * Rebuilds a client's portfolio as of any date after its baseline, by
 * replaying every Transaction since the baseline onto BaselineHolding[].
 *
 * This is a pure read/compute service: it never writes to Transaction,
 * Holding, or anything else. PortfolioHistoryService is the layer that
 * decides whether to call this at all (it prefers a cached HoldingSnapshot
 * first) and the layer that persists this service's output.
 *
 * Country/asset/sector allocation reuse `allocationBy` from
 * analytics/calculators/weights.ts — the same function the live book
 * (SnapshotService) and PerformanceService use — so a reconstructed
 * portfolio's allocation math cannot drift from the live one; only the input
 * positions differ (replayed-as-of-date vs. current Holding rows).
 */
@Injectable()
export class PortfolioReconstructionService {
  constructor(
    private prisma: PrismaService,
    private baseline: BaselineService,
    private prices: HistoricalPriceService,
  ) {}

  async reconstruct(clientId: string, asOfDate: Date): Promise<ReconstructedPortfolio> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const baselineRow = await this.baseline.findOrNull(clientId);
    if (!baselineRow) {
      throw new NotFoundException(
        `Client ${clientId} has no Legacy Portfolio Baseline — nothing to reconstruct from.`,
      );
    }

    if (asOfDate < baselineRow.baselineDate) {
      throw new BadRequestException(
        `Requested date ${asOfDate.toISOString().slice(0, 10)} is before the baseline date ` +
          `${baselineRow.baselineDate.toISOString().slice(0, 10)}. Nothing can be reconstructed ` +
          `before the baseline — history prior to it was not tracked.`,
      );
    }

    const positions = new Map<string, WorkingPosition>();
    for (const h of baselineRow.holdings) {
      positions.set(h.ticker, {
        ticker: h.ticker,
        quantity: h.quantity,
        costBasisTotal: h.quantity * h.averageCost,
        currency: h.currency,
        sector: h.sector,
        industry: h.industry,
      });
    }

    let cash = baselineRow.openingCash;
    let realizedGain = 0;

    const ledger = await this.prisma.transaction.findMany({
      where: { clientId, date: { gt: baselineRow.baselineDate, lte: asOfDate } },
      orderBy: { date: 'asc' },
    });

    for (const t of ledger) {
      realizedGain += this.applyTransaction(positions, t, (delta) => (cash += delta));
    }

    const open = [...positions.values()].filter((p) => p.quantity !== 0);
    const closes = await this.prices.closesOn(
      open.map((p) => p.ticker),
      asOfDate,
    );
    const profiles = await this.profiles();

    const reconstructedPositions: ReconstructedPosition[] = [];
    let holdingsValue = 0;
    let totalCost = 0;
    let unrealizedGain = 0;

    for (const p of open) {
      const price = closes.get(p.ticker) ?? p.costBasisTotal / p.quantity;
      const marketValue = p.quantity * price;
      const averageCost = p.costBasisTotal / p.quantity;
      const gain = marketValue - p.costBasisTotal;

      holdingsValue += marketValue;
      totalCost += p.costBasisTotal;
      unrealizedGain += gain;

      reconstructedPositions.push({
        ticker: p.ticker,
        quantity: p.quantity,
        averageCost,
        closingPrice: price,
        marketValue,
        costBasisTotal: p.costBasisTotal,
        unrealizedGain: gain,
        sector: p.sector,
        industry: p.industry,
        country: profiles.get(p.ticker)?.country ?? 'Unknown',
        assetClass: profiles.get(p.ticker)?.assetClass ?? 'EQUITY',
        weight: 0, // filled in below once portfolioValue is known
      });
    }

    const portfolioValue = holdingsValue + cash;
    for (const p of reconstructedPositions) {
      p.weight = portfolioValue > 0 ? p.marketValue / portfolioValue : 0;
    }

    const snap: PortfolioSnapshot = {
      clientId,
      clientName: client.name,
      asOf: asOfDate,
      baseCurrency: client.currency,
      cash,
      positions: reconstructedPositions.map((p) => this.toCalcPosition(p, profiles)),
    };

    return {
      clientId,
      asOfDate,
      baselineDate: baselineRow.baselineDate,
      cash,
      holdingsValue,
      portfolioValue,
      totalCost,
      unrealizedGain,
      realizedGain,
      positions: reconstructedPositions,
      sectorAllocation: allocationBy(snap, 'sector'),
      countryAllocation: allocationBy(snap, 'country', { lookThrough: true }),
      assetAllocation: allocationBy(snap, 'assetClass'),
      source: 'reconstruction',
    };
  }

  /**
   * Mutates `positions` in place and returns the realized gain this single
   * transaction contributed (zero for anything that isn't a SELL). Cash is
   * reported back through the callback rather than returned, since callers
   * need to accumulate it alongside realized gain in the same loop.
   */
  private applyTransaction(
    positions: Map<string, WorkingPosition>,
    t: { ticker: string | null; type: string; quantity: number | null; price: number | null; amount: number },
    addCash: (delta: number) => void,
  ): number {
    switch (t.type) {
      case 'BUY': {
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        const cost = t.amount; // total cost of the buy
        if (existing) {
          existing.quantity += t.quantity;
          existing.costBasisTotal += cost;
        } else {
          positions.set(t.ticker, {
            ticker: t.ticker,
            quantity: t.quantity,
            costBasisTotal: cost,
            currency: 'USD',
            sector: 'Unclassified',
            industry: 'Unclassified',
          });
        }
        addCash(-Math.abs(t.amount));
        return 0;
      }

      case 'SELL': {
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        addCash(Math.abs(t.amount));
        if (!existing || existing.quantity <= 0) return 0;

        // Average-cost accounting: realized gain is proceeds minus the cost
        // basis of the shares actually sold, at the position's average cost
        // per share *before* this sale — never the baseline's original
        // average cost, which may already have been diluted by prior BUYs.
        const avgCostPerShare = existing.costBasisTotal / existing.quantity;
        const soldQty = Math.min(t.quantity, existing.quantity);
        const costOfSold = avgCostPerShare * soldQty;

        existing.quantity -= soldQty;
        existing.costBasisTotal -= costOfSold;

        return Math.abs(t.amount) - costOfSold;
      }

      case 'DIVIDEND':
        addCash(Math.abs(t.amount));
        return 0;

      case 'FEES':
        addCash(-Math.abs(t.amount));
        return 0;

      case 'CASH_DEPOSIT':
        addCash(Math.abs(t.amount));
        return 0;

      case 'CASH_WITHDRAWAL':
        addCash(-Math.abs(t.amount));
        return 0;

      case 'SPLIT':
      case 'BONUS': {
        // Corporate actions change share count, not cash or cost basis total —
        // t.quantity here is the ADDITIONAL shares received (matches how the
        // Transactions module already records a bonus/split entry).
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        if (existing) existing.quantity += t.quantity;
        return 0;
      }

      case 'TRANSFER':
        // Changes custody, not money or shares held for this reconstruction's
        // purposes — no cash, cost basis, or quantity effect.
        return 0;

      default:
        return 0;
    }
  }

  private async profiles(): Promise<Map<string, Classification>> {
    const rows = await this.prisma.instrumentProfile.findMany();
    const map = new Map<string, Classification>();
    for (const r of rows) {
      map.set(r.symbol, {
        sector: r.sector,
        industry: r.industry,
        region: r.region,
        country: r.country,
        assetClass: r.assetClass as Classification['assetClass'],
        lookThrough: (r.lookThrough as Classification['lookThrough']) ?? null,
      });
    }
    return map;
  }

  private toCalcPosition(p: ReconstructedPosition, profiles: Map<string, Classification>): Position {
    const classification: Classification = profiles.get(p.ticker) ?? {
      sector: p.sector || 'Unclassified',
      industry: p.industry || 'Unclassified',
      region: 'Unknown',
      country: p.country || 'Unknown',
      assetClass: 'EQUITY',
      lookThrough: null,
    };

    return {
      ticker: p.ticker,
      company: p.ticker,
      quantity: p.quantity,
      costBasis: p.averageCost,
      price: p.closingPrice,
      marketValue: p.marketValue,
      costBasisTotal: p.costBasisTotal,
      realizedPnl: 0,
      unrealizedPnl: p.unrealizedGain,
      dividends: 0,
      classification,
      targetWeight: null,
    };
  }
}
