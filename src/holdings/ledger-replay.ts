import { TransactionType } from '@prisma/client';

/**
 * Below this, a position is closed rather than merely small.
 *
 * Quantities are fractional (46.414 shares), so selling a lot out in full
 * rarely lands on a clean 0 — the subtraction leaves float dust like 7e-15.
 * Comparing against zero would let a fully-exited position keep showing up as
 * an open holding worth $0.00. Matches the threshold the analytics layer
 * already uses for the same judgement.
 */
export const CLOSED_POSITION_EPSILON = 1e-9;

/**
 * Ledger rows that change a position's share count without moving money — the
 * same set PortfolioReconstructionService.applyTransaction replays as a signed
 * quantity delta. A lot rebuild must apply them too, or it disagrees with every
 * historical valuation about how many shares a split left behind.
 */
export const SHARE_COUNT_ACTIONS: TransactionType[] = [
  'SPLIT',
  'BONUS',
  'REVERSE_SPLIT',
  'SPINOFF',
  'MERGER',
  'ACQUISITION',
  'DELISTING_SETTLEMENT',
];

/** Every row type that moves a position's quantity or cost. */
export const POSITION_MOVING_TYPES: TransactionType[] = ['BUY', 'SELL', ...SHARE_COUNT_ACTIONS];

/** Derived position figures. Cost basis is always averageCost * quantity. */
export function derive(quantity: number, averageCost: number, currentPrice: number) {
  const marketValue = quantity * currentPrice;
  const costBasis = quantity * averageCost;
  return { marketValue, unrealizedPnL: marketValue - costBasis };
}

export interface ReplayedPosition {
  quantity: number;
  costBasis: number;
  realizedPnL: number;
}

/**
 * Replays one position's rows, which the caller must pass oldest first, under
 * the average-cost rule.
 *
 * Sells are costed against the running average at the time of the sale rather
 * than against today's, so replaying an unchanged ledger reproduces the same
 * realised figure every time. Share-count corporate actions apply their signed
 * delta to the quantity and leave the cost basis whole.
 */
export function replayLots(
  lots: Array<{ type: TransactionType | string; quantity: number | null; amount: number | null }>,
): ReplayedPosition {
  let quantity = 0;
  let costBasis = 0;
  let realizedPnL = 0;

  for (const lot of lots) {
    if (SHARE_COUNT_ACTIONS.includes(lot.type as TransactionType)) {
      // `quantity` is the signed delta here (see applyTransaction), so it is
      // applied as recorded, never through Math.abs.
      quantity += lot.quantity ?? 0;
      continue;
    }

    const size = Math.abs(lot.quantity ?? 0);
    const amount = Math.abs(lot.amount ?? 0);
    if (size === 0) continue;

    if (lot.type === 'BUY') {
      quantity += size;
      costBasis += amount;
    } else if (lot.type === 'SELL') {
      // Sells cannot take out more than is held: a ledger whose sells exceed
      // its buys is already inconsistent, and clamping keeps the rebuild from
      // inventing a negative position out of it.
      const sold = Math.min(size, quantity);
      const averageCost = quantity > 0 ? costBasis / quantity : 0;
      realizedPnL += amount - averageCost * sold;
      quantity -= sold;
      costBasis -= averageCost * sold;
    }
  }

  // Same snap the create path applies: a full exit built from fractional buys
  // and sells lands on float dust, not a clean zero, and that dust is what
  // keeps a closed name rendering as an open position worth nothing.
  if (Math.abs(quantity) < CLOSED_POSITION_EPSILON) {
    quantity = 0;
    costBasis = 0;
  }

  return { quantity, costBasis, realizedPnL };
}

/** IST is UTC+5:30 with no DST — see istDay(). */
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * The Indian calendar day a ledger date falls on.
 *
 * Manual entries are stored two ways — UTC midnight of the trade date, and IST
 * midnight (18:30 UTC the evening before) — so comparing raw UTC days would
 * miss every row of the second kind. Shifted into IST, both land on the trade
 * date.
 */
export const istDay = (d: Date) =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
