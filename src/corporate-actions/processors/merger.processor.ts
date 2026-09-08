/**
 * Mergers and acquisitions — PART 18.
 *
 * The client's old position ceases to exist and is replaced by some
 * combination of shares in the acquirer and cash. PART 18's worked example is
 * the general case: 1 old share becomes 0.75 new shares plus $10 cash.
 *
 * ── Two rows, because there are two economically distinct events ────────────
 *
 * PART 18 asks for both SECURITY_CONVERSION and CASH_CONSIDERATION, and the
 * reason to keep them separate is not tidiness. The share leg is
 * non-economic — value carries across from one security to another and no
 * money changes hands. The cash leg IS economic — real money arrives and must
 * reach the cash balance, the XIRR, and the capital-gains report. Merging them
 * into one row would force every downstream consumer to unpick which part of
 * the amount was real.
 *
 * ── Cost basis ──────────────────────────────────────────────────────────────
 *
 * The old position's basis carries over to the new shares, reduced by the
 * basis attributed to the cash received. In a taxable merger the cash portion
 * triggers a realised gain; computing that properly needs the tax-lot engine,
 * so what this does is the defensible accounting half — carry the residual
 * basis onto the new shares — and flag the gain for the desk rather than
 * inventing a figure.
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
export class MergerProcessor implements CorporateActionProcessor {
  readonly name = 'MergerProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;

    const details = (action.details ?? {}) as Record<string, unknown>;
    const exchangeRatio = numberOrNull(details.exchangeRatio) ?? 0;
    const cashPerShare = numberOrNull(details.cashPerShare) ?? action.cashAmount ?? 0;

    if (exchangeRatio <= 0 && cashPerShare <= 0) {
      throw new Error(
        `${action.symbol} ${action.actionType}: neither an exchange ratio nor cash consideration. ` +
          'Validation must run before processing.',
      );
    }

    // An all-cash acquisition needs no target symbol — the position simply
    // closes for cash. Only a share component requires one.
    if (exchangeRatio > 0 && !action.newSymbol?.trim()) {
      throw new Error(
        `${action.symbol} ${action.actionType}: newSymbol is required when shares are exchanged.`,
      );
    }

    return context.holdings
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) => this.planOne(holding, context, exchangeRatio, cashPerShare));
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    exchangeRatio: number,
    cashPerShare: number,
  ): PlannedClientChange {
    const { action, settings, runReference } = context;

    const currency = action.currency ?? holding.clientCurrency;
    const oldQuantity = holding.quantity;
    const oldTotalCost = normalize(oldQuantity * holding.averageCost);

    // ── Share leg ────────────────────────────────────────────────────────────
    const rawNewShares = normalize(oldQuantity * exchangeRatio);
    const newShares =
      settings.fractionalSharePolicy === 'RETAIN'
        ? rawNewShares
        : Math.floor(rawNewShares + 1e-9);
    const fractionalShares = normalize(rawNewShares - newShares);

    // ── Cash leg ─────────────────────────────────────────────────────────────
    const cashConsideration = normalize(oldQuantity * cashPerShare);

    /**
     * Basis attributed to the cash leg, split in proportion to the two legs'
     * relative consideration. With no market price for the acquirer's shares
     * in this book, the share leg is valued at the outgoing position's own
     * market value — the best available proxy, and one that at least makes the
     * split respond to the real cash/stock mix rather than being arbitrary.
     */
    const shareLegValue = normalize(newShares > 0 ? holding.marketValue : 0);
    const totalConsideration = normalize(shareLegValue + cashConsideration);
    const cashBasisShare =
      totalConsideration > 0 ? normalize(oldTotalCost * (cashConsideration / totalConsideration)) : 0;
    const carriedBasis = normalize(oldTotalCost - cashBasisShare);

    const newAverageCost = newShares > 0 ? normalize(carriedBasis / newShares) : 0;

    const newSymbol = action.newSymbol?.trim().toUpperCase() ?? null;
    const newCompany = action.newCompany?.trim() || newSymbol || holding.company;

    const transactions: PlannedTransaction[] = [];

    /**
     * Close the OLD position.
     *
     * A MERGER row with the full negative quantity, not a SELL: a SELL would
     * book proceeds equal to the market value and register a realised gain the
     * client did not choose to take, and the replay would credit cash that
     * never arrived.
     */
    transactions.push({
      clientId: holding.clientId,
      ticker: holding.ticker,
      type: action.actionType === 'ACQUISITION' ? 'ACQUISITION' : 'MERGER',
      quantity: normalize(-oldQuantity),
      price: null,
      amount: 0,
      date: action.effectiveDate,
      description:
        `${titleFor(action.actionType)} — ${trim(oldQuantity)} shares of ${holding.ticker} ` +
        `cancelled` +
        (newShares > 0 ? `, exchanged for ${trim(newShares)} shares of ${newSymbol}` : '') +
        (cashConsideration > 0 ? ` plus ${formatMoney(cashConsideration, currency)} cash` : ''),
      reference: runReference,
    });

    // Open the NEW position, where there is a share component.
    if (newShares > 1e-9 && newSymbol) {
      transactions.push({
        clientId: holding.clientId,
        ticker: newSymbol,
        type: action.actionType === 'ACQUISITION' ? 'ACQUISITION' : 'MERGER',
        quantity: newShares,
        price: null,
        // Non-economic: value carried across, no money moved.
        amount: 0,
        date: action.effectiveDate,
        description:
          `Security conversion — ${trim(newShares)} shares of ${newSymbol} received for ` +
          `${trim(oldQuantity)} shares of ${holding.ticker} at ${exchangeRatio} per share; ` +
          `cost basis carried at ${trim(newAverageCost)}/share`,
        reference: runReference,
      });
    }

    // The cash consideration — a real inflow, on its own row.
    if (cashConsideration > 0) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: 'CORPORATE_ACTION',
        quantity: null,
        price: cashPerShare,
        amount: cashConsideration,
        date: action.paymentDate ?? action.effectiveDate,
        description:
          `Cash consideration — ${formatMoney(cashPerShare, currency)}/share on ` +
          `${trim(oldQuantity)} shares of ${holding.ticker}`,
        reference: runReference,
      });
    }

    let cashInLieu = 0;
    if (fractionalShares > 1e-9 && settings.fractionalSharePolicy !== 'RETAIN') {
      cashInLieu = normalize(fractionalShares * newAverageCost);
      if (cashInLieu > 0) {
        transactions.push({
          clientId: holding.clientId,
          ticker: newSymbol ?? holding.ticker,
          type: 'CASH_IN_LIEU',
          quantity: null,
          price: null,
          amount: cashInLieu,
          date: action.paymentDate ?? action.effectiveDate,
          description: `Cash in lieu of ${trim(fractionalShares)} fractional share of ${newSymbol}`,
          reference: runReference,
        });
      }
    }

    const gainOnCash = cashConsideration > 0 ? normalize(cashConsideration - cashBasisShare) : 0;

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        quantityBefore: oldQuantity,
        // The OLD position goes to zero; the new one is reported via newHolding.
        quantityAfter: 0,
        averageCostBefore: holding.averageCost,
        averageCostAfter: 0,
        marketValueBefore: holding.marketValue,
        marketValueAfter: normalize(newShares * newAverageCost),
        cashImpact: normalize(cashConsideration + cashInLieu),
        currency,
        fractionalShares,
        status: 'READY',
        note:
          (newShares > 0
            ? `Receives ${trim(newShares)} ${newSymbol} at ${trim(newAverageCost)}/share carried basis`
            : `Position closed for cash`) +
          (gainOnCash !== 0
            ? `. Cash leg implies a realised gain of ${formatMoney(gainOnCash, currency)} — ` +
              'confirm tax treatment manually.'
            : ''),
      },
      transactions,
      // Close the outgoing position. It is set to zero rather than deleted:
      // deleting it would erase the row a historical report needs to explain
      // what happened, and the holdings screen already excludes zero positions.
      holdingUpdate: {
        holdingId: holding.holdingId,
        quantity: 0,
        averageCost: 0,
        marketValue: 0,
      },
      newHolding:
        newShares > 1e-9 && newSymbol
          ? {
              clientId: holding.clientId,
              ticker: newSymbol,
              company: newCompany,
              quantity: newShares,
              averageCost: newAverageCost,
              sector: holding.sector,
              industry: holding.industry,
              country: holding.country,
              exchange: holding.exchange,
            }
          : null,
    };
  }
}

function titleFor(actionType: string): string {
  return actionType === 'ACQUISITION' ? 'Acquisition' : 'Merger';
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
