import { Injectable, Logger } from '@nestjs/common';
import { WatchlistEvent, WatchlistEventType } from './events.service';

const YAHOO = 'https://query2.finance.yahoo.com';
const REQUEST_TIMEOUT_MS = 8000;

// Yahoo rejects requests that don't look like a browser.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Matches the old FMP lookahead so the page's "nearby events" framing is unchanged.
const LOOKAHEAD_DAYS = 60;

// quoteSummary is per-symbol, so a portfolio refresh is one request per ticker.
// Yahoo throttles bursts, so go a few at a time with a short gap between waves.
const BATCH_SIZE = 4;
const BATCH_PAUSE_MS = 150;

/**
 * Nearby corporate events (earnings, dividends, splits) sourced from Yahoo
 * Finance's `quoteSummary` endpoint.
 *
 * Unlike FMP's date-ranged whole-market calendars, Yahoo is per-symbol: there
 * is no "everything happening next month" feed to filter down. So the shape is
 * inverted — one request per held ticker, batched — and the date window is
 * applied by us after the fact rather than by the upstream query.
 *
 * What Yahoo gives us that FMP did not:
 *   - `isEarningsDateEstimate`, a genuine forecast-vs-confirmed signal for
 *     dates that are still in the future (FMP only revealed this after the
 *     print, via epsActual, by which point the event no longer mattered).
 *   - `dividendDate`, the pay date, which is a separate client-facing event
 *     from the ex-date.
 *
 * What it costs: `quoteSummary` needs a cookie+crumb pair, and the fields are
 * point-in-time rather than a series — `exDividendDate` is the LAST ex-date,
 * so it is frequently in the past and must be filtered, and `lastSplitDate` is
 * always historical.
 */
@Injectable()
export class YahooEventsService {
  private readonly logger = new Logger(YahooEventsService.name);

  // Shared with the same-origin session in MarketService in spirit, but kept
  // separate so an expiry here can't invalidate a lookup mid-flight there.
  private session: { cookie: string; crumb: string; expiresAt: number } | null = null;
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000;

  /**
   * Every event inside the lookahead window for the given tickers, oldest
   * first. Tickers Yahoo has no events for (ETFs, trusts) simply contribute
   * nothing rather than failing the batch.
   */
  async forTickers(rawTickers: string[]): Promise<WatchlistEvent[]> {
    const tickers = [...new Set(rawTickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length === 0) return [];

    const session = await this.getSession();
    if (!session) {
      this.logger.warn('No Yahoo session available — returning no events');
      return [];
    }

    const { from, to } = this.window();
    const events: WatchlistEvent[] = [];

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((t) => this.forTicker(t, session)));
      for (const list of results) events.push(...list);

      if (i + BATCH_SIZE < tickers.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    return events
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private async forTicker(
    ticker: string,
    session: { cookie: string; crumb: string },
  ): Promise<WatchlistEvent[]> {
    const data = await this.fetchJson(
      `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
        `?modules=calendarEvents,defaultKeyStatistics&crumb=${encodeURIComponent(session.crumb)}`,
      { Cookie: session.cookie },
    );

    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      // A rejected crumb is indistinguishable from a symbol with no data here;
      // drop the session so the next refresh mints a fresh one.
      if (data === null) this.session = null;
      return [];
    }

    const calendar = result.calendarEvents;
    const events: WatchlistEvent[] = [];

    const earningsDate = fmt(calendar?.earnings?.earningsDate?.[0]);
    if (earningsDate) {
      events.push({
        ticker,
        type: 'EARNINGS',
        code: 'E',
        label: 'Earnings',
        date: earningsDate,
        // Yahoo says outright whether the date is its own estimate or the
        // company's announced date — no inference needed.
        status: calendar?.earnings?.isEarningsDateEstimate === false ? 'Confirmed' : 'Upcoming',
      });
    }

    const exDate = fmt(calendar?.exDividendDate);
    if (exDate) {
      events.push({
        ticker,
        type: 'DIVIDEND',
        code: 'D',
        label: 'Dividend Ex-Date',
        date: exDate,
        status: 'Confirmed',
      });
    }

    // The pay date is a distinct event for a client: the ex-date decides
    // entitlement, this is when the cash actually lands.
    const payDate = fmt(calendar?.dividendDate);
    if (payDate) {
      events.push({
        ticker,
        type: 'DIVIDEND',
        code: 'D',
        label: 'Dividend Pay Date',
        date: payDate,
        status: 'Confirmed',
      });
    }

    const splitDate = fmt(result.defaultKeyStatistics?.lastSplitDate);
    if (splitDate) {
      const factor = result.defaultKeyStatistics?.lastSplitFactor;
      events.push({
        ticker,
        type: 'SPLIT',
        code: 'C',
        label: factor ? `Stock Split (${factor})` : 'Stock Split',
        date: splitDate,
        status: 'Confirmed',
      });
    }

    return events;
  }

  private window(): { from: string; to: string } {
    const from = new Date();
    const to = new Date(from.getTime() + LOOKAHEAD_DAYS * 86_400_000);
    return { from: toIsoDate(from), to: toIsoDate(to) };
  }

  private async getSession(): Promise<{ cookie: string; crumb: string } | null> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;

    try {
      // fc.yahoo.com answers 404 but still sets the consent cookie we need.
      const seed = await fetch('https://fc.yahoo.com', {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const cookie = seed.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      if (!cookie) return null;

      const res = await fetch(`${YAHOO}/v1/test/getcrumb`, {
        headers: { 'User-Agent': UA, Cookie: cookie },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const crumb = (await res.text()).trim();
      if (!res.ok || !crumb || crumb.includes('<')) return null;

      this.session = { cookie, crumb, expiresAt: Date.now() + YahooEventsService.SESSION_TTL_MS };
      return this.session;
    } catch (error) {
      this.logger.warn(`Could not establish Yahoo session: ${(error as Error).message}`);
      return null;
    }
  }

  /** Returns parsed JSON, or null on any network/parse/status failure. */
  private async fetchJson(url: string, extraHeaders: Record<string, string> = {}): Promise<any | null> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Yahoo request failed (${response.status}): ${url}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn(`Yahoo request errored: ${(error as Error).message}`);
      return null;
    }
  }
}

/** Yahoo wraps every date as `{ raw: epochSeconds, fmt: 'YYYY-MM-DD' }`. */
function fmt(node: any): string | null {
  const value = node?.fmt;
  return typeof value === 'string' && value.length === 10 ? value : null;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type { WatchlistEvent, WatchlistEventType };
