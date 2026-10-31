import { Injectable, Logger } from '@nestjs/common';

/**
 * Maps an ISIN to the Yahoo symbol this app stores positions under.
 *
 * A contract note identifies a security by ISIN, never by ticker, and nothing
 * in this database carries an Indian ISIN (InstrumentProfile covers the US book
 * only). NSE's own security masters do: one CSV each for the main board, Emerge
 * (SME) and ETFs, every row pairing a trading symbol with its ISIN. Those give
 * exactly the symbols already in use — MBEL.NS, HDFCSILVER.NS, REMUS-SM.NS —
 * where Yahoo's ISIN search tends to answer with the .BO listing instead, so
 * Yahoo is only asked about an ISIN NSE does not list.
 */

const NSE_ARCHIVES = 'https://nsearchives.nseindia.com';

/**
 * Main board first: a company that migrates from Emerge keeps its ISIN, and
 * after migration it is the main-board symbol that trades.
 */
const MASTERS: { url: string; symbol: (row: Record<string, string>) => string | null }[] = [
  {
    url: `${NSE_ARCHIVES}/content/equities/EQUITY_L.csv`,
    symbol: (r) => (r['SYMBOL'] ? `${r['SYMBOL']}.NS` : null),
  },
  {
    url: `${NSE_ARCHIVES}/content/equities/eq_etfseclist.csv`,
    symbol: (r) => (r['SYMBOL'] ? `${r['SYMBOL']}.NS` : null),
  },
  {
    // Emerge symbols carry their series, the same "-SM.NS"/"-ST.NS" form
    // MarketService recognises as an Emerge listing.
    url: `${NSE_ARCHIVES}/emerge/corporates/content/SME_EQUITY_L.csv`,
    symbol: (r) => (r['SYMBOL'] && r['SERIES'] ? `${r['SYMBOL']}-${r['SERIES']}.NS` : null),
  },
];

/** NSE republishes these daily; half a day keeps a new listing from going unresolved. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** "ISIN NUMBER", "ISIN_NUMBER" and "ISINNumber" are all the same column. */
const normaliseHeader = (h: string) => {
  const k = h.toUpperCase().replace(/[^A-Z]/g, '');
  return k.startsWith('ISIN') ? 'ISIN' : k;
};

/** Splits one CSV line, honouring quoted fields (company names can hold commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

@Injectable()
export class IsinResolverService {
  private readonly logger = new Logger(IsinResolverService.name);
  private cache: { at: number; byIsin: Map<string, string> } | null = null;
  private loading: Promise<Map<string, string>> | null = null;

  /** ISIN → symbol for each ISIN that could be resolved; absent when not. */
  async resolve(isins: string[]): Promise<Map<string, string>> {
    const master = await this.master();
    const out = new Map<string, string>();
    for (const isin of new Set(isins)) {
      const hit = master.get(isin) ?? (await this.fromYahoo(isin));
      if (hit) out.set(isin, hit);
    }
    return out;
  }

  private async master(): Promise<Map<string, string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.byIsin;
    // One download for every concurrent upload, not one each.
    this.loading ??= this.loadMasters().finally(() => (this.loading = null));
    return this.loading;
  }

  private async loadMasters(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let loadedAny = false;

    for (const { url, symbol } of MASTERS) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const [headerLine, ...lines] = (await res.text()).split(/\r?\n/);
        const headers = splitCsvLine(headerLine).map(normaliseHeader);
        for (const line of lines) {
          if (!line.trim()) continue;
          const cells = splitCsvLine(line);
          const row: Record<string, string> = {};
          headers.forEach((h, i) => (row[h] = cells[i] ?? ''));
          const isin = row['ISIN']?.toUpperCase();
          const sym = symbol(row);
          if (isin && sym && !map.has(isin)) map.set(isin, sym.toUpperCase());
        }
        loadedAny = true;
      } catch (error) {
        this.logger.warn(`NSE security master unavailable (${url}): ${(error as Error).message}`);
      }
    }

    if (loadedAny) {
      this.cache = { at: Date.now(), byIsin: map };
      return map;
    }
    // NSE unreachable: a stale master beats none, and with none at all every
    // row still falls through to Yahoo and, failing that, to the user.
    return this.cache?.byIsin ?? map;
  }

  /** Yahoo's search resolves most ISINs; an Indian listing is preferred on NSE. */
  private async fromYahoo(isin: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=6&newsCount=0`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) return null;
      const quotes: { symbol?: string }[] = (await res.json())?.quotes ?? [];
      const symbols = quotes.map((q) => q.symbol).filter((s): s is string => !!s);
      return symbols.find((s) => s.endsWith('.NS')) ?? symbols.find((s) => s.endsWith('.BO')) ?? null;
    } catch (error) {
      this.logger.warn(`Yahoo ISIN search failed for ${isin}: ${(error as Error).message}`);
      return null;
    }
  }
}
