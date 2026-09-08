/**
 * Spin-offs — PART 17.
 *
 * The client ends up holding a security they never bought. PART 17's
 * instruction — "do not treat the new security as a purchase" — is the whole
 * design constraint: a BUY row would record a cash outflow that never
 * happened, and the client's cash balance and XIRR would both be wrong.
 *
 * ── Cost basis allocation, and why the default is what it is ────────────────
 *
 * Strictly, a spin-off splits the parent's existing basis between parent and
 * child in proportion to their relative fair market values immediately after
 * the distribution — the ratio the issuer publishes in a Form 8937, typically
 * weeks later.
 *
 * Until that figure exists there is no defensible way to compute it, and
 * guessing produces a number that looks authoritative and is wrong. So the
 * default here allocates ZERO basis to the spun-off shares and leaves the
 * parent's basis whole, with the allocation surfaced as a note for the desk to
 * correct once the 8937 lands. That is conservative in the direction that
 * matters: it overstates the eventual gain on the child rather than
 * understating it, and it never silently reduces a parent position's basis on
 * the strength of a number nobody published.
 *
 * When the ratio IS known it is passed in `details.basisAllocationPercent` and
 * this processor applies it properly.
 */
import { Injectable } from '@nestjs/common';
import { normalize, spinOffShares } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  PlannedTransaction,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class SpinOffProcessor implements CorporateActionProcessor {
  readonly name = 'SpinOffProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;

    const details = (action.details ?? {}) as Record<string, unknown>;
    const distributionRatio = numberOrNull(details.distributionRatio);

    if (distributionRatio === null || distributionRatio <= 0) {
      throw new Error(
        `${action.symbol} SPIN_OFF: distributionRatio missing or non-positive. ` +
          'Validation must run before processing.',
      );
    }

    if (!action.newSymbol?.trim()) {
      throw new Error(`${action.symbol} SPIN_OFF: newSymbol is required.`);
    }

    /**
     * Percentage of the PARENT's basis that transfers to the spun-off shares.
     * Zero by default — see the header note.
     */
    const basisAllocationPercent = numberOrNull(details.basisAllocationPercent) ?? 0;

    return context.holdings
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) =>
        this.planOne(holding, context, distributionRatio, basisAllocationPercent),
      );
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    distributionRatio: number,
    basisAllocationPercent: number,
  ): PlannedClientChange {
    const { action, settings, runReference } = context;

    const newSymbol = action.newSymbol!.trim().toUpperCase();
    const newCompany = action.newCompany?.trim() || newSymbol;

    const rawNewShares = spinOffShares(holding.quantity, distributionRatio);
    const newShares =
      settings.fractionalSharePolicy === 'RETAIN'
        ? rawNewShares
        : Math.floor(rawNewShares + 1e-9);
    const fractionalShares = normalize(rawNewShares - newShares);

    // Basis moved from parent to child, if the allocation is known.
    const parentTotalCost = normalize(holding.quantity * holding.averageCost);
    const transferredCost = normalize(parentTotalCost * (basisAllocationPercent / 100));
    const parentTotalCostAfter = normalize(parentTotalCost - transferredCost);

    const parentAverageCostAfter =
      holding.quantity > 0 ? normalize(parentTotalCostAfter / holding.quantity) : 0;
    const childAverageCost = newShares > 0 ? normalize(transferredCost / newShares) : 0;

    const transactions: PlannedTransaction[] = [];

    if (newShares > 1e-9) {
      transactions.push({
        clientId: holding.clientId,
        // The row is stamped with the NEW security's symbol: it is that
        // position's opening entry, and a historical replay must attribute the
        // shares to the child, not the parent.
        ticker: newSymbol,
        // SPINOFF, never BUY (PART 17).
        type: 'SPINOFF',
        quantity: newShares,
        price: null,
        // Received for no consideration.
        amount: 0,
        date: action.effectiveDate,
        description:
          `Spin-off from ${holding.ticker} — ${trim(newShares)} shares of ${newSymbol} received ` +
          `on ${trim(holding.quantity)} parent shares` +
          (basisAllocationPercent > 0
            ? `; ${basisAllocationPercent}% of cost basis allocated`
            : '; no cost basis allocated (pending issuer allocation)'),
        reference: runReference,
      });
    }

    let cashInLieu = 0;
    if (fractionalShares > 1e-9 && settings.fractionalSharePolicy === 'CASH_IN_LIEU') {
      // The child has no market price in this book yet, so a fractional share
      // of it can only be valued at its allocated basis.
      cashInLieu = normalize(fractionalShares * childAverageCost);
      if (cashInLieu > 0) {
        transactions.push({
          clientId: holding.clientId,
          ticker: newSymbol,
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

    /**
     * A basis reallocation is recorded against the PARENT as its own row, so
     * the ledger explains why the parent's average cost moved without a trade.
     * Written only when there is something to explain.
     */
    if (transferredCost > 0) {
      transactions.push({
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: 'CORPORATE_ACTION',
        quantity: null,
        price: null,
        amount: 0,
        date: action.effectiveDate,
        description:
          `Cost basis reallocation for the ${newSymbol} spin-off — ` +
          `${basisAllocationPercent}% of ${holding.ticker} basis transferred; ` +
          `average cost ${trim(holding.averageCost)} → ${trim(parentAverageCostAfter)}`,
        reference: runReference,
      });
    }

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        // The parent share COUNT is unchanged by a spin-off.
        quantityBefore: holding.quantity,
        quantityAfter: holding.quantity,
        averageCostBefore: holding.averageCost,
        averageCostAfter: parentAverageCostAfter,
        marketValueBefore: holding.marketValue,
        marketValueAfter: holding.marketValue,
        cashImpact: cashInLieu,
        currency: holding.clientCurrency,
        fractionalShares,
        status: 'READY',
        note:
          `Receives ${trim(newShares)} shares of ${newSymbol}` +
          (basisAllocationPercent === 0
            ? '. No cost basis allocated — update once the issuer publishes the allocation.'
            : `; ${basisAllocationPercent}% of basis allocated to ${newSymbol}.`),
      },
      transactions,
      holdingUpdate:
        transferredCost > 0
          ? {
              holdingId: holding.holdingId,
              quantity: holding.quantity,
              averageCost: parentAverageCostAfter,
              marketValue: holding.marketValue,
            }
          : null,
      newHolding:
        newShares > 1e-9
          ? {
              clientId: holding.clientId,
              ticker: newSymbol,
              company: newCompany,
              quantity: newShares,
              averageCost: childAverageCost,
              // Inherit the parent's classification: a spun-off division is
              // usually in a related line of business, and an inherited sector
              // is a better default than 'Unclassified'. The desk can correct
              // it, and the classification service will refresh it.
              sector: holding.sector,
              industry: holding.industry,
              country: holding.country,
              exchange: holding.exchange,
            }
          : null,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
