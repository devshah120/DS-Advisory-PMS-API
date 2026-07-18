import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService, DailyClose } from '../market/market.service';

export interface HoldingMover {
  ticker: string;
  company: string;
  clientId: string;
  marketValue: number;
  currentPrice: number;
  changePercent: number;
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
  ) {}

  async getOverview() {
    const [clients, holdings] = await Promise.all([
      this.prisma.client.count(),
      this.prisma.holding.findMany(),
    ]);

    const totalAUM = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const movers = await this.dailyMovers(holdings);

    return {
      totalAUM,
      numClients: clients,
      numHoldings: holdings.length,
      topGainers: movers.filter((m) => m.changePercent != null).slice(0, 3),
      topLosers: [...movers].reverse().slice(0, 3),
    };
  }

  /**
   * Day-over-day % change per holding (today's close vs. the prior trading
   * day's close), ranked. One ticker held by multiple clients is fetched
   * once and reused — Yahoo doesn't care which client owns it.
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

    const movers: HoldingMover[] = [];
    for (const h of holdings) {
      const bars = closesByTicker.get(h.ticker) ?? [];
      if (bars.length < 2) continue;
      const [prior, last] = bars.slice(-2);
      if (prior.close === 0) continue;
      movers.push({
        ticker: h.ticker,
        company: h.company,
        clientId: h.clientId,
        marketValue: h.marketValue,
        currentPrice: last.close,
        changePercent: ((last.close - prior.close) / prior.close) * 100,
      });
    }

    return movers.sort((a, b) => b.changePercent - a.changePercent);
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
