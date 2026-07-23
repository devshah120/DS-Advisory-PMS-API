import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import {
  buildFlows,
  JUN30_REBASE_DATE,
  rebaseLedgerToJun30,
} from '../analytics/calculators/flows';
import { xirr } from '../analytics/calculators/xirr';

// Prisma persists SCREAMING_CASE enums; the HTTP contract uses lowercase.
const toDb = <T extends string>(v: T | undefined) =>
  v === undefined ? undefined : (v.toUpperCase() as any);

const toApi = (v: string | null | undefined) =>
  v == null ? v : (v.toLowerCase() as any);

function serialize<T extends { riskProfile: string; status: string; accountingMethod?: string }>(
  client: T
) {
  return {
    ...client,
    riskProfile: toApi(client.riskProfile),
    status: toApi(client.status),
    // CASH_FLOW -> cash_flow. toApi already lowercases; the underscore survives.
    accountingMethod: toApi(client.accountingMethod),
  };
}

/**
 * Portfolio value and XIRR for the Clients list, DERIVED — never read from the
 * stored Client.portfolioValue / Client.xirr columns.
 *
 * Those columns default to 0 and are only written by the workbook importer; the
 * bulk trade import writes holdings and a transaction ledger but never touches
 * them, so every bulk-imported client read $0.00 / 0.00% on the list. The
 * analytics engine already derives value the same way (quantity × price + cash);
 * this mirrors it so the list agrees with the Performance page.
 *
 *   portfolioValue = Σ(quantity × live price) + cashBalance   (cash is tracked but
 *                    idle — it inflates value, not the deployed-capital XIRR)
 *   xirr           = transactional XIRR over the BUY/SELL/DIVIDEND/FEES ledger,
 *                    terminal value = holdings only (idle cash excluded), or 0
 *                    when the ledger has no trades to solve on.
 *
 * Holdings are valued at LIVE quotes (with stored currentPrice as the fallback),
 * NOT the stored `marketValue` cache — because that is exactly how the Performance
 * page (SnapshotService) values them. Using the stored cache here made the list's
 * XIRR disagree with the Performance page (−38.9% vs −18.1% for Mrugesh) whenever
 * the cache had drifted from the live price. Same terminal value → same XIRR.
 */
function deriveMetrics(
  client: {
    cashBalance: number;
    holdings: Array<{ ticker: string; quantity: number; averageCost: number; currentPrice: number }>;
    transactions: Array<{ type: string; amount: number; date: Date }>;
  },
  jun30Close: Map<string, number>,
  /** ticker → live price; falls back to the holding's stored currentPrice when absent. */
  livePrice: Map<string, number>,
) {
  const holdingsValue = client.holdings.reduce(
    (s, h) => s + h.quantity * (livePrice.get(h.ticker) ?? h.currentPrice),
    0,
  );
  const portfolioValue = holdingsValue + client.cashBalance;

  // Every client is transactional now (see create/update). Terminal value is
  // holdings only — idle cash is excluded from the transactional return.
  //
  // The ledger is rebased onto a 30-June-2026 cost basis first — the SAME shared
  // transform the Performance page uses (rebaseLedgerToJun30 in flows.ts) — so the
  // list's XIRR matches the Performance page instead of showing the exploded
  // pre-rebase figure. Without this the two pages disagreed: Performance read
  // −16.9% while the list still showed +23,000,000%.
  const rebased = rebaseLedgerToJun30(client.holdings, client.transactions, jun30Close);
  const built = buildFlows(rebased, 'TRANSACTIONAL', holdingsValue, new Date());
  let rate = 0;
  if (built.status === 'ok') {
    const solved = xirr(built.flows);
    if (solved.status === 'ok') rate = solved.rate * 100; // the list renders a percent
  }

  return { portfolioValue, xirr: rate };
}

@Injectable()
export class ClientsService {
  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  async create(dto: CreateClientDto) {
    const existing = await this.prisma.client.findFirst({
      where: {
        broker: dto.broker,
        accountNumber: dto.accountNumber,
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        `Account ${dto.accountNumber} already exists for broker ${dto.broker}`
      );
    }

    try {
      const client = await this.prisma.client.create({
        data: {
          ...dto,
          riskProfile: toDb(dto.riskProfile),
          status: toDb(dto.status),
          // Every client is transactional now — the cash-flow method has been
          // retired from the product. Force it regardless of what the payload
          // carries so an old client or a stale form can't reintroduce it.
          accountingMethod: 'TRANSACTIONAL',
          inceptionDate: new Date(dto.inceptionDate),
        },
      });
      return serialize(client);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A client with these details already exists');
      }
      throw err;
    }
  }

  async findAll(skip = 0, take = 10) {
    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          holdings: true,
          transactions: true,
        },
      }),
      this.prisma.client.count(),
    ]);

    // Distinct tickers held across this page, resolved once and shared by every
    // client's deriveMetrics.
    const tickers = [...new Set(clients.flatMap((c) => c.holdings.map((h) => h.ticker)))];

    // 30-June-2026 closes (the rebasing cost basis) and today's LIVE quotes (the
    // terminal value) — both keyed by ledger ticker. Live quotes make the list's
    // terminal value identical to the Performance page's, so the XIRRs agree;
    // MarketService caches per ticker for an hour, so a symbol held by several
    // clients hits Yahoo at most once.
    const bars = await this.prisma.priceBar.findMany({
      where: { symbol: { in: tickers }, date: JUN30_REBASE_DATE },
      select: { symbol: true, adjClose: true },
    });
    const jun30Close = new Map(bars.map((b) => [b.symbol, b.adjClose]));

    const livePrice = new Map<string, number>();
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const { currentPrice } = await this.market.lookup(ticker);
          if (typeof currentPrice === 'number') livePrice.set(ticker, currentPrice);
        } catch {
          // Absent → deriveMetrics falls back to the holding's stored currentPrice.
        }
      }),
    );

    return {
      // Overlay the derived portfolioValue / xirr onto the serialized record so
      // the list stops showing $0.00 / 0.00% for bulk-imported clients whose
      // stored columns were never written. cashBalance stays as stored.
      data: clients.map((c) => ({ ...serialize(c), ...deriveMetrics(c, jun30Close, livePrice) })),
      total,
      page: Math.floor(skip / take) + 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        holdings: true,
        transactions: true,
        research: true,
      },
    });

    if (!client) throw new NotFoundException(`Client ${id} not found`);
    return serialize(client);
  }

  async update(id: string, dto: UpdateClientDto) {
    await this.findOne(id);

    const client = await this.prisma.client.update({
      where: { id },
      data: {
        ...dto,
        riskProfile: toDb(dto.riskProfile),
        status: toDb(dto.status),
        // Retired: always transactional. Saving any client normalizes a
        // legacy CASH_FLOW record onto the surviving method.
        accountingMethod: 'TRANSACTIONAL',
        inceptionDate: dto.inceptionDate ? new Date(dto.inceptionDate) : undefined,
      },
    });
    return serialize(client);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.client.delete({ where: { id } });
    return { success: true, id };
  }

  async count() {
    return this.prisma.client.count();
  }

  async getClientMetrics(id: string) {
    const client = await this.findOne(id);

    const totalValue = client.holdings.reduce(
      (sum: number, h: any) => sum + h.marketValue,
      0
    );
    const totalCost = client.holdings.reduce(
      (sum: number, h: any) => sum + h.averageCost * h.quantity,
      0
    );

    return {
      ...client,
      totalInvested: totalCost,
      unrealizedGain: totalValue - totalCost,
      gainPercent: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    };
  }
}
