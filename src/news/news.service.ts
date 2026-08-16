import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Market,
  DEFAULT_MARKET,
  ALL_MARKETS,
  displaySymbol,
} from '../common/market-scope';
import { NewsRepository } from './news.repository';
import { NewsItem, NewsKind, NewsTag } from './news.types';
import { YahooNewsProvider } from './providers/yahoo-news.provider';
import { BseFilingsProvider } from './providers/bse-filings.provider';
import { GoogleNewsProvider } from './providers/google-news.provider';

/** One story as the News Center renders it. */
export interface NewsFeedItem {
  id: string;
  ticker: string;
  /** Suffix stripped for display — 'RELIANCE.NS' reads as 'RELIANCE'. */
  symbol: string;
  company: string;
  market: Market;
  title: string;
  publisher: string;
  url: string;
  summary: string | null;
  publishedAt: string;
  kind: NewsKind;
  category: string | null;
  tag: NewsTag | null;
  source: string;
  /** True when no client holds the name — it is only being watched. */
  watchlistOnly: boolean;
  /** How many clients hold it, for the exposure badge. */
  clientCount: number;
}

export interface NewsRefreshResult {
  created: number;
  pruned: number;
  tickers: number;
}

/** A tracked name and who is exposed to it. */
interface TrackedName {
  company: string;
  clientCount: number;
}

/**
 * The News Center's data source: recent news and exchange filings for every
 * ticker the selected book holds or watchlists.
 *
 * The universe rule is deliberately identical to the Event Center's — an
 * advisor's attention should follow the money, and a name is equally worth
 * knowing about whether the exposure is a live position or a candidate on the
 * watchlist. Sharing the rule also means the two pages can never disagree about
 * which names matter.
 *
 * DB-first: reads serve the stored feed and never call upstream, so the page
 * renders instantly and keeps working when Yahoo throttles or BSE is down.
 * refresh() is the only method that touches the network.
 *
 * Sources are routed per market, which is the central design decision here:
 *   - US    → Yahoo (good, well-structured coverage of US names).
 *   - INDIA → BSE filings (authoritative) + Google News (press coverage).
 * Yahoo is never asked about an Indian ticker; it answers with generic filler
 * rather than an error, which would fill the Indian feed with plausible noise.
 */
@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  constructor(
    private prisma: PrismaService,
    private repository: NewsRepository,
    private yahoo: YahooNewsProvider,
    private bse: BseFilingsProvider,
    private googleNews: GoogleNewsProvider,
  ) {}

  /**
   * The stored feed for one book, newest first, enriched with the company and
   * exposure each ticker carries. No upstream call.
   */
  async feed(
    market: Market = DEFAULT_MARKET,
    opts: { limit?: number; ticker?: string } = {},
  ): Promise<NewsFeedItem[]> {
    const tracked = await this.trackedNames(market);

    // A single-ticker drill-down still goes through the tracked universe, so a
    // ticker outside this book returns nothing instead of another book's news.
    const tickers = opts.ticker
      ? [...tracked.keys()].filter((t) => t === opts.ticker.toUpperCase())
      : [...tracked.keys()];

    const rows = await this.repository.list(market, { tickers, limit: opts.limit });

    return rows.map((row) => {
      const entry = tracked.get(row.ticker);
      return {
        id: row.id,
        ticker: row.ticker,
        symbol: displaySymbol(row.ticker),
        company: entry?.company ?? row.ticker,
        market: row.market as Market,
        title: row.title,
        publisher: row.publisher,
        url: row.url,
        summary: row.summary,
        publishedAt: row.publishedAt.toISOString(),
        kind: row.kind as NewsKind,
        category: row.category,
        tag: row.tag as NewsTag | null,
        source: row.source,
        watchlistOnly: (entry?.clientCount ?? 0) === 0,
        clientCount: entry?.clientCount ?? 0,
      };
    });
  }

  /**
   * Fetches fresh news for every tracked ticker in BOTH books and stores it.
   *
   * Both books on every run, like the Event Center's refresh: the store is
   * shared and the scheduled job has no "selected market", so refreshing one
   * side would leave the other stale until someone opened it.
   */
  async refresh(): Promise<NewsRefreshResult> {
    const universes = new Map<Market, Map<string, TrackedName>>();
    for (const market of ALL_MARKETS) {
      universes.set(market, await this.trackedNames(market));
    }

    const items: NewsItem[] = [];

    // US: Yahoo carries the coverage, keyed by ticker.
    const usNames = universes.get('US') ?? new Map();
    if (usNames.size > 0) {
      items.push(...(await this.yahoo.fetch([...usNames.keys()])));
    }

    // India: exchange filings first, then press coverage. Independent of each
    // other, so one source failing still leaves the book with the other.
    const indiaNames = universes.get('INDIA') ?? new Map();
    if (indiaNames.size > 0) {
      const tickers = [...indiaNames.keys()];
      const [filings, press] = await Promise.all([
        this.bse.fetch(tickers),
        this.googleNews.fetch(
          tickers.map((ticker) => ({
            ticker,
            company: indiaNames.get(ticker)?.company ?? '',
            market: 'INDIA' as Market,
          })),
        ),
      ]);
      items.push(...filings, ...press);
    }

    const created = await this.repository.upsertMany(items);
    const pruned = await this.repository.prune();
    const tickers = usNames.size + indiaNames.size;

    this.logger.log(
      `News refreshed: ${created} new of ${items.length} fetched across ${tickers} tracked tickers (all books); pruned ${pruned}`,
    );
    return { created, pruned, tickers };
  }

  /**
   * One book's tracked universe: every ticker held by a client in that market,
   * plus every ticker on that market's watchlist.
   *
   * Mirrors PortfolioEventsService.trackedTickers, including the open-position
   * rule — a fully-exited lot keeps its transaction history but stops
   * generating alerts, because news about a name the client no longer owns is
   * noise. Held names are added first so a name that is both held and
   * watchlisted keeps its real client count.
   */
  private async trackedNames(market: Market): Promise<Map<string, TrackedName>> {
    const [holdings, watched] = await Promise.all([
      this.prisma.holding.findMany({
        where: { client: { market } },
        select: { ticker: true, company: true, clientId: true, quantity: true },
      }),
      this.prisma.watchlist.findMany({
        where: { market },
        select: { ticker: true, company: true },
      }),
    ]);

    const byTicker = new Map<string, TrackedName>();
    // Client ids per ticker, so several lots of one name count their owner once.
    const clientsByTicker = new Map<string, Set<string>>();

    for (const h of holdings.filter((h) => Math.abs(h.quantity) > 1e-9)) {
      const clients = clientsByTicker.get(h.ticker) ?? new Set<string>();
      clients.add(h.clientId);
      clientsByTicker.set(h.ticker, clients);

      byTicker.set(h.ticker, {
        company: byTicker.get(h.ticker)?.company || h.company,
        clientCount: clients.size,
      });
    }

    for (const w of watched) {
      if (byTicker.has(w.ticker)) continue;
      byTicker.set(w.ticker, { company: w.company, clientCount: 0 });
    }

    return byTicker;
  }
}
