import { BadRequestException } from '@nestjs/common';
import { availablePeriods, resolvePeriod } from './periods';

/**
 * The invariant every one of these tests defends: a reported window can never
 * open before 30-June-2026, because that is the earliest portfolio value the
 * house can price. A window that opened earlier would divide by an opening
 * value we cannot substantiate.
 */
const INCEPTION = '2026-06-30';
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Mid-Q3 CY26 — the quarter immediately after inception, still open.
const IN_Q3 = new Date('2026-08-05T00:00:00.000Z');

describe('resolvePeriod', () => {
  it('opens INCEPTION on 30-June-2026 and runs to today', () => {
    const r = resolvePeriod('INCEPTION', { asOf: IN_Q3 });
    expect(iso(r.from)).toBe(INCEPTION);
    expect(iso(r.to)).toBe('2026-08-05');
  });

  /**
   * The identity the desk asked for: while we are still in the quarter that
   * opens the day after inception, QTD measures the same window as inception,
   * so the two must report the same number rather than differing by a day.
   */
  it('anchors QTD on inception while still in the first quarter after it', () => {
    const inception = resolvePeriod('INCEPTION', { asOf: IN_Q3 });
    const qtd = resolvePeriod('QTD', { asOf: IN_Q3 });

    expect(iso(qtd.from)).toBe(INCEPTION);
    expect(iso(qtd.from)).toBe(iso(inception.from));
    expect(iso(qtd.to)).toBe(iso(inception.to));
    expect(qtd.clampedToInception).toBe(true);
  });

  it('anchors the named quarter that opens after inception on inception too', () => {
    const q3 = resolvePeriod('Q3-CY26', { asOf: IN_Q3 });
    expect(iso(q3.from)).toBe(INCEPTION);
    expect(q3.label).toBe('Q3 CY26');
  });

  it('clamps a quarter that ends after today back to today, and flags it open', () => {
    const q3 = resolvePeriod('Q3-CY26', { asOf: IN_Q3 });
    // Q3 nominally ends 30-Sep; we are only at 5-Aug.
    expect(iso(q3.to)).toBe('2026-08-05');
    expect(q3.openPeriod).toBe(true);
  });

  it('leaves a fully closed quarter on its own calendar boundaries', () => {
    const asOf = new Date('2027-02-10T00:00:00.000Z');
    const q4 = resolvePeriod('Q4-CY26', { asOf });

    expect(iso(q4.from)).toBe('2026-10-01');
    expect(iso(q4.to)).toBe('2026-12-31');
    expect(q4.openPeriod).toBe(false);
    expect(q4.clampedToInception).toBe(false);
  });

  /**
   * A later quarter must NOT be dragged back to inception — only the first one
   * after it has no opening value of its own.
   */
  it('does not anchor a later quarter on inception', () => {
    const asOf = new Date('2027-02-10T00:00:00.000Z');
    const q1 = resolvePeriod('Q1-CY27', { asOf });

    expect(iso(q1.from)).toBe('2027-01-01');
    expect(q1.clampedToInception).toBe(false);
  });

  it('pulls a window that starts before inception forward to it', () => {
    // YTD nominally opens 1-Jan-2026, months before the house has any history.
    const ytd = resolvePeriod('YTD', { asOf: IN_Q3 });
    expect(iso(ytd.from)).toBe(INCEPTION);
    expect(ytd.clampedToInception).toBe(true);
  });

  it('pulls a custom range that starts before inception forward to it', () => {
    const r = resolvePeriod('CUSTOM', {
      asOf: IN_Q3,
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(iso(r.from)).toBe(INCEPTION);
    expect(iso(r.to)).toBe('2026-08-01');
  });

  it('leaves a custom range that starts after inception alone', () => {
    const r = resolvePeriod('CUSTOM', {
      asOf: IN_Q3,
      from: new Date('2026-07-15T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(iso(r.from)).toBe('2026-07-15');
    expect(r.clampedToInception).toBe(false);
  });

  it('rejects a quarter that closed entirely before inception', () => {
    // Q1 CY26 ends 31-March, so after clamping it would end before it starts.
    expect(() => resolvePeriod('Q1-CY26', { asOf: IN_Q3 })).toThrow(BadRequestException);
  });

  it('rejects a quarter that has not started yet', () => {
    expect(() => resolvePeriod('Q4-CY26', { asOf: IN_Q3 })).toThrow(BadRequestException);
  });

  it('rejects a custom range with no start date', () => {
    expect(() => resolvePeriod('CUSTOM', { asOf: IN_Q3 })).toThrow(BadRequestException);
  });

  it('rejects an unrecognised code rather than defaulting it', () => {
    expect(() => resolvePeriod('LAST_YEAR', { asOf: IN_Q3 })).toThrow(BadRequestException);
  });
});

describe('availablePeriods', () => {
  it('offers inception, the rolling windows and custom', () => {
    const codes = availablePeriods(IN_Q3).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['INCEPTION', 'QTD', 'MTD', 'YTD', 'CUSTOM']));
  });

  /**
   * Inception falls on the LAST day of Q2 CY26, so that quarter would resolve to
   * a zero-length window — a guaranteed 0.00% that reads like a real quarterly
   * result. It must not be selectable.
   */
  it('omits the quarter that inception closes', () => {
    const codes = availablePeriods(IN_Q3).map((p) => p.code);
    expect(codes).not.toContain('Q2-CY26');
    expect(codes).toContain('Q3-CY26');
  });

  it('grows with the calendar and lists newest quarter first', () => {
    const codes = availablePeriods(new Date('2027-02-10T00:00:00.000Z')).map((p) => p.code);
    const quarters = codes.filter((c) => /^Q\d-CY\d\d$/.test(c));

    expect(quarters).toEqual(['Q1-CY27', 'Q4-CY26', 'Q3-CY26']);
  });

  it('only offers quarters that resolve', () => {
    const asOf = new Date('2027-02-10T00:00:00.000Z');
    for (const { code } of availablePeriods(asOf)) {
      if (code === 'CUSTOM') continue;
      expect(() => resolvePeriod(code, { asOf })).not.toThrow();
    }
  });
});
