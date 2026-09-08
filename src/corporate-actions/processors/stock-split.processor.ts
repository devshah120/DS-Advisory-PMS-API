/**
 * Stock splits and reverse splits — PART 9, 10 and 11.
 *
 * One class handles both directions, because they are one calculation. A
 * "reverse split" is a split whose multiplier is below 1 (see ratio.ts), and
 * giving it a second implementation would be a second chance to get the same
 * arithmetic wrong.
 *
 * ── What this writes, and why that shape ────────────────────────────────────
 *
 * For each holder, exactly two things:
 *
 *   1. A Transaction row of type SPLIT (or REVERSE_SPLIT) carrying the DELTA
 *      quantity and amount 0.
 *   2. An updated Holding with the new quantity and average cost.
 *
 * The transaction's `amount` is zero because no money moved, and that zero is
 * what keeps the split out of every cash-flow and performance calculation
 * (PART 26/52): `flows.ts` sums transaction amounts, `PerformanceService`
 * builds XIRR flows from cash movements, and a zero contributes to neither.
 * Writing the notional share value there instead — a tempting way to make the
 * row "look" complete — would register a $16,000 deposit and hand the client a
 * fabricated 100% return.
 *
 * The ORIGINAL BUY transaction is never touched (PART 50/51). A client who
 * bought 100 APH at $100 still has that row afterwards; the split is a
 * separate, later event, which is precisely what makes a historical report for
 * a date before the split still say 100 shares.
 */
import { Injectable } from '@nestjs/common';
import { applyRatio, formatRatioLabel, normalize } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  PlannedTransaction,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class StockSplitProcessor implements CorporateActionProcessor {
  readonly name = 'StockSplitProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action, holdings, settings } = context;

    const oldRatio = action.oldRatio;
    const newRatio = action.newRatio;

    // The validator has already rejected these, so reaching here with a bad
    // ratio means validation was bypassed. Fail rather than guess: a split
    // that silently no-ops looks identical to one that worked.
    if (
      oldRatio === null ||
      newRatio === null ||
      !Number.isFinite(oldRatio) ||
      !Number.isFinite(newRatio) ||
      oldRatio <= 0 ||
      newRatio <= 0
    ) {
      throw new Error(
        `${action.symbol} ${action.actionType}: ratio ${oldRatio}:${newRatio} is unusable. ` +
          'Validation must run before processing.',
      );
    }

    const isReverse = newRatio / oldRatio < 1;
    const label = formatRatioLabel(oldRatio, newRatio);

    return holdings.map((holding) =>
      this.planOne(holding, context, oldRatio, newRatio, isReverse, label),
    );
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    oldRatio: number,
    newRatio: number,
    isReverse: boolean,
    label: string,
  ): PlannedClientChange {
    const { action, settings, runReference } = context;

    const result = applyRatio({
      quantityBefore: holding.quantity,
      averageCostBefore: holding.averageCost,
      oldRatio,
      newRatio,
      policy: settings.fractionalSharePolicy,
      marketPrice:
        settings.cashInLieuPolicy === 'MARKET_PRICE' ? holding.currentPrice : holding.averageCost,
    });

    const deltaQuantity = normalize(result.quantityAfter - holding.quantity);

    /**
     * Market value is recomputed at the CURRENT price, unadjusted.
     *
     * That is deliberate and it is the one place this processor knowingly
     * produces a figure that looks wrong for a few hours. On the morning of a
     * 2:1 split the exchange halves the quoted price; until the next price
     * refresh, `currentPrice` is still the pre-split figure, so 200 x $160
     * momentarily reads as $32,000.
     *
     * The alternative — dividing currentPrice by the ratio here — would be
     * worse: it writes a synthetic price into the book that the next market
     * refresh silently overwrites, so the value would be right until the
     * refresh and then right again, with an invented number in between that no
     * source can corroborate. Holding.currentPrice is owned by MarketService,
     * and this engine does not forge prices. The reconciliation step reports
     * the transient variance rather than papering over it.
     */
    const marketValueAfter = normalize(result.quantityAfter * holding.currentPrice);

    const transactions: PlannedTransaction[] = [];

    /**
     * The share-count row.
     *
     * Skipped entirely when the delta is zero — a holder whose position is
     * unchanged (a 1:1, or a zero-share position) gets no ledger noise. The
     * ledger row is still written, so the audit trail records that they were
     * considered and unaffected.
     */
    if (Math.abs(deltaQuantity) > 1e-9) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        // Both map to types the existing replay already understands. SPLIT is
        // handled by PortfolioReconstructionService today; REVERSE_SPLIT is
        // new and is added to that replay alongside this change.
        type: isReverse ? 'REVERSE_SPLIT' : 'SPLIT',
        quantity: deltaQuantity,
        price: null,
        // No cash moved. See the header note — this zero is what keeps the
        // split out of every performance and cash-flow calculation.
        amount: 0,
        date: action.effectiveDate,
        description:
          `${label} ${isReverse ? 'reverse split' : 'stock split'} — ` +
          `${trim(holding.quantity)} → ${trim(result.quantityAfter)} shares, ` +
          `average cost ${trim(holding.averageCost)} → ${trim(result.averageCostAfter)}`,
        reference: runReference,
      });
    }

    /**
     * Cash in lieu of a fraction that could not be issued (PART 11).
     *
     * A separate row from the split itself, because it IS separate: real money
     * arrives, and it must appear in cash-flow and performance figures where
     * the split must not.
     */
    if (result.cashInLieu > 0) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: 'CASH_IN_LIEU',
        quantity: null,
        price: null,
        amount: result.cashInLieu,
        date: action.paymentDate ?? action.effectiveDate,
        description:
          `Cash in lieu of ${trim(result.fractionalShares)} fractional share of ` +
          `${holding.ticker} from the ${label} ${isReverse ? 'reverse split' : 'split'}`,
        reference: runReference,
      });
    }

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        quantityBefore: holding.quantity,
        quantityAfter: result.quantityAfter,
        averageCostBefore: holding.averageCost,
        averageCostAfter: result.averageCostAfter,
        marketValueBefore: holding.marketValue,
        marketValueAfter,
        cashImpact: result.cashInLieu,
        currency: holding.clientCurrency,
        fractionalShares: result.fractionalShares,
        status: 'READY',
        note:
          result.fractionalShares > 0
            ? `${trim(result.fractionalShares)} fractional share ${fractionNote(context)}`
            : null,
      },
      transactions,
      holdingUpdate: {
        holdingId: holding.holdingId,
        quantity: result.quantityAfter,
        averageCost: result.averageCostAfter,
        marketValue: marketValueAfter,
      },
      newHolding: null,
    };
  }
}

function fractionNote(context: ProcessorContext): string {
  switch (context.settings.fractionalSharePolicy) {
    case 'CASH_IN_LIEU':
      return 'settled in cash';
    case 'ROUND_DOWN':
      return 'dropped (round-down policy)';
    default:
      return 'retained on the position';
  }
}

/** Compact number for a human-readable description. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
