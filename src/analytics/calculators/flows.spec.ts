import { buildFlows, totalContributed, totalWithdrawn, LedgerEntry } from './flows';
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
