import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { displaySymbol } from '../../common/market-scope';
import { NewsItem, deriveTag } from '../news.types';

const BSE_API = 'https://api.bseindia.com/BseIndiaAPI/api';
const REQUEST_TIMEOUT_MS = 10000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * BSE's API is browser-facing and rejects requests without a matching origin.
 * These headers are what make it answer 200 rather than 403.
 */
const BSE_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
};

// BSE is a single public endpoint with no documented rate limit — go gently.
const BATCH_SIZE = 2;
const BATCH_PAUSE_MS = 400;

/** How far back a refresh looks for filings. */
const LOOKBACK_DAYS = 30;

/** BSE's attachment host, for filings whose body is a PDF. */
const ATTACHMENT_BASE = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive';

/**
 * Corporate announcements filed with the Bombay Stock Exchange — the
 * authoritative source for the Indian book.
 *
 * This is a primary regulatory source, not journalism: results declarations,
 * buybacks, acquisitions, board meeting outcomes and AGM notices arrive here
 * first, filed by the company itself under SEBI LODR Regulation 30. That is
 * exactly the material the desk needs, and it is why the Indian book leads with
 * filings and treats press coverage as the supplement rather than the reverse.
 *
 * Two undocumented endpoints are used:
 *   - `AnnSubCategoryGetData` — announcements for one scrip over a date range.
 *   - `PeerSmartSearch` — the site's autocomplete, used to resolve a ticker to
 *     the scrip code the first endpoint keys on.
 *
 * Both are the site's own XHR calls. They are stable in practice but carry no
 * compatibility promise, so every failure path here degrades to "no filings for
 * this ticker" rather than failing the refresh.
 */
@Injectable()
export class BseFilingsProvider {
  private readonly logger = new Logger(BseFilingsProvider.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Filings for the given Indian tickers. Tickers whose scrip code cannot be
   * resolved contribute nothing rather than failing the batch — the Google News
   * provider still covers them.
   */
  async fetch(tickers: string[]): Promise<NewsItem[]> {
    const items: NewsItem[] = [];

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((t) => this.forTicker(t)));
      for (const list of results) items.push(...list);

      if (i + BATCH_SIZE < tickers.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    return items;
  }

  private async forTicker(ticker: string): Promise<NewsItem[]> {
    const scripCode = await this.resolveScripCode(ticker);
    if (!scripCode) return [];

    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);

    const data = await this.fetchJson(
      `${BSE_API}/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strType=C&strSearch=P` +
        `&strPrevDate=${compactDate(from)}&strToDate=${compactDate(to)}` +
        `&strScrip=${encodeURIComponent(scripCode)}&subcategory=-1`,
    );

    const rows = data?.Table;
    if (!Array.isArray(rows)) return [];

    return rows
      .map((r: any): NewsItem | null => {
        // NEWSSUB is the human-readable subject line; HEADLINE is sometimes
        // richer but frequently absent, so prefer the subject and fall back.
        const title = clean(r?.NEWSSUB) || clean(r?.HEADLINE);
        const published = parseBseDate(r?.NEWS_DT ?? r?.DissemDT);
        if (!title || !published) return null;

        const category = clean(r?.CATEGORYNAME) || null;

        return {
          ticker,
          market: 'INDIA',
          title,
          publisher: 'BSE',
          // Prefer the filed PDF; fall back to a stable per-filing permalink so
          // the row is always clickable even when there is no attachment.
          url: this.filingUrl(r, scripCode),
          summary: clean(r?.MORE) || null,
          publishedAt: published,
          kind: 'FILING',
          category,
          tag: deriveTag(title, category),
          source: 'bse',
        };
      })
      .filter((i): i is NewsItem => i !== null);
  }

  /**
   * A link to the filing itself. ATTACHMENTNAME is the PDF the company filed;
   * when it is absent the announcements page for the scrip is the next best
   * anchor — never an empty href, because `url` is also the dedupe key and a
   * blank would collapse every attachment-less filing into one row.
   */
  private filingUrl(row: any, scripCode: string): string {
    const attachment = clean(row?.ATTACHMENTNAME);
    if (attachment) return `${ATTACHMENT_BASE}/${attachment}`;

    const newsId = clean(row?.NEWSID);
    return newsId
      ? `https://www.bseindia.com/corporates/anndet_new.aspx?newsid=${encodeURIComponent(newsId)}`
      : `https://www.bseindia.com/stock-share-price/scripcode/${encodeURIComponent(scripCode)}/`;
  }

  /**
   * Ticker → BSE scrip code, cached in the database.
   *
   * A stored mapping is always trusted, including an unverified one: BSE's
   * autocomplete is the same answer every time, so re-resolving would spend a
   * request to learn what we already know. `verified` exists so a human can
   * correct a bad auto-match without a later refresh overwriting the fix.
   */
  private async resolveScripCode(ticker: string): Promise<string | null> {
    const stored = await this.prisma.bseScripCode.findUnique({ where: { ticker } });
    if (stored) return stored.scripCode;

    const resolved = await this.lookupScripCode(ticker);
    if (!resolved) {
      this.logger.warn(`No BSE scrip code found for ${ticker} — filings will be skipped`);
      return null;
    }

    await this.prisma.bseScripCode.upsert({
      where: { ticker },
      create: {
        ticker,
        scripCode: resolved.scripCode,
        bseName: resolved.name,
        verified: false,
      },
      // A concurrent refresh may have written it first; keep whatever is there
      // rather than clobbering a mapping someone has since verified.
      update: {},
    });

    return resolved.scripCode;
  }

  /**
   * Queries BSE's autocomplete and picks the row whose NSE symbol matches.
   *
   * The match matters: searching "RELIANCE" returns Reliance Industries AND
   * Reliance Infrastructure/Power, so taking the first hit would silently file
   * the wrong company's announcements against the holding. The response embeds
   * each candidate's NSE symbol, so an exact symbol match is available and is
   * required — an ambiguous search resolves to nothing rather than to a guess.
   */
  private async lookupScripCode(
    ticker: string,
  ): Promise<{ scripCode: string; name: string } | null> {
    const symbol = displaySymbol(ticker);
    const raw = await this.fetchText(
      `${BSE_API}/PeerSmartSearch/w?Type=SS&text=${encodeURIComponent(symbol)}`,
    );
    if (!raw) return null;

    // The endpoint returns a JSON-encoded HTML fragment: a list of <li> rows,
    // each carrying liclick('<scripCode>','<COMPANY NAME>') and a <span> that
    // contains the NSE symbol, the ISIN and the scrip code.
    const html = raw.startsWith('"') ? safeJsonParse(raw) : raw;
    if (!html) return null;

    const rows = html.split('<li').slice(1);
    for (const row of rows) {
      const click = /liclick\('(\d+)','([^']*)'\)/.exec(row);
      if (!click) continue;

      // Strip tags and entities so the symbol comparison sees plain text —
      // BSE bolds the matched substring, which would otherwise split the symbol.
      const text = row
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .toUpperCase();

      // Word-boundary match so "RELIANCE" does not match "RELIANCEPOWER".
      if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text)) {
        return { scripCode: click[1], name: click[2] };
      }
    }

    return null;
  }

  private async fetchJson(url: string): Promise<any | null> {
    const text = await this.fetchText(url);
    if (text === null) return null;
    return safeJsonParseAny(text);
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: BSE_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`BSE request failed (${response.status}): ${url}`);
        return null;
      }
      return await response.text();
    } catch (error) {
      this.logger.warn(`BSE request errored: ${(error as Error).message}`);
      return null;
    }
  }
}

/** BSE date params are compact `YYYYMMDD`. */
function compactDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * BSE timestamps arrive as `2026-08-14T18:32:00` with no zone marker. They are
 * IST (UTC+5:30); parsing them as UTC would shift every evening filing onto the
 * wrong day, which is exactly the kind of off-by-one that makes a filing appear
 * to precede the news story reporting it.
 */
function parseBseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const iso = value.trim().replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}+05:30`;

  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Collapses BSE's padded/entity-laden strings to a clean single line. */
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>/g, ' ')
    // BSE stores text SQL-escaped, so apostrophes come back doubled —
    // "Investors'' Meeting". Collapse them before the whitespace pass.
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function safeJsonParseAny(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
