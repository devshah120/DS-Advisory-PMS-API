import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Actor,
  assertOwns,
  clientWhere,
  ownedWhere,
  ownerForCreate,
} from '../common/ownership-scope';
import { MarketService } from '../market/market.service';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import {
  DEFAULT_MARKET,
  Market,
  currencyForMarket,
  displaySymbol,
  marketForSymbol,
} from '../common/market-scope';

/**
 * Below this a position is closed rather than merely small.
 *
 * Same threshold the holdings and analytics layers use for the same judgement:
 * fractional quantities mean a full exit nets to float dust (7e-15) rather than
 * a clean zero, and a sold-out lot must not surface as a ₹0.00 line in the
 * family roll-up any more than it may in a single client's book.
 */
const CLOSED_POSITION_EPSILON = 1e-9;

/** One symbol, merged across every account in the household. */
export interface FamilyPosition {
  ticker: string;
  /** Suffix stripped for display — 'RELIANCE.NS' reads as 'RELIANCE'. */
  displayTicker: string;
  company: string;
  sector: string;
  industry: string;

  /** Summed across accounts — the household's true share count in the name. */
  quantity: number;
  /**
   * Cost-weighted average across accounts, NOT the mean of their average costs.
   *
   * Σ(qty × avgCost) ÷ Σ(qty). Averaging the per-account figures instead would
   * weight a 5-share lot the same as a 500-share one and report a blended cost
   * the family never paid.
   */
  averageCost: number;
  /** Σ(quantity × averageCost) — what the household actually put in. */
  costBasis: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  /** Unrealised P&L as a percent of the household's cost basis in the name. */
  unrealizedPnLPercent: number;
  /** Share of the family's total market value (positions only, cash excluded). */
  weight: number;
  /** Realised P&L booked across the household's accounts in this name. */
  realizedPnL: number;
  /** How many of the family's accounts hold it — 3 of 5 is a real signal. */
  accounts: number;
  /** Per-account breakdown, so a merged row can be opened up. */
  holders: Array<{
    clientId: string;
    clientName: string;
    quantity: number;
    averageCost: number;
    marketValue: number;
    unrealizedPnL: number;
  }>;
}

export interface FamilySectorAllocation {
  sector: string;
  marketValue: number;
  /** Percent of the household's invested value. */
  weight: number;
  positions: number;
  unrealizedPnL: number;
}

export interface FamilyAggregate {
  id: string;
  name: string;
  market: Market;
  /** The single reporting unit for every figure below. */
  currency: string;
  members: Array<{
    id: string;
    name: string;
    marketValue: number;
    cashBalance: number;
    portfolioValue: number;
  }>;
  positions: FamilyPosition[];
  sectorAllocation: FamilySectorAllocation[];
  totals: {
    /** Distinct symbols after merging — the household's real name count. */
    positionCount: number;
    /** Rows before merging, i.e. how many account-level lots fed the roll-up. */
    lotCount: number;
    costBasis: number;
    marketValue: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    realizedPnL: number;
    cashBalance: number;
    /** marketValue + cashBalance — the household's total assets. */
    portfolioValue: number;
  };
}

@Injectable()
export class FamiliesService {
  private readonly logger = new Logger(FamiliesService.name);

  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  async create(dto: CreateFamilyDto, actor: Actor) {
    const market = (dto.market as Market) ?? DEFAULT_MARKET;

    try {
      const family = await this.prisma.family.create({
        data: {
          name: dto.name,
          market,
          notes: dto.notes,
          // A household belongs to the manager who runs its mandates.
          ownerId: ownerForCreate(actor),
        },
      });

      if (dto.clientIds?.length) {
        await this.setMembers(family.id, dto.clientIds, market, actor);
      }

      return this.findOne(family.id, actor);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A family named "${dto.name}" already exists in this book`);
      }
      throw err;
    }
  }

  /**
   * Families in one book, each with a light member summary — enough for the
   * selector to read "Shah Family · 4 accounts" without loading every holding.
   */
  async findAll(market?: Market, actor?: Actor) {
    const families = await this.prisma.family.findMany({
      where: {
        ...(market ? { market } : {}),
        ...(actor ? ownedWhere(actor) : {}),
      },
      include: {
        clients: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });

    return families.map((f) => ({
      id: f.id,
      name: f.name,
      market: f.market as Market,
      currency: currencyForMarket(f.market as Market),
      notes: f.notes,
      memberCount: f.clients.length,
      members: f.clients,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }

  async findOne(id: string, actor: Actor) {
    const family = await this.prisma.family.findUnique({
      where: { id },
      include: {
        clients: {
          select: { id: true, name: true, accountNumber: true, broker: true, cashBalance: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    // 404 for absent and for someone else's alike — a household lists its
    // member client names, so confirming one exists leaks the roster.
    assertOwns(actor, family, 'Family');
    return {
      id: family!.id,
      name: family!.name,
      market: family!.market as Market,
      currency: currencyForMarket(family!.market as Market),
      notes: family!.notes,
      memberCount: family!.clients.length,
      members: family!.clients,
      createdAt: family!.createdAt,
      updatedAt: family!.updatedAt,
    };
  }

  async update(id: string, dto: UpdateFamilyDto, actor: Actor) {
    const existing = await this.prisma.family.findUnique({ where: { id } });
    assertOwns(actor, existing, 'Family');

    // The book is fixed at creation: moving a household across books would
    // leave its existing members — all from the old book — invalid members of
    // the new one, and there is no currency in which the combined figure would
    // then make sense.
    if (dto.market && dto.market !== existing!.market) {
      throw new BadRequestException(
        "A family's market cannot be changed. Create a family in the other book instead.",
      );
    }

    try {
      await this.prisma.family.update({
        where: { id },
        data: { name: dto.name, notes: dto.notes },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A family named "${dto.name}" already exists in this book`);
      }
      throw err;
    }

    if (dto.clientIds) {
      await this.setMembers(id, dto.clientIds, existing!.market as Market, actor);
    }

    return this.findOne(id, actor);
  }

  /**
   * Replaces the household's membership wholesale.
   *
   * Every candidate must already be in the family's own book — an INR mandate
   * and a USD one cannot be summed into one portfolio value, and the codebase
   * carries no FX rate that would make such a total meaningful. Rejecting here
   * is deliberate: the alternative is a number that looks right and isn't.
   */
  private async setMembers(
    familyId: string,
    clientIds: string[],
    market: Market,
    actor: Actor,
  ) {
    const ids = [...new Set(clientIds.filter(Boolean))];

    if (ids.length > 0) {
      // Scoped: without this a manager could pull another manager's mandate
      // into their own household and read its positions through the family
      // aggregate, bypassing every per-client check. An unowned id simply does
      // not come back, and falls into the "no client found" branch below.
      const candidates = await this.prisma.client.findMany({
        where: { id: { in: ids }, ...clientWhere(actor) },
        select: { id: true, name: true, market: true },
      });

      const missing = ids.filter((id) => !candidates.some((c) => c.id === id));
      if (missing.length > 0) {
        throw new BadRequestException(`No client found for id(s): ${missing.join(', ')}`);
      }

      const foreign = candidates.filter((c) => c.market !== market);
      if (foreign.length > 0) {
        throw new BadRequestException(
          `A family holds accounts from one book only. ` +
            `${foreign.map((c) => c.name).join(', ')} ` +
            `${foreign.length === 1 ? 'is' : 'are'} not in the ${market} book.`,
        );
      }
    }

    // Detach anyone dropped from the list, then attach the current set. Two
    // writes rather than a diff: the membership of a household is a handful of
    // rows, and this cannot leave a client attached to a family they were
    // removed from.
    await this.prisma.client.updateMany({
      where: { familyId, id: { notIn: ids.length ? ids : ['__none__'] } },
      data: { familyId: null },
    });

    if (ids.length > 0) {
      await this.prisma.client.updateMany({
        where: { id: { in: ids } },
        data: { familyId },
      });
    }
  }

  /**
   * Deletes the household. Member clients are left intact and unaffiliated —
   * the FK is SetNull — because dissolving a family must never take the
   * underlying mandates (or their holdings) with it.
   */
  async remove(id: string, actor: Actor) {
    const existing = await this.prisma.family.findUnique({ where: { id } });
    assertOwns(actor, existing, 'Family');

    await this.prisma.client.updateMany({ where: { familyId: id }, data: { familyId: null } });
    await this.prisma.family.delete({ where: { id } });
    return { success: true, id };
  }

  /**
   * The integrated household view: every member's positions merged into one
   * book, duplicates collapsed by symbol, with the sector allocation of the
   * combined portfolio.
   *
   * This is the same treatment the holdings page gives the firm-wide symbol
   * aggregate — quantities summed, cost blended by weight, one live quote per
   * distinct symbol shared across the accounts holding it — applied to a
   * family's subset of accounts rather than the whole book. Positions are
   * valued at LIVE quotes, not the stored marketValue cache, so the family
   * total agrees with what each member's own page reports.
   */
  async aggregate(id: string, actor: Actor): Promise<FamilyAggregate> {
    const family = await this.prisma.family.findUnique({
      where: { id },
      include: {
        clients: {
          select: {
            id: true,
            name: true,
            cashBalance: true,
            holdings: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    // The most disclosive family route — it returns every member's positions.
    assertOwns(actor, family, 'Family');
    if (!family) throw new NotFoundException(`Family ${id} not found`);

    const market = family.market as Market;

    // Every open lot across the household, tagged with its owning account.
    const lots = family.clients.flatMap((c) =>
      c.holdings
        .filter((h) => Math.abs(h.quantity) > CLOSED_POSITION_EPSILON)
        .map((h) => ({ ...h, clientId: c.id, clientName: c.name })),
    );

    // One quote per distinct symbol, shared by every account holding it — a
    // name held in four family accounts costs one lookup, not four.
    const livePrice = await this.livePrices([...new Set(lots.map((l) => l.ticker))]);

    // --- merge by symbol ---
    const merged = new Map<
      string,
      Omit<FamilyPosition, 'averageCost' | 'unrealizedPnLPercent' | 'weight'> & {
        /** Σ(qty × avgCost), carried so the blended cost divides once at the end. */
        investedTotal: number;
      }
    >();

    for (const lot of lots) {
      const price = livePrice.get(lot.ticker) ?? lot.currentPrice;
      const invested = lot.quantity * lot.averageCost;
      const marketValue = lot.quantity * price;

      const cur = merged.get(lot.ticker) ?? {
        ticker: lot.ticker,
        displayTicker: displaySymbol(lot.ticker),
        company: lot.company,
        sector: lot.sector || 'Uncategorized',
        industry: lot.industry || 'Unclassified',
        quantity: 0,
        investedTotal: 0,
        costBasis: 0,
        currentPrice: price,
        marketValue: 0,
        unrealizedPnL: 0,
        realizedPnL: 0,
        accounts: 0,
        holders: [] as FamilyPosition['holders'],
      };

      cur.quantity += lot.quantity;
      cur.investedTotal += invested;
      cur.costBasis += invested;
      cur.marketValue += marketValue;
      cur.unrealizedPnL += marketValue - invested;
      cur.realizedPnL += lot.realizedPnL ?? 0;
      cur.accounts += 1;
      // Every account holds the same instrument at the same price; keep the
      // live one rather than whichever lot happened to be written last.
      cur.currentPrice = price;
      cur.holders.push({
        clientId: lot.clientId,
        clientName: lot.clientName,
        quantity: lot.quantity,
        averageCost: lot.averageCost,
        marketValue,
        unrealizedPnL: marketValue - invested,
      });

      merged.set(lot.ticker, cur);
    }

    const totalMarketValue = [...merged.values()].reduce((s, p) => s + p.marketValue, 0);

    const positions: FamilyPosition[] = [...merged.values()]
      .map((p) => ({
        ticker: p.ticker,
        displayTicker: p.displayTicker,
        company: p.company,
        sector: p.sector,
        industry: p.industry,
        quantity: p.quantity,
        // The blended cost the household actually paid, weighted by size.
        averageCost: p.quantity !== 0 ? p.investedTotal / p.quantity : 0,
        costBasis: p.costBasis,
        currentPrice: p.currentPrice,
        marketValue: p.marketValue,
        unrealizedPnL: p.unrealizedPnL,
        unrealizedPnLPercent: p.costBasis !== 0 ? (p.unrealizedPnL / p.costBasis) * 100 : 0,
        weight: totalMarketValue > 0 ? (p.marketValue / totalMarketValue) * 100 : 0,
        realizedPnL: p.realizedPnL,
        accounts: p.accounts,
        holders: p.holders.sort((a, b) => b.marketValue - a.marketValue),
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    // --- sector allocation of the merged book ---
    const sectorMap = new Map<string, FamilySectorAllocation>();
    for (const p of positions) {
      const cur =
        sectorMap.get(p.sector) ??
        { sector: p.sector, marketValue: 0, weight: 0, positions: 0, unrealizedPnL: 0 };
      cur.marketValue += p.marketValue;
      cur.unrealizedPnL += p.unrealizedPnL;
      // Counted per merged name, so a stock held by three accounts is one
      // position in the household's sector mix, not three.
      cur.positions += 1;
      sectorMap.set(p.sector, cur);
    }

    const sectorAllocation = [...sectorMap.values()]
      .map((s) => ({
        ...s,
        weight: totalMarketValue > 0 ? (s.marketValue / totalMarketValue) * 100 : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    // --- member summaries ---
    const members = family.clients.map((c) => {
      const marketValue = c.holdings
        .filter((h) => Math.abs(h.quantity) > CLOSED_POSITION_EPSILON)
        .reduce((s, h) => s + h.quantity * (livePrice.get(h.ticker) ?? h.currentPrice), 0);
      return {
        id: c.id,
        name: c.name,
        marketValue,
        cashBalance: c.cashBalance,
        portfolioValue: marketValue + c.cashBalance,
      };
    });

    const costBasis = positions.reduce((s, p) => s + p.costBasis, 0);
    const unrealizedPnL = positions.reduce((s, p) => s + p.unrealizedPnL, 0);
    // Summed per member, never per position — a client's balance must be
    // counted once for the household, not once for every lot they own.
    const cashBalance = members.reduce((s, m) => s + m.cashBalance, 0);

    return {
      id: family.id,
      name: family.name,
      market,
      currency: currencyForMarket(market),
      members,
      positions,
      sectorAllocation,
      totals: {
        positionCount: positions.length,
        lotCount: lots.length,
        costBasis,
        marketValue: totalMarketValue,
        unrealizedPnL,
        unrealizedPnLPercent: costBasis !== 0 ? (unrealizedPnL / costBasis) * 100 : 0,
        realizedPnL: positions.reduce((s, p) => s + p.realizedPnL, 0),
        cashBalance,
        portfolioValue: totalMarketValue + cashBalance,
      },
    };
  }

  /**
   * Live quote per distinct symbol. A failed lookup is absent from the map and
   * the caller falls back to the lot's stored price, so one unreachable ticker
   * never fails the whole household view.
   */
  private async livePrices(tickers: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          // Stored tickers are fully qualified, so the book is read off the
          // symbol's own suffix rather than the family's.
          const { currentPrice } = await this.market.lookup(ticker, marketForSymbol(ticker));
          if (typeof currentPrice === 'number') prices.set(ticker, currentPrice);
        } catch (error) {
          this.logger.warn(
            `Live price lookup failed for ${ticker}: ${(error as Error).message}`,
          );
        }
      }),
    );
    return prices;
  }
}
