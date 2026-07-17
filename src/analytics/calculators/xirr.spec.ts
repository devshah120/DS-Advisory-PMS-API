import { xirr, interimReturn, benchmarkXirr, CashFlow } from './xirr';

/**
 * Fixtures taken directly from `Portfolio June 2026.xlsx` -> `XIRR Calc` sheet.
 * These are numbers the team already trusts, so they pin the implementation to a
 * spreadsheet that can be independently checked.
 */
const WORKBOOK_FLOWS: CashFlow[] = [
  { date: new Date('2026-04-27'), amount: -98996.68 },  // opening balance
  { date: new Date('2026-05-06'), amount: -48800.0 },   // inflow
  { date: new Date('2026-05-06'), amount: -26784.0 },   // inflow
  { date: new Date('2026-06-15'), amount: -14200.0 },   // inflow
  { date: new Date('2026-06-25'), amount: 191837.3873 }, // closing value
];

const EXPECTED_ANNUALIZED = 0.11999054551124572;
const EXPECTED_INTERIM = 0.018486313662314124;

describe('xirr', () => {
  it('reproduces the workbook annualized XIRR to 6 decimal places', () => {
    const result = xirr(WORKBOOK_FLOWS);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.rate).toBeCloseTo(EXPECTED_ANNUALIZED, 6);
  });

  it('reproduces the workbook interim return', () => {
    expect(interimReturn(WORKBOOK_FLOWS)).toBeCloseTo(EXPECTED_INTERIM, 6);
  });

  it('is order-independent', () => {
    const shuffled = [...WORKBOOK_FLOWS].reverse();
    const a = xirr(WORKBOOK_FLOWS);
    const b = xirr(shuffled);

    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status !== 'ok' || b.status !== 'ok') return;

    expect(a.rate).toBeCloseTo(b.rate, 10);
  });

  it('converges from a deliberately bad initial guess', () => {
    // Newton diverges from here; this asserts the bisection fallback actually
    // catches it rather than the function returning NaN or its own guess.
    const result = xirr(WORKBOOK_FLOWS, 50);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rate).toBeCloseTo(EXPECTED_ANNUALIZED, 6);
  });

  it('refuses to invent a rate when there are no inflows', () => {
    const result = xirr([
      { date: new Date('2026-01-01'), amount: -1000 },
      { date: new Date('2026-06-01'), amount: -2000 },
    ]);
    expect(result.status).toBe('no-solution');
  });

  it('handles a total loss without exploding', () => {
    const result = xirr([
      { date: new Date('2026-01-01'), amount: -1000 },
      { date: new Date('2026-12-31'), amount: 1 },
    ]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rate).toBeLessThan(-0.99);
  });

  it('returns a simple doubling over one year as ~100%', () => {
    const result = xirr([
      { date: new Date('2025-01-01'), amount: -1000 },
      { date: new Date('2026-01-01'), amount: 2000 },
    ]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rate).toBeCloseTo(1.0, 2);
  });
});

describe('benchmarkXirr (unit-purchase method)', () => {
  // Index closes on each contribution date, from the workbook's `S&P500` column.
  const CONTRIBUTIONS = WORKBOOK_FLOWS.slice(0, 4);
  const SP500_CLOSES = [7174, 7259.22, 7259.22, 7550];
  const SP500_TERMINAL = 7357;
  const CLOSE_DATE = new Date('2026-06-25');

  /** Workbook: "S&P 500 return" = 0.019234825563025026 over the same 59 days. */
  const EXPECTED_SP500_INTERIM = 0.019234825563025026;

  it('reproduces the workbook S&P 500 interim return', () => {
    const result = benchmarkXirr(CONTRIBUTIONS, SP500_CLOSES, SP500_TERMINAL, CLOSE_DATE);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const interim = (1 + result.rate) ** (59 / 365) - 1;
    expect(interim).toBeCloseTo(EXPECTED_SP500_INTERIM, 6);
  });

  it('preserves the workbook conclusion: the portfolio trailed the S&P by ~7bp', () => {
    const bench = benchmarkXirr(CONTRIBUTIONS, SP500_CLOSES, SP500_TERMINAL, CLOSE_DATE);
    expect(bench.status).toBe('ok');
    if (bench.status !== 'ok') return;

    const benchInterim = (1 + bench.rate) ** (59 / 365) - 1;
    const shortfall = EXPECTED_INTERIM - benchInterim;

    // ~ -7bp. This spread is small enough that a sloppier benchmark construction
    // (e.g. a naive index point-to-point return) could invert its sign, so the
    // sign itself is worth asserting.
    expect(shortfall).toBeLessThan(0);
    expect(shortfall).toBeCloseTo(-0.00075, 4);
  });

  it('rejects a missing index close rather than guessing one', () => {
    const result = benchmarkXirr(
      [{ date: new Date('2026-04-27'), amount: -1000 }],
      [0],
      7357,
      new Date('2026-06-25'),
    );
    expect(result.status).toBe('no-solution');
  });
});
