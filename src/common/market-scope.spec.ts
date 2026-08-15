import {
  MARKETS,
  currencyForMarket,
  displaySymbol,
  marketForSymbol,
  normalizeSymbol,
  parseMarket,
} from './market-scope';

describe('parseMarket', () => {
  it('accepts the known codes in any casing', () => {
    expect(parseMarket('US')).toBe('US');
    expect(parseMarket('INDIA')).toBe('INDIA');
    expect(parseMarket('india')).toBe('INDIA');
    expect(parseMarket(' India ')).toBe('INDIA');
  });

  // A stray query param must not blank the dashboard — see the note on the
  // function. This is the behaviour that keeps a UI bug from becoming a 400.
  it('falls back to the US book rather than throwing', () => {
    expect(parseMarket('UK')).toBe('US');
    expect(parseMarket('')).toBe('US');
    expect(parseMarket(undefined)).toBe('US');
    expect(parseMarket(null)).toBe('US');
    expect(parseMarket(42)).toBe('US');
  });
});

describe('marketForSymbol', () => {
  it('reads the Indian book off the exchange suffix', () => {
    expect(marketForSymbol('RELIANCE.NS')).toBe('INDIA');
    expect(marketForSymbol('INFY.BO')).toBe('INDIA');
    expect(marketForSymbol('reliance.ns')).toBe('INDIA');
  });

  it('treats unsuffixed symbols as US', () => {
    expect(marketForSymbol('AAPL')).toBe('US');
    expect(marketForSymbol('BRK.B')).toBe('US');
    expect(marketForSymbol('^GSPC')).toBe('US');
  });

  // Indian indices carry no suffix, so the suffix rule alone would misfile them.
  it('recognises Indian indices despite having no suffix', () => {
    expect(marketForSymbol('^NSEI')).toBe('INDIA');
    expect(marketForSymbol('^BSESN')).toBe('INDIA');
  });
});

describe('normalizeSymbol', () => {
  it('qualifies a bare Indian ticker to the NSE', () => {
    expect(normalizeSymbol('RELIANCE', 'INDIA')).toBe('RELIANCE.NS');
    expect(normalizeSymbol('tcs', 'INDIA')).toBe('TCS.NS');
  });

  it('leaves an explicitly-suffixed symbol alone', () => {
    // A BSE-only listing must survive: appending .NS would break it.
    expect(normalizeSymbol('INFY.BO', 'INDIA')).toBe('INFY.BO');
    expect(normalizeSymbol('RELIANCE.NS', 'INDIA')).toBe('RELIANCE.NS');
  });

  it('never suffixes indices or futures', () => {
    expect(normalizeSymbol('^NSEI', 'INDIA')).toBe('^NSEI');
    expect(normalizeSymbol('GC=F', 'INDIA')).toBe('GC=F');
  });

  it('is a no-op for the US book', () => {
    expect(normalizeSymbol('AAPL', 'US')).toBe('AAPL');
    expect(normalizeSymbol('^GSPC', 'US')).toBe('^GSPC');
  });

  it('handles empty input without producing a bare suffix', () => {
    expect(normalizeSymbol('', 'INDIA')).toBe('');
    expect(normalizeSymbol('   ', 'INDIA')).toBe('');
  });
});

describe('displaySymbol', () => {
  it('strips the exchange suffix', () => {
    expect(displaySymbol('RELIANCE.NS')).toBe('RELIANCE');
    expect(displaySymbol('INFY.BO')).toBe('INFY');
  });

  it('leaves US symbols and indices untouched', () => {
    expect(displaySymbol('AAPL')).toBe('AAPL');
    expect(displaySymbol('^NSEI')).toBe('^NSEI');
  });

  it('round-trips with normalizeSymbol', () => {
    expect(displaySymbol(normalizeSymbol('RELIANCE', 'INDIA'))).toBe('RELIANCE');
  });
});

describe('market definitions', () => {
  it('denominates each book in its own currency', () => {
    expect(currencyForMarket('US')).toBe('USD');
    expect(currencyForMarket('INDIA')).toBe('INR');
  });

  // Each book's default benchmark has to be one of its own indices, or a client
  // created in that book gets benchmarked against the other market.
  it('defaults each book to one of its own indices', () => {
    for (const def of Object.values(MARKETS)) {
      expect(def.indices.map((i) => i.symbol)).toContain(def.defaultBenchmark.symbol);
    }
  });

  it('classifies every index under the market that declares it', () => {
    for (const def of Object.values(MARKETS)) {
      for (const index of def.indices) {
        expect(marketForSymbol(index.symbol)).toBe(def.code);
      }
    }
  });
});
