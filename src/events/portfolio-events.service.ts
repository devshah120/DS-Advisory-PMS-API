import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventsService, WatchlistEvent } from '../market/events.service';
import { EventSnapshotRepository } from './event-snapshot.repository';

export interface PortfolioEvent extends WatchlistEvent {
  company: string;
  /** How many clients currently hold this ticker — a rough measure of exposure. */
  clientCount: number;
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
 * store and never call FMP, so the page keeps rendering when the FMP request
 * budget is exhausted or the API just restarted. FMP is only ever touched by
 * refresh(), which the manual POST /events/refresh endpoint triggers.
 */
@Injectable()
export class PortfolioEventsService {
  private readonly logger = new Logger(PortfolioEventsService.name);

  constructor(
    private prisma: PrismaService,
    private events: EventsService,
    private snapshots: EventSnapshotRepository,
  ) {}

  /** DB-first read — serves the last saved snapshot, no FMP call. */
  async forAllHoldings(): Promise<PortfolioEvent[]> {
    const byTicker = await this.holdingsByTicker();
    const stored = await this.snapshots.listAll();

    return stored
      .map((e) => ({
        ticker: e.ticker,
        type: e.type as WatchlistEvent['type'],
        code: e.code as WatchlistEvent['code'],
        label: e.label,
        date: e.date,
        status: e.status as WatchlistEvent['status'],
        company: byTicker.get(e.ticker)?.company ?? e.ticker,
        clientCount: byTicker.get(e.ticker)?.clientIds.size ?? 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Fetches the FMP calendars for every held ticker and replaces the snapshot.
   * The one place in the Event Center that spends the FMP request budget.
   */
  async refresh(): Promise<EventRefreshResult> {
    const byTicker = await this.holdingsByTicker();
    const tickers = [...byTicker.keys()];

    const raw = await this.events.forTickers(tickers);
    const refreshed = await this.snapshots.replaceAll(raw);

    this.logger.log(`Event snapshot refreshed: ${refreshed} events across ${tickers.length} held tickers`);
    return { refreshed, tickers: tickers.length };
  }

  /** Deduplicated held tickers -> { company, set of clientIds }. */
  private async holdingsByTicker(): Promise<Map<string, { company: string; clientIds: Set<string> }>> {
    const holdings = await this.prisma.holding.findMany({
      select: { ticker: true, company: true, clientId: true },
    });

    const byTicker = new Map<string, { company: string; clientIds: Set<string> }>();
    for (const h of holdings) {
      const entry = byTicker.get(h.ticker) ?? { company: h.company, clientIds: new Set() };
      entry.clientIds.add(h.clientId);
      byTicker.set(h.ticker, entry);
    }
    return byTicker;
  }
}
