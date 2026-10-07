import { HistoricalPriceService } from './historical-price.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { DailyClose, MarketService } from '../market/market.service';

/**
 * Pins the rules that decide whether a historical holdings statement prints
 * the right close. Each case is a way the previous resolver handed a client a
 * wrong price depending only on when the ticker had last been backfilled.
 */

type Bar = { symbol: string; date: Date; close: number; adjClose: number; source: string };

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** An in-memory PriceBar table answering the three query shapes the service issues. */
function fakePrisma(seed: Bar[]) {
  const bars = [...seed];

  const matches = (b: Bar, where: any) => {
    if (b.symbol !== where.symbol) return false;
    if (where.source?.in && !where.source.in.includes(b.source)) return false;
    if (where.date?.lt && !(b.date < where.date.lt)) return false;
    if (where.date?.gte && !(b.date >= where.date.gte)) return false;
    return true;
  };

  const prisma = {
    priceBar: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const hits = bars.filter((b) => matches(b, where));
        hits.sort((a, b) => a.date.getTime() - b.date.getTime());
        if (orderBy?.date === 'desc') hits.reverse();
        return hits[0] ?? null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.symbol_date;
        const existing = bars.find(
          (b) => b.symbol === key.symbol && b.date.getTime() === key.date.getTime(),
        );
        if (existing) Object.assign(existing, update);
        else bars.push({ ...create });
      }),
    },
  } as unknown as PrismaService;

  return { prisma, bars };
}

function fakeMarket(history: DailyClose[] | Error) {
  return {
    history: jest.fn(async () => {
      if (history instanceof Error) throw history;
      return history;
    }),
    lookup: jest.fn(async () => ({ currentPrice: 999 })),
  } as unknown as MarketService & { history: jest.Mock };
}

const bar = (date: string, close: number, source = 'yahoo-close'): Bar => ({
  symbol: 'ABC.NS',
  date: d(date),
  close,
  adjClose: close,
  source,
});

describe('HistoricalPriceService.resolveClose', () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterAll(() => jest.useRealTimers());

  it('serves an exact-date settled bar without fetching', async () => {
    const { prisma } = fakePrisma([bar('2026-09-30', 100)]);
    const market = fakeMarket([]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-09-30'))).resolves.toEqual({
      price: 100,
      priceDate: '2026-09-30',
      status: 'close',
    });
    expect(market.history).not.toHaveBeenCalled();
  });

  it('does NOT serve a bar from days earlier just because it is "close enough"', async () => {
    // The old five-day tolerance answered the 6th with the 2nd's close: the
    // store had simply not been backfilled past the 2nd.
    const { prisma } = fakePrisma([bar('2026-10-01', 90), bar('2026-10-02', 91)]);
    const market = fakeMarket([
      { date: '2026-10-01', close: 90, rawClose: 90 },
      { date: '2026-10-02', close: 91, rawClose: 91 },
      { date: '2026-10-05', close: 95, rawClose: 95 },
      { date: '2026-10-06', close: 97, rawClose: 97 },
    ]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-10-06'))).resolves.toEqual({
      price: 97,
      priceDate: '2026-10-06',
      status: 'close',
    });
    expect(market.history).toHaveBeenCalledTimes(1);
  });

  it('answers a weekend from the store when the session after it is stored too', async () => {
    const { prisma } = fakePrisma([bar('2026-09-25', 80), bar('2026-09-28', 82)]);
    const market = fakeMarket([]);
    const svc = new HistoricalPriceService(prisma, market);

    // Saturday the 26th: Friday's close, proven by Monday's bar.
    await expect(svc.resolveClose('ABC.NS', d('2026-09-26'))).resolves.toEqual({
      price: 80,
      priceDate: '2026-09-25',
      status: 'close',
    });
    expect(market.history).not.toHaveBeenCalled();
  });

  it('re-fetches when the stored bars either side of the date are too far apart', async () => {
    // A hole in the store, not a market closure.
    const { prisma } = fakePrisma([bar('2026-08-03', 70), bar('2026-09-01', 75)]);
    const market = fakeMarket([
      { date: '2026-08-14', close: 72, rawClose: 72 },
      { date: '2026-08-17', close: 73, rawClose: 73 },
    ]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-08-15'))).resolves.toEqual({
      price: 72,
      priceDate: '2026-08-14',
      status: 'close',
    });
  });

  it('never trusts a legacy "yahoo" bar, and overwrites it with the real close', async () => {
    // Legacy rows can hold an intraday price or a split-adjusted one.
    const { prisma, bars } = fakePrisma([bar('2024-10-01', 1464.82, 'yahoo')]);
    const market = fakeMarket([
      // After RELIANCE's 1:1 bonus, Yahoo reports half the printed price.
      { date: '2024-10-01', close: 1464.82, rawClose: 2929.65 },
      { date: '2024-10-03', close: 1406.97, rawClose: 2813.95 },
    ]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2024-10-01'))).resolves.toEqual({
      price: 2929.65,
      priceDate: '2024-10-01',
      status: 'close',
    });
    const stored = bars.find((b) => b.date.getTime() === d('2024-10-01').getTime())!;
    expect(stored).toMatchObject({ close: 2929.65, adjClose: 1464.82, source: 'yahoo-close' });
  });

  it("never stores today's unfinished session", async () => {
    const { prisma, bars } = fakePrisma([]);
    const market = fakeMarket([
      { date: '2026-10-06', close: 100, rawClose: 100 },
      // Yahoo reports the live price as the in-progress session's close.
      { date: '2026-10-07', close: 104.5, rawClose: 104.5 },
    ]);
    const svc = new HistoricalPriceService(prisma, market);

    await svc.resolveClose('ABC.NS', d('2026-10-06'));
    expect(bars.map((b) => b.date.toISOString().slice(0, 10))).toEqual(['2026-10-06']);
  });

  it("answers yesterday's weekend at the live edge, where no later session exists yet", async () => {
    jest.setSystemTime(new Date('2026-10-05T02:00:00Z')); // Monday, before the open
    const { prisma } = fakePrisma([]);
    const market = fakeMarket([{ date: '2026-10-02', close: 50, rawClose: 50 }]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-10-04'))).resolves.toEqual({
      price: 50,
      priceDate: '2026-10-02',
      status: 'close',
    });
    jest.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  });

  it('flags a price from before a long trading gap as stale', async () => {
    // Suspended for weeks: the last print is the best available, not a close for the date.
    const { prisma } = fakePrisma([]);
    const market = fakeMarket([
      { date: '2026-08-03', close: 40, rawClose: 40 },
      { date: '2026-09-15', close: 30, rawClose: 30 },
    ]);
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-08-31'))).resolves.toEqual({
      price: 40,
      priceDate: '2026-08-03',
      status: 'stale',
    });
  });

  it('falls back to any stored bar, flagged stale, when the source is unreachable', async () => {
    const { prisma } = fakePrisma([bar('2026-09-20', 66, 'yahoo')]);
    const market = fakeMarket(new Error('Yahoo down'));
    const svc = new HistoricalPriceService(prisma, market);

    await expect(svc.resolveClose('ABC.NS', d('2026-09-30'))).resolves.toEqual({
      price: 66,
      priceDate: '2026-09-20',
      status: 'stale',
    });
  });

  it('prices today from the live quote', async () => {
    const { prisma } = fakePrisma([]);
    const svc = new HistoricalPriceService(prisma, fakeMarket([]));

    await expect(svc.resolveClose('ABC.NS', d('2026-10-07'))).resolves.toEqual({
      price: 999,
      priceDate: '2026-10-07',
      status: 'live',
    });
  });
});

describe('MarketService.history split un-adjustment', () => {
  /** NVDA around its 10:1 split on 2024-06-10, exactly as Yahoo's chart API returns it. */
  const nvda = {
    chart: {
      result: [
        {
          meta: { gmtoffset: -14400 },
          timestamp: [1717680600, 1717767000, 1718026200, 1718112600],
          events: {
            splits: { '1718026200': { date: 1718026200, numerator: 10, denominator: 1, splitRatio: '10:1' } },
          },
          indicators: { quote: [{ close: [120.998, 120.888, 121.79, 120.91] }] },
        },
      ],
    },
  };

  it('restores the printed close before the ex-date and leaves the ex-date onward alone', async () => {
    const svc = new MarketService();
    (svc as any).fetchJson = jest.fn().mockResolvedValue(nvda);

    const bars = await svc.history('NVDA', '2024-06-06');

    expect(bars.map((b) => b.date)).toEqual(['2024-06-06', '2024-06-07', '2024-06-10', '2024-06-11']);
    expect(bars[1].close).toBeCloseTo(120.888);
    expect(bars[1].rawClose).toBeCloseTo(1208.88); // what NVDA actually closed at
    expect(bars[2].rawClose).toBeCloseTo(121.79); // ex-date trades post-split
    expect(bars[3].rawClose).toBeCloseTo(120.91);
  });

  it('retries a BSE-only symbol stored with the NSE suffix', async () => {
    const svc = new MarketService();
    const bse = {
      chart: {
        result: [
          {
            meta: { gmtoffset: 19800 },
            timestamp: [1727754300],
            indicators: { quote: [{ close: [12.5] }] },
          },
        ],
      },
    };
    const fetchJson = jest.fn().mockResolvedValueOnce({ chart: { result: null } }).mockResolvedValueOnce(bse);
    (svc as any).fetchJson = fetchJson;

    const bars = await svc.history('SMALLCO.NS', '2024-10-01');

    expect(fetchJson.mock.calls[1][0]).toContain('SMALLCO.BO');
    expect(bars).toEqual([{ date: '2024-10-01', close: 12.5, rawClose: 12.5 }]);
  });
});
