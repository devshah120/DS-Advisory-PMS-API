import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService, DailyClose } from '../market/market.service';
import { CreateWatchlistDto, WATCHLIST_SLOTS } from './dto/create-watchlist.dto';
import {
  DEFAULT_MARKET,
  MARKETS,
  Market,
  displaySymbol,
  normalizeSymbol,
} from '../common/market-scope';

export interface PeriodReturn {
  baseDate: string | null;
  baseClose: number | null;
  lastDate: string | null;
  lastClose: number | null;
  returnPct: number | null;
}

export interface WatchlistReturns {
  currentPrice: number | null;
  mtd: PeriodReturn;
  qtd: PeriodReturn;
  ytd: PeriodReturn;
}

/**
 * The indices the watchlist compares against, per book.
 *
 * Read off the market definition rather than hardcoded here, so the Indian
 * watchlist measures itself against the Nifty and the Sensex instead of the
 * S&P — comparing an Indian book's MTD to the Dow tells the manager nothing.
 * Capped at three to match the row of benchmark tiles the UI renders.
 */
export function trackedBenchmarks(market: Market) {
  return MARKETS[market].indices.slice(0, 3);
}

const DEFAULT_FOLDER_NAMES: Record<string, string> = {
  '1': 'Watchlist 1',
  '2': 'Watchlist 2',
  '3': 'Watchlist 3',
  '4': 'Watchlist 4',
  '5': 'Watchlist 5',
};

export interface BulkAddResult {
  added: Array<{ ticker: string; id: string }>;
  skipped: Array<{ ticker: string; reason: string }>;
}

@Injectable()
export class WatchlistService {
  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  /**
   * Adds a ticker to a slot on one book's watchlist.
   *
   * The symbol is qualified against that book BEFORE the lookup, which is the
   * whole reason an Indian name can be added at all: a manager types
   * "RELIANCE", Yahoo returns nothing for the bare form, and the add used to
   * fail outright. `normalizeSymbol` turns it into "RELIANCE.NS" first, and
   * MarketService retries '.BO' for a BSE-only listing. A symbol typed with its
   * own suffix is honoured as-is, so this is a no-op for the US book.
   */
  async create(dto: CreateWatchlistDto) {
    const market = (dto.market as Market) ?? DEFAULT_MARKET;
    const input = dto.ticker.trim().toUpperCase();
    const ticker = normalizeSymbol(input, market);
    const slot = dto.slot ?? '1';

    const profile = await this.market.lookup(ticker, market);

    try {
      return await this.prisma.watchlist.create({
        data: {
          ticker,
          slot,
          market,
          company: profile.company,
          sector: profile.sector,
          industry: profile.industry,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Reported under the name the user typed, not the qualified symbol.
        throw new ConflictException(`${displaySymbol(ticker)} is already on this watchlist`);
      }
      throw err;
    }
  }

  /**
   * Adds many tickers to a slot in one call (e.g. pasted from a spreadsheet
   * column). Each ticker is resolved independently — one bad/unknown ticker
   * or a duplicate doesn't fail the whole batch.
   */
  async bulkAdd(rawTickers: string[], slot = '1', market?: Market): Promise<BulkAddResult> {
    const tickers = [...new Set(rawTickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
    const added: BulkAddResult['added'] = [];
    const skipped: BulkAddResult['skipped'] = [];

    for (const ticker of tickers) {
      try {
        const item = await this.create({ ticker, slot, market });
        added.push({ ticker, id: item.id });
      } catch (err: any) {
        skipped.push({ ticker, reason: err?.message || 'Lookup failed' });
      }
    }

    return { added, skipped };
  }

  /**
   * One book's tracked names. `market` is optional so an unscoped call still
   * returns everything (an export, an admin screen); the UI always sends it.
   */
  findAll(slot?: string, market?: Market) {
    return this.prisma.watchlist.findMany({
      where: {
        ...(slot ? { slot } : {}),
        ...(market ? { market } : {}),
      },
      orderBy: { ticker: 'asc' },
    });
  }

  findOne(id: string) {
    return this.prisma.watchlist.findUnique({
      where: { id },
    });
  }

  remove(id: string) {
    return this.prisma.watchlist.delete({
      where: { id },
    });
  }

  async folders(market: Market = DEFAULT_MARKET) {
    const rows = await this.prisma.watchlistFolder.findMany({ where: { market } });
    const byslot = new Map(rows.map((r) => [r.slot, r.name]));
    return WATCHLIST_SLOTS.map((slot) => ({
      slot,
      name: byslot.get(slot) ?? DEFAULT_FOLDER_NAMES[slot],
      market,
    }));
  }

  async renameFolder(slot: string, name: string, market: Market = DEFAULT_MARKET) {
    await this.prisma.watchlistFolder.upsert({
      where: { market_slot: { market, slot } },
      create: { slot, name, market },
      update: { name },
    });
    return { slot, name, market };
  }

  /** Current price + MTD/QTD/YTD for one symbol, computed from live market data. */
  async returnsFor(symbol: string): Promise<WatchlistReturns> {
    const bases = periodBaseDates();
    // A week of headroom before the earliest base date so a base that lands
    // on a holiday/weekend still has an earlier bar to walk back to.
    const from = toIsoDate(addDays(new Date(`${bases.ytd}T00:00:00Z`), -7));
    const [bars, quote] = await Promise.all([
      this.market.history(symbol, from),
      // A live quote can 404 for an index/ticker the chart endpoint still serves;
      // current price is a nice-to-have here, so don't let that fail the whole call.
      this.market.lookup(symbol).catch((): null => null),
    ]);
    return {
      currentPrice: quote?.currentPrice ?? null,
      mtd: computePeriodReturn(bars, bases.mtd),
      qtd: computePeriodReturn(bars, bases.qtd),
      ytd: computePeriodReturn(bars, bases.ytd),
    };
  }

  /**
   * Same MTD/QTD/YTD windows, applied to the selected book's benchmark indices
   * — the Nifty/Sensex for India, the S&P/Russell/Dow for the US.
   */
  async benchmarkReturns(
    market: Market = DEFAULT_MARKET,
  ): Promise<Array<{ code: string; label: string; symbol: string } & WatchlistReturns>> {
    return Promise.all(
      trackedBenchmarks(market).map(async (b) => ({
        ...b,
        ...(await this.returnsFor(b.symbol)),
      })),
    );
  }
}

/** Calendar base dates (as ISO strings) for MTD/QTD/YTD, anchored to today. */
function periodBaseDates(today = new Date()): { mtd: string; qtd: string; ytd: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-11

  // MTD: last day of the prior month.
  const mtdBase = new Date(Date.UTC(y, m, 0));

  // QTD: last day of the prior calendar quarter (Jan 1 / Apr 1 / Jul 1 / Oct 1 boundaries).
  const quarterStartMonth = Math.floor(m / 3) * 3;
  const qtdBase = new Date(Date.UTC(y, quarterStartMonth, 0));

  // YTD: Dec 31 of the prior year.
  const ytdBase = new Date(Date.UTC(y - 1, 11, 31));

  return {
    mtd: toIsoDate(mtdBase),
    qtd: toIsoDate(qtdBase),
    ytd: toIsoDate(ytdBase),
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/**
 * Base close = the closing price on the last trading day on/before `baseDate`
 * (walks backward through holidays/weekends). Last close = the most recent
 * bar available. Returns nulls when there isn't enough history rather than
 * inventing a price.
 */
function computePeriodReturn(bars: DailyClose[], baseDate: string): PeriodReturn {
  if (bars.length === 0) {
    return { baseDate: null, baseClose: null, lastDate: null, lastClose: null, returnPct: null };
  }

  // bars is oldest-first; the last trading day on/before baseDate is the last
  // bar whose date does not exceed it.
  let base: DailyClose | null = null;
  for (const bar of bars) {
    if (bar.date <= baseDate) base = bar;
    else break;
  }

  const last = bars[bars.length - 1];

  if (!base) {
    return { baseDate: null, baseClose: null, lastDate: last.date, lastClose: last.close, returnPct: null };
  }

  const returnPct = base.close !== 0 ? ((last.close - base.close) / base.close) * 100 : null;

  return {
    baseDate: base.date,
    baseClose: base.close,
    lastDate: last.date,
    lastClose: last.close,
    returnPct,
  };
}
