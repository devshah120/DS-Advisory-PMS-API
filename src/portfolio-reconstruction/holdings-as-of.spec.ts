import { BadRequestException } from '@nestjs/common';
import { buildHoldingsAsOf, HoldingsAsOfMember, parseAsOfDate } from './holdings-as-of';
import { ReconstructedPortfolio, ReconstructedPosition } from './types';

const pos = (p: Partial<ReconstructedPosition> & { ticker: string; quantity: number }): ReconstructedPosition => {
  const averageCost = p.averageCost ?? 100;
  const closingPrice = p.closingPrice ?? 120;
  return {
    averageCost,
    closingPrice,
    priceDate: '2026-06-30',
    priceStatus: 'close',
    marketValue: p.quantity * closingPrice,
    costBasisTotal: p.quantity * averageCost,
    unrealizedGain: p.quantity * (closingPrice - averageCost),
    sector: 'Energy',
    industry: 'Oil & Gas',
    country: 'India',
    assetClass: 'EQUITY',
    weight: 0,
    ...p,
  };
};

const member = (
  clientId: string,
  positions: ReconstructedPosition[],
  cash: number,
  cashShortfall = 0,
): HoldingsAsOfMember => {
  const holdingsValue = positions.reduce((s, p) => s + p.marketValue, 0);
  return {
    clientId,
    clientName: clientId.toUpperCase(),
    companies: new Map([['RELIANCE.NS', 'Reliance Industries']]),
    portfolio: {
      positions,
      cash,
      cashShortfall,
      holdingsValue,
      portfolioValue: holdingsValue + cash,
    } as unknown as ReconstructedPortfolio,
  };
};

describe('buildHoldingsAsOf', () => {
  const asOf = new Date('2026-06-30T00:00:00Z');

  it('weights against the portfolio INCLUDING cash, so positions and cash sum to 100%', () => {
    const out = buildHoldingsAsOf(asOf, 'INR', [
      member('a', [pos({ ticker: 'RELIANCE.NS', quantity: 50 })], 4000), // 6,000 invested
    ]);

    expect(out.totals.portfolioValue).toBe(10_000);
    expect(out.positions[0].weight).toBeCloseTo(60);
    expect(out.positions[0].weight + (out.totals.cash / out.totals.portfolioValue) * 100).toBeCloseTo(100);
  });

  it('blends a merged name by size, not by averaging the accounts', () => {
    const out = buildHoldingsAsOf(asOf, 'INR', [
      member('a', [pos({ ticker: 'RELIANCE.NS', quantity: 5, averageCost: 1000 })], 0),
      member('b', [pos({ ticker: 'RELIANCE.NS', quantity: 495, averageCost: 2000 })], 0),
    ]);

    const [p] = out.positions;
    expect(p.quantity).toBe(500);
    expect(p.averageCost).toBeCloseTo((5 * 1000 + 495 * 2000) / 500); // 1,990 — not 1,500
    expect(p.accounts).toBe(2);
    expect(p.company).toBe('Reliance Industries');
    expect(p.displayTicker).toBe('RELIANCE');
  });

  it('counts each account\'s cash once and carries shortfalls through', () => {
    const out = buildHoldingsAsOf(asOf, 'INR', [
      member('a', [pos({ ticker: 'X.NS', quantity: 1 })], 500),
      member('b', [pos({ ticker: 'Y.NS', quantity: 1 }), pos({ ticker: 'Z.NS', quantity: 1 })], 0, 250),
    ]);
    expect(out.totals.cash).toBe(500);
    expect(out.totals.cashShortfall).toBe(250);
  });

  it('lists every price that is not a verified close, keeping the worst status for a merged name', () => {
    const out = buildHoldingsAsOf(asOf, 'INR', [
      member('a', [pos({ ticker: 'X.NS', quantity: 1 }), pos({ ticker: 'Y.NS', quantity: 1, priceStatus: 'stale', priceDate: '2026-06-02' })], 0),
      member('b', [pos({ ticker: 'X.NS', quantity: 1, priceStatus: 'missing', priceDate: null })], 0),
    ]);

    expect(out.priceExceptions).toEqual(
      expect.arrayContaining([
        { ticker: 'X.NS', displayTicker: 'X', priceDate: null, priceStatus: 'missing' },
        { ticker: 'Y.NS', displayTicker: 'Y', priceDate: '2026-06-02', priceStatus: 'stale' },
      ]),
    );
    expect(out.priceExceptions).toHaveLength(2);
  });

  it('drops float dust left by a full exit', () => {
    const out = buildHoldingsAsOf(asOf, 'INR', [member('a', [pos({ ticker: 'X.NS', quantity: 7e-15 })], 0)]);
    expect(out.positions).toHaveLength(0);
  });
});

describe('parseAsOfDate', () => {
  it('reads YYYY-MM-DD as midnight UTC of that day', () => {
    expect(parseAsOfDate('2026-06-30').toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it.each(['30-06-2026', '2026-6-30', '2026-02-30', 'yesterday'])('rejects %s', (v) => {
    expect(() => parseAsOfDate(v)).toThrow(BadRequestException);
  });

  it('rejects a date with no close yet', () => {
    expect(() => parseAsOfDate('2999-01-01')).toThrow(BadRequestException);
  });
});
