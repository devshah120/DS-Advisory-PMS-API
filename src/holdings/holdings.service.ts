import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';

/** Derived position figures. Cost basis is always averageCost * quantity. */
function derive(quantity: number, averageCost: number, currentPrice: number) {
  const marketValue = quantity * currentPrice;
  const costBasis = quantity * averageCost;
  return { marketValue, unrealizedPnL: marketValue - costBasis };
}

@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  /**
   * Overlays each holding's stored `currentPrice`/`marketValue`/`unrealizedPnL`
   * with a live quote. The DB row stays untouched (it's the cost-basis ledger,
   * not a price cache) — this only affects what a read returns. One ticker
   * lookup per distinct symbol, shared across every client holding it, and a
   * failed quote just falls back to the last stored price rather than failing
   * the whole list.
   */
  private async withLivePrices<T extends { ticker: string; quantity: number; averageCost: number; currentPrice: number }>(
    holdings: T[],
  ): Promise<T[]> {
    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    const quotes = new Map<string, number>();

    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const { currentPrice } = await this.market.lookup(ticker);
          if (typeof currentPrice === 'number') quotes.set(ticker, currentPrice);
        } catch (error) {
          this.logger.warn(`Live price lookup failed for ${ticker}: ${(error as Error).message}`);
        }
      }),
    );

    return holdings.map((h) => {
      const livePrice = quotes.get(h.ticker);
      if (livePrice == null) return h;
      return {
        ...h,
        currentPrice: livePrice,
        ...derive(h.quantity, h.averageCost, livePrice),
      };
    });
  }

  /**
   * Records a buy or a sell against a client's position in a ticker.
   *
   * A negative quantity is a sell. Buys fold into the existing lot at the
   * weighted-average cost across both the old and new amounts invested; sells
   * only draw the position down, leaving averageCost untouched, so realised
   * gains never distort the basis of the remaining shares.
   */
  async create(createHoldingDto: CreateHoldingDto) {
    const { clientId, marketValue: _ignored, ...data } = createHoldingDto;
    const { ticker, quantity, averageCost, currentPrice } = data;

    if (quantity === 0) {
      throw new BadRequestException('Quantity must be non-zero');
    }

    const existing = await this.prisma.holding.findUnique({
      where: { clientId_ticker: { clientId, ticker } },
    });

    const classified = {
      ...data,
      // Yahoo leaves these blank for ETFs and indices, but the schema (and the
      // sector-exposure grouping) expect a value.
      sector: data.sector?.trim() || 'Unclassified',
      industry: data.industry?.trim() || 'Unclassified',
      country: data.country?.trim() || 'Unknown',
      exchange: data.exchange?.trim() || 'Unknown',
    };

    if (!existing) {
      if (quantity < 0) {
        throw new BadRequestException(`No open position in ${ticker} to sell`);
      }
      return this.prisma.holding.create({
        data: {
          ...classified,
          ...derive(quantity, averageCost, currentPrice),
          client: { connect: { id: clientId } },
        },
      });
    }

    const newQuantity = existing.quantity + quantity;
    if (newQuantity < 0) {
      throw new BadRequestException(
        `Cannot sell ${Math.abs(quantity)} shares of ${ticker}; only ${existing.quantity} held`,
      );
    }

    let newAverageCost = existing.averageCost;
    let realizedPnL = existing.realizedPnL;

    if (quantity > 0) {
      // Weighted average across the existing and incoming amounts invested.
      const totalInvested = existing.averageCost * existing.quantity + averageCost * quantity;
      newAverageCost = totalInvested / newQuantity;
    } else {
      // Sold shares realise (sale price - basis) and leave averageCost alone.
      realizedPnL += (currentPrice - existing.averageCost) * Math.abs(quantity);
    }

    // Closing the position out entirely resets the basis rather than leaving a stale one.
    if (newQuantity === 0) newAverageCost = 0;

    return this.prisma.holding.update({
      where: { id: existing.id },
      data: {
        ...classified,
        quantity: newQuantity,
        averageCost: newAverageCost,
        currentPrice,
        realizedPnL,
        ...derive(newQuantity, newAverageCost, currentPrice),
      },
    });
  }

  async findAll() {
    const holdings = await this.prisma.holding.findMany({
      include: {
        client: true,
      },
    });
    return this.withLivePrices(holdings);
  }

  async findByClient(clientId: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { clientId },
    });
    return this.withLivePrices(holdings);
  }

  findOne(id: string) {
    return this.prisma.holding.findUnique({
      where: { id },
    });
  }

  /** Recomputes marketValue and unrealizedPnL whenever an input to them changes. */
  async update(id: string, updateHoldingDto: UpdateHoldingDto) {
    const existing = await this.prisma.holding.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException(`No holding with id ${id}`);

    const { marketValue: _ignored, ...data } = updateHoldingDto as UpdateHoldingDto & {
      marketValue?: number;
    };

    const quantity = data.quantity ?? existing.quantity;
    const averageCost = data.averageCost ?? existing.averageCost;
    const currentPrice = data.currentPrice ?? existing.currentPrice;

    return this.prisma.holding.update({
      where: { id },
      data: { ...data, ...derive(quantity, averageCost, currentPrice) },
    });
  }

  remove(id: string) {
    return this.prisma.holding.delete({
      where: { id },
    });
  }

  async getByTicker(ticker: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { ticker },
      include: {
        client: true,
      },
    });
    return this.withLivePrices(holdings);
  }

  async getSectorExposure(clientId: string) {
    const stored = await this.prisma.holding.findMany({
      where: { clientId },
    });
    const holdings = await this.withLivePrices(stored);

    const sectors = holdings.reduce((acc: Record<string, { value: number; holdings: number }>, h: any) => {
      if (!acc[h.sector]) {
        acc[h.sector] = { value: 0, holdings: 0 };
      }
      acc[h.sector].value += h.marketValue;
      acc[h.sector].holdings += 1;
      return acc;
    }, {} as Record<string, { value: number; holdings: number }>);

    return sectors;
  }
}
