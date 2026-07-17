import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AssetClass,
  Classification,
  LookThroughMap,
  PortfolioSnapshot,
  Position,
} from '../calculators/types';

/**
 * The single gateway between the database and the math layer.
 *
 * Everything in `calculators/` consumes PortfolioSnapshot and nothing else, so
 * this is the ONLY place that knows about Prisma, and the only place where the
 * "derive, never trust" rule has to be enforced.
 */
@Injectable()
export class SnapshotService {
  constructor(private prisma: PrismaService) {}

  /** Classification cache. A few hundred documents, effectively static. */
  private profileCache: Map<string, Classification> | null = null;
  private profileCacheAt = 0;
  private static readonly PROFILE_TTL_MS = 5 * 60 * 1000;

  private async profiles(): Promise<Map<string, Classification>> {
    if (this.profileCache && Date.now() - this.profileCacheAt < SnapshotService.PROFILE_TTL_MS) {
      return this.profileCache;
    }

    const rows = await this.prisma.instrumentProfile.findMany();
    const map = new Map<string, Classification>();

    for (const r of rows) {
      map.set(r.symbol, {
        sector: r.sector,
        industry: r.industry,
        region: r.region,
        country: r.country,
        assetClass: r.assetClass as AssetClass,
        lookThrough: (r.lookThrough as LookThroughMap | null) ?? null,
      });
    }

    this.profileCache = map;
    this.profileCacheAt = Date.now();
    return map;
  }

  /**
   * Builds a client's snapshot.
   *
   * `marketValue` is ALWAYS `quantity * currentPrice`, and `cash` comes from the
   * client record. The stored `Holding.marketValue`, `Holding.weight` and
   * `Client.portfolioValue` columns are never read: they are a display cache for
   * the CRUD UI and they are already known to drift (the live client "Dev" had
   * portfolioValue = 0 against $40,702 of holdings).
   */
  async forClient(clientId: string): Promise<PortfolioSnapshot> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { holdings: true },
    });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const profiles = await this.profiles();

    return {
      clientId: client.id,
      clientName: client.name,
      asOf: new Date(),
      baseCurrency: client.currency,
      cash: client.cashBalance,
      positions: client.holdings
        .filter((h) => h.quantity !== 0) // closed positions are not exposures
        .map((h) => this.toPosition(h, profiles)),
    };
  }

  async forAllClients(): Promise<PortfolioSnapshot[]> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE' },
      include: { holdings: true },
    });

    const profiles = await this.profiles();

    return clients.map((c) => ({
      clientId: c.id,
      clientName: c.name,
      asOf: new Date(),
      baseCurrency: c.currency,
      cash: c.cashBalance,
      positions: c.holdings.filter((h) => h.quantity !== 0).map((h) => this.toPosition(h, profiles)),
    }));
  }

  /**
   * The house book: every client merged into one snapshot.
   *
   * Positions in the same ticker are combined, with cost basis and P&L summed —
   * so `allocationBy(houseSnapshot, 'sector')` is the same function call as the
   * client-level one. That is the payoff of the pure-calculator split: house and
   * client analytics literally cannot disagree, because there is only one
   * implementation.
   */
  async houseSnapshot(): Promise<PortfolioSnapshot> {
    const snaps = await this.forAllClients();

    const merged = new Map<string, Position>();
    let cash = 0;

    for (const s of snaps) {
      cash += s.cash;
      for (const p of s.positions) {
        const existing = merged.get(p.ticker);
        if (!existing) {
          merged.set(p.ticker, { ...p });
          continue;
        }

        const quantity = existing.quantity + p.quantity;
        const costBasisTotal = existing.costBasisTotal + p.costBasisTotal;

        merged.set(p.ticker, {
          ...existing,
          quantity,
          costBasisTotal,
          // Weighted-average cost across the merged lots.
          costBasis: quantity > 0 ? costBasisTotal / quantity : 0,
          marketValue: existing.marketValue + p.marketValue,
          realizedPnl: existing.realizedPnl + p.realizedPnl,
          unrealizedPnl: existing.unrealizedPnl + p.unrealizedPnl,
          dividends: existing.dividends + p.dividends,
          targetWeight: null, // a house-level target weight is not meaningful
        });
      }
    }

    return {
      clientId: 'HOUSE',
      clientName: 'House',
      asOf: new Date(),
      baseCurrency: 'USD',
      cash,
      positions: [...merged.values()],
    };
  }

  private toPosition(h: any, profiles: Map<string, Classification>): Position {
    // DERIVED. Never h.marketValue.
    const marketValue = h.quantity * h.currentPrice;
    const costBasisTotal = h.quantity * h.averageCost;

    const classification: Classification = profiles.get(h.ticker) ?? {
      // Falls back to whatever the holding row carries, but keeps the shape
      // valid. A missing profile is surfaced as unclassified weight downstream
      // rather than being silently bucketed as a real answer.
      sector: h.sector || 'Unclassified',
      industry: h.industry || 'Unclassified',
      region: 'Unknown',
      country: h.country || 'Unknown',
      assetClass: 'EQUITY',
      lookThrough: null,
    };

    return {
      ticker: h.ticker,
      company: h.company,
      quantity: h.quantity,
      price: h.currentPrice,
      costBasis: h.averageCost,
      costBasisTotal,
      marketValue,
      realizedPnl: h.realizedPnL ?? 0,
      unrealizedPnl: marketValue - costBasisTotal,
      dividends: h.dividend ?? 0,
      classification,
      // null = no model assigned. NOT zero — treating it as zero would make the
      // rebalancer recommend liquidating every unmodelled position.
      targetWeight: h.targetWeight && h.targetWeight > 0 ? h.targetWeight / 100 : null,
    };
  }
}
