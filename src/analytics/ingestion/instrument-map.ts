import { AssetClass, LookThroughMap } from '../calculators/types';

/**
 * Classification for every instrument in the book, including the ETF
 * look-through maps.
 *
 * The look-throughs are hand-mapped, and that is a deliberate choice rather than
 * a shortcut. Every ETF held here is a single-country or single-theme fund, so
 * its exposure is 100% to one bucket and a hand-map is *exactly* correct — no
 * paid constituent feed required, no external dependency, no drift. Broad
 * multi-region ETFs would need issuer factsheet weights (quarterly refresh);
 * none are held today.
 *
 * `country` is the fund's DOMICILE (what Yahoo returns). `lookThrough.region` is
 * its actual EXPOSURE. For MCHI those are "United States" and "China"
 * respectively, and conflating them is the bug this map exists to prevent.
 */

export interface InstrumentSeed {
  symbol: string;
  company: string;
  assetClass: AssetClass;
  sector: string;
  industry: string;
  country: string;
  region: string;
  exchange: string;
  lookThrough?: LookThroughMap;
}

const stock = (
  symbol: string,
  company: string,
  sector: string,
  industry: string,
  exchange = 'NYSE',
): InstrumentSeed => ({
  symbol,
  company,
  assetClass: 'EQUITY',
  sector,
  industry,
  country: 'United States',
  region: 'USA',
  exchange,
});

/** A single-country or single-theme ETF: 100% of its exposure is one bucket. */
const etf = (
  symbol: string,
  company: string,
  exposureRegion: string,
  exposureSector: string,
  exposureCountry: string,
): InstrumentSeed => ({
  symbol,
  company,
  assetClass: 'ETF',
  // What the fund IS classified as by the data provider...
  sector: exposureSector,
  industry: 'Exchange Traded Fund',
  country: 'United States', // domicile: every one of these is US-listed
  region: 'USA',
  exchange: 'NYSE Arca',
  // ...versus what it actually EXPOSES you to. This is the correction.
  lookThrough: {
    region: [{ key: exposureRegion, weight: 1 }],
    country: [{ key: exposureCountry, weight: 1 }],
    sector: [{ key: exposureSector, weight: 1 }],
  },
});

export const INSTRUMENT_SEEDS: InstrumentSeed[] = [
  // ── Equities ──────────────────────────────────────────────────────────────
  stock('CAT',  'Caterpillar Inc',                      'Industrials',        'Farm & Heavy Construction Machinery'),
  stock('AEP',  'American Electric Power Company Inc',  'Utilities',          'Utilities - Regulated Electric', 'NASDAQ'),
  stock('IR',   'Ingersoll Rand Inc',                   'Industrials',        'Specialty Industrial Machinery'),
  stock('JPM',  'JPMorgan Chase & Co',                  'Financial Services', 'Banks - Diversified'),
  stock('NSC',  'Norfolk Southern Corporation',         'Industrials',        'Railroads'),
  stock('VIRT', 'Virtu Financial Inc',                  'Financial Services', 'Capital Markets', 'NASDAQ'),
  stock('ANET', 'Arista Networks Inc',                  'Technology',         'Computer Hardware'),
  stock('HWM',  'Howmet Aerospace Inc',                 'Industrials',        'Aerospace & Defense'),
  stock('STT',  'State Street Corporation',             'Financial Services', 'Asset Management'),
  stock('NUE',  'Nucor Corporation',                    'Basic Materials',    'Steel'),
  stock('BKR',  'Baker Hughes Company',                 'Energy',             'Oil & Gas Equipment & Services', 'NASDAQ'),
  stock('GM',   'General Motors Company',               'Consumer Cyclical',  'Auto Manufacturers'),
  stock('COST', 'Costco Wholesale Corporation',         'Consumer Defensive', 'Discount Stores', 'NASDAQ'),
  stock('OKE',  'ONEOK Inc',                            'Energy',             'Oil & Gas Midstream'),

  // ── ETFs — where look-through matters ─────────────────────────────────────
  // Without these maps, every one of these reports as USA exposure.
  etf('EWQ',  'iShares MSCI France ETF',        'Europe', 'Diversified',     'France'),
  etf('MCHI', 'iShares MSCI China ETF',         'China',  'Diversified',     'China'),
  etf('URNM', 'Sprott Uranium Miners ETF',      'Global', 'Energy',          'Global'),
  etf('ICLN', 'iShares Global Clean Energy ETF','Global', 'Utilities',       'Global'),
  etf('CPER', 'United States Copper Index Fund','Global', 'Basic Materials', 'Global'),
];

/** Benchmarks. These are stored as ordinary PriceBar symbols. */
export const BENCHMARK_SEEDS = [
  { code: 'SP500',   name: 'S&P 500',              symbol: '^GSPC', isDefault: true },
  { code: 'NASDAQ',  name: 'Nasdaq Composite',     symbol: '^IXIC', isDefault: false },
  { code: 'RUSSELL2000', name: 'Russell 2000',     symbol: '^RUT',  isDefault: false },
  { code: 'DOWJONES', name: 'Dow Jones Industrial Average', symbol: '^DJI', isDefault: false },
];
