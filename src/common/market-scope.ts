/**
 * Market scope — the single source of truth for "which book am I looking at".
 *
 * The product manages two books of business (a US book and an Indian one) out of
 * one database rather than two deployments, so nearly every read is filtered by
 * this dimension. Keeping the definition here means a third market (say the UK)
 * is a new entry in MARKETS plus a Prisma enum value, not a hunt through every
 * service for hardcoded '^GSPC' / 'USD' pairs.
 *
 * Note the asymmetry with Prisma: the database persists SCREAMING_CASE enums
 * (US / INDIA) while the HTTP contract speaks the same casing here, unlike
 * RiskProfile/ClientStatus which lowercase across that boundary. Market is a
 * two-letter-ish code rather than a word, so 'india' buys no readability and the
 * uppercase form matches how the tickers and currency codes read.
 */

export type Market = 'US' | 'INDIA';

export const DEFAULT_MARKET: Market = 'US';

export interface MarketDefinition {
  code: Market;
  label: string;
  /** ISO 4217, used for both formatting and InstrumentProfile.currency. */
  currency: string;
  /**
   * Yahoo suffix appended to a bare ticker for this market's primary exchange.
   * Empty for the US, where symbols carry no suffix. India defaults to the NSE
   * ('.NS'); a BSE-only name is entered with an explicit '.BO' and is left alone
   * (see normalizeSymbol).
   */
  defaultSuffix: string;
  /** Every Yahoo suffix that belongs to this market. */
  suffixes: string[];
  /** Indices shown on the dashboard's market strip for this book. */
  indices: ReadonlyArray<{ code: string; label: string; symbol: string }>;
  /**
   * Commodities are quoted in USD globally. The Indian book still shows them —
   * a PM watches gold regardless of book — but they are flagged so the UI can
   * avoid formatting a USD future as rupees.
   */
  commodities: ReadonlyArray<{ code: string; label: string; symbol: string }>;
  /** Benchmark used when a client in this market has none set. */
  defaultBenchmark: { code: string; name: string; symbol: string };
}

const COMMODITIES = [
  { code: 'CRUDE', label: 'Crude Oil (WTI)', symbol: 'CL=F' },
  { code: 'GOLD', label: 'Gold', symbol: 'GC=F' },
  { code: 'SILVER', label: 'Silver', symbol: 'SI=F' },
] as const;

export const MARKETS: Record<Market, MarketDefinition> = {
  US: {
    code: 'US',
    label: 'United States',
    currency: 'USD',
    defaultSuffix: '',
    suffixes: [],
    indices: [
      { code: 'SP500', label: 'S&P 500', symbol: '^GSPC' },
      { code: 'NASDAQ', label: 'Nasdaq', symbol: '^IXIC' },
      { code: 'DOWJONES', label: 'Dow Jones', symbol: '^DJI' },
      { code: 'RUSSELL2000', label: 'Russell 2000', symbol: '^RUT' },
    ],
    commodities: COMMODITIES,
    defaultBenchmark: { code: 'SP500', name: 'S&P 500', symbol: '^GSPC' },
  },
  INDIA: {
    code: 'INDIA',
    label: 'India',
    currency: 'INR',
    defaultSuffix: '.NS',
    suffixes: ['.NS', '.BO'],
    indices: [
      { code: 'NIFTY50', label: 'Nifty 50', symbol: '^NSEI' },
      { code: 'SENSEX', label: 'Sensex', symbol: '^BSESN' },
      { code: 'BANKNIFTY', label: 'Nifty Bank', symbol: '^NSEBANK' },
      { code: 'NIFTYMIDCAP', label: 'Nifty Midcap 50', symbol: '^NSEMDCP50' },
    ],
    commodities: COMMODITIES,
    defaultBenchmark: { code: 'NIFTY50', name: 'Nifty 50', symbol: '^NSEI' },
  },
};

export const ALL_MARKETS: Market[] = ['US', 'INDIA'];

/**
 * Coerces an untrusted query-string value to a Market.
 *
 * Deliberately lenient — an absent or unrecognised `?market=` falls back to the
 * default rather than throwing, because every dashboard/holdings read takes this
 * param and a 400 on a stray value would blank the page instead of showing the
 * US book. A genuinely wrong value is a UI bug, not user input to validate.
 */
export function parseMarket(value: unknown): Market {
  if (typeof value !== 'string') return DEFAULT_MARKET;
  const upper = value.trim().toUpperCase();
  return (ALL_MARKETS as string[]).includes(upper) ? (upper as Market) : DEFAULT_MARKET;
}

/**
 * Which market a Yahoo symbol belongs to, decided by its suffix.
 *
 * This is what lets instruments be classified without a per-ticker table: a
 * symbol ending '.NS' or '.BO' is Indian, anything else is US. Indices are
 * special-cased because '^NSEI' carries no suffix but is unambiguously Indian.
 */
export function marketForSymbol(symbol: string): Market {
  const s = symbol.trim().toUpperCase();
  if (INDIAN_INDEX_SYMBOLS.has(s)) return 'INDIA';
  return MARKETS.INDIA.suffixes.some((suffix) => s.endsWith(suffix)) ? 'INDIA' : 'US';
}

const INDIAN_INDEX_SYMBOLS = new Set(
  MARKETS.INDIA.indices.map((i) => i.symbol.toUpperCase()),
);

/**
 * Canonical Yahoo symbol for a ticker typed by a human in a given market.
 *
 * Indian tickers are entered bare ("RELIANCE") far more often than suffixed, and
 * Yahoo returns nothing at all for the bare form — so the suffix is appended
 * rather than left to the user. An explicitly-suffixed symbol is honoured as
 * typed, which is how a BSE-only listing ('.BO') survives this function, and
 * indices (leading '^') are never suffixed.
 */
export function normalizeSymbol(rawTicker: string, market: Market): string {
  const ticker = rawTicker.trim().toUpperCase();
  if (!ticker) return ticker;
  if (ticker.startsWith('^') || ticker.includes('=')) return ticker;

  const def = MARKETS[market];
  if (!def.defaultSuffix) return ticker;
  if (def.suffixes.some((suffix) => ticker.endsWith(suffix))) return ticker;

  return `${ticker}${def.defaultSuffix}`;
}

/** Strips the market suffix for display — 'RELIANCE.NS' reads as 'RELIANCE'. */
export function displaySymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  for (const suffix of MARKETS.INDIA.suffixes) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length);
  }
  return s;
}

export function currencyForMarket(market: Market): string {
  return MARKETS[market].currency;
}
