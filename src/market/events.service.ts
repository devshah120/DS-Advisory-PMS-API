import { Injectable, Logger } from '@nestjs/common';

export type WatchlistEventType = 'EARNINGS' | 'DIVIDEND' | 'SPLIT';

export interface WatchlistEvent {
  ticker: string;
  type: WatchlistEventType;
  /** Short code shown as the badge: E = earnings, D = dividend, C = corporate action (split). */
  code: 'E' | 'D' | 'C';
  label: string;
  date: string; // ISO date
  status: 'Upcoming' | 'Confirmed';
}

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const REQUEST_TIMEOUT_MS = 8000;

// The free FMP plan rejects calendar ranges much wider than this, and a
// "nearby events" panel has no use for anything further out anyway.
const LOOKAHEAD_DAYS = 60;

/**
 * Nearby corporate events (earnings, dividends, stock splits) for whatever
 * tickers are on a watchlist, sourced from Financial Modeling Prep's
 * calendar endpoints.
 *
 * FMP's calendars are date-ranged and NOT per-symbol — there is no
 * "events for AAPL" endpoint on the free tier — so the approach is: pull the
 * whole calendar for the lookahead window once, then filter down to the
 * tickers the caller actually asked about. One shared cache entry per
 * calendar serves every watchlist and every client, which matters on a
 * 250-request/day free-tier budget.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly apiKey = process.env.FMP_API_KEY;

  // The calendars only move once a day (new confirmations, date changes), so
  // a multi-hour cache keeps this well inside the free-tier request budget.
  private readonly cache = new Map<WatchlistEventType, { value: WatchlistEvent[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  async forTickers(rawTickers: string[]): Promise<WatchlistEvent[]> {
    const tickers = new Set(rawTickers.map((t) => t.trim().toUpperCase()).filter(Boolean));
    if (tickers.size === 0 || !this.apiKey) return [];

    const [earnings, dividends, splits] = await Promise.all([
      this.calendar('EARNINGS'),
      this.calendar('DIVIDEND'),
      this.calendar('SPLIT'),
    ]);

    return [...earnings, ...dividends, ...splits]
      .filter((e) => tickers.has(e.ticker))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private async calendar(type: WatchlistEventType): Promise<WatchlistEvent[]> {
    const cached = this.cache.get(type);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const { from, to } = this.window();
    const path =
      type === 'EARNINGS' ? 'earnings-calendar' : type === 'DIVIDEND' ? 'dividends-calendar' : 'splits-calendar';

    const rows = await this.fetchJson(`${FMP_BASE}/${path}?from=${from}&to=${to}&apikey=${this.apiKey}`);
    const value = Array.isArray(rows) ? rows.map((r) => this.toEvent(type, r)).filter((e): e is WatchlistEvent => e !== null) : [];

    this.cache.set(type, { value, expiresAt: Date.now() + EventsService.CACHE_TTL_MS });
    return value;
  }

  private toEvent(type: WatchlistEventType, row: any): WatchlistEvent | null {
    const ticker = String(row?.symbol ?? '').toUpperCase();
    const date = row?.date;
    if (!ticker || !date) return null;

    if (type === 'EARNINGS') {
      return {
        ticker,
        type,
        code: 'E',
        label: 'Earnings',
        date,
        // FMP fills in epsActual once the print has happened; until then it's a forecast date.
        status: row.epsActual != null ? 'Confirmed' : 'Upcoming',
      };
    }

    if (type === 'DIVIDEND') {
      return {
        ticker,
        type,
        code: 'D',
        label: 'Dividend Ex-Date',
        date,
        status: 'Confirmed',
      };
    }

    return {
      ticker,
      type,
      code: 'C',
      label: 'Stock Split',
      date,
      status: 'Confirmed',
    };
  }

  private window(): { from: string; to: string } {
    const from = new Date();
    const to = new Date(from.getTime() + LOOKAHEAD_DAYS * 86_400_000);
    return { from: toIsoDate(from), to: toIsoDate(to) };
  }

  private async fetchJson(url: string): Promise<any | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        this.logger.warn(`FMP request failed (${response.status}): ${url}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn(`FMP request errored: ${(error as Error).message}`);
      return null;
    }
  }
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
