import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Market, DEFAULT_MARKET, ALL_MARKETS } from '../common/market-scope';
import { WatchlistEvent } from '../market/events.service';
import { YahooEventsService } from '../market/yahoo-events.service';
import { EventSnapshotRepository } from './event-snapshot.repository';

export interface PortfolioEvent extends WatchlistEvent {
  company: string;
  /** How many clients currently hold this ticker — a rough measure of exposure. */
  clientCount: number;
  /** Which book the ticker trades in, so the UI never mixes the two. */
  market: Market;
  /** True when the ticker is only watchlisted, i.e. no client holds it yet. */
  watchlistOnly: boolean;
}

export interface EventRefreshResult {
  refreshed: number;
  tickers: number;
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
  async forAllHoldings(market: Market = DEFAULT_MARKET): Promise<PortfolioEvent[]> {
    const byTicker = await this.trackedTickers(market);
    const stored = await this.snapshots.listAll();

    return stored
      .filter((e) => byTicker.has(e.ticker))
      .map((e) => {
        const entry = byTicker.get(e.ticker)!;
        return {
          ticker: e.ticker,
          type: e.type as WatchlistEvent['type'],
          code: e.code as WatchlistEvent['code'],
          label: e.label,
          date: e.date,
          status: e.status as WatchlistEvent['status'],
          company: entry.company,
          clientCount: entry.clientIds.size,
          market,
          watchlistOnly: entry.clientIds.size === 0,
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
  ): Promise<Map<string, { company: string; clientIds: Set<string> }>> {
    const [stored, watched] = await Promise.all([
      this.prisma.holding.findMany({
        where: { client: { market } },
        select: { ticker: true, company: true, clientId: true, quantity: true },
      }),
      this.prisma.watchlist.findMany({
        where: { market },
        select: { ticker: true, company: true },
      }),
    ]);

    const byTicker = new Map<string, { company: string; clientIds: Set<string> }>();

    for (const h of stored.filter((h) => Math.abs(h.quantity) > 1e-9)) {
      const entry = byTicker.get(h.ticker) ?? { company: h.company, clientIds: new Set<string>() };
      entry.clientIds.add(h.clientId);
      byTicker.set(h.ticker, entry);
    }

    // Added after the holdings so a name that is both held and watchlisted keeps
    // its real clientCount instead of being reset to a watchlist-only zero.
    for (const w of watched) {
      if (byTicker.has(w.ticker)) continue;
      byTicker.set(w.ticker, { company: w.company, clientIds: new Set<string>() });
    }

    return byTicker;
  }
}
