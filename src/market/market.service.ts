import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FALLBACK_SYMBOLS, SymbolProfile, deriveTheme } from './symbol-fallback';

export interface LookupResult extends SymbolProfile {
  theme: string;
  /** Where the classification came from, so the UI can flag guessed data. */
  source: 'yahoo' | 'fallback';
}

export interface DailyClose {
  /** ISO date (YYYY-MM-DD), in the exchange's local trading day. */
  date: string;
  close: number;
}

const YAHOO = 'https://query2.finance.yahoo.com';
const REQUEST_TIMEOUT_MS = 6000;

// Yahoo rejects requests that don't look like a browser.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  // Classification data is effectively static, and this keeps a fast-typing
  // user from firing one upstream call per keystroke.
  private readonly cache = new Map<string, { value: LookupResult; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000;

  // Daily closes only change once a day (at market close), so a cache keyed by
  // ticker+fromDate can live a lot longer than the quote/classification cache.
  private readonly historyCache = new Map<string, { value: DailyClose[]; expiresAt: number }>();
  private static readonly HISTORY_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

  // `quoteSummary` requires a cookie+crumb pair; both are reusable for a while.
  private session: { cookie: string; crumb: string; expiresAt: number } | null = null;
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000;

  async lookup(rawTicker: string): Promise<LookupResult> {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker) throw new NotFoundException('Ticker is required');

    const cached = this.cache.get(ticker);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = (await this.fromYahoo(ticker)) ?? this.fromFallback(ticker);
    if (!result) {
      throw new NotFoundException(`No symbol found for "${ticker}"`);
    }

    this.cache.set(ticker, {
      value: result,
      expiresAt: Date.now() + MarketService.CACHE_TTL_MS,
    });
    return result;
  }

  /**
   * Daily closes from `fromDate` (inclusive) through today, oldest first.
   * Used to resolve "closing price on or before date X" for return windows
   * (MTD/QTD/YTD) — the caller walks the array backward from the target date
   * to skip weekends/holidays rather than this method knowing the calendar.
   */
  async history(rawTicker: string, fromDate: string): Promise<DailyClose[]> {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker) throw new NotFoundException('Ticker is required');

    const cacheKey = `${ticker}:${fromDate}`;
    const cached = this.historyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const period1 = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const data = await this.fetchJson(
      `${YAHOO}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`
    );

    const result = data?.chart?.result?.[0];
    const timestamps: number[] | undefined = result?.timestamp;
    const closes: Array<number | null> | undefined = result?.indicators?.quote?.[0]?.close;
    if (!timestamps || !closes) {
      throw new NotFoundException(`No price history found for "${ticker}"`);
    }

    const bars: DailyClose[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue; // Yahoo emits a null bar for the still-open current session.
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        close,
      });
    }

    this.historyCache.set(cacheKey, {
      value: bars,
      expiresAt: Date.now() + MarketService.HISTORY_CACHE_TTL_MS,
    });
    return bars;
  }

  private fromFallback(ticker: string): LookupResult | null {
    const hit = FALLBACK_SYMBOLS[ticker];
    if (!hit) return null;
    return {
      ticker,
      ...hit,
      theme: deriveTheme(hit.sector, hit.industry),
      source: 'fallback',
    };
  }

  private async fromYahoo(ticker: string): Promise<LookupResult | null> {
    // `search` carries name/sector/industry/exchange without any auth, and
    // `chart` carries live price. Both are cheap, so run them together.
    const [search, chart] = await Promise.all([
      this.fetchJson(
        `${YAHOO}/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=6&newsCount=0`
      ),
      this.fetchJson(
        `${YAHOO}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`
      ),
    ]);

    const meta = chart?.chart?.result?.[0]?.meta;
    const quote = this.pickQuote(search?.quotes, ticker);

    // Neither endpoint knows the symbol -> let the caller try the fallback table.
    if (!meta && !quote) return null;

    const fallback = FALLBACK_SYMBOLS[ticker];
    const company =
      quote?.longname || quote?.shortname || meta?.longName || meta?.shortName || fallback?.company || '';
    if (!company) return null;

    // Sector/industry are present for equities; ETFs, indices and funds omit them.
    const sector = quote?.sectorDisp || quote?.sector || fallback?.sector || '';
    const industry = quote?.industryDisp || quote?.industry || fallback?.industry || '';

    // Only `quoteSummary` reports country, and only with a crumb — so fetch it
    // lazily and treat failure as non-fatal.
    const country =
      (await this.fetchCountry(ticker)) || fallback?.country || '';

    return {
      ticker,
      company,
      sector,
      industry,
      country,
      exchange: quote?.exchDisp || meta?.fullExchangeName || meta?.exchangeName || fallback?.exchange || '',
      currentPrice: typeof meta?.regularMarketPrice === 'number' ? meta.regularMarketPrice : undefined,
      currency: meta?.currency,
      theme: deriveTheme(sector, industry),
      source: 'yahoo',
    };
  }

  /** Yahoo ranks by fuzzy score, so prefer an exact symbol match over quotes[0]. */
  private pickQuote(quotes: any[] | undefined, ticker: string): any | undefined {
    if (!Array.isArray(quotes) || quotes.length === 0) return undefined;
    return quotes.find((q) => String(q?.symbol).toUpperCase() === ticker) ?? undefined;
  }

  private async fetchCountry(ticker: string): Promise<string> {
    const session = await this.getSession();
    if (!session) return '';

    const data = await this.fetchJson(
      `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
        `?modules=assetProfile&crumb=${encodeURIComponent(session.crumb)}`,
      { Cookie: session.cookie }
    );

    const country = data?.quoteSummary?.result?.[0]?.assetProfile?.country;
    if (!country) {
      // A rejected crumb looks like any other failure here; drop it so the next
      // lookup mints a fresh one rather than reusing a dead session.
      this.session = null;
    }
    return country ?? '';
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

      this.session = { cookie, crumb, expiresAt: Date.now() + MarketService.SESSION_TTL_MS };
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
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      this.logger.warn(`Yahoo request failed (${url}): ${(error as Error).message}`);
      return null;
    }
  }
}
