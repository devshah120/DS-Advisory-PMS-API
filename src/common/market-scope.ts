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
  /**
   * The month (0-indexed, UTC) the reporting year opens on, and how a year is
   * named. The US book reports on the calendar year; the Indian book reports on
   * the statutory April–March financial year, and every Indian client statement,
   * capital-gains filing and audit is cut on that boundary — so a "YTD" that
   * silently meant January would not tie to anything the client receives
   * elsewhere.
   *
   * `yearEndsOnLabelYear` is the naming convention, and it is the half that is
   * easy to get wrong: India names a financial year for the calendar year it
   * ENDS in, so April-2026 → March-2027 is FY27. The US names its year for the
   * year it runs in, which is the same thing when the year starts in January.
   */
  fiscalYear: {
    /** 0 = January, 3 = April. */
    startMonth: number;
    /** Prefix on the year label — 'FY' for India, 'CY' for the US. */
    labelPrefix: string;
    /** True when the year is named for its ending calendar year (India). */
    yearEndsOnLabelYear: boolean;
  };
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
    // Calendar year: opens 1 January, named for the year it runs in.
    fiscalYear: { startMonth: 0, labelPrefix: 'CY', yearEndsOnLabelYear: false },
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
    // April–March, named for the ending year: Apr-2026 → Mar-2027 is FY27.
    fiscalYear: { startMonth: 3, labelPrefix: 'FY', yearEndsOnLabelYear: true },
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

// ── Fiscal calendar ──────────────────────────────────────────────────────────
/**
 * Everything below converts between a DATE and the reporting period that
 * contains it, for whichever market's calendar applies. It lives here, beside
 * the market definitions, because "which months make a year" is a property of
 * the book — not of the performance engine that happens to ask.
 *
 * All arithmetic is UTC. A local-time Date would put 1-April in the previous
 * fiscal year for anyone east of Greenwich, which is precisely the desk this
 * feature is for.
 */

/** The fiscal year a date falls in, as the number used in its label. */
export function fiscalYearOf(date: Date, market: Market): number {
  const { startMonth, yearEndsOnLabelYear } = MARKETS[market].fiscalYear;
  const y = date.getUTCFullYear();

  // Before the start month, the date belongs to the year that OPENED last
  // calendar year. January-2027 is in the year that opened April-2026.
  const openingYear = date.getUTCMonth() >= startMonth ? y : y - 1;
  return yearEndsOnLabelYear ? openingYear + 1 : openingYear;
}

/** The fiscal quarter (1-4) a date falls in. */
export function fiscalQuarterOf(date: Date, market: Market): number {
  const { startMonth } = MARKETS[market].fiscalYear;
  // Months elapsed since the year opened, wrapped into 0-11.
  const offset = (date.getUTCMonth() - startMonth + 12) % 12;
  return Math.floor(offset / 3) + 1;
}

/** Two-digit label year, e.g. 27 for FY27. */
function labelYear(fy: number): string {
  return String(fy).slice(-2);
}

/** The calendar year a fiscal year OPENS in. */
function openingCalendarYear(fy: number, market: Market): number {
  return MARKETS[market].fiscalYear.yearEndsOnLabelYear ? fy - 1 : fy;
}

/** `[start, end]` of a whole fiscal year, end being its last day. */
export function fiscalYearRange(fy: number, market: Market): { start: Date; end: Date } {
  const { startMonth } = MARKETS[market].fiscalYear;
  const open = openingCalendarYear(fy, market);
  return {
    start: new Date(Date.UTC(open, startMonth, 1)),
    // Day 0 of the month 12 months later is the year's last day.
    end: new Date(Date.UTC(open, startMonth + 12, 0)),
  };
}

/** `[start, end]` of one fiscal quarter, end being its last day. */
export function fiscalQuarterRange(
  q: number,
  fy: number,
  market: Market,
): { start: Date; end: Date } {
  const { startMonth } = MARKETS[market].fiscalYear;
  const open = openingCalendarYear(fy, market);
  const month = startMonth + (q - 1) * 3;
  return {
    start: new Date(Date.UTC(open, month, 1)),
    end: new Date(Date.UTC(open, month + 3, 0)),
  };
}

/** e.g. `FY27` / `CY26`. */
export function fiscalYearLabel(fy: number, market: Market): string {
  return `${MARKETS[market].fiscalYear.labelPrefix}${labelYear(fy)}`;
}

/** e.g. `Q2 FY27` / `Q3 CY26`. */
export function fiscalQuarterLabel(q: number, fy: number, market: Market): string {
  return `Q${q} ${fiscalYearLabel(fy, market)}`;
}

/** The machine code for a quarter, e.g. `Q2-FY27`. Parsed by resolvePeriod. */
export function fiscalQuarterCode(q: number, fy: number, market: Market): string {
  return `Q${q}-${MARKETS[market].fiscalYear.labelPrefix}${labelYear(fy)}`;
}

/** The machine code for a whole year, e.g. `FY27`. */
export function fiscalYearCode(fy: number, market: Market): string {
  return `${MARKETS[market].fiscalYear.labelPrefix}${labelYear(fy)}`;
}
