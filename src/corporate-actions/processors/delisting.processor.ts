/**
 * Delistings — PART 22.
 *
 * A delisting is the one corporate action where doing nothing is sometimes
 * correct, and knowing which case applies matters more than the arithmetic:
 *
 *  - CASH SETTLEMENT: shareholders are bought out at a stated price. The
 *    position closes and real cash arrives. Economically identical to a
 *    forced sale, and it must reach the cash balance and the gain report.
 *
 *  - REPLACEMENT SECURITY: the listing moved (a re-domicile, a holding-company
 *    reorganisation). Handled as a conversion, not a closure.
 *
 *  - NEITHER: the company failed and the shares are worthless, or they moved
 *    to an over-the-counter market this system does not price. The position is
 *    written to zero value but NOT deleted, and that distinction is deliberate
 *    — a client whose holding went to zero needs the loss on their statement,
 *    and deleting the row would make the money look like it was never there.
 */
import { Injectable } from '@nestjs/common';
import { normalize } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  PlannedTransaction,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class DelistingProcessor implements CorporateActionProcessor {
  readonly name = 'DelistingProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    return context.holdings
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) => this.planOne(holding, context));
  }

  private planOne(holding: AffectedHolding, context: ProcessorContext): PlannedClientChange {
    const { action, runReference } = context;

    const details = (action.details ?? {}) as Record<string, unknown>;
    const cashSettlementPerShare =
      numberOrNull(details.cashSettlement) ?? numberOrNull(action.cashAmount) ?? 0;
    const reason = String(details.reason ?? 'not stated');
    const replacementSymbol =
      (action.newSymbol?.trim() || String(details.replacementSymbol ?? '')).toUpperCase() || null;

    const currency = action.currency ?? holding.clientCurrency;
    const totalCost = normalize(holding.quantity * holding.averageCost);
    const proceeds = normalize(holding.quantity * cashSettlementPerShare);

    const transactions: PlannedTransaction[] = [];

    // Close the position — shares cease to exist as a tradable holding.
    transactions.push({
      clientId: holding.clientId,
      ticker: holding.ticker,
      type: 'DELISTING_SETTLEMENT',
      quantity: normalize(-holding.quantity),
      price: cashSettlementPerShare > 0 ? cashSettlementPerShare : null,
      // The share leg carries no cash; the settlement is its own row below, so
      // the two legs stay separable for the same reason as in a merger.
      amount: 0,
      date: action.effectiveDate,
      description:
        `Delisting of ${holding.ticker} (${reason}) — ${trim(holding.quantity)} shares removed` +
        (cashSettlementPerShare > 0
          ? ` at ${formatMoney(cashSettlementPerShare, currency)}/share cash settlement`
          : replacementSymbol
            ? `, replaced by ${replacementSymbol}`
            : '; no settlement — position written to zero'),
      reference: runReference,
    });

    if (proceeds > 0) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: 'DELISTING_SETTLEMENT',
        quantity: null,
        price: cashSettlementPerShare,
        // Real money: this leg DOES belong in cash flow and performance.
        amount: proceeds,
        date: action.paymentDate ?? action.effectiveDate,
        description:
          `Delisting cash settlement — ${formatMoney(proceeds, currency)} on ` +
          `${trim(holding.quantity)} shares of ${holding.ticker} ` +
          `(cost basis ${formatMoney(totalCost, currency)})`,
        reference: runReference,
      });
    }

    const realised = proceeds > 0 ? normalize(proceeds - totalCost) : normalize(-totalCost);

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        quantityBefore: holding.quantity,
        quantityAfter: replacementSymbol ? holding.quantity : 0,
        averageCostBefore: holding.averageCost,
        averageCostAfter: replacementSymbol ? holding.averageCost : 0,
        marketValueBefore: holding.marketValue,
        marketValueAfter: 0,
        cashImpact: proceeds,
        currency,
        fractionalShares: 0,
        status: 'READY',
        note:
          (proceeds > 0
            ? `Settled for ${formatMoney(proceeds, currency)}`
            : replacementSymbol
              ? `Replaced by ${replacementSymbol}`
              : 'No settlement — position written to zero') +
          `. Realised ${realised >= 0 ? 'gain' : 'loss'} ${formatMoney(Math.abs(realised), currency)}.`,
      },
      transactions,
      holdingUpdate: replacementSymbol
        ? {
            holdingId: holding.holdingId,
            quantity: holding.quantity,
            averageCost: holding.averageCost,
            marketValue: holding.marketValue,
            ticker: replacementSymbol,
          }
        : {
            holdingId: holding.holdingId,
            quantity: 0,
            averageCost: 0,
            marketValue: 0,
          },
      newHolding: null,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatMoney(value: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : '';
  return `${symbol}${normalize(value)}`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
