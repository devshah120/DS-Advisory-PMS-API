import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Market, DEFAULT_MARKET, ALL_MARKETS } from '../common/market-scope';
import { Actor, clientWhere, ownedWhere } from '../common/ownership-scope';
import { WatchlistEvent } from '../market/events.service';
import { YahooEventsService } from '../market/yahoo-events.service';
import { EventSnapshotRepository } from './event-snapshot.repository';

/** One client's exposure to a single event — the rows behind the Held By hover. */
export interface EventHolder {
  clientId: string;
  clientName: string;
  /** Shares held right now, which is what the entitlement is priced on. */
  quantity: number;
  /**
   * `quantity x dividendRate` — this client's ANNUAL dividend income from the
   * name, in the book's currency. Null for non-dividend events and whenever
   * the upstream had no rate.
   */
  annualAmount: number | null;
  /**
   * The single payment this event represents, `annualAmount / payoutsPerYear`.
   * Null when the frequency could not be inferred — an estimate is offered
   * only where there is a real basis for one.
   */
  estimatedAmount: number | null;
}

export interface PortfolioEvent extends WatchlistEvent {
  company: string;
  /** How many clients currently hold this ticker — a rough measure of exposure. */
  clientCount: number;
  /** Which book the ticker trades in, so the UI never mixes the two. */
  market: Market;
  /** True when the ticker is only watchlisted, i.e. no client holds it yet. */
  watchlistOnly: boolean;
  /** Per-client breakdown behind the count, largest holder first. */
  holders: EventHolder[];
  /** Shares held across every client — the hover's footer total. */
  totalQuantity: number;
  /** Annual dividend across every client. Null when there is no rate. */
  totalAnnualAmount: number | null;
  /** Estimated single payment across every client. Null without a frequency. */
  totalEstimatedAmount: number | null;
}

export interface EventRefreshResult {
  refreshed: number;
  tickers: number;
}

/** One ticker's event universe entry, keyed by clientId so lots merge per client. */
interface TrackedTicker {
  company: string;
  holders: Map<string, { clientName: string; quantity: number }>;
}

/**
 * The Event Center's data source: every ticker any client currently holds
 * (deduplicated), not the watchlist and not S&P 500 constituents. A client's
 * money is at stake in a holding whether or not anyone remembered to also
 * watchlist it, so that is the list this page has to be complete over.
 *
 * DB-first, exactly like the Fundamentals page: reads serve the EventSnapshot
 * store and never call upstream, so the page keeps rendering when Yahoo is
 * throttling or the API just restarted. Yahoo is only ever touched by
 * refresh(), which the manual POST /events/refresh endpoint triggers.
 */
@Injectable()
export class PortfolioEventsService {
  private readonly logger = new Logger(PortfolioEventsService.name);

  constructor(
    private prisma: PrismaService,
    private events: YahooEventsService,
    private snapshots: EventSnapshotRepository,
  ) {}

  /**
   * DB-first read — serves the last saved snapshot, no upstream call.
   *
   * Scoped to one book. An event whose ticker is not in the selected market's
   * universe is dropped rather than shown greyed out: the Indian desk reviewing
   * corporate actions has no use for an Apple ex-date, and a mixed calendar is
   * actively confusing when the two books' dates sit side by side.
   */
  async forAllHoldings(
    market: Market = DEFAULT_MARKET,
    actor?: Actor,
  ): Promise<PortfolioEvent[]> {
    const byTicker = await this.trackedTickers(market, actor);
    const stored = await this.snapshots.listAll();

    return stored
      .filter((e) => byTicker.has(e.ticker))
      .map((e) => {
        const entry = byTicker.get(e.ticker)!;

        // Only a dividend carries cash. A split changes the share count, not
        // the client's money, so its holders are listed with quantities and no
        // amount rather than a misleading zero.
        const rate = e.type === 'DIVIDEND' ? e.dividendRate : null;
        const frequency = e.type === 'DIVIDEND' ? e.payoutsPerYear : null;

        const holders: EventHolder[] = [...entry.holders.entries()]
          .map(([clientId, h]) => {
            const annualAmount = rate != null ? h.quantity * rate : null;
            return {
              clientId,
              clientName: h.clientName,
              quantity: h.quantity,
              annualAmount,
              estimatedAmount:
                annualAmount != null && frequency ? annualAmount / frequency : null,
            };
          })
          // Largest position first: the advisor wants the most exposed client
          // at the top of the hover, not whichever row Mongo returned first.
          .sort((a, b) => b.quantity - a.quantity);

        const totalQuantity = holders.reduce((sum, h) => sum + h.quantity, 0);

        return {
          ticker: e.ticker,
          type: e.type as WatchlistEvent['type'],
          code: e.code as WatchlistEvent['code'],
          label: e.label,
          date: e.date,
          status: e.status as WatchlistEvent['status'],
          dividendRate: rate,
          payoutsPerYear: frequency,
          company: entry.company,
          clientCount: entry.holders.size,
          market,
          watchlistOnly: entry.holders.size === 0,
          holders,
          totalQuantity,
          totalAnnualAmount: rate != null ? totalQuantity * rate : null,
          totalEstimatedAmount:
            rate != null && frequency ? (totalQuantity * rate) / frequency : null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Fetches Yahoo's calendar for every tracked ticker and replaces the snapshot.
   * The one place in the Event Center that goes out to the network — one
   * request per ticker, since Yahoo has no whole-market calendar feed.
   */
  async refresh(): Promise<EventRefreshResult> {
    // Deliberately refreshes BOTH books in one pass, even though reads are
    // scoped to one. The snapshot is a single shared store, so fetching only the
    // active market would delete the other book's events on every replaceAll —
    // switching the selector would then show an empty calendar until someone
    // refreshed again from that side.
    // Deliberately UNSCOPED (no actor): the snapshot is one shared store keyed
    // by ticker, so it must be built from every manager's tracked universe.
    // Scoping this would make whichever manager refreshed last delete everyone
    // else's events. Privacy is enforced on the READ path instead — a manager
    // only ever sees the rows whose tickers they actually hold or watch.
    const universes = await Promise.all(ALL_MARKETS.map((m) => this.trackedTickers(m)));
    const tickers = [...new Set(universes.flatMap((u) => [...u.keys()]))];

    const raw = await this.events.forTickers(tickers);
    const refreshed = await this.snapshots.replaceAll(raw);

    this.logger.log(
      `Event snapshot refreshed: ${refreshed} events across ${tickers.length} tracked tickers (all books)`,
    );
    return { refreshed, tickers: tickers.length };
  }

  /**
   * One book's event universe: every ticker held by a client in that market,
   * plus every ticker on that market's watchlist, deduplicated.
   *
   * "Held" means an open position. A sold-out lot keeps its row for the
   * realized P&L it booked, but its earnings and dividend dates are no longer
   * this desk's business — surfacing them would alert an advisor about a name
   * their client has already exited.
   *
   * Watchlisted names are in scope because the desk tracks a candidate's
   * earnings date before it ever buys — the same rule the US book already
   * follows. They carry clientCount 0, which is what marks them watchlist-only.
   *
   * Holdings are scoped through `client.market` rather than a column on Holding
   * itself: the position belongs to whichever book its mandate does, and that is
   * how /holdings scopes too.
   */
  private async trackedTickers(
    market: Market,
    actor?: Actor,
  ): Promise<Map<string, TrackedTicker>> {
    const [stored, watched] = await Promise.all([
      this.prisma.holding.findMany({
        where: {
          client: { market, ...(actor ? clientWhere(actor) : {}) },
        },
        // The client relation is what turns a bare count into a named
        // breakdown; quantity is what prices each holder's entitlement.
        select: {
          ticker: true,
          company: true,
          clientId: true,
          quantity: true,
          client: { select: { name: true } },
        },
      }),
      this.prisma.watchlist.findMany({
        where: { market, ...(actor ? ownedWhere(actor) : {}) },
        select: { ticker: true, company: true },
      }),
    ]);

    const byTicker = new Map<string, TrackedTicker>();

    for (const h of stored.filter((h) => Math.abs(h.quantity) > 1e-9)) {
      const entry = byTicker.get(h.ticker) ?? { company: h.company, holders: new Map() };
      // A client can hold the same ticker across several lots; the entitlement
      // is on the combined position, so quantities accumulate per client rather
      // than the last lot overwriting the earlier ones.
      const held = entry.holders.get(h.clientId);
      if (held) {
        held.quantity += h.quantity;
      } else {
        entry.holders.set(h.clientId, {
          clientName: h.client?.name ?? 'Unknown client',
          quantity: h.quantity,
        });
      }
      byTicker.set(h.ticker, entry);
    }

    // Added after the holdings so a name that is both held and watchlisted keeps
    // its real clientCount instead of being reset to a watchlist-only zero.
    for (const w of watched) {
      if (byTicker.has(w.ticker)) continue;
      byTicker.set(w.ticker, { company: w.company, holders: new Map() });
    }

    return byTicker;
  }
}
