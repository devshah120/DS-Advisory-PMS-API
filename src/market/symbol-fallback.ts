/**
 * Offline classification data used when Yahoo Finance is unreachable or does not
 * return a profile for a ticker. Covers the large caps most likely to be typed
 * by hand; anything else falls through to a name-only result.
 */
export interface SymbolProfile {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  country: string;
  exchange: string;
  currentPrice?: number;
  currency?: string;
}

export const FALLBACK_SYMBOLS: Record<string, Omit<SymbolProfile, 'ticker'>> = {
  AAPL: { company: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics', country: 'United States', exchange: 'NASDAQ' },
  MSFT: { company: 'Microsoft Corporation', sector: 'Technology', industry: 'Software—Infrastructure', country: 'United States', exchange: 'NASDAQ' },
  GOOGL: { company: 'Alphabet Inc.', sector: 'Communication Services', industry: 'Internet Content & Information', country: 'United States', exchange: 'NASDAQ' },
  AMZN: { company: 'Amazon.com, Inc.', sector: 'Consumer Cyclical', industry: 'Internet Retail', country: 'United States', exchange: 'NASDAQ' },
  META: { company: 'Meta Platforms, Inc.', sector: 'Communication Services', industry: 'Internet Content & Information', country: 'United States', exchange: 'NASDAQ' },
  NVDA: { company: 'NVIDIA Corporation', sector: 'Technology', industry: 'Semiconductors', country: 'United States', exchange: 'NASDAQ' },
  TSLA: { company: 'Tesla, Inc.', sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', country: 'United States', exchange: 'NASDAQ' },
  AMD: { company: 'Advanced Micro Devices, Inc.', sector: 'Technology', industry: 'Semiconductors', country: 'United States', exchange: 'NASDAQ' },
  INTC: { company: 'Intel Corporation', sector: 'Technology', industry: 'Semiconductors', country: 'United States', exchange: 'NASDAQ' },
  AVGO: { company: 'Broadcom Inc.', sector: 'Technology', industry: 'Semiconductors', country: 'United States', exchange: 'NASDAQ' },
  CRM: { company: 'Salesforce, Inc.', sector: 'Technology', industry: 'Software—Application', country: 'United States', exchange: 'NYSE' },
  ORCL: { company: 'Oracle Corporation', sector: 'Technology', industry: 'Software—Infrastructure', country: 'United States', exchange: 'NYSE' },
  ADBE: { company: 'Adobe Inc.', sector: 'Technology', industry: 'Software—Infrastructure', country: 'United States', exchange: 'NASDAQ' },
  NFLX: { company: 'Netflix, Inc.', sector: 'Communication Services', industry: 'Entertainment', country: 'United States', exchange: 'NASDAQ' },
  JPM: { company: 'JPMorgan Chase & Co.', sector: 'Financial Services', industry: 'Banks—Diversified', country: 'United States', exchange: 'NYSE' },
  BAC: { company: 'Bank of America Corporation', sector: 'Financial Services', industry: 'Banks—Diversified', country: 'United States', exchange: 'NYSE' },
  GS: { company: 'The Goldman Sachs Group, Inc.', sector: 'Financial Services', industry: 'Capital Markets', country: 'United States', exchange: 'NYSE' },
  V: { company: 'Visa Inc.', sector: 'Financial Services', industry: 'Credit Services', country: 'United States', exchange: 'NYSE' },
  MA: { company: 'Mastercard Incorporated', sector: 'Financial Services', industry: 'Credit Services', country: 'United States', exchange: 'NYSE' },
  BRKB: { company: 'Berkshire Hathaway Inc.', sector: 'Financial Services', industry: 'Insurance—Diversified', country: 'United States', exchange: 'NYSE' },
  JNJ: { company: 'Johnson & Johnson', sector: 'Healthcare', industry: 'Drug Manufacturers—General', country: 'United States', exchange: 'NYSE' },
  UNH: { company: 'UnitedHealth Group Incorporated', sector: 'Healthcare', industry: 'Healthcare Plans', country: 'United States', exchange: 'NYSE' },
  LLY: { company: 'Eli Lilly and Company', sector: 'Healthcare', industry: 'Drug Manufacturers—General', country: 'United States', exchange: 'NYSE' },
  PFE: { company: 'Pfizer Inc.', sector: 'Healthcare', industry: 'Drug Manufacturers—General', country: 'United States', exchange: 'NYSE' },
  XOM: { company: 'Exxon Mobil Corporation', sector: 'Energy', industry: 'Oil & Gas Integrated', country: 'United States', exchange: 'NYSE' },
  CVX: { company: 'Chevron Corporation', sector: 'Energy', industry: 'Oil & Gas Integrated', country: 'United States', exchange: 'NYSE' },
  WMT: { company: 'Walmart Inc.', sector: 'Consumer Defensive', industry: 'Discount Stores', country: 'United States', exchange: 'NYSE' },
  COST: { company: 'Costco Wholesale Corporation', sector: 'Consumer Defensive', industry: 'Discount Stores', country: 'United States', exchange: 'NASDAQ' },
  PG: { company: 'The Procter & Gamble Company', sector: 'Consumer Defensive', industry: 'Household & Personal Products', country: 'United States', exchange: 'NYSE' },
  KO: { company: 'The Coca-Cola Company', sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic', country: 'United States', exchange: 'NYSE' },
  PEP: { company: 'PepsiCo, Inc.', sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic', country: 'United States', exchange: 'NASDAQ' },
  DIS: { company: 'The Walt Disney Company', sector: 'Communication Services', industry: 'Entertainment', country: 'United States', exchange: 'NYSE' },
  BA: { company: 'The Boeing Company', sector: 'Industrials', industry: 'Aerospace & Defense', country: 'United States', exchange: 'NYSE' },
  CAT: { company: 'Caterpillar Inc.', sector: 'Industrials', industry: 'Farm & Heavy Construction Machinery', country: 'United States', exchange: 'NYSE' },
  UBER: { company: 'Uber Technologies, Inc.', sector: 'Technology', industry: 'Software—Application', country: 'United States', exchange: 'NYSE' },
  PLTR: { company: 'Palantir Technologies Inc.', sector: 'Technology', industry: 'Software—Infrastructure', country: 'United States', exchange: 'NASDAQ' },
  SHOP: { company: 'Shopify Inc.', sector: 'Technology', industry: 'Software—Application', country: 'Canada', exchange: 'NYSE' },
  TSM: { company: 'Taiwan Semiconductor Manufacturing Company Limited', sector: 'Technology', industry: 'Semiconductors', country: 'Taiwan', exchange: 'NYSE' },
  ASML: { company: 'ASML Holding N.V.', sector: 'Technology', industry: 'Semiconductor Equipment & Materials', country: 'Netherlands', exchange: 'NASDAQ' },
  BABA: { company: 'Alibaba Group Holding Limited', sector: 'Consumer Cyclical', industry: 'Internet Retail', country: 'China', exchange: 'NYSE' },
  'RELIANCE.NS': { company: 'Reliance Industries Limited', sector: 'Energy', industry: 'Oil & Gas Refining & Marketing', country: 'India', exchange: 'NSE' },
  'TCS.NS': { company: 'Tata Consultancy Services Limited', sector: 'Technology', industry: 'Information Technology Services', country: 'India', exchange: 'NSE' },
  'INFY.NS': { company: 'Infosys Limited', sector: 'Technology', industry: 'Information Technology Services', country: 'India', exchange: 'NSE' },
  'HDFCBANK.NS': { company: 'HDFC Bank Limited', sector: 'Financial Services', industry: 'Banks—Regional', country: 'India', exchange: 'NSE' },
};

/**
 * Yahoo returns a sector/industry pair but no thematic tag, so derive one.
 * Matched against the industry first (more specific), then the sector.
 */
const INDUSTRY_THEMES: Array<[RegExp, string]> = [
  [/semiconductor equipment/i, 'Semicap'],
  [/semiconductor/i, 'AI & Semis'],
  [/software—infrastructure|infrastructure software/i, 'Cloud'],
  [/software—application|application software/i, 'SaaS'],
  [/information technology services|it services/i, 'IT Services'],
  [/internet content|interactive media/i, 'Digital Advertising'],
  [/internet retail/i, 'E-Commerce'],
  [/computer hardware|consumer electronics/i, 'Consumer Tech'],
  [/auto manufacturers/i, 'Electric Vehicles'],
  [/solar|renewable/i, 'Clean Energy'],
  [/oil & gas/i, 'Traditional Energy'],
  [/banks?—|capital markets/i, 'Financials'],
  [/credit services/i, 'Payments'],
  [/insurance/i, 'Insurance'],
  [/biotechnology/i, 'Biotech'],
  [/drug manufacturers|pharmaceutical/i, 'Pharma'],
  [/healthcare plans|medical/i, 'Healthcare'],
  [/aerospace & defense/i, 'Aerospace & Defense'],
  [/entertainment|broadcasting/i, 'Media & Streaming'],
  [/discount stores|grocery/i, 'Staples Retail'],
  [/beverages|household & personal|packaged foods/i, 'Consumer Staples'],
  [/reit|real estate/i, 'Real Estate'],
  [/utilities/i, 'Utilities'],
  [/gold|mining|steel|copper/i, 'Materials'],
];

const SECTOR_THEMES: Record<string, string> = {
  Technology: 'Technology',
  'Communication Services': 'Communications',
  'Consumer Cyclical': 'Consumer Discretionary',
  'Consumer Defensive': 'Consumer Staples',
  'Financial Services': 'Financials',
  Healthcare: 'Healthcare',
  Energy: 'Energy',
  Industrials: 'Industrials',
  'Basic Materials': 'Materials',
  'Real Estate': 'Real Estate',
  Utilities: 'Utilities',
};

export function deriveTheme(sector?: string, industry?: string): string {
  if (industry) {
    for (const [pattern, theme] of INDUSTRY_THEMES) {
      if (pattern.test(industry)) return theme;
    }
  }
  return (sector && SECTOR_THEMES[sector]) || '';
}
