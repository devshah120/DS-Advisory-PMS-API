import { positionWindowReturn as measure, valuationCutoff } from './client-portfolio-watchlist.service';
import { LedgerEntry } from '../analytics/calculators/flows';

type WindowInput = Parameters<typeof measure>[0];

/** A single client's call: one account, one ledger. */
const positionWindowReturn = ({
  rows,
  isHouseBaseline,
  ...rest
}: Omit<WindowInput, 'ledgers'> & { rows: LedgerEntry[]; isHouseBaseline: boolean }) =>
  measure({ ...rest, ledgers: [{ rows, isHouseBaseline }] });

/**
 * The per-position window return behind the client-portfolio watchlist.
 *
 * Each case below is one way a per-symbol return goes wrong while still
 * looking plausible: a top-up read as gain, a mid-window purchase compounded
 * over days it was not held, a trade booked today missing from the flows.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const FROM = day('2026-10-01');
const TO = day('2026-10-08');

const base = {
  from: FROM,
  to: TO,
  openedThrough: day('2026-10-02'), // end of the opening day
  closedThrough: null as Date | null, // live book: every entered row is in the closing value
  isHouseBaseline: false,
};

describe('positionWindowReturn', () => {
  it('reports the plain price move for a position held throughout with no flows', () => {
    const r = positionWindowReturn({ ...base, openingValue: 1000, closingValue: 1100, rows: [] });
    expect(r.returnPct).toBeCloseTo(10, 6);
    expect(r.measuredFrom).toBe('2026-10-01');
  });

  it('does not count a mid-window top-up as return', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 1000,
      closingValue: 2000, // flat prices: the extra 1000 is the purchase
      rows: [{ type: 'BUY', amount: 1000, date: day('2026-10-04') }],
    });
    expect(r.returnPct).toBeCloseTo(0, 6);
    expect(r.netFlows).toBe(1000);
  });

  it('measures a position opened mid-window over the days it was held, not the whole window', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 0,
      closingValue: 1010,
      rows: [{ type: 'BUY', amount: 1000, date: day('2026-10-07') }],
    });
    // 1% in one day. Compounding the rate back to 1-Oct would print ~7%.
    expect(r.returnPct).toBeCloseTo(1, 6);
    expect(r.measuredFrom).toBe('2026-10-07');
  });

  it('counts a trade booked today, which the live closing value already holds', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 1000,
      closingValue: 1500,
      rows: [{ type: 'BUY', amount: 500, date: new Date('2026-10-08T04:30:00.000Z') }],
    });
    expect(r.returnPct).toBeCloseTo(0, 6);
  });

  it('does not count a trade on the opening day twice', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 1500, // the opening-day valuation already includes the 500 buy
      closingValue: 1500,
      rows: [{ type: 'BUY', amount: 500, date: new Date('2026-10-01T05:00:00.000Z') }],
    });
    expect(r.returnPct).toBeCloseTo(0, 6);
    expect(r.netFlows).toBe(0);
  });

  it('nets a partial sale out rather than reporting it as a loss', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 1000,
      closingValue: 500,
      rows: [{ type: 'SELL', amount: 500, date: day('2026-10-05') }],
    });
    expect(r.returnPct).toBeCloseTo(0, 6);
  });

  it('gives the plain gain on cost for a position bought today', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 0,
      closingValue: 1020,
      rows: [{ type: 'BUY', amount: 1000, date: new Date('2026-10-08T05:00:00.000Z') }],
    });
    expect(r.returnPct).toBeCloseTo(2, 6);
  });

  it('reports 0% on a live window that opened today', () => {
    const r = positionWindowReturn({
      ...base,
      from: TO,
      openedThrough: null,
      openingValue: 1000,
      closingValue: 1000,
      rows: [{ type: 'BUY', amount: 1000, date: new Date('2026-10-08T05:00:00.000Z') }],
    });
    expect(r.returnPct).toBeCloseTo(0, 6);
  });

  it('declines to invent a return for a position that arrived without a priced trade', () => {
    const r = positionWindowReturn({
      ...base,
      openingValue: 0,
      closingValue: 1000,
      rows: [{ type: 'TRANSFER', amount: 0, date: day('2026-10-03') }],
    });
    expect(r.returnPct).toBeNull();
    expect(r.reason).toMatch(/no opening value/i);
  });

  it('drops a bulk-import 1-July BUY for a house-baseline client but keeps it for anyone else', () => {
    const window = {
      ...base,
      from: day('2026-06-30'),
      openedThrough: day('2026-07-01'),
      openingValue: 1000,
      closingValue: 1100,
      rows: [{ type: 'BUY', amount: 1000, date: day('2026-07-01') }],
    };
    // The baseline already holds those shares: the row is the opening position.
    expect(positionWindowReturn({ ...window, isHouseBaseline: true }).netFlows).toBe(0);
    // For a client onboarded on their own date it is a real purchase.
    expect(positionWindowReturn({ ...window, isHouseBaseline: false }).netFlows).toBe(1000);
  });
});

describe('positionWindowReturn for a household', () => {
  const window = { from: FROM, to: TO, openedThrough: base.openedThrough, closedThrough: base.closedThrough };

  it('solves one return over every member, not an average of their returns', () => {
    // A holds 1000 → 1100 (+10%); B buys 1000 on the 7th and closes at 1000 (0%).
    // B's 1000 was at work for one day of seven, so the household earned 100
    // on roughly 1000 + 1000/7 of capital: ~8.8%, nowhere near the 5% a plain
    // mean of the two accounts would print.
    const r = measure({
      ...window,
      openingValue: 1000,
      closingValue: 2100,
      ledgers: [
        { rows: [], isHouseBaseline: false },
        { rows: [{ type: 'BUY', amount: 1000, date: day('2026-10-07') }], isHouseBaseline: false },
      ],
    });
    expect(r.netFlows).toBe(1000);
    expect(r.returnPct).toBeGreaterThan(8.5);
    expect(r.returnPct).toBeLessThan(9);
  });

  it('measures from the earliest purchase across accounts, whichever ledger it sits in', () => {
    const r = measure({
      ...window,
      openingValue: 0,
      closingValue: 2000,
      ledgers: [
        { rows: [{ type: 'BUY', amount: 1000, date: day('2026-10-05') }], isHouseBaseline: false },
        { rows: [{ type: 'BUY', amount: 1000, date: day('2026-10-03') }], isHouseBaseline: false },
      ],
    });
    expect(r.measuredFrom).toBe('2026-10-03');
    expect(r.returnPct).toBeCloseTo(0, 6);
  });

  it('decides the 1-July import artifact per member', () => {
    const july = [{ type: 'BUY', amount: 1000, date: day('2026-07-01') }];
    const r = measure({
      ...window,
      from: day('2026-06-30'),
      openedThrough: day('2026-07-01'),
      openingValue: 1000,
      closingValue: 2200,
      ledgers: [
        { rows: july, isHouseBaseline: true }, // already in the opening value
        { rows: july, isHouseBaseline: false }, // a real purchase
      ],
    });
    expect(r.netFlows).toBe(1000);
  });
});

describe('valuationCutoff', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');

  it('includes every entered row in the live book', () => {
    expect(valuationCutoff(day('2026-10-08'), now)).toBeNull();
  });

  it('closes a historical date at the end of that day', () => {
    expect(valuationCutoff(day('2026-10-01'), now)).toEqual(day('2026-10-02'));
  });
});
