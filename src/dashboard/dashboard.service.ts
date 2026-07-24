import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService, DailyClose } from '../market/market.service';
import { HouseService } from '../analytics/services/house.service';

export interface HoldingMover {
  ticker: string;
  company: string;
  clientId: string;
  marketValue: number;
  currentPrice: number;
  changePercent: number;
}

export interface TopHolding {
  ticker: string;
  company: string;
  marketValue: number;
  weight: number;
  numClients: number;
}

export interface MarketQuote {
  code: string;
  label: string;
  symbol: string;
  currentPrice: number | null;
  dayChangePercent: number | null;
  ytdChangePercent: number | null;
}

const TRACKED_INDICES = [
  { code: 'SP500', label: 'S&P 500', symbol: '^GSPC' },
  { code: 'NASDAQ', label: 'Nasdaq', symbol: '^IXIC' },
  { code: 'DOWJONES', label: 'Dow Jones', symbol: '^DJI' },
  { code: 'RUSSELL2000', label: 'Russell 2000', symbol: '^RUT' },
] as const;

const TRACKED_COMMODITIES = [
  { code: 'CRUDE', label: 'Crude Oil (WTI)', symbol: 'CL=F' },
  { code: 'GOLD', label: 'Gold', symbol: 'GC=F' },
  { code: 'SILVER', label: 'Silver', symbol: 'SI=F' },
] as const;

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private market: MarketService,
    private house: HouseService,
  ) {}

  async getOverview() {
    const [clients, stored, exposure, cashAgg] = await Promise.all([
      this.prisma.client.count(),
      this.prisma.holding.findMany(),
      this.house.exposure(),
      // House-wide idle cash: summed straight off the client records, so a
      // client's balance is counted once regardless of how many positions they
      // hold. This is buying power available for deployment, not deployed capital.
      this.prisma.client.aggregate({ _sum: { cashBalance: true } }),
    ]);

    const holdings = await this.withLiveMarketValue(stored);
    const totalAUM = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCash = cashAgg._sum.cashBalance ?? 0;
    const movers = await this.dailyMovers(holdings);

    return {
      totalAUM,
      // Cash the house holds across every client — deployable, not yet invested.
      totalCash,
      numClients: clients,
      numHoldings: holdings.length,
      // movers is sorted best-to-worst. Split by sign so a flat/green day
      // can't list a riser under "losers" (and vice versa) just to fill three
      // slots — either card is allowed to come back short.
      topGainers: movers.filter((m) => m.changePercent > 0).slice(0, 3),
      topLosers: movers
        .filter((m) => m.changePercent < 0)
        .reverse()
        .slice(0, 3),
      // House-wide, not per-client: every client's holdings merged into one
      // book before grouping by sector, with ETFs exploded via look-through.
      sectorAllocation: exposure.data.sectors,
      // Same book, grouped by ticker instead of sector: one row per stock
      // regardless of how many clients hold it, ranked by combined market value.
      topHoldings: this.topHoldingsByTicker(holdings, totalAUM),
    };
  }

  /**
   * Recomputes marketValue from a live quote per distinct ticker, so AUM and
   * top-holdings match what the holdings page now shows instead of the
   * DB's last-saved price. A ticker whose live quote fails to resolve keeps
   * its stored marketValue rather than dropping out of the total.
   */
  private async withLiveMarketValue<T extends { ticker: string; quantity: number; marketValue: number }>(
    holdings: T[],
  ): Promise<T[]> {
    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    const quotes = new Map<string, number>();

    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const { currentPrice } = await this.market.lookup(ticker);
          if (typeof currentPrice === 'number') quotes.set(ticker, currentPrice);
        } catch {
          // Keep the stored marketValue for this ticker.
        }
      }),
    );

    return holdings.map((h) => {
      const livePrice = quotes.get(h.ticker);
      if (livePrice == null) return h;
      return { ...h, marketValue: h.quantity * livePrice };
    });
  }

  /** Combines one ticker's positions across every client into a single ranked row. */
  private topHoldingsByTicker(
    holdings: Array<{ ticker: string; company: string; clientId: string; marketValue: number }>,
    totalAUM: number,
  ): TopHolding[] {
    const byTicker = new Map<string, { company: string; marketValue: number; clientIds: Set<string> }>();

    for (const h of holdings) {
      const entry = byTicker.get(h.ticker);
      if (entry) {
        entry.marketValue += h.marketValue;
        entry.clientIds.add(h.clientId);
      } else {
        byTicker.set(h.ticker, { company: h.company, marketValue: h.marketValue, clientIds: new Set([h.clientId]) });
      }
    }

    return [...byTicker.entries()]
      .map(([ticker, v]) => ({
        ticker,
        company: v.company,
        marketValue: v.marketValue,
        weight: totalAUM > 0 ? v.marketValue / totalAUM : 0,
        numClients: v.clientIds.size,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);
  }

  /**
   * Day-over-day % change per ticker (today's close vs. the prior trading
   * day's close), ranked. One ticker held by multiple clients is fetched
   * once and reused — Yahoo doesn't care which client owns it — and collapses
   * to a single row, so a widely-held name can't fill the board on its own.
   */
  private async dailyMovers(holdings: Array<{ ticker: string; company: string; clientId: string; marketValue: number }>): Promise<HoldingMover[]> {
    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    // A short window comfortably spans the last two trading days through any
    // weekend/holiday gap without pulling a year of history per ticker.
    const from = toIsoDate(daysAgo(10));

    const closesByTicker = new Map<string, DailyClose[]>();
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          closesByTicker.set(ticker, await this.market.history(ticker, from));
        } catch {
          closesByTicker.set(ticker, []);
        }
      }),
    );

    // Collapse to one row per ticker. The % move belongs to the security, not
    // to any one client's lot, so multiple holders would otherwise produce
    // identical duplicate rows and crowd out genuinely different names.
    // marketValue is summed across holders to keep it house-wide, matching
    // how topHoldingsByTicker reports the same book.
    const byTicker = new Map<string, HoldingMover>();
    for (const h of holdings) {
      const existing = byTicker.get(h.ticker);
      if (existing) {
        existing.marketValue += h.marketValue;
        continue;
      }

      const bars = closesByTicker.get(h.ticker) ?? [];
      if (bars.length < 2) continue;
      const [prior, last] = bars.slice(-2);
      if (prior.close === 0) continue;
      byTicker.set(h.ticker, {
        ticker: h.ticker,
        company: h.company,
        clientId: h.clientId,
        marketValue: h.marketValue,
        currentPrice: last.close,
        changePercent: ((last.close - prior.close) / prior.close) * 100,
      });
    }

    return [...byTicker.values()].sort((a, b) => b.changePercent - a.changePercent);
  }

  /** Live daily and YTD % change for the tracked indices and commodities. */
  async marketOverview(): Promise<MarketQuote[]> {
    const all = [...TRACKED_INDICES, ...TRACKED_COMMODITIES];
    const ytdBase = toIsoDate(new Date(Date.UTC(new Date().getUTCFullYear() - 1, 11, 31)));
    // A week of headroom before Dec 31 so a base date landing on a
    // holiday/weekend still has an earlier bar to walk back to.
    const from = toIsoDate(addDays(new Date(`${ytdBase}T00:00:00Z`), -7));

    return Promise.all(
      all.map(async (entry) => {
        try {
          const bars = await this.market.history(entry.symbol, from);
          const currentPrice = bars.length > 0 ? bars[bars.length - 1].close : null;
          return { ...entry, currentPrice, ...changeFromBars(bars, ytdBase) };
        } catch {
          return { ...entry, currentPrice: null, dayChangePercent: null, ytdChangePercent: null };
        }
      }),
    );
  }
}

function changeFromBars(bars: DailyClose[], ytdBase: string): { dayChangePercent: number | null; ytdChangePercent: number | null } {
  if (bars.length === 0) return { dayChangePercent: null, ytdChangePercent: null };

  const last = bars[bars.length - 1];
  const prior = bars.length >= 2 ? bars[bars.length - 2] : null;

  // Last bar on/before the YTD base date — walks back through any
  // holiday/weekend the base itself lands on, same convention as watchlist.
  let base: DailyClose | null = null;
  for (const bar of bars) {
    if (bar.date <= ytdBase) base = bar;
    else break;
  }

  return {
    dayChangePercent: prior && prior.close !== 0 ? ((last.close - prior.close) / prior.close) * 100 : null,
    ytdChangePercent: base && base.close !== 0 ? ((last.close - base.close) / base.close) * 100 : null,
  };
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
