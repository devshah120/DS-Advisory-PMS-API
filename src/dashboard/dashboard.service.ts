import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService, DailyClose } from '../market/market.service';
import { HouseService } from '../analytics/services/house.service';
import {
  DEFAULT_MARKET,
  MARKETS,
  Market,
  currencyForMarket,
  displaySymbol,
} from '../common/market-scope';

export interface HoldingMover {
  ticker: string;
  /** Suffix-stripped ticker for display ('RELIANCE.NS' → 'RELIANCE'). */
  displayTicker: string;
  company: string;
  clientId: string;
  marketValue: number;
  currentPrice: number;
  changePercent: number;
}

export interface TopHolding {
  ticker: string;
  displayTicker: string;
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
  /**
   * The currency this particular quote is denominated in. Needed because a
   * market's strip is not uniform: the Indian book shows Nifty/Sensex in INR
   * alongside WTI and gold, which Yahoo quotes in USD no matter who is looking.
   * Formatting the whole strip in the book's currency would misprice them.
   */
  currency: string;
}

export interface ClientMover {
  clientId: string;
  clientName: string;
  marketValue: number;
  changePercent: number;
}

// Commodities are dollar-denominated globally, so their quotes are labelled USD
// regardless of which book is selected — see MarketQuote.currency.
const COMMODITY_CURRENCY = 'USD';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private market: MarketService,
    private house: HouseService,
  ) {}

  /**
   * The house-level overview for ONE book of business.
   *
   * Every figure here is scoped to `market`: AUM, cash, client and holding
   * counts, movers, sector allocation and top holdings all describe the selected
   * book alone. The two books are deliberately never summed — they are
   * denominated in different currencies, and adding rupees to dollars without an
   * FX rate would produce a meaningless headline number.
   *
   * Holdings are reached through their client rather than filtered directly,
   * because market lives on Client: a holding's book is a property of whose
   * mandate it sits in, not of the ticker (the same ADR could in principle be
   * held either side).
   */
  async getOverview(market: Market = DEFAULT_MARKET) {
    const [clients, stored, exposure, cashAgg] = await Promise.all([
      this.prisma.client.findMany({
        where: { market },
        select: { id: true, name: true },
      }),
      this.prisma.holding.findMany({ where: { client: { market } } }),
      this.house.exposure(market),
      // House-wide idle cash: summed straight off the client records, so a
      // client's balance is counted once regardless of how many positions they
      // hold. This is buying power available for deployment, not deployed capital.
      this.prisma.client.aggregate({
        where: { market },
        _sum: { cashBalance: true },
      }),
    ]);

    // Closed lots keep their row for the realized P&L they booked, but they are
    // not positions: counting them would inflate numHoldings and let a
    // sold-out name sit in top holdings at $0.
    const open = stored.filter((h) => Math.abs(h.quantity) > 1e-9);
    const holdings = await this.withLiveMarketValue(open);
    const totalAUM = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCash = cashAgg._sum.cashBalance ?? 0;
    const closesByTicker = await this.closesForTickers(holdings.map((h) => h.ticker));
    const movers = this.dailyMovers(holdings, closesByTicker);

    return {
      // Echoed back so the UI formats this payload in the currency it was
      // actually computed in, rather than trusting its own selector state —
      // which can be a render ahead of the response it is labelling.
      market,
      currency: currencyForMarket(market),
      totalAUM,
      // Cash the house holds across every client — deployable, not yet invested.
      totalCash,
      numClients: clients.length,
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
      // Per-client day change, weighted by each client's own holdings — reuses
      // the same closes fetched for movers so this doesn't double the Yahoo calls.
      clientMovers: this.clientDailyMovers(holdings, clients, closesByTicker),
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
        displayTicker: displaySymbol(ticker),
        company: v.company,
        marketValue: v.marketValue,
        weight: totalAUM > 0 ? v.marketValue / totalAUM : 0,
        numClients: v.clientIds.size,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);
  }

  /** Fetches recent daily closes for every distinct ticker, once, shared by movers and client movers. */
  private async closesForTickers(tickers: string[]): Promise<Map<string, DailyClose[]>> {
    const distinct = [...new Set(tickers)];
    // A short window comfortably spans the last two trading days through any
    // weekend/holiday gap without pulling a year of history per ticker.
    const from = toIsoDate(daysAgo(10));

    const closesByTicker = new Map<string, DailyClose[]>();
    await Promise.all(
      distinct.map(async (ticker) => {
        try {
          closesByTicker.set(ticker, await this.market.history(ticker, from));
        } catch {
          closesByTicker.set(ticker, []);
        }
      }),
    );
    return closesByTicker;
  }

  /**
   * Day-over-day % change per ticker (today's close vs. the prior trading
   * day's close), ranked. One ticker held by multiple clients collapses
   * to a single row, so a widely-held name can't fill the board on its own.
   */
  private dailyMovers(
    holdings: Array<{ ticker: string; company: string; clientId: string; marketValue: number }>,
    closesByTicker: Map<string, DailyClose[]>,
  ): HoldingMover[] {
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
        displayTicker: displaySymbol(h.ticker),
        company: h.company,
        clientId: h.clientId,
        marketValue: h.marketValue,
        currentPrice: last.close,
        changePercent: ((last.close - prior.close) / prior.close) * 100,
      });
    }

    return [...byTicker.values()].sort((a, b) => b.changePercent - a.changePercent);
  }

  /**
   * Day-over-day % change per client, weighted by each holding's market value
   * (today's close vs. prior close), so a client's box mirrors a market
   * index's day change rather than a simple average across their tickers.
   * Clients with no priceable holdings (e.g. all-cash, or every ticker
   * missing two closes) are omitted rather than shown as a false 0%.
   */
  private clientDailyMovers(
    holdings: Array<{ ticker: string; clientId: string; marketValue: number; quantity: number }>,
    clients: Array<{ id: string; name: string }>,
    closesByTicker: Map<string, DailyClose[]>,
  ): ClientMover[] {
    const nameById = new Map(clients.map((c) => [c.id, c.name]));
    const byClient = new Map<string, { priorValue: number; currentValue: number }>();

    for (const h of holdings) {
      const bars = closesByTicker.get(h.ticker) ?? [];
      if (bars.length < 2) continue;
      const [prior, last] = bars.slice(-2);
      if (prior.close === 0) continue;

      const entry = byClient.get(h.clientId) ?? { priorValue: 0, currentValue: 0 };
      entry.priorValue += h.quantity * prior.close;
      entry.currentValue += h.quantity * last.close;
      byClient.set(h.clientId, entry);
    }

    return [...byClient.entries()]
      .map(([clientId, v]) => ({
        clientId,
        clientName: nameById.get(clientId) ?? 'Unknown',
        marketValue: v.currentValue,
        changePercent: v.priorValue !== 0 ? ((v.currentValue - v.priorValue) / v.priorValue) * 100 : 0,
      }))
      .sort((a, b) => b.changePercent - a.changePercent);
  }

  /**
   * Live daily and YTD % change for the selected book's indices, plus the
   * globally-quoted commodities.
   *
   * The Indian book tracks Nifty/Sensex where the US book tracks the S&P/Nasdaq,
   * so the strip is driven off MARKETS rather than a module constant. Each quote
   * carries its own currency because the two halves of the list disagree: the
   * indices follow the book, the commodities are always USD.
   */
  async marketOverview(market: Market = DEFAULT_MARKET): Promise<MarketQuote[]> {
    const def = MARKETS[market];
    const all = [
      ...def.indices.map((i) => ({ ...i, currency: def.currency })),
      ...def.commodities.map((c) => ({ ...c, currency: COMMODITY_CURRENCY })),
    ];
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
