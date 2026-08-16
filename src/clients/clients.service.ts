import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
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
import {
  DEFAULT_MARKET,
  Market,
  currencyForMarket,
  marketForSymbol,
} from '../common/market-scope';
import {
  Actor,
  assertCanAccessClient,
  assertFirmWide,
  clientWhere,
  isFirmWide,
  ownerForCreate,
} from '../common/ownership-scope';

// Prisma persists SCREAMING_CASE enums; the HTTP contract uses lowercase.
const toDb = <T extends string>(v: T | undefined) =>
  v === undefined ? undefined : (v.toUpperCase() as any);

const toApi = (v: string | null | undefined) =>
  v == null ? v : (v.toLowerCase() as any);

// The User model splits names into first/last; a client only carries a single
// display name. Split on the first space so "Evergreen Capital" → ("Evergreen",
// "Capital") and a one-word name keeps an empty last name.
const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name.trim();
const lastNameOf = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
};

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

  async create(dto: CreateClientDto, actor: Actor) {
    // Who this mandate will belong to. A manager always owns what they create;
    // only a Super Admin may name someone else (the form's "Assigned Manager").
    const ownerId = ownerForCreate(actor, dto.ownerId);
    await this.assertOwnerIsManager(ownerId);

    // Scoped: the broker+account uniqueness check must not report a conflict
    // against a mandate the caller cannot see. Doing so would leak that another
    // manager holds that account number — a slow enumeration of the firm's book
    // through the create form.
    const existing = await this.prisma.client.findFirst({
      where: {
        ...clientWhere(actor),
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

    // The login account is a User row keyed by a unique email, so a client login
    // needs an email. Password is required on create (DTO), so require the email
    // alongside it rather than silently creating a client with no way to sign in.
    //
    // `ownerId` is pulled out and discarded here: the authoritative value was
    // already resolved through ownerForCreate above, and letting the raw payload
    // field survive into the spread would let a manager POST someone else's
    // ownerId and file a mandate into their book.
    const { password, ownerId: _ignoredOwnerId, ...clientData } = dto;
    if (!dto.email) {
      throw new BadRequestException({
        message: 'Please correct the highlighted fields.',
        errors: { email: 'An email is required to create the login account' },
      });
    }
    // The email must be free across all users (staff and other client logins).
    const emailTaken = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (emailTaken) {
      throw new ConflictException({
        message: 'Please correct the highlighted fields.',
        errors: { email: 'An account with this email already exists' },
      });
    }

    // Which book this mandate belongs to. The currency follows from it unless the
    // caller named one explicitly — an Indian client should report in rupees
    // without the form having to restate that on every create, and the schema's
    // "USD" column default would otherwise quietly win.
    const market: Market = (dto.market as Market) ?? DEFAULT_MARKET;

    // A household holds accounts from one book only — see FamiliesService.
    await this.assertFamilyInMarket(dto.familyId, market);

    try {
      const client = await this.prisma.client.create({
        data: {
          ...clientData,
          ownerId,
          market,
          currency: dto.currency ?? currencyForMarket(market),
          riskProfile: toDb(dto.riskProfile),
          status: toDb(dto.status),
          // Every client is transactional now — the cash-flow method has been
          // retired from the product. Force it regardless of what the payload
          // carries so an old client or a stale form can't reintroduce it.
          accountingMethod: 'TRANSACTIONAL',
          inceptionDate: new Date(dto.inceptionDate),
          // Create the client's own login (role VIEWER) in the same write, linked
          // by clientId. Reuses the existing /auth/login + JWT + reset flow.
          loginUsers: {
            create: {
              email: dto.email,
              firstName: firstNameOf(dto.name),
              lastName: lastNameOf(dto.name),
              password: await bcrypt.hash(password, 10),
              role: 'VIEWER',
            },
          },
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

  /**
   * Rejects an "Assigned Manager" that cannot actually hold a book.
   *
   * A mandate assigned to a client-portal login (VIEWER) would be invisible to
   * every manager and to the portal user alike; one assigned to a deactivated
   * account would be invisible to everyone but a Super Admin. Both are silent
   * data-loss shapes, so they are rejected at the point of assignment rather
   * than discovered later as a client that "disappeared".
   *
   * Null is valid and means UNASSIGNED — Super-Admin-visible only.
   */
  private async assertOwnerIsManager(ownerId: string | null) {
    if (!ownerId) return;

    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, role: true, active: true, clientId: true },
    });

    if (!owner || owner.clientId || owner.role === 'VIEWER') {
      throw new BadRequestException({
        message: 'Please correct the highlighted fields.',
        errors: { ownerId: 'Select a staff member who can hold a book of business' },
      });
    }
    if (!owner.active) {
      throw new BadRequestException({
        message: 'Please correct the highlighted fields.',
        errors: { ownerId: 'That account is deactivated' },
      });
    }
  }

  /**
   * Rejects placing a mandate in a household from another book.
   *
   * The family view sums its members' positions into one portfolio value, and
   * an INR mandate cannot be added to a USD household without an FX rate the
   * codebase does not have. Catching it here (as well as in FamiliesService)
   * means neither entry point — the client form or the family editor — can
   * create the mismatch.
   */
  private async assertFamilyInMarket(familyId: string | null | undefined, market: Market) {
    if (!familyId) return;

    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: { name: true, market: true },
    });
    if (!family) {
      throw new BadRequestException({
        message: 'Please correct the highlighted fields.',
        errors: { familyId: 'That family no longer exists' },
      });
    }
    if (family.market !== market) {
      throw new BadRequestException({
        message: 'Please correct the highlighted fields.',
        errors: {
          familyId: `"${family.name}" is in the ${family.market} book — a family holds accounts from one book only`,
        },
      });
    }
  }

  /**
   * `market` narrows the list to one book. Optional — an omitted value returns
   * every book, which is what a firm-wide export or an admin screen wants; the
   * header's country selector always sends it.
   *
   * `actor` narrows it to one MANAGER, and unlike market it is REQUIRED — note
   * it sits before the optional `market` in the signature for that reason.
   * Omitting the book is a display choice; omitting the owner would be a data
   * leak, so the compiler is made to enforce it rather than a reviewer. A Super
   * Admin's filter resolves to `{}` and sees the firm.
   */
  async findAll(actor: Actor, skip = 0, take = 10, market?: Market) {
    const where = {
      ...clientWhere(actor),
      ...(market ? { market } : {}),
    };
    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          holdings: true,
          transactions: true,
          // The list shows which household a mandate belongs to, and the
          // family selector is built from the same read.
          family: { select: { id: true, name: true } },
        },
      }),
      this.prisma.client.count({ where }),
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

    // Stored tickers are already fully qualified ('RELIANCE.NS'), so the market
    // is read off the symbol itself rather than the client's — a lookup here
    // needs no hint and stays correct even for a mixed page of both books.
    const livePrice = new Map<string, number>();
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const { currentPrice } = await this.market.lookup(ticker, marketForSymbol(ticker));
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

  /**
   * One mandate, if this actor is allowed to see it.
   *
   * The ownership check runs AFTER the fetch rather than as a `where` clause so
   * that "absent" and "not yours" both land in assertCanAccessClient and come
   * back as the same NotFoundException — a 403 here would confirm the id exists
   * and turn id-guessing into a census of the firm's clients.
   */
  async findOne(id: string, actor: Actor) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        holdings: true,
        transactions: true,
        research: true,
        family: { select: { id: true, name: true } },
      },
    });

    assertCanAccessClient(actor, client);
    return serialize(client!);
  }

  async update(id: string, dto: UpdateClientDto, actor: Actor) {
    // Doubles as the ownership gate: findOne throws NotFound unless this actor
    // owns the mandate, so everything below is already authorised.
    const current = await this.findOne(id, actor);

    // Reassigning a mandate to another manager is a Super-Admin-only act. A
    // manager who could set this could push a client out of their own book (or,
    // worse, pull one in) and quietly move the data this whole boundary exists
    // to separate.
    if (dto.ownerId !== undefined && dto.ownerId !== current.ownerId) {
      assertFirmWide(actor, 'reassign a client to another manager');
      await this.assertOwnerIsManager(dto.ownerId ?? null);
    }

    // Validated against the mandate's own book (which an edit cannot change),
    // not the payload's — otherwise an omitted `market` would fall back to the
    // US default and let an Indian client join a US household.
    if (dto.familyId !== undefined) {
      await this.assertFamilyInMarket(dto.familyId, current.market as Market);
    }

    // Password is edit-optional: a blank/absent value leaves the login unchanged.
    // Never persist it on the client row — hash it into the linked User instead.
    //
    // `ownerId` is split out and re-applied below only when the actor passed the
    // Super-Admin check above; letting the spread carry it would reintroduce the
    // reassignment path that check exists to close.
    const { password, ownerId: requestedOwnerId, ...clientData } = dto;
    if (password) {
      const login = await this.prisma.user.findFirst({
        where: { clientId: id },
        select: { id: true },
      });
      const hashed = await bcrypt.hash(password, 10);
      if (login) {
        await this.prisma.user.update({
          where: { id: login.id },
          data: { password: hashed },
        });
      } else {
        // The client predates client logins (or never had one). Create it now —
        // this needs an email, which comes from the payload or the stored record.
        const email = dto.email ?? current.email;
        if (!email) {
          throw new BadRequestException({
            message: 'Please correct the highlighted fields.',
            errors: { email: 'An email is required to create the login account' },
          });
        }
        const emailTaken = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (emailTaken) {
          throw new ConflictException({
            message: 'Please correct the highlighted fields.',
            errors: { email: 'An account with this email already exists' },
          });
        }
        const name = dto.name ?? current.name;
        await this.prisma.user.create({
          data: {
            email,
            firstName: firstNameOf(name),
            lastName: lastNameOf(name),
            password: hashed,
            role: 'VIEWER',
            clientId: id,
          },
        });
      }
    }

    // Keep the login's email in sync when the client's contact email changes.
    if (dto.email) {
      await this.prisma.user.updateMany({
        where: { clientId: id },
        data: { email: dto.email },
      });
    }

    const client = await this.prisma.client.update({
      where: { id },
      data: {
        ...clientData,
        // Only a Super Admin reaches here with a changed value — the guard at
        // the top of this method already threw for anyone else.
        ...(isFirmWide(actor) && requestedOwnerId !== undefined
          ? { ownerId: requestedOwnerId }
          : {}),
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

  async remove(id: string, actor: Actor) {
    // Ownership gate — NotFound for a mandate that is not this actor's, so a
    // manager cannot delete (or probe for) another manager's client.
    await this.findOne(id, actor);
    await this.prisma.client.delete({ where: { id } });
    return { success: true, id };
  }

  /** Headline count for the caller's own book; the firm's, for a Super Admin. */
  async count(actor: Actor) {
    return this.prisma.client.count({ where: clientWhere(actor) });
  }

  async getClientMetrics(id: string, actor: Actor) {
    const client = await this.findOne(id, actor);

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
