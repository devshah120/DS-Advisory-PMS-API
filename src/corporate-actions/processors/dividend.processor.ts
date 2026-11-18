/**
 * Cash dividends, special dividends, cash distributions and return of capital
 * — PART 13, 15 and the cash half of PART 22.
 *
 * ── The one accounting distinction that matters here ────────────────────────
 *
 * A DIVIDEND is income: cash arrives and the cost basis of the position is
 * untouched (PART 13's "do not modify average cost").
 *
 * A RETURN OF CAPITAL is not income: the company is handing back part of what
 * was invested, so the cash arrives AND the cost basis falls by the same
 * amount. Booking one as the other overstates income and understates the gain
 * on a later sale — a real tax error, not a cosmetic one, which is why the two
 * share a processor but not a code path.
 *
 * ── Entitlement ─────────────────────────────────────────────────────────────
 *
 * Paid on the shares held at the close before the ex-date, never on today's
 * holding. CorporateActionService works that figure out from the ledger, both
 * for current holders and for clients who held on the ex-date but have sold out
 * since, and attaches it as `holding.entitlement` (see dividend-entitlement.ts).
 * A BLOCKED entitlement is planned with no transactions so the preview can show
 * it, and `process()` refuses to commit a run that contains one.
 *
 * ── Withholding ─────────────────────────────────────────────────────────────
 *
 * Income (DIVIDEND, SPECIAL_DIVIDEND) is booked NET of the client's flat
 * withholding rate. The ledger amount is the cash that actually arrived, which
 * is what every valuation and XIRR series has to see. Gross and tax go in the
 * description. A return of capital is not income, so nothing is withheld here.
 * CASH_DISTRIBUTION is also left gross, because it is unclassified until a
 * reviewer decides what it is.
 */
import { Injectable } from '@nestjs/common';
import { Eligibility, settle } from '../dividend-entitlement';
import { normalize } from '../ratio';
import {
  AffectedHolding,
  CorporateActionProcessor,
  PlannedClientChange,
  PlannedTransaction,
  ProcessorContext,
} from './processor.interface';

/** Distributions that are income, and so are paid net of withholding tax. */
const WITHHELD_TYPES = new Set(['DIVIDEND', 'SPECIAL_DIVIDEND']);

@Injectable()
export class DividendProcessor implements CorporateActionProcessor {
  readonly name = 'DividendProcessor';

  plan(context: ProcessorContext): PlannedClientChange[] {
    const { action } = context;
    const perShare = action.cashAmount;

    if (perShare === null || perShare === undefined || !Number.isFinite(perShare)) {
      throw new Error(
        `${action.symbol} ${action.actionType}: no amount per share. Validation must run first.`,
      );
    }

    return context.holdings.flatMap((holding) => {
      const entitlement = holding.entitlement;
      if (!entitlement) {
        throw new Error(
          `${action.symbol} ${action.actionType}: no ex-date entitlement for ${holding.clientName}. ` +
            'Dividends are paid on shares held on the ex-date, never on the current holding.',
        );
      }

      // PART 45 Test 7: a client with no shares generates no transaction at
      // all, rather than a $0 row that every downstream report then has to
      // know to ignore. A BLOCKED entitlement is kept so the preview shows it.
      if (entitlement.status === 'OK' && Math.abs(entitlement.shares) <= 1e-9) return [];

      return [this.planOne(holding, context, perShare, entitlement)];
    });
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    perShare: number,
    entitlement: Eligibility,
  ): PlannedClientChange {
    const { action, runReference } = context;

    const isReturnOfCapital = action.actionType === 'RETURN_OF_CAPITAL';
    const isFormerHolder = holding.holdingId === '';
    const blocked = entitlement.status === 'BLOCKED';
    const shares = entitlement.shares;

    const withholdingRate = WITHHELD_TYPES.has(action.actionType)
      ? (holding.dividendWithholdingRate ?? 0)
      : 0;
    const { gross, withheld, net } = settle(shares, perShare, withholdingRate);

    const currency = action.currency ?? holding.clientCurrency;
    const paymentDate = action.paymentDate ?? action.effectiveDate;

    const notes = [...entitlement.notes];
    if (isFormerHolder) {
      notes.push(`Held ${trim(shares)} shares on the ex-date; the position has since been closed.`);
    } else if (Math.abs(shares - holding.quantity) > 1e-9) {
      notes.push(
        `Paid on the ${trim(shares)} shares held on the ex-date, not the ${trim(holding.quantity)} held today.`,
      );
    }

    const transactions: PlannedTransaction[] = blocked
      ? []
      : [
          {
            clientId: holding.clientId,
            ticker: holding.ticker,
            type: transactionTypeFor(action.actionType),
            // No shares change hands in a cash dividend. Null rather than 0 so the
            // row cannot be mistaken for a quantity event by anything replaying it.
            quantity: null,
            price: null,
            // NET and positive: the cash that actually arrived. This one IS a
            // real flow and SHOULD reach performance — unlike a split, a
            // dividend is economic. flows.ts gives it its sign.
            amount: net,
            date: paymentDate,
            description:
              `${labelFor(action.actionType)} ${formatMoney(perShare, currency)}/share on ` +
              `${trim(shares)} shares of ${holding.ticker}` +
              (withheld > 0
                ? `: gross ${formatCash(gross, currency)}, withholding ` +
                  `${normalize(withholdingRate * 100)}% ${formatCash(withheld, currency)}, ` +
                  `net ${formatCash(net, currency)}`
                : '') +
              (isReturnOfCapital ? ' (reduces cost basis)' : ''),
            reference: runReference,
          },
        ];

    /**
     * Return of capital reduces the basis rather than booking income.
     *
     * The reduction is floored at zero: once basis is exhausted, further
     * distributions are a capital gain, not a negative cost. Modelling that
     * gain properly needs the tax-lot engine (analytics/calculators/tax-lots),
     * so the excess is surfaced as a note for the desk rather than silently
     * producing a negative average cost that would corrupt every gain figure
     * that touches the position.
     *
     * A former holder has no holding left to adjust: the basis that should
     * fall belonged to shares already sold, which only the desk can rework.
     */
    let averageCostAfter = holding.averageCost;
    let basisReduction: number | undefined;
    const adjustBasis = isReturnOfCapital && !isFormerHolder && !blocked;

    if (isReturnOfCapital && isFormerHolder) {
      notes.push(
        'Return of capital on a closed position: the basis reduction belongs to shares already ' +
          'sold and needs manual treatment.',
      );
    }

    if (adjustBasis) {
      // Basis falls only for entitled shares that are still held. Shares bought
      // after the ex-date received nothing, and shares sold since took their
      // basis with them when they went.
      const stillHeld = Math.min(shares, holding.quantity);
      const costBefore = holding.quantity * holding.averageCost;
      const returned = stillHeld * perShare;
      basisReduction = normalize(Math.min(costBefore, returned));
      averageCostAfter =
        holding.quantity > 0 ? normalize((costBefore - basisReduction) / holding.quantity) : 0;

      if (returned > costBefore + 1e-9) {
        notes.push(
          `Return of capital (${formatMoney(perShare, currency)}/share) exceeds the remaining ` +
            `cost basis of ${formatMoney(holding.averageCost, currency)}/share. Basis floored at zero; ` +
            `${formatCash(returned - costBefore, currency)} is a capital gain requiring manual treatment.`,
        );
      }

      if (shares > holding.quantity + 1e-9) {
        notes.push(
          `${trim(shares - holding.quantity)} of the entitled shares were sold after the ex-date; the ` +
            'return of capital on those belongs to closed lots and needs manual treatment.',
        );
      }
    }

    const quantityUnchanged = holding.quantity;
    const marketValueAfter = normalize(quantityUnchanged * holding.currentPrice);

    return {
      impact: {
        clientId: holding.clientId,
        clientName: holding.clientName,
        symbol: holding.ticker,
        quantityBefore: holding.quantity,
        // A cash action never changes the share count (PART 13).
        quantityAfter: holding.quantity,
        averageCostBefore: holding.averageCost,
        averageCostAfter,
        marketValueBefore: holding.marketValue,
        marketValueAfter,
        cashImpact: blocked ? 0 : net,
        currency,
        fractionalShares: 0,
        ...(basisReduction !== undefined ? { basisReduction } : {}),
        status: blocked ? 'BLOCKED' : 'READY',
        note: notes.length > 0 ? notes.join(' ') : null,
      },
      transactions,
      // Only a return of capital touches the holding, and only its basis.
      holdingUpdate: adjustBasis
        ? {
            holdingId: holding.holdingId,
            quantity: holding.quantity,
            averageCost: averageCostAfter,
            marketValue: marketValueAfter,
          }
        : null,
      newHolding: null,
    };
  }
}

function transactionTypeFor(actionType: string) {
  switch (actionType) {
    case 'SPECIAL_DIVIDEND':
      return 'SPECIAL_DIVIDEND' as const;
    case 'RETURN_OF_CAPITAL':
      return 'RETURN_OF_CAPITAL' as const;
    case 'CASH_DISTRIBUTION':
      return 'CORPORATE_ACTION' as const;
    default:
      // Plain DIVIDEND — the type the Transactions module and the replay have
      // always used, so dividend history stays homogeneous whether a row was
      // keyed by hand or written by this engine.
      return 'DIVIDEND' as const;
  }
}

function labelFor(actionType: string): string {
  switch (actionType) {
    case 'SPECIAL_DIVIDEND':
      return 'Special dividend';
    case 'RETURN_OF_CAPITAL':
      return 'Return of capital';
    case 'CASH_DISTRIBUTION':
      return 'Cash distribution';
    default:
      return 'Dividend';
  }
}

function currencySymbol(currency: string): string {
  return currency === 'INR' ? '₹' : currency === 'USD' ? '$' : '';
}

/** A per-share rate, at full precision: 0.1925 must not print as 0.19. */
function formatMoney(value: number, currency: string): string {
  return `${currencySymbol(currency)}${normalize(value)}`;
}

/** A cash total, to the cent or paisa. */
function formatCash(value: number, currency: string): string {
  return `${currencySymbol(currency)}${value.toFixed(2)}`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
