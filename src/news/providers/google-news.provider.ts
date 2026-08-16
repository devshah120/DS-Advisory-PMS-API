import { Injectable, Logger } from '@nestjs/common';
import { Market } from '../../common/market-scope';
import { NewsItem, deriveTag } from '../news.types';

const REQUEST_TIMEOUT_MS = 10000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const BATCH_SIZE = 3;
const BATCH_PAUSE_MS = 300;

/** Matches the BSE lookback so the two India sources cover the same window. */
const LOOKBACK_DAYS = 30;

const MAX_ITEMS_PER_TICKER = 12;

/**
 * Sources that are not journalism. Google News indexes social posts and
 * aggregator pages alongside real reporting — a live observation, not a
 * hypothetical: a query for "Reliance Industries" returned a facebook.com
 * patriotic post beside the Reuters story. Publisher is the only reliable
 * discriminator the feed gives us, so it is filtered on.
 */
const EXCLUDED_PUBLISHERS =
  /facebook\.com|twitter\.com|x\.com|instagram|youtube|reddit|linkedin|quora|tiktok/i;

/**
 * Press coverage from Google News RSS.
 *
 * Complements BseFilingsProvider on the Indian book: a filing tells you what
 * the company disclosed, this tells you how it was reported and picks up the
 * analyst and sector stories that never become filings. Cross-checking the two
 * during design showed them corroborating the same event from both sides — BSE
 * carried Reliance's own Rolls-Royce media release, Google News carried
 * Reuters' write-up of it — which is the intended pairing.
 *
 * Queried by COMPANY NAME, not ticker. "RELIANCE.NS" and even "RELIANCE" are
 * poor news queries; the registered company name is what publishers actually
 * write, and quoting it keeps a multi-word name from matching each word apart.
 */
@Injectable()
export class GoogleNewsProvider {
  private readonly logger = new Logger(GoogleNewsProvider.name);

  /**
   * Recent coverage for each (ticker, company) pair. Entries whose company name
   * is unknown are skipped — a bare ticker query returns mostly noise, and an
   * empty result is better than a feed of wrong-company stories.
   */
  async fetch(
    entries: Array<{ ticker: string; company: string; market: Market }>,
  ): Promise<NewsItem[]> {
    const usable = entries.filter((e) => e.company && e.company.trim().length > 1);
    const items: NewsItem[] = [];

    for (let i = 0; i < usable.length; i += BATCH_SIZE) {
      const batch = usable.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((e) => this.forEntry(e)));
      for (const list of results) items.push(...list);

      if (i + BATCH_SIZE < usable.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    return items;
  }

  private async forEntry(entry: {
    ticker: string;
    company: string;
    market: Market;
  }): Promise<NewsItem[]> {
    // Locale steers both the sources and the ranking: an Indian name should
    // surface Indian business press, a US name the US wires.
    const locale =
      entry.market === 'INDIA'
        ? 'hl=en-IN&gl=IN&ceid=IN:en'
        : 'hl=en-US&gl=US&ceid=US:en';

    const query = `"${entry.company.trim()}" when:${LOOKBACK_DAYS}d`;
    const xml = await this.fetchText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`,
    );
    if (!xml) return [];

    const items: NewsItem[] = [];

    for (const block of xml.split('<item>').slice(1, MAX_ITEMS_PER_TICKER + 1)) {
      const rawTitle = extract(block, 'title');
      const link = extract(block, 'link');
      const pubDate = extract(block, 'pubDate');
      // <source url="...">Publisher</source>
      const publisher = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1];

      if (!rawTitle || !link || !pubDate) continue;

      const publishedAt = new Date(pubDate);
      if (Number.isNaN(publishedAt.getTime())) continue;

      const cleanPublisher = decode(publisher ?? '').trim() || 'Google News';
      if (EXCLUDED_PUBLISHERS.test(cleanPublisher) || EXCLUDED_PUBLISHERS.test(link)) continue;

      // Google appends " - Publisher" to every headline; stripping it stops the
      // outlet name being repeated in both the title and the publisher column.
      const title = decode(rawTitle)
        .replace(new RegExp(`\\s*-\\s*${escapeRegExp(cleanPublisher)}\\s*$`), '')
        .trim();
      if (!title) continue;

      items.push({
        ticker: entry.ticker,
        market: entry.market,
        title,
        publisher: cleanPublisher,
        url: decode(link).trim(),
        summary: null,
        publishedAt,
        kind: 'NEWS',
        category: null,
        tag: deriveTag(title),
        source: 'google-news',
      });
    }

    return items;
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Google News request failed (${response.status})`);
        return null;
      }
      return await response.text();
    } catch (error) {
      this.logger.warn(`Google News request errored: ${(error as Error).message}`);
      return null;
    }
  }
}

/** First value of an RSS tag, unwrapping CDATA. */
function extract(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return null;
  const value = match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
  return value || null;
}

function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // Ampersand last: decoding it first would corrupt the other entities.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
