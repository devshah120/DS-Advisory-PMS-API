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
 * Who gets paid is decided by who held the shares on the record date, and this
 * engine resolves that against the CURRENT holding rather than a
 * point-in-time reconstruction. That is a deliberate, documented limitation
 * rather than an oversight — see `entitledQuantity` for why, and what it costs.
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

    const isReturnOfCapital = action.actionType === 'RETURN_OF_CAPITAL';

    return context.holdings
      // PART 45 Test 7: a client with no shares generates no transaction at
      // all. Filtered here rather than producing a zero-amount row, because a
      // $0 dividend in the ledger is noise that every downstream report then
      // has to know to ignore.
      .filter((h) => Math.abs(h.quantity) > 1e-9)
      .map((holding) => this.planOne(holding, context, perShare, isReturnOfCapital));
  }

  private planOne(
    holding: AffectedHolding,
    context: ProcessorContext,
    perShare: number,
    isReturnOfCapital: boolean,
  ): PlannedClientChange {
    const { action, runReference } = context;

    const eligibleShares = this.entitledQuantity(holding, context);
    const gross = normalize(eligibleShares * perShare);

    const currency = action.currency ?? holding.clientCurrency;
    const paymentDate = action.paymentDate ?? action.effectiveDate;

    const transactions: PlannedTransaction[] = [
      {
        clientId: holding.clientId,
        ticker: holding.ticker,
        type: transactionTypeFor(action.actionType),
        // No shares change hands in a cash dividend. Null rather than 0 so the
        // row cannot be mistaken for a quantity event by anything replaying it.
        quantity: null,
        price: null,
        // Positive: cash INTO the portfolio. This one IS a real flow and
        // SHOULD reach performance — unlike a split, a dividend is economic.
        amount: gross,
        date: paymentDate,
        description:
          `${labelFor(action.actionType)} ${formatMoney(perShare, currency)}/share on ` +
          `${trim(eligibleShares)} shares of ${holding.ticker}` +
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
     */
    let averageCostAfter = holding.averageCost;
    let note: string | null = null;

    if (isReturnOfCapital) {
      const perShareReduction = perShare;
      const proposed = normalize(holding.averageCost - perShareReduction);

      if (proposed < 0) {
        averageCostAfter = 0;
        note =
          `Return of capital (${formatMoney(perShare, currency)}/share) exceeds the remaining ` +
          `cost basis of ${formatMoney(holding.averageCost, currency)}/share. Basis floored at zero; ` +
          `${formatMoney(perShareReduction - holding.averageCost, currency)}/share is a capital gain ` +
          'requiring manual treatment.';
      } else {
        averageCostAfter = proposed;
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
        cashImpact: gross,
        currency,
        fractionalShares: 0,
        status: 'READY',
        note,
      },
      transactions,
      // Only a return of capital touches the holding, and only its basis.
      holdingUpdate: isReturnOfCapital
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

  /**
   * Shares entitled to the distribution (PART 13's "applicable record/ex-date
   * entitlement rules").
   *
   * ── The limitation, stated plainly ─────────────────────────────────────────
   *
   * This returns the CURRENT quantity, not the quantity held on the record
   * date. For an action processed on or near its record date — which is the
   * normal case, since the scheduler sweeps daily — the two are identical.
   * They diverge only when an action is processed late AND the client traded
   * the name in between.
   *
   * Resolving it properly would mean replaying the client's ledger to the
   * record date for every holder on every dividend, i.e. a full
   * PortfolioReconstructionService call per client per action. That service
   * requires a PortfolioBaseline, which not every client has, and it would
   * turn a 40-holder dividend into 40 reconstructions inside an open database
   * transaction — a long-running write transaction is exactly what MongoDB
   * punishes hardest.
   *
   * So the trade is made explicitly: current quantity, with a WARNING surfaced
   * on the preview whenever the effective date is far enough in the past that
   * intervening trades are plausible. The desk sees the risk on the exact
   * actions where it applies, instead of paying the cost on every action where
   * it does not.
   */
  private entitledQuantity(holding: AffectedHolding, context: ProcessorContext): number {
    return holding.quantity;
  }
}

/** How stale an action can be before entitlement drift is worth warning about. */
export const ENTITLEMENT_STALENESS_DAYS = 5;

/**
 * Warning text when a cash action is processed long after its record date, so
 * the preview can say what the entitlement figure does and does not account
 * for. Returns null when the action is current and the question is moot.
 */
export function entitlementWarning(recordDate: Date | null, now = new Date()): string | null {
  if (!recordDate) return null;
  const days = Math.floor((now.getTime() - recordDate.getTime()) / (24 * 3600 * 1000));
  if (days <= ENTITLEMENT_STALENESS_DAYS) return null;

  return (
    `Record date was ${days} days ago. Entitlement is calculated from CURRENT share counts, ` +
    'so any client who bought or sold this name since the record date will be paid on the ' +
    'wrong quantity. Verify holders who traded in the interim.'
  );
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

function formatMoney(value: number, currency: string): string {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : '';
  return `${symbol}${normalize(value)}`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
