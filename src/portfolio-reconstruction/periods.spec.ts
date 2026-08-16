import { BadRequestException } from '@nestjs/common';
import { availablePeriods, resolvePeriod } from './periods';

/**
 * Two invariants are defended here.
 *
 * The first is unchanged: a reported window can never open before 30-June-2026,
 * because that is the earliest portfolio value the house can price. A window
 * that opened earlier would divide by an opening value we cannot substantiate.
 *
 * The second is new: the Indian book reports on the April–March financial year,
 * so "Q2" and "FYTD" mean different windows on the two books. Every test below
 * that names a quarter states which market it is on, because a test that did not
 * would pass under either calendar and defend neither.
 */
const INCEPTION = '2026-06-30';
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Mid-August 2026 — Q2 FY27 on the Indian calendar, Q3 CY26 on the US one. */
const AUG_2026 = new Date('2026-08-16T00:00:00.000Z');

describe('resolvePeriod — Indian financial year', () => {
  it('reads today as Q2 FY27 and opens QTD on 1-July', () => {
    const r = resolvePeriod('QTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(r.label).toBe('Q2 FY27 to date');
    // Anchored back onto inception: 1-July has no valuation of its own.
    expect(iso(r.from)).toBe(INCEPTION);
  });

  it('opens FYTD on the 31-March close', () => {
    const r = resolvePeriod('FYTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(r.label).toBe('FY27 to date');
    expect(iso(r.nominalFrom!)).toBe('2026-04-01');
  });

  it('opens CYTD on the 31-December close, not on 1-April', () => {
    const r = resolvePeriod('CYTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(iso(r.nominalFrom!)).toBe('2026-01-01');
  });

  /**
   * The clamp is allowed to shorten a window; it is NOT allowed to do so
   * silently. `daysClamped` is what the sheet prints to say the FYTD figure
   * measures 47 days rather than a full year to date.
   */
  it('reports how many days the inception clamp cost', () => {
    const fytd = resolvePeriod('FYTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(fytd.clampedToInception).toBe(true);
    expect(fytd.daysClamped).toBe(90); // 1-Apr → 30-Jun
    expect(iso(fytd.from)).toBe(INCEPTION);

    const cytd = resolvePeriod('CYTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(cytd.daysClamped).toBe(180); // 1-Jan → 30-Jun
  });

  /**
   * The one-day anchor (Q1's nominal 1-July start becoming the 30-June close)
   * is the same valuation under two names, not a lost day — reporting it as a
   * shortfall would be a lie in the other direction.
   */
  it('does not count the one-day inception anchor as lost days', () => {
    const r = resolvePeriod('QTD', { asOf: AUG_2026, market: 'INDIA' });
    expect(r.clampedToInception).toBe(true);
    expect(r.daysClamped).toBe(0);
    expect(r.nominalFrom).toBeUndefined();
  });

  it('resolves a named fiscal quarter on April–March boundaries', () => {
    const asOf = new Date('2027-05-10T00:00:00.000Z');
    const q3 = resolvePeriod('Q3-FY27', { asOf, market: 'INDIA' });

    expect(iso(q3.from)).toBe('2026-10-01');
    expect(iso(q3.to)).toBe('2026-12-31');
    expect(q3.label).toBe('Q3 FY27');
    expect(q3.openPeriod).toBe(false);
  });

  it('resolves a whole fiscal year as April → March', () => {
    const asOf = new Date('2028-02-01T00:00:00.000Z');
    const fy27 = resolvePeriod('FY27', { asOf, market: 'INDIA' });

    expect(iso(fy27.nominalFrom!)).toBe('2026-04-01');
    expect(iso(fy27.to)).toBe('2027-03-31');
    expect(fy27.label).toBe('FY27');
  });

  it('clamps an open quarter back to today and flags it', () => {
    const q2 = resolvePeriod('Q2-FY27', { asOf: AUG_2026, market: 'INDIA' });
    expect(iso(q2.to)).toBe('2026-08-16'); // nominally 30-Sept
    expect(q2.openPeriod).toBe(true);
  });
});

describe('resolvePeriod — US calendar year is unchanged', () => {
  it('still reads today as Q3 CY26', () => {
    const r = resolvePeriod('QTD', { asOf: AUG_2026, market: 'US' });
    expect(r.label).toBe('Q3 CY26 to date');
  });

  it('treats FYTD and CYTD as the same window', () => {
    const fytd = resolvePeriod('FYTD', { asOf: AUG_2026, market: 'US' });
    const cytd = resolvePeriod('CYTD', { asOf: AUG_2026, market: 'US' });
    expect(iso(fytd.nominalFrom!)).toBe(iso(cytd.nominalFrom!));
  });

  it('keeps resolving legacy calendar-quarter codes', () => {
    const asOf = new Date('2027-02-10T00:00:00.000Z');
    const q4 = resolvePeriod('Q4-CY26', { asOf, market: 'US' });

    expect(iso(q4.from)).toBe('2026-10-01');
    expect(iso(q4.to)).toBe('2026-12-31');
  });

  /**
   * A code carries its own calendar, so an FY code asked for on the US book
   * resolves on the Indian calendar rather than being silently reinterpreted
   * as CY — answering the question that was actually asked.
   */
  it('honours an explicit FY code regardless of the caller market', () => {
    const asOf = new Date('2027-05-10T00:00:00.000Z');
    const r = resolvePeriod('Q3-FY27', { asOf, market: 'US' });
    expect(iso(r.from)).toBe('2026-10-01');
  });
});

describe('resolvePeriod — inception guard', () => {
  it('opens INCEPTION on 30-June-2026 and runs to today', () => {
    const r = resolvePeriod('INCEPTION', { asOf: AUG_2026, market: 'INDIA' });
    expect(iso(r.from)).toBe(INCEPTION);
    expect(iso(r.to)).toBe('2026-08-16');
  });

  it('pulls a custom range that starts before inception forward to it', () => {
    const r = resolvePeriod('CUSTOM', {
      asOf: AUG_2026,
      market: 'INDIA',
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(iso(r.from)).toBe(INCEPTION);
    expect(r.daysClamped).toBeGreaterThan(0);
  });

  it('leaves a custom range that starts after inception alone', () => {
    const r = resolvePeriod('CUSTOM', {
      asOf: AUG_2026,
      market: 'INDIA',
      from: new Date('2026-07-15T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(iso(r.from)).toBe('2026-07-15');
    expect(r.clampedToInception).toBe(false);
    expect(r.daysClamped).toBe(0);
  });

  /**
   * Inception (30-June) is the LAST day of Q1 FY27, so that quarter clamps to a
   * window that opens and closes on the same date — a guaranteed 0.00% that
   * would read as a real quarterly result.
   */
  it('rejects the quarter that inception closes', () => {
    expect(() =>
      resolvePeriod('Q1-FY27', { asOf: AUG_2026, market: 'INDIA' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a quarter that closed entirely before inception', () => {
    expect(() =>
      resolvePeriod('Q4-FY26', { asOf: AUG_2026, market: 'INDIA' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a quarter that has not started yet', () => {
    expect(() =>
      resolvePeriod('Q3-FY27', { asOf: AUG_2026, market: 'INDIA' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a custom range with no start date', () => {
    expect(() => resolvePeriod('CUSTOM', { asOf: AUG_2026 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unrecognised code rather than defaulting it', () => {
    expect(() => resolvePeriod('LAST_YEAR', { asOf: AUG_2026 })).toThrow(
      BadRequestException,
    );
  });
});

describe('availablePeriods', () => {
  it('leads with the named current quarter on the Indian book', () => {
    const opts = availablePeriods(AUG_2026, 'INDIA');
    expect(opts[0].code).toBe('QTD');
    expect(opts[0].label).toBe('Q2 FY27 to date');
  });

  it('offers the four windows the desk asked for, plus custom', () => {
    const codes = availablePeriods(AUG_2026, 'INDIA').map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining(['QTD', 'FYTD', 'CYTD', 'MTD', 'INCEPTION', 'CUSTOM']),
    );
  });

  it('omits closed quarters until one has actually closed', () => {
    // Mid-August 2026: the only prior quarter is the one inception closes.
    const codes = availablePeriods(AUG_2026, 'INDIA').map((p) => p.code);
    expect(codes).not.toContain('Q1-FY27');
  });

  it('lists closed fiscal quarters newest-first once they exist', () => {
    const asOf = new Date('2027-05-10T00:00:00.000Z');
    const codes = availablePeriods(asOf, 'INDIA').map((p) => p.code);
    const quarters = codes.filter((c) => /^Q\d-FY\d\d$/.test(c));

    expect(quarters).toEqual(['Q4-FY27', 'Q3-FY27', 'Q2-FY27']);
  });

  it('offers a whole fiscal year only once it has closed', () => {
    expect(availablePeriods(AUG_2026, 'INDIA').map((p) => p.code)).not.toContain('FY27');
    expect(
      availablePeriods(new Date('2027-05-10T00:00:00.000Z'), 'INDIA').map((p) => p.code),
    ).toContain('FY27');
  });

  /**
   * The list and the resolver must never disagree: an option the dropdown
   * renders but the backend rejects is a dead entry the user can select.
   */
  it('only offers periods that resolve, on both books', () => {
    for (const market of ['INDIA', 'US'] as const) {
      for (const asOf of [AUG_2026, new Date('2028-02-01T00:00:00.000Z')]) {
        for (const { code } of availablePeriods(asOf, market)) {
          if (code === 'CUSTOM') continue;
          expect(() => resolvePeriod(code, { asOf, market })).not.toThrow();
        }
      }
    }
  });
});
