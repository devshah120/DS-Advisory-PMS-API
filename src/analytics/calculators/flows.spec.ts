import {
  buildFlows,
  buildWindowFlows,
  isImportArtifact,
  totalContributed,
  totalWithdrawn,
  LedgerEntry,
} from './flows';
import { xirr } from './xirr';

const d = (s: string) => new Date(s);
const ASOF = d('2026-06-25');

/**
 * One ledger, read two ways. This is the whole point of the feature: the same
 * rows must produce a different — and individually correct — series depending on
 * how the client was onboarded.
 */
const LEDGER: LedgerEntry[] = [
  { type: 'CASH_DEPOSIT', amount: 100000, date: d('2026-01-05') },
  { type: 'BUY', amount: 60000, date: d('2026-01-10') },
  { type: 'BUY', amount: 30000, date: d('2026-02-14') },
  { type: 'DIVIDEND', amount: 500, date: d('2026-03-01') },
  { type: 'SELL', amount: 20000, date: d('2026-04-20') },
  { type: 'CASH_WITHDRAWAL', amount: 15000, date: d('2026-05-02') },
  { type: 'FEES', amount: 250, date: d('2026-05-30') },
  { type: 'SPLIT', amount: 0, date: d('2026-06-01') },
];

describe('buildFlows — CASH_FLOW method', () => {
  it('uses only deposits and withdrawals, and ignores the trades entirely', () => {
    const r = buildFlows(LEDGER, 'CASH_FLOW', 95000, ASOF);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.flows).toEqual([
      { date: d('2026-01-05'), amount: -100000 }, // deposit = money in
      { date: d('2026-05-02'), amount: 15000 },   // withdrawal = money out
      { date: ASOF, amount: 95000 },              // terminal value
    ]);
  });

  it('reports insufficient — with an actionable reason — when only trades exist', () => {
    const tradesOnly = LEDGER.filter((t) => t.type === 'BUY' || t.type === 'SELL');
    const r = buildFlows(tradesOnly, 'CASH_FLOW', 95000, ASOF);

    expect(r.status).toBe('insufficient');
    if (r.status !== 'insufficient') return;
    expect(r.reason).toMatch(/transactional method/);
  });
});

describe('buildFlows — TRANSACTIONAL method', () => {
  it('treats every buy as an inflow and every sell as an outflow', () => {
    const r = buildFlows(LEDGER, 'TRANSACTIONAL', 95000, ASOF);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.flows).toEqual([
      { date: d('2026-01-10'), amount: -60000 }, // buy = money in
      { date: d('2026-02-14'), amount: -30000 },
      { date: d('2026-03-01'), amount: 500 },    // dividend = cash received
      { date: d('2026-04-20'), amount: 20000 },  // sell = money out
      { date: d('2026-05-30'), amount: -250 },   // fee = money out of the client
      { date: ASOF, amount: 95000 },
    ]);
  });

  it('excludes deposits — counting both the deposit and the buy it funded would double-count', () => {
    const r = buildFlows(LEDGER, 'TRANSACTIONAL', 95000, ASOF);
    if (r.status !== 'ok') return;
    expect(r.flows.some((f) => f.amount === -100000)).toBe(false);
  });

  it('excludes splits and bonuses — they move shares, not money', () => {
    const r = buildFlows(LEDGER, 'TRANSACTIONAL', 95000, ASOF);
    if (r.status !== 'ok') return;
    expect(r.flows).toHaveLength(6); // 5 ledger rows + terminal; SPLIT dropped
  });

  it('solves for buy-and-hold, where the terminal value is the only positive flow', () => {
    const holdOnly: LedgerEntry[] = [{ type: 'BUY', amount: 100000, date: d('2026-01-01') }];
    const r = buildFlows(holdOnly, 'TRANSACTIONAL', 112000, d('2027-01-01'));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const result = xirr(r.flows);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rate).toBeCloseTo(0.12, 3); // +12% over one year
  });
});

describe('sign normalisation', () => {
  it('derives direction from the type, not from the stored sign', () => {
    // The ledger is not consistent: the same withdrawal may be written -5000 or 5000.
    const messy: LedgerEntry[] = [
      { type: 'CASH_DEPOSIT', amount: -100000, date: d('2026-01-01') },
      { type: 'CASH_WITHDRAWAL', amount: -5000, date: d('2026-03-01') },
    ];
    const r = buildFlows(messy, 'CASH_FLOW', 100000, ASOF);
    if (r.status !== 'ok') return;

    expect(r.flows[0].amount).toBe(-100000); // still an inflow
    expect(r.flows[1].amount).toBe(5000);    // still an outflow
  });
});

/**
 * Dividends must raise the return under BOTH methods — but by different
 * mechanisms, and conflating them is the easiest way to get this wrong.
 */
describe('dividends increase the return', () => {
  const BUY: LedgerEntry[] = [{ type: 'BUY', amount: 100000, date: d('2026-01-01') }];
  const DIV: LedgerEntry = { type: 'DIVIDEND', amount: 5000, date: d('2026-07-01') };
  const END = d('2027-01-01');

  it('transactional: as an explicit positive flow', () => {
    const without = buildFlows(BUY, 'TRANSACTIONAL', 100000, END);
    const with_ = buildFlows([...BUY, DIV], 'TRANSACTIONAL', 100000, END);
    if (without.status !== 'ok' || with_.status !== 'ok') throw new Error('setup');

    const a = xirr(without.flows);
    const b = xirr(with_.flows);
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('no solution');

    // Flat price + a $5k dividend must beat flat price with none.
    expect(a.rate).toBeCloseTo(0, 6); // bought 100k, still worth 100k => 0%
    expect(b.rate).toBeGreaterThan(0.04);
  });

  it('cash-flow: through the terminal value, NOT as a flow', () => {
    const deposit: LedgerEntry[] = [
      { type: 'CASH_DEPOSIT', amount: 100000, date: d('2026-01-01') },
    ];

    // The dividend's $5k is sitting in the cash balance, so it is inside the NAV.
    const r = buildFlows([...deposit, DIV], 'CASH_FLOW', 105000, END);
    if (r.status !== 'ok') throw new Error('setup');

    // It must NOT appear as its own flow — only the deposit and the terminal value.
    expect(r.flows).toEqual([
      { date: d('2026-01-01'), amount: -100000 },
      { date: END, amount: 105000 },
    ]);

    const result = xirr(r.flows);
    if (result.status !== 'ok') throw new Error('no solution');
    expect(result.rate).toBeCloseTo(0.05, 3); // +5%, earned entirely by the dividend
  });

  it('cash-flow: counting the dividend as a flow would overstate the return', () => {
    // The bug this guards against: if DIVIDEND were added to CASH_FLOW_TYPES, the
    // $5k would be counted twice — once in the NAV, once as a "withdrawal".
    const doubleCounted = [
      { date: d('2026-01-01'), amount: -100000 },
      { date: d('2026-07-01'), amount: 5000 }, // the erroneous extra flow
      { date: END, amount: 105000 },
    ];
    const wrong = xirr(doubleCounted);
    if (wrong.status !== 'ok') throw new Error('no solution');

    // ~10%, double the true 5% — which is exactly why DIVIDEND is not a cash flow.
    expect(wrong.rate).toBeGreaterThan(0.09);
  });
});

/**
 * A client who buys ten $10k positions in one session gave the portfolio one
 * $100k trade, not ten cash-flow events. This is the whole point of the
 * "one date = one trade" rule: XIRR must see it as a single decision.
 */
describe('buildFlows — TRANSACTIONAL same-day netting', () => {
  it('nets multiple same-day buys into a single flow', () => {
    const ledger: LedgerEntry[] = [
      { type: 'BUY', amount: 10000, date: d('2026-05-06') },
      { type: 'BUY', amount: 10000, date: d('2026-05-06') },
      { type: 'BUY', amount: 10000, date: d('2026-05-06') },
    ];
    const r = buildFlows(ledger, 'TRANSACTIONAL', 33000, d('2026-06-01'));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    expect(r.flows).toEqual([
      { date: d('2026-05-06'), amount: -30000 },
      { date: d('2026-06-01'), amount: 33000 },
    ]);
  });

  it('nets a same-day buy and sell into one signed flow', () => {
    const ledger: LedgerEntry[] = [
      { type: 'BUY', amount: 10000, date: d('2026-05-06') },
      { type: 'SELL', amount: 4000, date: d('2026-05-06') },
    ];
    const r = buildFlows(ledger, 'TRANSACTIONAL', 6000, d('2026-06-01'));
    if (r.status !== 'ok') throw new Error('setup');

    expect(r.flows).toEqual([
      { date: d('2026-05-06'), amount: -6000 }, // net: -10,000 + 4,000
      { date: d('2026-06-01'), amount: 6000 },
    ]);
  });

  it('keeps trades on different days as separate flows', () => {
    const ledger: LedgerEntry[] = [
      { type: 'BUY', amount: 10000, date: d('2026-05-06') },
      { type: 'BUY', amount: 10000, date: d('2026-05-07') },
    ];
    const r = buildFlows(ledger, 'TRANSACTIONAL', 20000, d('2026-06-01'));
    if (r.status !== 'ok') throw new Error('setup');

    expect(r.flows).toEqual([
      { date: d('2026-05-06'), amount: -10000 },
      { date: d('2026-05-07'), amount: -10000 },
      { date: d('2026-06-01'), amount: 20000 },
    ]);
  });

  it('does not net DIVIDEND or FEES rows — each stays its own flow', () => {
    const ledger: LedgerEntry[] = [
      { type: 'DIVIDEND', amount: 50, date: d('2026-05-06') },
      { type: 'DIVIDEND', amount: 30, date: d('2026-05-06') },
      { type: 'FEES', amount: 20, date: d('2026-05-06') },
    ];
    const r = buildFlows(ledger, 'TRANSACTIONAL', 1000, d('2026-06-01'));
    if (r.status !== 'ok') throw new Error('setup');

    // 3 distinct ledger rows + terminal — none merged.
    expect(r.flows).toHaveLength(4);
    expect(r.flows.filter((f) => f.date.getTime() === d('2026-05-06').getTime())).toHaveLength(3);
  });
});

describe('totals', () => {
  it('sums contributions and withdrawals without swallowing the terminal value', () => {
    const r = buildFlows(LEDGER, 'CASH_FLOW', 95000, ASOF);
    if (r.status !== 'ok') return;

    expect(totalContributed(r.flows)).toBe(100000);
    expect(totalWithdrawn(r.flows)).toBe(15000); // NOT 110000 — terminal excluded
  });
});

/**
 * The bulk-import artifact rule.
 *
 * The legacy book was imported with every pre-existing position written as a
 * fresh BUY stamped 2026-07-01. Those rows are the opening position, not trades,
 * and the 30-June baseline already represents them — so replaying them on top of
 * the baseline books each purchase twice and drives reconstructed cash negative
 * (it reached −$25,596 on a client whose real balance is zero, which in turn
 * corrupted every allocation weight computed from portfolioValue).
 */
describe('isImportArtifact', () => {
  it('treats an import-dated BUY as part of the opening position', () => {
    expect(isImportArtifact({ type: 'BUY', date: d('2026-07-01') })).toBe(true);
  });

  it('covers a BUY dated on the inception date itself', () => {
    expect(isImportArtifact({ type: 'BUY', date: d('2026-06-30') })).toBe(true);
  });

  /**
   * The baseline is a POSITION snapshot, not a cash history — it cannot account
   * for a sale or a dividend, so those must still replay even inside the import
   * window, or their cash effect would be lost entirely.
   */
  it('does not skip non-BUY rows inside the import window', () => {
    expect(isImportArtifact({ type: 'SELL', date: d('2026-07-01') })).toBe(false);
    expect(isImportArtifact({ type: 'DIVIDEND', date: d('2026-07-01') })).toBe(false);
    expect(isImportArtifact({ type: 'FEES', date: d('2026-07-01') })).toBe(false);
    expect(isImportArtifact({ type: 'CASH_WITHDRAWAL', date: d('2026-07-01') })).toBe(false);
  });

  it('does not skip a genuine BUY made after the import window', () => {
    expect(isImportArtifact({ type: 'BUY', date: d('2026-07-02') })).toBe(false);
    expect(isImportArtifact({ type: 'BUY', date: d('2026-08-05') })).toBe(false);
  });

  /**
   * The end-to-end property that matters: filtering the artifacts out of a
   * replay leaves cash at the real maintained balance instead of deep negative.
   */
  it('leaves replayed cash non-negative once artifacts are excluded', () => {
    const imported: LedgerEntry[] = [
      { type: 'BUY', amount: 40000, date: d('2026-07-01') },
      { type: 'BUY', amount: 25000, date: d('2026-07-01') },
      { type: 'SELL', amount: 5000, date: d('2026-07-20') },
      { type: 'BUY', amount: 3000, date: d('2026-07-25') },
    ];

    const cashOf = (rows: LedgerEntry[]) =>
      rows.reduce((c, t) => (t.type === 'BUY' || t.type === 'FEES' ? c - t.amount : c + t.amount), 0);

    // Replaying everything double-counts the imported book.
    expect(cashOf(imported)).toBeLessThan(0);

    // Replaying only the real activity does not.
    const replayed = cashOf(imported.filter((t) => !isImportArtifact(t)));
    expect(replayed).toBe(2000); // +5,000 sale − 3,000 genuine buy
    expect(replayed).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The Mamta Jain regression.
 *
 * Reported from the Q2-FY27 sheet: a +43.54% "money-weighted, flow-adjusted"
 * return and a +Rs10,87,063 "Gain", on a book whose holdings statement showed
 * only Rs95,442 of unrealized gain. The window had shown "Deposits - withdrawals
 * during the period: Rs0.00" while ~Rs9.92 lakh of fresh capital had in fact
 * been deployed.
 *
 * Cause: the period engines filtered the window's ledger to CASH_DEPOSIT /
 * CASH_WITHDRAWAL only. A TRANSACTIONAL book has no such rows, so the series
 * collapsed to [opening, closing] and the headline became identical to the
 * naive (close - open) / open figure printed beside it.
 *
 * These numbers are the fixture: an implementation that reports 43.54% here is
 * reproducing the bug.
 */
describe('buildWindowFlows — period windows respect the accounting method', () => {
  const FROM = d('2026-06-30');
  const TO = d('2026-09-11');
  const OPENING = 2_496_749.0;
  const CLOSING = 3_583_812.33;
  const DEPLOYED = 991_621.31;

  const WINDOW: LedgerEntry[] = [
    // Fresh capital deployed mid-quarter, as trades — the only way a
    // transactional book ever records money arriving.
    { type: 'BUY', amount: 600_000, date: d('2026-07-15') },
    { type: 'BUY', amount: 391_621.31, date: d('2026-08-20') },
  ];

  const solve = (flows: ReturnType<typeof buildWindowFlows>) => {
    const series = [
      { date: FROM, amount: -OPENING },
      ...flows,
      { date: TO, amount: CLOSING },
    ];
    const r = xirr(series);
    if (r.status !== 'ok') throw new Error('no solution');
    const days = Math.round((TO.getTime() - FROM.getTime()) / 86_400_000);
    return (1 + r.rate) ** (days / 365) - 1;
  };

  it('treats mid-window BUYs on a transactional book as capital, not return', () => {
    const flows = buildWindowFlows(WINDOW, 'TRANSACTIONAL', FROM, TO);

    expect(flows).toHaveLength(2);
    // Net external money in = deposits − withdrawals, the sheet's netFlows.
    const netFlows = flows.reduce((sum, f) => sum - f.amount, 0);
    expect(netFlows).toBeCloseTo(DEPLOYED, 2);

    // The Gain tile is closing − opening − netFlows, and must now land on the
    // holdings statement's figure rather than on the whole value change.
    const gain = CLOSING - OPENING - netFlows;
    expect(gain).toBeCloseTo(95_442.02, 2);
  });

  it('no longer reports the naive return as the flow-adjusted one', () => {
    const naive = (CLOSING - OPENING) / OPENING;
    expect(naive).toBeCloseTo(0.4354, 4); // the number that was on the sheet

    const adjusted = solve(buildWindowFlows(WINDOW, 'TRANSACTIONAL', FROM, TO));

    // Materially below the naive figure, and in single digits — the book only
    // really earned ~95k on ~34.9 lakh of capital at work.
    expect(adjusted).toBeLessThan(0.1);
    expect(adjusted).toBeGreaterThan(0);
    expect(Math.abs(adjusted - naive)).toBeGreaterThan(0.3);
  });

  it('reproduces the old collapse when the window has no eligible rows', () => {
    // A cash-flow reading of the same ledger finds nothing — which is exactly
    // what the old hardcoded filter did to every transactional book.
    const flows = buildWindowFlows(WINDOW, 'CASH_FLOW', FROM, TO);
    expect(flows).toHaveLength(0);
    expect(solve(flows)).toBeCloseTo((CLOSING - OPENING) / OPENING, 6);
  });

  it('still reads a cash-flow book by its deposits', () => {
    const cashLedger: LedgerEntry[] = [
      { type: 'CASH_DEPOSIT', amount: 500_000, date: d('2026-07-15') },
      { type: 'CASH_WITHDRAWAL', amount: 100_000, date: d('2026-08-01') },
      { type: 'BUY', amount: 400_000, date: d('2026-07-16') },
    ];
    const flows = buildWindowFlows(cashLedger, 'CASH_FLOW', FROM, TO);

    expect(flows).toHaveLength(2); // the BUY is not a flow here
    expect(flows[0].amount).toBe(-500_000);
    expect(flows[1].amount).toBe(100_000);
  });

  it('excludes bulk-import BUY artifacts the 30-June baseline already holds', () => {
    const withArtifacts: LedgerEntry[] = [
      { type: 'BUY', amount: 2_496_749, date: d('2026-07-01') }, // the imported book
      ...WINDOW,
    ];
    const flows = buildWindowFlows(withArtifacts, 'TRANSACTIONAL', FROM, TO);

    expect(flows).toHaveLength(2);
    const netFlows = flows.reduce((sum, f) => sum - f.amount, 0);
    expect(netFlows).toBeCloseTo(DEPLOYED, 2); // not 34.9 lakh
  });

  it('nets same-day buys and sells, and drops a day that cancelled out', () => {
    const sameDay: LedgerEntry[] = [
      { type: 'BUY', amount: 100_000, date: d('2026-07-15') },
      { type: 'SELL', amount: 100_000, date: d('2026-07-15') },
      { type: 'BUY', amount: 250_000, date: d('2026-08-10') },
      { type: 'SELL', amount: 50_000, date: d('2026-08-10') },
    ];
    const flows = buildWindowFlows(sameDay, 'TRANSACTIONAL', FROM, TO);

    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(-200_000); // 250k out, 50k back in
  });

  it('ignores rows on the window boundaries, which the valuations already hold', () => {
    const boundary: LedgerEntry[] = [
      { type: 'BUY', amount: 500_000, date: FROM },
      { type: 'BUY', amount: 500_000, date: TO },
    ];
    expect(buildWindowFlows(boundary, 'TRANSACTIONAL', FROM, TO)).toHaveLength(0);
  });

  it('leaves share-count-only corporate actions out of the flow series', () => {
    const actions: LedgerEntry[] = [
      { type: 'SPLIT', amount: 0, date: d('2026-07-20') },
      { type: 'BONUS', amount: 0, date: d('2026-07-21') },
      { type: 'DIVIDEND', amount: 12_000, date: d('2026-08-05') },
    ];
    const flows = buildWindowFlows(actions, 'TRANSACTIONAL', FROM, TO);

    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(12_000); // cash out to the client, not a split
  });
});
