/**
 * Ticker changes, company name changes and exchange changes — PART 19, 20, 21.
 *
 * These three share a processor because they are one operation: relabelling a
 * security without touching the economics. No shares move, no cash moves, no
 * basis changes. PART 19 states it directly — "this must NOT create a new
 * economic position".
 *
 * ── The hard constraint, and how it is met ──────────────────────────────────
 *
 * PART 19: "Historical records must continue to display the old symbol before
 * the effective date. New records should use the new symbol. NEVER rewrite
 * historical transactions."
 *
 * So this processor updates the CURRENT Holding row's ticker and writes a
 * marker Transaction — and deliberately does NOT touch the existing
 * Transaction rows. A client who bought ABC keeps a BUY row that says ABC
 * forever, which is what makes a report dated before the change still read
 * ABC.
 *
 * ── The consequence that has to be handled, not ignored ─────────────────────
 *
 * Leaving history alone has a cost: PortfolioReconstructionService replays
 * transactions keyed by ticker, so after a rename the old BUY rows (ABC) and
 * the new ones (XYZ) build two separate positions, and a reconstruction spanning
 * the change reports both — the client appears to hold ABC they no longer own
 * and XYZ they never bought.
 *
 * The fix is NOT to rewrite the old rows. It is to teach the replay that ABC
 * and XYZ are the same security across a date boundary, which is exactly what
 * `InstrumentProfile.previousSymbols` and the TICKER_CHANGE ledger row exist
 * for — the alias is applied at replay time, so history stays honest on disk
 * and reads correctly on screen. See `symbol-alias.ts`.
 */
import { Injectable } from '@nestjs/common';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class TickerChangeProcessor implements CorporateActionProcessor {
  readonly name = 'TickerChangeProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;

    const isSymbolChange = action.actionType === 'TICKER_CHANGE';

    if (isSymbolChange && !action.newSymbol?.trim()) {
      throw new Error(`${action.symbol} TICKER_CHANGE: newSymbol is required.`);
    }

    return context.holdings.map((holding) => this.planOne(holding, context, isSymbolChange));
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    isSymbolChange: boolean,
  ): PlannedClientChange {
    const { action, runReference } = context;

    const details = (action.details ?? {}) as Record<string, unknown>;

    const newTicker = isSymbolChange
      ? action.newSymbol!.trim().toUpperCase()
      : holding.ticker;
    const newCompany = action.newCompany?.trim() || holding.company;
    const newExchange =
      action.actionType === 'EXCHANGE_CHANGE'
        ? String(details.newExchange ?? holding.exchange)
        : holding.exchange;

    const description = this.describe(action.actionType, holding, {
      newTicker,
      newCompany,
      newExchange,
      oldExchange: String(details.oldExchange ?? holding.exchange),
    });

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        // Every economic field is identical either side. That is the point.
        quantityBefore: holding.quantity,
        quantityAfter: holding.quantity,
        averageCostBefore: holding.averageCost,
        averageCostAfter: holding.averageCost,
        marketValueBefore: holding.marketValue,
        marketValueAfter: holding.marketValue,
        cashImpact: 0,
        currency: holding.clientCurrency,
        fractionalShares: 0,
        status: 'READY',
        note: description,
      },
      transactions: [
        {
          clientId: holding.clientId,
          // Stamped with the NEW symbol so the row sorts with the position it
          // now describes. The OLD symbol survives in the description and, more
          // importantly, in every pre-existing transaction row — untouched.
          ticker: newTicker,
          type: 'TICKER_CHANGE',
          // No shares, no money. A relabelling is not a transaction in any
          // economic sense; this row exists purely so the ledger can explain
          // why the symbol differs either side of a date.
          quantity: null,
          price: null,
          amount: 0,
          date: action.effectiveDate,
          description,
          reference: runReference,
        },
      ],
      holdingUpdate: {
        holdingId: holding.holdingId,
        // Unchanged — passed through so the update is a single write.
        quantity: holding.quantity,
        averageCost: holding.averageCost,
        marketValue: holding.marketValue,
        ticker: newTicker,
        company: newCompany,
        exchange: newExchange,
      },
      newHolding: null,
    };
  }

  private describe(
    actionType: string,
    holding: AffectedHolding,
    next: { newTicker: string; newCompany: string; newExchange: string; oldExchange: string },
  ): string {
    switch (actionType) {
      case 'TICKER_CHANGE':
        return (
          `Ticker change — ${holding.ticker} became ${next.newTicker} ` +
          `(no change to quantity, cost or value). Transactions before this date retain ${holding.ticker}.`
        );
      case 'NAME_CHANGE':
        return (
          `Company name change — "${holding.company}" became "${next.newCompany}". ` +
          'Historical records retain the name in force at the time.'
        );
      case 'EXCHANGE_CHANGE':
        return (
          `Exchange change — ${holding.ticker} moved from ${next.oldExchange} to ` +
          `${next.newExchange}. Not a trade; quantity, cost and value are unchanged.`
        );
      default:
        return `Security master update for ${holding.ticker}.`;
    }
  }
}
