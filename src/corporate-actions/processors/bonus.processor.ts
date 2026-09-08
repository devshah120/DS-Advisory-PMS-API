/**
 * Bonus issues and stock dividends — PART 12.
 *
 * ── Why this is not a split, despite looking like one ───────────────────────
 *
 * A 1:1 bonus and a 2-for-1 split both take 100 shares to 200 and both leave
 * total cost at $10,000. The arithmetic converges; the CONVENTION does not,
 * and that is the trap:
 *
 *     bonus  1:1  =  one NEW share for every ONE held      -> 100 becomes 200
 *     split  1:2  =  each ONE share BECOMES two            -> 100 becomes 200
 *     bonus  1:2  =  one NEW share for every TWO held      -> 100 becomes 150
 *     split  1:2  =  (as above)                            -> 100 becomes 200
 *
 * Read a bonus ratio with split semantics and a 1:2 bonus doubles a position
 * that should have grown by half. That is why `bonusShares` lives in its own
 * function in ratio.ts and why this processor exists rather than delegating to
 * StockSplitProcessor with a converted ratio.
 *
 * ── Accounting ──────────────────────────────────────────────────────────────
 *
 * PART 12 says "average cost must be recalculated based on the economic
 * accounting treatment", and for a bonus that treatment is unambiguous: the
 * shares are issued from reserves for no consideration, so total cost is
 * unchanged and average cost falls across the enlarged holding. The client
 * paid nothing extra, so nothing extra enters the basis.
 *
 * The row is written as BONUS, never BUY (PART 12's explicit instruction) —
 * a BUY would register a cash outflow that never happened and would corrupt
 * both the cash balance and the XIRR.
 */
import { Injectable } from '@nestjs/common';
import { bonusShares, normalize } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  PlannedTransaction,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class BonusProcessor implements CorporateActionProcessor {
  readonly name = 'BonusProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;

    /**
     * Bonus ratios are stored in the same two columns as splits, read with the
     * bonus convention: `newRatio` new shares for every `oldRatio` held.
     *
     * A 1:1 bonus is therefore oldRatio=1, newRatio=1 — which a split would
     * read as "no change". The two conventions genuinely collide on the same
     * stored pair, and the ACTION TYPE is what disambiguates them. Nothing
     * else can.
     */
    const bonusFor = action.oldRatio;
    const bonusNew = action.newRatio;

    if (
      bonusFor === null ||
      bonusNew === null ||
      !Number.isFinite(bonusFor) ||
      !Number.isFinite(bonusNew) ||
      bonusFor <= 0 ||
      bonusNew <= 0
    ) {
      throw new Error(
        `${action.symbol} ${action.actionType}: bonus ratio ${bonusFor}:${bonusNew} is unusable. ` +
          'Validation must run before processing.',
      );
    }

    return context.holdings
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) => this.planOne(holding, context, bonusNew, bonusFor));
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    bonusNew: number,
    bonusFor: number,
  ): PlannedClientChange {
    const { action, settings, runReference } = context;

    const rawAdditional = bonusShares(holding.quantity, bonusNew, bonusFor);

    // Bonus shares are issued whole; a fraction arises when the holding is not
    // a clean multiple of the bonus denominator (105 shares on a 1:10 bonus).
    const wholeAdditional =
      settings.fractionalSharePolicy === 'RETAIN'
        ? rawAdditional
        : Math.floor(rawAdditional + 1e-9);
    const fractionalShares = normalize(rawAdditional - wholeAdditional);

    const quantityAfter = normalize(holding.quantity + wholeAdditional);

    // Total cost is untouched — the defining property of a bonus.
    const totalCost = normalize(holding.quantity * holding.averageCost);
    const averageCostAfter = quantityAfter > 0 ? normalize(totalCost / quantityAfter) : 0;
    const marketValueAfter = normalize(quantityAfter * holding.currentPrice);

    const label = `${trim(bonusNew)}:${trim(bonusFor)}`;

    const transactions: PlannedTransaction[] = [];

    if (Math.abs(wholeAdditional) > 1e-9) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        // BONUS, not BUY (PART 12). The existing replay in
        // PortfolioReconstructionService already treats this as delta-shares
        // with no cash and no basis change — exactly right.
        type: 'BONUS',
        quantity: wholeAdditional,
        price: null,
        // Issued for no consideration: no cash moved.
        amount: 0,
        date: action.effectiveDate,
        description:
          `${label} bonus issue — ${trim(wholeAdditional)} shares of ${holding.ticker} received, ` +
          `${trim(holding.quantity)} → ${trim(quantityAfter)}, ` +
          `average cost ${trim(holding.averageCost)} → ${trim(averageCostAfter)}`,
        reference: runReference,
      });
    }

    let cashInLieu = 0;
    if (fractionalShares > 1e-9 && settings.fractionalSharePolicy === 'CASH_IN_LIEU') {
      const perShare =
        settings.cashInLieuPolicy === 'MARKET_PRICE' ? holding.currentPrice : averageCostAfter;
      cashInLieu = normalize(fractionalShares * perShare);

      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: 'CASH_IN_LIEU',
        quantity: null,
        price: null,
        amount: cashInLieu,
        date: action.paymentDate ?? action.effectiveDate,
        description:
          `Cash in lieu of ${trim(fractionalShares)} fractional bonus share of ${holding.ticker}`,
        reference: runReference,
      });
    }

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        quantityBefore: holding.quantity,
        quantityAfter,
        averageCostBefore: holding.averageCost,
        averageCostAfter,
        marketValueBefore: holding.marketValue,
        marketValueAfter,
        cashImpact: cashInLieu,
        currency: holding.clientCurrency,
        fractionalShares,
        status: 'READY',
        note:
          fractionalShares > 1e-9
            ? `${trim(fractionalShares)} fractional entitlement ` +
              (settings.fractionalSharePolicy === 'CASH_IN_LIEU'
                ? 'settled in cash'
                : 'dropped — bonus shares are issued whole')
            : null,
      },
      transactions,
      holdingUpdate: {
        holdingId: holding.holdingId,
        quantity: quantityAfter,
        averageCost: averageCostAfter,
        marketValue: marketValueAfter,
      },
      newHolding: null,
    };
  }
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
