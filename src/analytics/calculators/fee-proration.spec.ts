import { computeProratedFee, FeeLedgerEntry } from './fee-proration';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Q3-CY26: 1 Jul - 30 Sep 2026, 92 days. The quarter the feature shipped in. */
const Q3 = {
  quarterStart: d('2026-07-01'),
  quarterEnd: d('2026-09-30'),
  billingEnd: d('2026-09-30'),
};

/** A mandate that predates the quarter, so inception prorates nothing. */
const ESTABLISHED = d('2024-01-01');

const base = {
  ...Q3,
  feeRatePercent: 2,
  inceptionDate: ESTABLISHED,
  ledger: [] as FeeLedgerEntry[],
};

const buy = (amount: number, iso: string): FeeLedgerEntry => ({
  type: 'BUY',
  amount,
  date: d(iso),
});

const sell = (amount: number, iso: string): FeeLedgerEntry => ({
  type: 'SELL',
  amount,
  date: d(iso),
});

describe('computeProratedFee', () => {
  it('bills an untraded book the full quarterly rate', () => {
    const r = computeProratedFee({ ...base, openingValue: 10_000_000 });

    // 1Cr x 2%/4 = 50,000.
    expect(r.feeAmount).toBeCloseTo(50_000, 2);
    expect(r.daysBilled).toBe(92);
    expect(r.daysInQuarter).toBe(92);
  });

  /**
   * THE CASE THIS FEATURE EXISTS FOR.
   *
   * 50L deployed on 11-Sep is at work for 20 days of a 92-day quarter, not 92.
   * The old basis billed quarter-end NAV (1.5Cr) x 0.5% = 75,000 flat.
   */
  it('bills mid-quarter capital only for the days it was deployed', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [buy(5_000_000, '2026-09-11')],
    });

    const opening = 50_000; // 1Cr, full quarter
    const deployed = 5_000_000 * 0.005 * (20 / 92); // 11-Sep..30-Sep inclusive

    expect(deployed).toBeCloseTo(5_434.78, 2);
    expect(r.feeAmount).toBeCloseTo(opening + deployed, 2);

    // Emphatically NOT the old flat charge on closing NAV.
    expect(r.feeAmount).toBeLessThan(75_000);
  });

  it('counts the deployment date itself as a billed day', () => {
    const lastDay = computeProratedFee({
      ...base,
      openingValue: 0,
      ledger: [buy(1_000_000, '2026-09-30')],
    });

    // One day, not zero: capital deployed on the 30th worked on the 30th.
    expect(lastDay.segments[0].days).toBe(1);
    expect(lastDay.feeAmount).toBeCloseTo(1_000_000 * 0.005 * (1 / 92), 2);
  });

  it('reduces the base for the remainder when capital is withdrawn', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [sell(4_000_000, '2026-08-01')],
    });

    // 1-Aug..30-Sep is 61 days the 40L was no longer at work.
    const credit = -4_000_000 * 0.005 * (61 / 92);
    expect(r.feeAmount).toBeCloseTo(50_000 + credit, 2);
    expect(r.feeAmount).toBeLessThan(50_000);
  });

  it('treats a same-day rebalance as billing-neutral', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [sell(2_000_000, '2026-08-15'), buy(2_000_000, '2026-08-15')],
    });

    // Rotating one position into another is not new capital.
    expect(r.feeAmount).toBeCloseTo(50_000, 2);
    expect(r.segments.filter((s) => s.kind === 'flow')).toHaveLength(0);
  });

  /**
   * The 1-July bulk import wrote the whole legacy book as BUYs stamped
   * 2026-07-01 - inside Q3-CY26. Billing them as flows would charge the entire
   * opening book twice.
   */
  it('ignores the 1-July bulk-import artifacts', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [buy(10_000_000, '2026-07-01')],
    });

    expect(r.feeAmount).toBeCloseTo(50_000, 2);
    expect(r.segments).toHaveLength(1);
  });

  it('still prorates a mandate that began mid-quarter', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      inceptionDate: d('2026-08-16'),
    });

    // 16-Aug..30-Sep = 46 days.
    expect(r.daysBilled).toBe(46);
    expect(r.feeAmount).toBeCloseTo(10_000_000 * 0.005 * (46 / 92), 2);
  });

  it('applies both prorations when a new mandate deploys again later', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      inceptionDate: d('2026-08-16'),
      ledger: [buy(5_000_000, '2026-09-11')],
    });

    const opening = 10_000_000 * 0.005 * (46 / 92);
    const deployed = 5_000_000 * 0.005 * (20 / 92);
    expect(r.feeAmount).toBeCloseTo(opening + deployed, 2);
  });

  it('drops trades made before the mandate began', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 0,
      inceptionDate: d('2026-09-01'),
      ledger: [buy(5_000_000, '2026-08-01')],
    });

    expect(r.feeAmount).toBe(0);
  });

  it('bills an open quarter only to today, not to quarter end', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      billingEnd: d('2026-09-11'),
      ledger: [buy(5_000_000, '2026-09-11')],
    });

    // 1-Jul..11-Sep = 73 days elapsed; the buy has worked for exactly 1.
    expect(r.daysBilled).toBe(73);
    const opening = 10_000_000 * 0.005 * (73 / 92);
    const deployed = 5_000_000 * 0.005 * (1 / 92);
    expect(r.feeAmount).toBeCloseTo(opening + deployed, 2);
  });

  it('never invoices a negative fee', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 1_000_000,
      ledger: [sell(50_000_000, '2026-07-02')],
    });

    expect(r.feeAmount).toBe(0);
  });

  it('ignores dividends and fee rows, which are not deployment decisions', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [
        { type: 'DIVIDEND', amount: 200_000, date: d('2026-08-01') },
        { type: 'FEES', amount: 50_000, date: d('2026-08-01') },
        { type: 'SPLIT', amount: 0, date: d('2026-08-01') },
      ],
    });

    expect(r.feeAmount).toBeCloseTo(50_000, 2);
  });

  it('reports segments that reconcile to the billed total', () => {
    const r = computeProratedFee({
      ...base,
      openingValue: 10_000_000,
      ledger: [buy(5_000_000, '2026-09-11'), sell(1_000_000, '2026-08-01')],
    });

    const summed = r.segments.reduce((s, seg) => s + seg.fee, 0);
    expect(summed).toBeCloseTo(r.feeAmount, 6);

    // Segments read chronologically: opening, then flows in date order.
    expect(r.segments.map((s) => s.from)).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-11',
    ]);

    // billableValue is the capital actually charged against.
    expect(r.billableValue).toBeCloseTo(14_000_000, 2);
  });
});
