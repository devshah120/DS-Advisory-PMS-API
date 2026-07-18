import { CashFlow } from './xirr';

/**
 * Turning a transaction ledger into an XIRR cash-flow series.
 *
 * XIRR does not care where a number came from — it solves whatever series it is
 * handed. So the ONLY thing that distinguishes a "transactional" client from a
 * "cash-flow" client is which ledger rows become flows, and with what sign. That
 * decision lives here, as a pure function, because it is the decision most likely
 * to be got wrong and the one most worth testing without a database attached.
 *
 * Sign convention (shared with xirr.ts and the workbook):
 *   negative = money INTO the portfolio  (a contribution / a purchase)
 *   positive = money OUT of the portfolio (a withdrawal / a sale / terminal value)
 */

export type AccountingMethod = 'TRANSACTIONAL' | 'CASH_FLOW';

/** The subset of a Transaction row the flow builder needs. */
export interface LedgerEntry {
  type: string;
  amount: number;
  date: Date;
}

export type FlowBuildResult =
  | { status: 'ok'; flows: CashFlow[] }
  | { status: 'insufficient'; reason: string };

/**
 * CASH_FLOW method: only money that genuinely crossed the boundary between the
 * client and the portfolio.
 *
 * A BUY is excluded on purpose. Buying $10k of AAPL moves $10k from the cash
 * sleeve into the equity sleeve; the portfolio is worth exactly what it was worth
 * a second earlier. Count it as a flow and you have told XIRR that the client
 * contributed $10k they never contributed, which drags the computed return toward
 * zero — the more actively the book is traded, the more wrong the number gets.
 *
 * A DIVIDEND is excluded for the mirror-image reason, and this is the one that
 * looks wrong at a glance. A dividend DOES raise this client's return — but it
 * does so through the terminal value, because the cash landed in their balance
 * and is already counted there. Adding it as a positive flow as well would tell
 * XIRR the client WITHDREW that cash, which inflates the reported return on money
 * that never left the portfolio. Same for FEES: the cash already left the balance.
 */
const CASH_FLOW_TYPES = new Set(['CASH_DEPOSIT', 'CASH_WITHDRAWAL']);

/**
 * TRANSACTIONAL method: the deployment of capital into positions IS the flow.
 *
 * This is for the client who never tells us "I gave you $50k" — we only ever see
 * the trades. The return is then measured on capital at work: every BUY is money
 * in, every SELL is money out, and whatever is still held is the terminal value.
 *
 * DIVIDEND and FEES are included because they are real cash that arrived or left
 * and are not captured by any BUY/SELL. SPLIT, BONUS and TRANSFER are excluded:
 * they change the share count, not the money, and their `amount` column is not a
 * cash figure.
 */
const TRANSACTIONAL_TYPES = new Set(['BUY', 'SELL', 'DIVIDEND', 'FEES']);

/** Types whose `amount` represents money leaving the client's pocket. */
const OUTFLOW_TYPES = new Set(['CASH_DEPOSIT', 'BUY', 'FEES']);

/**
 * The brief makes dividends and fees OPTIONAL under the transactional method,
 * and the option is worth having: excluding fees gives a gross-of-fee return,
 * which is the figure a manager is measured on, while including them gives the
 * net-of-fee return the client actually received. Both are legitimate; they are
 * answers to different questions, and a system that can only produce one of them
 * cannot be reconciled against a statement that used the other.
 *
 * Both default ON, so the headline number is the one the client experienced.
 *
 * These flags do nothing under the CASH_FLOW method, and that is not an
 * oversight: dividends and fees are already inside the terminal value there,
 * because the cash landed in (or left) the balance. Adding them as flows as well
 * would count them twice. See the CASH_FLOW comment above.
 */
export interface FlowOptions {
  includeDividends?: boolean;
  includeFees?: boolean;
}

const DEFAULTS: Required<FlowOptions> = {
  includeDividends: true,
  includeFees: true,
};

export function isFlowType(
  type: string,
  method: AccountingMethod,
  opts: FlowOptions = {},
): boolean {
  if (method === 'CASH_FLOW') return CASH_FLOW_TYPES.has(type);

  const { includeDividends, includeFees } = { ...DEFAULTS, ...opts };

  if (type === 'DIVIDEND') return includeDividends;
  if (type === 'FEES') return includeFees;

  return TRANSACTIONAL_TYPES.has(type);
}

/**
 * Types that get same-day netting under the transactional method: a client who
 * buys ten $10k positions in one session gave the portfolio one $100k trade,
 * not ten separate cash-flow events. XIRR treats each flow date as one client
 * decision, so ten rows on the same day would overweight that day's trading
 * activity relative to a single $100k buy made on a quieter day.
 *
 * DIVIDEND and FEES are deliberately NOT netted here: they are per-event cash
 * (a dividend per holding, a fee charge), not a batch of orders placed as one
 * trading decision, so each row already represents its own real-world event.
 */
const NETTABLE_TYPES = new Set(['BUY', 'SELL']);

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Turn already flow-eligible ledger rows into signed cash flows, netting same-day
 * BUY/SELL rows into one flow per day (per the NETTABLE_TYPES rationale above).
 * Non-nettable rows (DIVIDEND, FEES) each become their own flow, one per row.
 */
function toNettedCashFlows(eligible: LedgerEntry[]): CashFlow[] {
  const buckets = new Map<string, number>();
  const passthrough: CashFlow[] = [];

  for (const t of eligible) {
    // Magnitude, not the stored sign: the ledger is not consistent about whether
    // a withdrawal is written as -5000 or 5000, and the TYPE is the reliable signal.
    const signedAmount = OUTFLOW_TYPES.has(t.type) ? -Math.abs(t.amount) : Math.abs(t.amount);

    if (!NETTABLE_TYPES.has(t.type)) {
      passthrough.push({ date: t.date, amount: signedAmount });
      continue;
    }

    // Net BUY and SELL against each other within the same day so that a buy and
    // a sell on the same day still produce one flow, signed by which side won.
    const key = dateKey(t.date);
    buckets.set(key, (buckets.get(key) ?? 0) + signedAmount);
  }

  const netted = [...buckets.entries()].map(([key, amount]) => ({
    date: new Date(key),
    amount,
  }));

  return [...passthrough, ...netted];
}

/**
 * Build the XIRR series for a client.
 *
 * `terminalValue` is the book's worth today (securities + cash) and closes the
 * series. Under the transactional method it is what makes an unsold position
 * count at all: a client who bought and never sold has only negative flows, and
 * XIRR has no root in an all-negative series — without the terminal value we
 * would report "no solution" for the most ordinary buy-and-hold account there is.
 */
export function buildFlows(
  ledger: LedgerEntry[],
  method: AccountingMethod,
  terminalValue: number,
  asOf: Date,
  opts: FlowOptions = {},
): FlowBuildResult {
  const eligible = ledger.filter((t) => isFlowType(t.type, method, opts));

  if (eligible.length === 0) {
    return {
      status: 'insufficient',
      reason:
        method === 'CASH_FLOW'
          ? 'No deposits or withdrawals recorded. XIRR on the cash-flow method needs at least one contribution — record the client’s inflows, or switch this client to the transactional method.'
          : 'No trades recorded. XIRR on the transactional method needs at least one buy.',
    };
  }

  // Only the transactional method nets same-day BUY/SELL rows: under CASH_FLOW,
  // trades are not flows at all, so there is nothing here to net.
  const flows =
    method === 'TRANSACTIONAL'
      ? toNettedCashFlows(eligible)
      : eligible.map((t) => ({
          date: t.date,
          amount: OUTFLOW_TYPES.has(t.type) ? -Math.abs(t.amount) : Math.abs(t.amount),
        }));

  flows.sort((a, b) => a.date.getTime() - b.date.getTime());
  flows.push({ date: asOf, amount: terminalValue });

  return { status: 'ok', flows };
}

/** Total money the client put in — the denominator people expect next to a return. */
export function totalContributed(flows: CashFlow[]): number {
  return flows.filter((f) => f.amount < 0).reduce((s, f) => s + -f.amount, 0);
}

/** Money already taken out, excluding the terminal value that closes the series. */
export function totalWithdrawn(flows: CashFlow[]): number {
  return flows.slice(0, -1).filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
}
