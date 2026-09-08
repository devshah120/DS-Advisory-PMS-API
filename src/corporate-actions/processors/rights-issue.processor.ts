/**
 * Rights issues — PART 16.
 *
 * ── What this processor deliberately does NOT do ────────────────────────────
 *
 * It does not subscribe. PART 16 is explicit — "do NOT automatically subscribe
 * unless the user explicitly enables automatic subscription" — and that
 * instruction is worth more than it first appears: subscribing spends the
 * client's money at a price the manager may not want to pay, on a security
 * they may be trying to exit. A rights issue is an OPTION granted to the
 * holder, and an engine that exercised options on a client's behalf overnight
 * would be making investment decisions.
 *
 * So this records the ENTITLEMENT and stops. The rights sit on the ledger as a
 * RIGHTS_ENTITLEMENT row carrying no cash and no shares, which is exactly what
 * an unexercised right is worth to the portfolio's accounting until someone
 * decides. Subscription is a separate, explicitly-invoked action
 * (`subscribe()` on the service), which writes the RIGHTS_SUBSCRIPTION row
 * that does move cash and shares.
 */
import { Injectable } from '@nestjs/common';
import { normalize, rightsEntitlement } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  ProcessorContext,
} from './processor.interface';

@Injectable()
export class RightsIssueProcessor implements CorporateActionProcessor {
  readonly name = 'RightsIssueProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;

    const details = (action.details ?? {}) as Record<string, unknown>;
    const subscriptionRatio = numberOrNull(details.subscriptionRatio);
    const subscriptionPrice = numberOrNull(details.subscriptionPrice);

    if (subscriptionRatio === null || subscriptionRatio <= 0) {
      throw new Error(
        `${action.symbol} RIGHTS_ISSUE: subscriptionRatio is missing or non-positive. ` +
          'Validation must run before processing.',
      );
    }

    /**
     * `subscriptionRatio` is normalised at ingest to RIGHTS PER SHARE HELD —
     * "1 right for every 10 shares" is 0.1. Feeds quote it both ways, and
     * normalising at the boundary keeps one convention inside the engine (the
     * same discipline as spin-off distribution ratios).
     */
    return context.holdings
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) => this.planOne(holding, context, subscriptionRatio, subscriptionPrice));
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    subscriptionRatio: number,
    subscriptionPrice: number | null,
  ): PlannedClientChange {
    const { action, runReference } = context;

    // rightsEntitlement takes (new, for) — here "1 right per 1/ratio shares".
    const { rights, fractional } = rightsEntitlement(holding.quantity, subscriptionRatio, 1);

    const currency = action.currency ?? holding.clientCurrency;
    const cost = subscriptionPrice !== null ? normalize(rights * subscriptionPrice) : null;

    const details = (action.details ?? {}) as Record<string, unknown>;
    const window = [details.subscriptionStart, details.subscriptionEnd]
      .filter(Boolean)
      .map((d) => String(d).slice(0, 10))
      .join(' to ');

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        // An entitlement changes nothing about the position it derives from.
        quantityBefore: holding.quantity,
        quantityAfter: holding.quantity,
        averageCostBefore: holding.averageCost,
        averageCostAfter: holding.averageCost,
        marketValueBefore: holding.marketValue,
        marketValueAfter: holding.marketValue,
        // No cash moves until the client actually subscribes.
        cashImpact: 0,
        currency,
        fractionalShares: fractional,
        status: 'READY',
        note:
          `${rights} right(s) entitled` +
          (cost !== null ? `; ${formatMoney(cost, currency)} to take up in full` : '') +
          (window ? `; subscription window ${window}` : '') +
          '. Not subscribed — requires explicit instruction.',
      },
      transactions: [
        {
          clientId: holding.clientId,
          ticker: holding.ticker,
          type: 'RIGHTS_ENTITLEMENT',
          // Rights are not shares. Recording them in `quantity` would let the
          // reconstruction replay add them to the share count, inventing a
          // position the client does not own.
          quantity: null,
          price: subscriptionPrice,
          // No money has moved; an entitlement is an option, not a purchase.
          amount: 0,
          date: action.exDate ?? action.effectiveDate,
          description:
            `Rights issue entitlement — ${rights} right(s) on ${trim(holding.quantity)} shares of ` +
            `${holding.ticker}` +
            (subscriptionPrice !== null
              ? ` at ${formatMoney(subscriptionPrice, currency)} per share`
              : '') +
            (fractional > 1e-9 ? `; ${trim(fractional)} fractional right lapsed` : '') +
            '. Unexercised.',
          reference: runReference,
        },
      ],
      // The underlying position is untouched.
      holdingUpdate: null,
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
