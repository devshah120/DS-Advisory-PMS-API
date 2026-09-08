/**
 * PART 6 — everything that must be true before an action may touch a holding.
 *
 * The validator's contract is narrow and worth stating: it decides whether an
 * action is COHERENT, not whether it is TRUE. It cannot tell you that Amphenol
 * really did announce a split; it can tell you that a split with a zero ratio,
 * a record date after its effective date, or no source at all must never be
 * processed. Truth is what the source hierarchy and the human review are for.
 *
 * Findings are graded. An ERROR blocks processing outright; a WARNING is
 * recorded, shown in the Review Center, and processed through. That grading is
 * the difference between a validator people trust and one they learn to
 * click past: a missing announcement date is not a reason to refuse to
 * process a well-sourced split, but a missing ratio is.
 */
import { Injectable } from '@nestjs/common';
import { CorporateAction, CorporateActionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  CASH_TYPES,
  ENTITLEMENT_TYPES,
  RATIO_TYPES,
} from './corporate-action.dedupe';
import { ValidationFinding, ValidationOutcome } from './corporate-action.types';

/** Actions that must name a target security to mean anything. */
const REQUIRES_NEW_SYMBOL: ReadonlySet<CorporateActionType> = new Set([
  'SPIN_OFF',
  'MERGER',
  'ACQUISITION',
  'TICKER_CHANGE',
] as CorporateActionType[]);

@Injectable()
export class CorporateActionValidator {
  constructor(private prisma: PrismaService) {}

  /**
   * Runs every check against a stored action.
   *
   * Takes the row rather than an id so the caller does the one fetch it was
   * making anyway — the same convention as canAccessClient in ownership-scope.
   */
  async validate(action: CorporateAction): Promise<ValidationOutcome> {
    const findings: ValidationFinding[] = [];

    findings.push(...this.checkSymbol(action));
    findings.push(...this.checkDates(action));
    findings.push(...this.checkRatio(action));
    findings.push(...this.checkCash(action));
    findings.push(...this.checkTargetSecurity(action));
    findings.push(...this.checkSource(action));
    findings.push(...this.checkConflict(action));

    findings.push(...(await this.checkSecurityExists(action)));
    findings.push(...(await this.checkDuplicate(action)));

    return {
      valid: !findings.some((f) => f.severity === 'ERROR'),
      findings,
    };
  }

  // ── Symbol ────────────────────────────────────────────────────────────────

  private checkSymbol(action: CorporateAction): ValidationFinding[] {
    if (!action.symbol || !action.symbol.trim()) {
      return [
        {
          code: 'SYMBOL_MISSING',
          severity: 'ERROR',
          field: 'symbol',
          message: 'Corporate action has no symbol; it cannot be matched to any holding.',
        },
      ];
    }
    return [];
  }

  /**
   * "Security exists" (PART 6), interpreted against this codebase rather than
   * literally.
   *
   * A hard requirement that InstrumentProfile hold the symbol would reject
   * every Indian action, because that table is populated by the US workbook
   * importer alone. What actually matters is whether the symbol is one this
   * firm has any exposure to — so the check is: does any Holding, any
   * Watchlist row, or any InstrumentProfile know this symbol?
   *
   * A symbol nobody holds or watches is a WARNING, not an error. Ingesting an
   * action for a stock the firm is about to buy is useful; refusing to store
   * it means the first client to buy in has no history.
   */
  private async checkSecurityExists(action: CorporateAction): Promise<ValidationFinding[]> {
    if (!action.symbol?.trim()) return [];

    const symbol = action.symbol.trim().toUpperCase();

    const [holding, profile, watchlist] = await Promise.all([
      this.prisma.holding.findFirst({ where: { ticker: symbol }, select: { id: true } }),
      this.prisma.instrumentProfile.findUnique({
        where: { symbol },
        select: { id: true },
      }),
      this.prisma.watchlist.findFirst({ where: { ticker: symbol }, select: { id: true } }),
    ]);

    if (holding || profile || watchlist) return [];

    return [
      {
        code: 'SECURITY_UNKNOWN',
        severity: 'WARNING',
        field: 'symbol',
        message:
          `No client holds ${symbol}, and it is not in the watchlist or instrument master. ` +
          'The action is stored for the record but will affect no positions.',
      },
    ];
  }

  // ── Dates ─────────────────────────────────────────────────────────────────

  /**
   * PART 6's date rules.
   *
   * The record-date-vs-effective-date rule is stated in the spec with an
   * escape hatch — "unless legitimately applicable" — and that hedge is
   * correct: for a rights issue or a dividend the record date genuinely
   * precedes the payment by weeks, while for a split the two are days apart.
   * So the check is graded rather than absolute: a record date AFTER the
   * effective date is a WARNING for entitlement-driven actions (where a late
   * record date can be legitimate) and an ERROR for a ratio action, where it
   * indicates the two dates were transposed at ingest.
   */
  private checkDates(action: CorporateAction): ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const { recordDate, exDate, effectiveDate, paymentDate, announcementDate } = action;

    if (!effectiveDate || Number.isNaN(effectiveDate.getTime())) {
      findings.push({
        code: 'EFFECTIVE_DATE_MISSING',
        severity: 'ERROR',
        field: 'effectiveDate',
        message: 'Effective date is required — it is the date holdings change on.',
      });
      return findings;
    }

    if (recordDate && recordDate > effectiveDate) {
      const ratioDriven = RATIO_TYPES.has(action.actionType);
      findings.push({
        code: 'RECORD_AFTER_EFFECTIVE',
        severity: ratioDriven ? 'ERROR' : 'WARNING',
        field: 'recordDate',
        message:
          `Record date (${iso(recordDate)}) is after the effective date (${iso(effectiveDate)}). ` +
          (ratioDriven
            ? 'For a ratio action this normally means the two dates were transposed.'
            : 'Permitted for entitlement actions, but verify against the source.'),
      });
    }

    /**
     * The ex-date is when the share starts trading without the entitlement, so
     * it falls ON or ONE DAY BEFORE the record date under T+1 settlement, and
     * up to two days before under the older T+2 convention still used in some
     * markets. An ex-date AFTER the record date is inconsistent by definition.
     */
    if (exDate && recordDate && exDate > recordDate) {
      const daysAfter = dayGap(recordDate, exDate);
      findings.push({
        code: 'EX_DATE_AFTER_RECORD',
        severity: daysAfter > 1 ? 'ERROR' : 'WARNING',
        field: 'exDate',
        message:
          `Ex-date (${iso(exDate)}) falls after the record date (${iso(recordDate)}). ` +
          'The ex-date should be on or before the record date.',
      });
    }

    if (paymentDate && recordDate && paymentDate < recordDate) {
      findings.push({
        code: 'PAYMENT_BEFORE_RECORD',
        severity: 'ERROR',
        field: 'paymentDate',
        message:
          `Payment date (${iso(paymentDate)}) is before the record date (${iso(recordDate)}); ` +
          'holders cannot be paid before entitlement is established.',
      });
    }

    if (announcementDate && effectiveDate < announcementDate) {
      findings.push({
        code: 'EFFECTIVE_BEFORE_ANNOUNCEMENT',
        severity: 'WARNING',
        field: 'effectiveDate',
        message:
          `Effective date (${iso(effectiveDate)}) precedes the announcement ` +
          `(${iso(announcementDate)}). Retroactive actions occur but are rare — verify.`,
      });
    }

    if (ENTITLEMENT_TYPES.has(action.actionType) && !recordDate && !exDate) {
      findings.push({
        code: 'ENTITLEMENT_DATE_MISSING',
        severity: 'ERROR',
        field: 'recordDate',
        message:
          'An entitlement action needs a record date or an ex-date to decide who qualifies.',
      });
    }

    /**
     * A far-future or long-past effective date usually means a parsing error
     * (a two-digit year, a Unix epoch read as seconds). Warned, not blocked —
     * a genuine multi-year merger timetable exists.
     */
    const yearsOut = (effectiveDate.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    if (yearsOut > 3 || yearsOut < -10) {
      findings.push({
        code: 'EFFECTIVE_DATE_IMPLAUSIBLE',
        severity: 'WARNING',
        field: 'effectiveDate',
        message: `Effective date ${iso(effectiveDate)} is implausibly far from today — check the source parse.`,
      });
    }

    return findings;
  }

  // ── Ratio ─────────────────────────────────────────────────────────────────

  /** PART 6: old_ratio > 0 and new_ratio > 0 for anything ratio-driven. */
  private checkRatio(action: CorporateAction): ValidationFinding[] {
    if (!RATIO_TYPES.has(action.actionType)) return [];

    const findings: ValidationFinding[] = [];
    const { oldRatio, newRatio } = action;

    // A spin-off carries its ratio in `details.distributionRatio` instead —
    // it distributes a DIFFERENT security, so old:new share arithmetic on the
    // parent does not describe it.
    if (action.actionType === 'SPIN_OFF') {
      const distribution = readNumber(action.details, 'distributionRatio');
      if (distribution === null || distribution <= 0) {
        findings.push({
          code: 'SPINOFF_RATIO_INVALID',
          severity: 'ERROR',
          field: 'details.distributionRatio',
          message: 'Spin-off requires a positive distribution ratio (new shares per parent share).',
        });
      }
      return findings;
    }

    if (action.actionType === 'RIGHTS_ISSUE') {
      const subscriptionRatio = readNumber(action.details, 'subscriptionRatio');
      const price = readNumber(action.details, 'subscriptionPrice');
      if (subscriptionRatio === null || subscriptionRatio <= 0) {
        findings.push({
          code: 'RIGHTS_RATIO_INVALID',
          severity: 'ERROR',
          field: 'details.subscriptionRatio',
          message: 'Rights issue requires a positive subscription ratio (rights per share held).',
        });
      }
      if (price === null || price < 0) {
        findings.push({
          code: 'RIGHTS_PRICE_INVALID',
          severity: 'ERROR',
          field: 'details.subscriptionPrice',
          message: 'Rights issue requires a subscription price.',
        });
      }
      return findings;
    }

    if (oldRatio === null || oldRatio === undefined || !Number.isFinite(oldRatio)) {
      findings.push({
        code: 'OLD_RATIO_MISSING',
        severity: 'ERROR',
        field: 'oldRatio',
        message: 'Ratio action requires old_ratio.',
      });
    } else if (oldRatio <= 0) {
      findings.push({
        code: 'OLD_RATIO_NON_POSITIVE',
        severity: 'ERROR',
        field: 'oldRatio',
        message: `old_ratio must be greater than zero; got ${oldRatio}.`,
      });
    }

    if (newRatio === null || newRatio === undefined || !Number.isFinite(newRatio)) {
      findings.push({
        code: 'NEW_RATIO_MISSING',
        severity: 'ERROR',
        field: 'newRatio',
        message: 'Ratio action requires new_ratio.',
      });
    } else if (newRatio <= 0) {
      findings.push({
        code: 'NEW_RATIO_NON_POSITIVE',
        severity: 'ERROR',
        field: 'newRatio',
        message: `new_ratio must be greater than zero; got ${newRatio}.`,
      });
    }

    /**
     * A ratio of exactly 1:1 changes nothing and is almost always a parse
     * failure (a feed defaulting both legs to 1). Processing it would write a
     * no-op transaction to every holder's ledger, which is noise in the
     * accounting history rather than a corruption — hence WARNING.
     *
     * BONUS_ISSUE is exempt: 1:1 is the single most common bonus there is,
     * and it means one free share per share held, not "no change".
     */
    if (
      oldRatio === newRatio &&
      Number.isFinite(oldRatio ?? NaN) &&
      action.actionType !== 'BONUS_ISSUE'
    ) {
      findings.push({
        code: 'RATIO_IS_IDENTITY',
        severity: 'WARNING',
        field: 'newRatio',
        message: `Ratio ${oldRatio}:${newRatio} leaves quantities unchanged — verify it parsed correctly.`,
      });
    }

    /**
     * Splits beyond about 100:1 exist (Berkshire's B-share split was 50:1) but
     * a ratio of 10,000 is a decimal-point error, and the cost of processing
     * one is every affected client's position multiplied into nonsense.
     */
    if (
      Number.isFinite(oldRatio ?? NaN) &&
      Number.isFinite(newRatio ?? NaN) &&
      (oldRatio ?? 0) > 0
    ) {
      const multiplier = (newRatio as number) / (oldRatio as number);
      if (multiplier > 1000 || multiplier < 0.001) {
        findings.push({
          code: 'RATIO_IMPLAUSIBLE',
          severity: 'ERROR',
          field: 'newRatio',
          message:
            `Ratio ${oldRatio}:${newRatio} implies a ${multiplier.toFixed(4)}x change in share ` +
            'count, which is outside any plausible corporate action. Refusing to process.',
        });
      }
    }

    return findings;
  }

  // ── Cash ──────────────────────────────────────────────────────────────────

  private checkCash(action: CorporateAction): ValidationFinding[] {
    if (!CASH_TYPES.has(action.actionType)) return [];

    const findings: ValidationFinding[] = [];
    const amount = action.cashAmount;

    if (amount === null || amount === undefined || !Number.isFinite(amount)) {
      findings.push({
        code: 'CASH_AMOUNT_MISSING',
        severity: 'ERROR',
        field: 'cashAmount',
        message: 'A cash action requires an amount per share.',
      });
    } else if (amount < 0) {
      findings.push({
        code: 'CASH_AMOUNT_NEGATIVE',
        severity: 'ERROR',
        field: 'cashAmount',
        message: `Amount per share cannot be negative; got ${amount}.`,
      });
    } else if (amount === 0) {
      findings.push({
        code: 'CASH_AMOUNT_ZERO',
        severity: 'WARNING',
        field: 'cashAmount',
        message: 'Amount per share is zero — no client will receive anything.',
      });
    }

    if (!action.currency) {
      findings.push({
        code: 'CURRENCY_MISSING',
        severity: 'WARNING',
        field: 'currency',
        message: "No currency set; the client's book currency will be assumed.",
      });
    }

    return findings;
  }

  // ── Target security ───────────────────────────────────────────────────────

  private checkTargetSecurity(action: CorporateAction): ValidationFinding[] {
    if (!REQUIRES_NEW_SYMBOL.has(action.actionType)) return [];

    const findings: ValidationFinding[] = [];

    if (!action.newSymbol?.trim()) {
      findings.push({
        code: 'NEW_SYMBOL_MISSING',
        severity: 'ERROR',
        field: 'newSymbol',
        message: `${action.actionType} requires the resulting security's symbol.`,
      });
    } else if (
      action.newSymbol.trim().toUpperCase() === action.symbol.trim().toUpperCase()
    ) {
      findings.push({
        code: 'NEW_SYMBOL_SAME',
        severity: 'ERROR',
        field: 'newSymbol',
        message: 'The resulting symbol is identical to the original — nothing would change.',
      });
    }

    if (action.actionType === 'MERGER' || action.actionType === 'ACQUISITION') {
      const exchangeRatio = readNumber(action.details, 'exchangeRatio');
      const cashPerShare = readNumber(action.details, 'cashPerShare');
      // A merger may be all-stock, all-cash, or both — but not neither.
      if ((exchangeRatio === null || exchangeRatio <= 0) && (cashPerShare === null || cashPerShare <= 0)) {
        findings.push({
          code: 'MERGER_CONSIDERATION_MISSING',
          severity: 'ERROR',
          field: 'details.exchangeRatio',
          message:
            'A merger needs an exchange ratio, a cash-per-share figure, or both — ' +
            'otherwise holders receive nothing for their shares.',
        });
      }
    }

    return findings;
  }

  // ── Provenance ────────────────────────────────────────────────────────────

  /** PART 5: never silently trust a feed — a source is mandatory, a URL is not. */
  private checkSource(action: CorporateAction): ValidationFinding[] {
    const findings: ValidationFinding[] = [];

    if (!action.source?.trim()) {
      findings.push({
        code: 'SOURCE_MISSING',
        severity: 'ERROR',
        field: 'source',
        message: 'Every corporate action must record where it came from.',
      });
    }

    /**
     * "Source URL where available" (PART 6) — so its absence is a warning.
     * Some genuine sources have no addressable URL at all: a manually keyed
     * action from a faxed registrar notice is properly sourced and properly
     * un-linkable.
     */
    if (!action.sourceUrl?.trim()) {
      findings.push({
        code: 'SOURCE_URL_MISSING',
        severity: 'WARNING',
        field: 'sourceUrl',
        message: 'No source URL recorded — provenance cannot be verified by a reviewer.',
      });
    }

    return findings;
  }

  private checkConflict(action: CorporateAction): ValidationFinding[] {
    if (!action.hasConflict) return [];
    const conflicts = Array.isArray(action.conflicts) ? action.conflicts : [];
    const fields = conflicts
      .map((c) => (c as { field?: string })?.field)
      .filter(Boolean)
      .join(', ');

    return [
      {
        code: 'DATA_CONFLICT',
        severity: 'ERROR',
        message:
          `Sources disagree${fields ? ` on: ${fields}` : ''}. ` +
          'Resolve the conflict before processing (PART 32).',
      },
    ];
  }

  // ── Duplicates ────────────────────────────────────────────────────────────

  /**
   * PART 6/7's duplicate check.
   *
   * The fingerprint unique index already makes an exact duplicate impossible
   * to insert, so what this looks for is the case the index CANNOT catch: a
   * near-duplicate that differs by a day or a rounding, which would process
   * twice and double-adjust every holder. Same symbol, same type, within three
   * days, not already superseded.
   */
  private async checkDuplicate(action: CorporateAction): Promise<ValidationFinding[]> {
    if (!action.symbol || !action.effectiveDate) return [];

    const windowMs = 3 * 24 * 60 * 60 * 1000;
    const near = await this.prisma.corporateAction.findMany({
      where: {
        id: { not: action.id },
        symbol: action.symbol,
        actionType: action.actionType,
        status: { notIn: ['REJECTED', 'CANCELLED'] },
        effectiveDate: {
          gte: new Date(action.effectiveDate.getTime() - windowMs),
          lte: new Date(action.effectiveDate.getTime() + windowMs),
        },
      },
      select: { id: true, effectiveDate: true, status: true, source: true },
    });

    if (near.length === 0) return [];

    return [
      {
        code: 'POSSIBLE_DUPLICATE',
        severity: 'ERROR',
        message:
          `${near.length} similar ${action.actionType} action(s) for ${action.symbol} exist within ` +
          `3 days of ${iso(action.effectiveDate)} ` +
          `(${near.map((n) => `${n.source} @ ${iso(n.effectiveDate)} [${n.status}]`).join('; ')}). ` +
          'Processing both would double-adjust every holder. Merge or reject one.',
      },
    ];
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days between two dates, ignoring time of day. */
function dayGap(from: Date, to: Date): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / day);
}

/** Reads a finite number out of the `details` Json blob, or null. */
function readNumber(details: unknown, key: string): number | null {
  if (!details || typeof details !== 'object') return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
