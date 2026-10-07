import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { DailyClose, MarketService } from '../market/market.service';

const MS_PER_DAY = 86_400_000;

/** Midnight UTC of the calendar day `d` falls on — the key PriceBar rows are stored under. */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

/** Whole calendar days from `a` to `b`, both YYYY-MM-DD. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * How a price was arrived at, so a report can say so rather than imply every
 * figure is a verified close.
 *
 *  - `live`  — today, from the live quote.
 *  - `close` — the official close of the last session on or before the date.
 *              On a weekend or holiday that is the prior session, which is the
 *              correct answer, not an approximation.
 *  - `stale` — the best price available, but nothing proves it is that
 *              session's close: the series has a hole around the date, or the
 *              market data source could not be reached and an older stored bar
 *              stood in. `priceDate` says how old it is.
 */
export type PriceStatus = 'live' | 'close' | 'stale';

export interface ResolvedClose {
  price: number;
  /** The session this is the close of (YYYY-MM-DD). Today's date for `live`. */
  priceDate: string;
  status: PriceStatus;
}

/**
 * The single place that resolves "closing price of TICKER on or before DATE".
 *
 * Both PortfolioReconstructionService and PortfolioHistoryService need this,
 * and both need it to behave identically — a reconstruction for 30-Sept and
 * a snapshot written on 30-Sept must price every position the same way, or
 * "the user should not know whether a snapshot or a reconstruction served
 * this" (PART 7) stops being true.
 *
 * PriceBar is the durable store (same table performance.service.ts reads for
 * benchmark closes). A miss falls back to backfilling PriceBar from Yahoo via
 * MarketService, matching the existing pattern in
 * analytics/scripts/backfill-benchmark-bars.ts, rather than duplicating a
 * second fetch-and-cache path.
 *
 * A stored bar answers a date only when it can be PROVEN to be the right
 * session's close. The previous rule accepted any bar within five days, which
 * is not the same question: if the last backfill ran on the 2nd, a request for
 * the 6th found the 2nd's bar "close enough" and valued the book four trading
 * sessions stale. Whether a client's historical holdings statement came out
 * right then depended on when someone had last happened to touch that ticker.
 */
@Injectable()
export class HistoricalPriceService {
  private readonly logger = new Logger(HistoricalPriceService.name);

  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  /**
   * Provenance written by `backfill`: the session's ACTUAL close in `close`,
   * Yahoo's split-adjusted series in `adjClose`, and only for sessions that had
   * finished trading when fetched.
   *
   * Bars written before this tag existed (`source: 'yahoo'`) are never trusted
   * as a close, for two reasons. Their `close` is split-adjusted, so a holding
   * that later split or issued a bonus was valued at a fraction of what it
   * traded at — RELIANCE.NS before its Oct-2024 1:1 bonus at half its price.
   * And they may hold an INTRADAY price: Yahoo returns the still-open session
   * with the live price as its close, and a backfill run during market hours
   * stored it as that day's close, permanently, because an exact-date bar was
   * never re-fetched. The first request that touches such a bar re-fetches its
   * window and overwrites it under this tag, so the store heals as it is used.
   */
  static readonly YAHOO_SOURCE = 'yahoo-close';

  /** Provenances whose `close` is a settled session close that can be served without re-checking. */
  private static readonly SETTLED_SOURCES = [HistoricalPriceService.YAHOO_SOURCE, 'workbook', 'manual'];

  /**
   * The longest run of calendar days with no session that is still an ordinary
   * market closure — a weekend plus a holiday or two either side. Bars further
   * apart than this mean the series has a hole (a backfill never covered it, or
   * the stock was suspended), so the earlier bar cannot be assumed to be the
   * close for a date that falls inside the gap.
   */
  private static readonly MAX_SESSION_GAP_DAYS = 7;

  /** How far before the requested date a backfill starts, so a long closure still has a prior session in range. */
  private static readonly BACKFILL_LOOKBACK_DAYS = 30;

  /**
   * How far past the requested date a backfill stores bars. Storing the
   * sessions just after the date is what lets the next request for the same
   * weekend or holiday be answered from the store: the bar after the gap is the
   * evidence that no session was missed.
   */
  private static readonly BACKFILL_LOOKAHEAD_DAYS = 14;

  /** Is `date` today (UTC)? Today is priced live, not from a stored bar — see `closeOn`. */
  private static isToday(date: Date): boolean {
    return utcDay(date).getTime() === utcDay(new Date()).getTime();
  }

  /**
   * Closing price for `ticker` on or before `date`. Null if truly no history exists.
   *
   * **Today is priced from the live quote, not from PriceBar.** PriceBar's newest
   * row is yesterday's close until the daily backfill runs, so valuing "today"
   * from it prices the book a day stale — while SnapshotService (the Current tab)
   * uses the live quote for the same instant. That split had the two tabs
   * reporting different market values for the same client on the same day
   * ($115,533.25 historical vs $116,204.72 current on an 18-position book), and
   * every gain figure derived from either inherited the discrepancy.
   *
   * A past date still comes from PriceBar, which is what makes a historical
   * valuation reproducible. Only the live edge is special-cased, and it is
   * special-cased toward the SAME source the rest of the product already treats
   * as today's truth.
   */
  async closeOn(ticker: string, date: Date): Promise<number | null> {
    return (await this.resolveClose(ticker, date))?.price ?? null;
  }

  /** Batched convenience wrapper — one query per ticker, run concurrently. */
  async closesOn(tickers: string[], date: Date): Promise<Map<string, number>> {
    const resolved = await this.resolveCloses(tickers, date);
    return new Map([...resolved].map(([ticker, r]) => [ticker, r.price]));
  }

  /** `closesOn` with each price's session date and provenance, for callers that report them. */
  async resolveCloses(tickers: string[], date: Date): Promise<Map<string, ResolvedClose>> {
    const unique = [...new Set(tickers)];
    const out = new Map<string, ResolvedClose>();

    await Promise.all(
      unique.map(async (ticker) => {
        const resolved = await this.resolveClose(ticker, date);
        if (resolved) out.set(ticker, resolved);
      }),
    );

    return out;
  }

  /**
   * `closeOn`, with the evidence. See `PriceStatus` for what each outcome means.
   *
   * Order of preference for a past date: a stored settled bar that is provably
   * the right session; otherwise a fresh fetch, which both answers and repairs
   * the store; and only if the fetch fails, the newest stored bar of any
   * provenance, flagged `stale` so it is never mistaken for a verified close.
   */
  async resolveClose(ticker: string, date: Date): Promise<ResolvedClose | null> {
    if (HistoricalPriceService.isToday(date)) {
      const live = await this.liveQuote(ticker);
      if (live !== null) return { price: live, priceDate: isoDay(utcDay(date)), status: 'live' };
      // No quote (lookup failed, market data down) — fall through to the stored
      // bar rather than dropping the position's price entirely.
    }

    const day = utcDay(date);

    const stored = await this.fromStore(ticker, day);
    if (stored) return stored;

    const fetched = await this.backfill(ticker, day);
    if (fetched) return fetched;

    const fallback = await this.prisma.priceBar.findFirst({
      where: { symbol: ticker, date: { lt: addDays(day, 1) } },
      orderBy: { date: 'desc' },
    });
    if (!fallback) return null;

    this.logger.warn(
      `No verifiable close for ${ticker} on ${isoDay(day)}; ` +
        `using stored ${fallback.source} bar from ${isoDay(fallback.date)}`,
    );
    return { price: fallback.close, priceDate: isoDay(fallback.date), status: 'stale' };
  }

  /**
   * A settled stored bar that is provably the close for `day`, or null.
   *
   * A bar ON the day is the answer. A bar BEFORE it is the answer only when the
   * store also holds the next session and the two are close enough together
   * that the gap is a market closure — otherwise the store simply has not been
   * filled that far, and the request must go to the source.
   */
  private async fromStore(ticker: string, day: Date): Promise<ResolvedClose | null> {
    const settled = { in: HistoricalPriceService.SETTLED_SOURCES };
    const nextDay = addDays(day, 1);

    const prev = await this.prisma.priceBar.findFirst({
      where: { symbol: ticker, source: settled, date: { lt: nextDay } },
      orderBy: { date: 'desc' },
    });
    if (!prev) return null;

    const prevDay = isoDay(utcDay(prev.date));
    if (prevDay === isoDay(day)) return { price: prev.close, priceDate: prevDay, status: 'close' };

    const after = await this.prisma.priceBar.findFirst({
      where: { symbol: ticker, source: settled, date: { gte: nextDay } },
      orderBy: { date: 'asc' },
    });
    if (!after) return null;

    const gap = daysBetween(prevDay, isoDay(utcDay(after.date)));
    if (gap > HistoricalPriceService.MAX_SESSION_GAP_DAYS) return null;

    return { price: prev.close, priceDate: prevDay, status: 'close' };
  }

  /**
   * Fetches the window around `day` from Yahoo, stores its settled sessions,
   * and answers `day` from the fetched series itself. Null if the fetch failed
   * or the window holds no session on or before `day`.
   *
   * Answering from the series rather than re-reading the store matters at the
   * live edge: for yesterday (or last Friday), the session after the date has
   * not happened yet, so there is no later bar to prove the gap with. The fetch
   * runs through today, so if it holds no later session then there has not been
   * one, and the last session on or before the date is correct.
   */
  private async backfill(ticker: string, day: Date): Promise<ResolvedClose | null> {
    let bars: DailyClose[];
    try {
      const fromDate = isoDay(addDays(day, -HistoricalPriceService.BACKFILL_LOOKBACK_DAYS));
      bars = await this.market.history(ticker, fromDate);
    } catch (error) {
      this.logger.warn(`Historical backfill failed for ${ticker}: ${(error as Error).message}`);
      return null;
    }

    const today = isoDay(utcDay(new Date()));
    const target = isoDay(day);
    const horizon = isoDay(addDays(day, HistoricalPriceService.BACKFILL_LOOKAHEAD_DAYS));

    // Today's bar is a session still in progress — Yahoo reports the live price
    // as its close. It is never stored, and never served as a past date's close.
    const settled = bars.filter((b) => b.date < today);

    try {
      // Mongo's Prisma connector has no `skipDuplicates` on createMany, so this
      // upserts one bar at a time keyed on [symbol, date] — the same pattern
      // backfill-benchmark-bars.ts and workbook-import.service.ts already use.
      for (const b of settled.filter((x) => x.date <= horizon)) {
        const barDate = new Date(`${b.date}T00:00:00.000Z`);
        const data = {
          close: b.rawClose,
          adjClose: b.close,
          source: HistoricalPriceService.YAHOO_SOURCE,
        };
        await this.prisma.priceBar.upsert({
          where: { symbol_date: { symbol: ticker, date: barDate } },
          create: { symbol: ticker, date: barDate, ...data },
          update: data,
        });
      }
    } catch (error) {
      // The fetched series still answers this request; only the cache missed.
      this.logger.warn(`Storing price bars failed for ${ticker}: ${(error as Error).message}`);
    }

    const prev = [...settled].reverse().find((b) => b.date <= target);
    if (!prev) return null;

    if (prev.date === target) return { price: prev.rawClose, priceDate: prev.date, status: 'close' };

    // Any later bar — even today's unfinished one — proves the sessions in
    // between were all reported. With none, the gap runs to today.
    const next = bars.find((b) => b.date > target);
    const gap = daysBetween(prev.date, next ? next.date : today);

    return {
      price: prev.rawClose,
      priceDate: prev.date,
      status: gap <= HistoricalPriceService.MAX_SESSION_GAP_DAYS ? 'close' : 'stale',
    };
  }

  /**
   * Today's live price, from the same MarketService.lookup SnapshotService uses —
   * deliberately the identical call, so the Historical and Current tabs cannot
   * resolve different prices for the same ticker at the same moment. Returns null
   * on any failure and lets the caller fall back to the stored bar.
   */
  private async liveQuote(ticker: string): Promise<number | null> {
    try {
      const { currentPrice } = await this.market.lookup(ticker);
      return typeof currentPrice === 'number' ? currentPrice : null;
    } catch (error) {
      this.logger.warn(`Live quote failed for ${ticker}: ${(error as Error).message}`);
      return null;
    }
  }
}
