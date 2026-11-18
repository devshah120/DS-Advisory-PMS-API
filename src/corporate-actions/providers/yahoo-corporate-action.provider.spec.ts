import { actionsFromChart, ChartEvents } from './yahoo-corporate-action.provider';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** AAPL in 2020: two dividends either side of the 4-for-1 split, as Yahoo returns them. */
const AAPL_2020: ChartEvents = {
  gmtOffset: -14400,
  currency: 'USD',
  dividends: [
    // Yahoo restates the pre-split payment: 0.77 was paid, 0.1925 is listed.
    { date: at('2020-02-07T14:30:00Z'), amount: 0.1925 },
    { date: at('2020-11-06T14:30:00Z'), amount: 0.205 },
  ],
  splits: [{ date: at('2020-08-31T13:30:00Z'), numerator: 4, denominator: 1 }],
};

describe('actionsFromChart', () => {
  const year = { from: day('2020-01-01'), to: day('2020-12-31') };

  it('restores a dividend Yahoo restated for a later split to the amount actually paid', () => {
    const dividends = actionsFromChart('AAPL', AAPL_2020, year).filter((a) => a.actionType === 'DIVIDEND');

    expect(dividends.map((d) => [d.exDate, d.cashAmount])).toEqual([
      [day('2020-02-07'), 0.77],
      [day('2020-11-06'), 0.205],
    ]);
    // The restatement is kept for the reviewer; an untouched amount carries nothing.
    expect(dividends[0].details).toEqual({ yahooSplitAdjustedAmount: 0.1925 });
    expect(dividends[1].details).toBeNull();
  });

  it('still uses a split outside the window to restore a dividend inside it', () => {
    const firstHalf = { from: day('2020-01-01'), to: day('2020-06-30') };
    const actions = actionsFromChart('AAPL', AAPL_2020, firstHalf);

    expect(actions.map((a) => [a.actionType, a.cashAmount])).toEqual([['DIVIDEND', 0.77]]);
  });

  it('stores a split in the engine convention: a 4-for-1 is old 1, new 4', () => {
    const [split] = actionsFromChart('AAPL', AAPL_2020, year).filter((a) => a.actionType !== 'DIVIDEND');

    expect(split).toMatchObject({
      actionType: 'STOCK_SPLIT',
      oldRatio: 1,
      newRatio: 4,
      exDate: day('2020-08-31'),
      effectiveDate: day('2020-08-31'),
    });
  });

  it('reads a 1-for-10 as a reverse split', () => {
    const chart: ChartEvents = {
      gmtOffset: -14400,
      currency: 'USD',
      dividends: [],
      splits: [{ date: at('2026-08-03T13:30:00Z'), numerator: 1, denominator: 10 }],
    };
    const [split] = actionsFromChart('XYZ', chart, { from: day('2026-07-01'), to: day('2026-11-18') });

    expect(split).toMatchObject({ actionType: 'REVERSE_SPLIT', oldRatio: 10, newRatio: 1 });
  });

  it('dates an event in the exchange’s calendar, not UTC', () => {
    // 18:30Z on 13-Aug is midnight IST on 14-Aug.
    const chart: ChartEvents = {
      gmtOffset: 19800,
      currency: 'INR',
      dividends: [{ date: at('2026-08-13T18:30:00Z'), amount: 5.5 }],
      splits: [],
    };
    const [dividend] = actionsFromChart('ITC.NS', chart, { from: day('2026-07-01'), to: day('2026-11-18') });

    expect(dividend.exDate).toEqual(day('2026-08-14'));
    expect(dividend.market).toBe('INDIA');
    expect(dividend.currency).toBe('INR');
  });

  it('dates the cash on the ex-date and uses it as the record date, with no pay date', () => {
    const chart: ChartEvents = {
      gmtOffset: -14400,
      currency: 'USD',
      dividends: [{ date: at('2026-08-03T13:30:00Z'), amount: 1.07 }],
      splits: [],
    };
    const [dividend] = actionsFromChart('OKE', chart, { from: day('2026-07-01'), to: day('2026-11-18') });

    expect(dividend).toMatchObject({
      symbol: 'OKE',
      actionType: 'DIVIDEND',
      exDate: day('2026-08-03'),
      recordDate: day('2026-08-03'),
      effectiveDate: day('2026-08-03'),
      paymentDate: null,
      cashAmount: 1.07,
      source: 'yahoo',
      tier: 'SECONDARY_API',
    });
  });
});
