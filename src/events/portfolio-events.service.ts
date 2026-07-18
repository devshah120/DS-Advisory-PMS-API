import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventsService, WatchlistEvent } from '../market/events.service';

export interface PortfolioEvent extends WatchlistEvent {
  company: string;
  /** How many clients currently hold this ticker — a rough measure of exposure. */
  clientCount: number;
}

/**
 * The Event Center's data source: every ticker any client currently holds
 * (deduplicated), not the watchlist and not S&P 500 constituents. A client's
 * money is at stake in a holding whether or not anyone remembered to also
 * watchlist it, so that is the list this page has to be complete over.
 */
@Injectable()
export class PortfolioEventsService {
  constructor(
    private prisma: PrismaService,
    private events: EventsService,
  ) {}

  async forAllHoldings(): Promise<PortfolioEvent[]> {
    const holdings = await this.prisma.holding.findMany({
      select: { ticker: true, company: true, clientId: true },
    });

    const byTicker = new Map<string, { company: string; clientIds: Set<string> }>();
    for (const h of holdings) {
      const entry = byTicker.get(h.ticker) ?? { company: h.company, clientIds: new Set() };
      entry.clientIds.add(h.clientId);
      byTicker.set(h.ticker, entry);
    }

    const tickers = [...byTicker.keys()];
    const raw = await this.events.forTickers(tickers);

    return raw.map((e) => ({
      ...e,
      company: byTicker.get(e.ticker)?.company ?? e.ticker,
      clientCount: byTicker.get(e.ticker)?.clientIds.size ?? 0,
    }));
  }
}
