import { Injectable, Logger } from '@nestjs/common';
import { NewsItem, deriveTag } from '../news.types';

const YAHOO = 'https://query2.finance.yahoo.com';
const REQUEST_TIMEOUT_MS = 8000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Yahoo throttles bursts, so the same batching shape as YahooEventsService.
const BATCH_SIZE = 4;
const BATCH_PAUSE_MS = 150;

const ARTICLES_PER_TICKER = 10;

/**
 * How long a sampled filler fingerprint stays valid. Yahoo rotates the filler
 * set over the day, so it is re-sampled rather than hardcoded.
 */
const FILLER_TTL_MS = 10 * 60 * 1000;

/**
 * A symbol Yahoo cannot possibly have news for. Its response IS the filler set,
 * which is what makes filler detectable at all.
 */
const FILLER_PROBE_SYMBOL = 'ZZZZNOTAREALTICKER';

/**
 * Above this share of a ticker's stories matching the filler set, the whole
 * response is treated as filler. A real response occasionally shares a
 * broad-market story with the probe ("Fed rate odds"), so a couple of hits is
 * normal and only a wholesale match is disqualifying.
 */
const FILLER_MATCH_RATIO = 0.6;

/**
 * Company news for US tickers, from Yahoo Finance's `search` endpoint.
 *
 * Why this endpoint and not the RSS feed everyone reaches for first:
 * `feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL` is retired and answers 404
 * (verified Aug 2026). This one is JSON, needs no cookie+crumb handshake
 * (unlike quoteSummary, which YahooEventsService has to authenticate for), and
 * returns a publisher and a real publish timestamp per story.
 *
 * ── The filler problem ────────────────────────────────────────────────────
 * This endpoint never reports failure. When it cannot or will not answer for a
 * symbol it returns HTTP 200 with a set of generic market stories — "Sunflowers
 * in South Dakota", "Market brings together shoppers" — that look exactly like
 * real news in a UI. Observed in two distinct situations:
 *
 *   1. Symbols Yahoo does not recognise (every '.NS' ticker; US share classes
 *      such as HEI-A). This is why the Indian book never reaches this provider.
 *   2. Intermittently, for symbols that normally work — AAPL returned real
 *      Apple coverage and, twenty minutes later in the same session, pure
 *      filler. So it is a load/rate-limit behaviour, not a property of the
 *      symbol, and no static allowlist would catch it.
 *
 * Storing filler is worse than storing nothing: it puts irrelevant headlines
 * under a client's holding and is hard to spot as broken. So each pass probes
 * with a nonsense symbol to learn the current filler set, and any ticker whose
 * response is mostly that set is discarded. Discarding is safe — the feed is
 * append-only, so a ticker skipped now keeps the stories it already had and
 * simply picks up again on the next refresh.
 */
@Injectable()
export class YahooNewsProvider {
  private readonly logger = new Logger(YahooNewsProvider.name);

  /** Current filler headlines, re-sampled per TTL. */
  private filler: { titles: Set<string>; expiresAt: number } | null = null;

  /** Recent stories for US tickers, batched to stay under Yahoo's rate limit. */
  async fetch(tickers: string[]): Promise<NewsItem[]> {
    const filler = await this.fillerTitles();
    const items: NewsItem[] = [];
    let skipped = 0;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((t) => this.forTicker(t)));

      for (const list of results) {
        if (this.isFiller(list, filler)) {
          skipped += 1;
          continue;
        }
        items.push(...list);
      }

      if (i + BATCH_SIZE < tickers.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    if (skipped > 0) {
      this.logger.warn(
        `Discarded generic filler for ${skipped}/${tickers.length} US tickers — Yahoo served no real coverage for them this pass`,
      );
    }

    return items;
  }

  /**
   * True when a response is Yahoo's generic filler rather than company news.
   * An empty response is not filler — it is simply nothing to store.
   */
  private isFiller(items: NewsItem[], filler: Set<string>): boolean {
    if (items.length === 0 || filler.size === 0) return false;
    const matches = items.filter((i) => filler.has(i.title)).length;
    return matches / items.length >= FILLER_MATCH_RATIO;
  }

  /**
   * The filler set, sampled by asking for a symbol that cannot exist. A failed
   * probe returns empty, which disables filtering for the pass — better to
   * store a little filler than to drop every ticker's real news on a bad probe.
   */
  private async fillerTitles(): Promise<Set<string>> {
    if (this.filler && this.filler.expiresAt > Date.now()) return this.filler.titles;

    const probe = await this.forTicker(FILLER_PROBE_SYMBOL);
    const titles = new Set(probe.map((p) => p.title));

    if (titles.size === 0) {
      this.logger.warn('Filler probe returned nothing — filler filtering disabled this pass');
      return titles;
    }

    this.filler = { titles, expiresAt: Date.now() + FILLER_TTL_MS };
    return titles;
  }

  private async forTicker(ticker: string): Promise<NewsItem[]> {
    const data = await this.fetchJson(
      `${YAHOO}/v1/finance/search?q=${encodeURIComponent(ticker)}` +
        `&newsCount=${ARTICLES_PER_TICKER}&quotesCount=0&enableNavLinks=false&enableFuzzyQuery=false`,
    );

    const news = data?.news;
    if (!Array.isArray(news)) return [];

    return news
      .map((a: any): NewsItem | null => {
        const title = typeof a?.title === 'string' ? a.title.trim() : '';
        const url = typeof a?.link === 'string' ? a.link.trim() : '';
        // Yahoo gives publish time as epoch SECONDS. A story with neither a
        // title nor a link is unusable, and one with no timestamp cannot be
        // placed on a timeline, so all three are required rather than defaulted
        // to "now" — which would park undated filler at the top of the feed.
        const seconds = a?.providerPublishTime;
        if (!title || !url || typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;

        return {
          ticker,
          market: 'US',
          title,
          publisher: typeof a?.publisher === 'string' && a.publisher ? a.publisher : 'Yahoo Finance',
          url,
          summary: null,
          publishedAt: new Date(seconds * 1000),
          kind: 'NEWS',
          category: null,
          tag: deriveTag(title),
          source: 'yahoo',
        };
      })
      .filter((i): i is NewsItem => i !== null);
  }

  /** Returns parsed JSON, or null on any network/parse/status failure. */
  private async fetchJson(url: string): Promise<any | null> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Yahoo news request failed (${response.status}): ${url}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn(`Yahoo news request errored: ${(error as Error).message}`);
      return null;
    }
  }
}
