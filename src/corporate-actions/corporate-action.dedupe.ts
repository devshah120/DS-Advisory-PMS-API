/**
 * Deduplication, source merging and conflict detection — PART 7, 32 and 33.
 *
 * The problem this file solves: the same APH 2-for-1 split arrives from FMP on
 * Monday and from an SEC filing on Tuesday. Those must become ONE corporate
 * action carrying TWO sources. Two rows would mean two processing runs, and
 * the second would double the client's shares — the idempotency key on the
 * ledger stops that from corrupting a book, but only by failing loudly, and a
 * failed run at 2am is a worse outcome than never creating the duplicate.
 *
 * Pure functions throughout, for the same reason as ratio.ts: "are these the
 * same event?" is a judgement that should be provable in a unit test.
 */
import { createHash } from 'crypto';
import type { CorporateActionType } from '@prisma/client';
import {
  NormalizedCorporateAction,
  SOURCE_TIERS,
  SourceConflict,
  SourceReference,
  SourceTier,
} from './corporate-action.types';

/**
 * The identity fields, per PART 7: symbol, action type, record date, effective
 * date, and the ratio.
 *
 * ── Why dates are bucketed to the day ──────────────────────────────────────
 * Feeds report dates as bare ISO days, as midnight UTC, or as midnight in the
 * exchange's own timezone. Hashing a raw Date would make 2026-09-03T00:00:00Z
 * and 2026-09-03T04:30:00+05:30 different events despite being the same day.
 * Truncating to YYYY-MM-DD in UTC is what makes the key stable across feeds.
 *
 * ── Why the ratio is rounded ───────────────────────────────────────────────
 * One provider sends 0.3333333333, another 0.33333333333333. Rounded to 6
 * decimals both become 0.333333 — tighter than any real ratio needs and loose
 * enough to survive a provider's float formatting.
 *
 * ── Why recordDate is optional in the key ──────────────────────────────────
 * Many feeds omit it. Including a missing value as the literal string 'none'
 * rather than skipping the field keeps the key positional, so an action WITH a
 * record date never collides with one that lacks it — those genuinely might be
 * different events, and merging them would be worse than duplicating them.
 */
export function fingerprintOf(
  action: Pick<
    NormalizedCorporateAction,
    'symbol' | 'actionType' | 'recordDate' | 'effectiveDate' | 'oldRatio' | 'newRatio'
  >,
): string {
  const parts = [
    action.symbol.trim().toUpperCase(),
    action.actionType,
    dayKey(action.recordDate),
    dayKey(action.effectiveDate),
    ratioKey(action.oldRatio),
    ratioKey(action.newRatio),
  ];

  // Hashed rather than stored as a readable composite so the value is a fixed
  // 32 chars whatever the symbol length, which keeps the unique index small.
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function dayKey(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return 'none';
  return date.toISOString().slice(0, 10);
}

function ratioKey(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'none';
  return value.toFixed(6);
}

/**
 * Whether two normalised actions describe the same real-world event.
 *
 * Fingerprint equality is the primary test. The looser `nearDuplicate` below
 * exists because feeds disagree by a day or two on which date is the "ex" and
 * which the "effective" — a fingerprint match is proof, but a miss is not
 * proof of difference.
 */
export function isSameEvent(
  a: NormalizedCorporateAction,
  b: NormalizedCorporateAction,
): boolean {
  return fingerprintOf(a) === fingerprintOf(b);
}

/**
 * A softer match for actions the fingerprint would separate: same symbol, same
 * type, and an effective date within `toleranceDays`.
 *
 * Used ONLY to raise a review flag, never to merge automatically. Two splits
 * of the same stock three days apart are almost certainly one event reported
 * twice — but "almost certainly" is not a licence to silently combine them,
 * because the failure mode (dropping a real second action) is invisible.
 */
export function isNearDuplicate(
  a: NormalizedCorporateAction,
  b: NormalizedCorporateAction,
  toleranceDays = 3,
): boolean {
  if (a.symbol.trim().toUpperCase() !== b.symbol.trim().toUpperCase()) return false;
  if (a.actionType !== b.actionType) return false;

  const gap = Math.abs(a.effectiveDate.getTime() - b.effectiveDate.getTime());
  return gap <= toleranceDays * 24 * 60 * 60 * 1000;
}

/** Ranks a tier for priority comparison; unknown tiers sort last. */
export function tierRank(tier: SourceTier): number {
  return SOURCE_TIERS[tier]?.rank ?? 99;
}

/** True when `candidate` outranks `incumbent` and should become the primary source. */
export function outranks(candidate: SourceTier, incumbent: SourceTier): boolean {
  return tierRank(candidate) < tierRank(incumbent);
}

/**
 * Builds the SourceReference for one provider's report.
 *
 * `payload` captures the figures that source reported, which is what makes a
 * later conflict describable field-by-field instead of as a bare boolean.
 */
export function toSourceReference(action: NormalizedCorporateAction): SourceReference {
  return {
    source: action.source,
    tier: action.tier,
    url: action.sourceUrl ?? null,
    reference: action.sourceReference ?? null,
    fetchedAt: new Date().toISOString(),
    payload: {
      oldRatio: action.oldRatio ?? null,
      newRatio: action.newRatio ?? null,
      cashAmount: action.cashAmount ?? null,
      recordDate: action.recordDate?.toISOString() ?? null,
      exDate: action.exDate?.toISOString() ?? null,
      effectiveDate: action.effectiveDate.toISOString(),
      paymentDate: action.paymentDate?.toISOString() ?? null,
      newSymbol: action.newSymbol ?? null,
    },
  };
}

/**
 * Merges a newly-fetched report into the sources already recorded (PART 7).
 *
 * Rules:
 *  - A source that has reported before is REPLACED by its newer report, not
 *    appended twice — otherwise a nightly scheduler grows the array without
 *    bound.
 *  - The array is kept sorted by tier, so `sources[0]` is always the primary
 *    and the UI's "Primary / Secondary" labels need no extra logic.
 */
export function mergeSources(
  existing: SourceReference[],
  incoming: SourceReference,
): SourceReference[] {
  const others = existing.filter((s) => s.source !== incoming.source);
  return [...others, incoming].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
}

/**
 * Fields that must agree between sources for an action to process
 * automatically. A disagreement on any of these is a DATA_CONFLICT (PART 32).
 *
 * Deliberately excludes announcementDate and company name: providers routinely
 * differ on when a thing was "announced" and on whether a company is called
 * "Amphenol Corp" or "Amphenol Corporation", and neither changes a single
 * share of anyone's position. Flagging those would train the desk to dismiss
 * conflict warnings, which is worse than not raising them.
 */
const MATERIAL_FIELDS = [
  'oldRatio',
  'newRatio',
  'cashAmount',
  'recordDate',
  'effectiveDate',
  'newSymbol',
] as const;

/**
 * Compares every source's reported payload and returns the fields they
 * disagree on.
 *
 * A field is only compared where at least two sources actually reported it —
 * one source having a record date and another leaving it null is INCOMPLETE
 * data, not CONFLICTING data, and conflating the two would block processing on
 * half the feed's normal output.
 */
export function detectConflicts(sources: SourceReference[]): SourceConflict[] {
  if (sources.length < 2) return [];

  const conflicts: SourceConflict[] = [];

  for (const field of MATERIAL_FIELDS) {
    const reported = sources
      .map((s) => ({ source: s.source, value: s.payload?.[field] ?? null }))
      .filter((entry) => entry.value !== null && entry.value !== undefined);

    if (reported.length < 2) continue;

    const distinct = new Set(reported.map((entry) => comparableValue(entry.value)));
    if (distinct.size > 1) {
      conflicts.push({ field, values: reported });
    }
  }

  return conflicts;
}

/**
 * Normalises a value for equality comparison.
 *
 * Dates collapse to their UTC day for the same reason the fingerprint does,
 * and numbers to 6 decimals — otherwise 2 and 2.0000000001 read as a conflict
 * and every action from two providers would land in the review queue.
 */
function comparableValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'number') return value.toFixed(6);
  if (typeof value === 'string') {
    // An ISO timestamp compares by day; anything else by its trimmed self.
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return new Date(asDate).toISOString().slice(0, 10);
    }
    return value.trim().toUpperCase();
  }
  return String(value);
}

/**
 * PART 33's confidence score.
 *
 * Starts from the best source's tier and then DEDUCTS for the things that make
 * a well-sourced action still risky to process blind:
 *
 *  - an unresolved conflict caps the score at 50, well under any sane
 *    threshold, so PART 32's "do not automatically process" is enforced by the
 *    number as well as by the explicit `hasConflict` flag. Belt and braces,
 *    because this is the failure that corrupts holdings.
 *  - a missing ratio on a ratio-driven action is a 30-point deduction: the
 *    processor cannot run without it, so it should never approach the
 *    threshold.
 *  - a missing effective or record date costs 10 each.
 *
 * Corroboration ADDS 5 (capped at 100) when two independent sources agree —
 * two feeds saying the same thing is genuinely stronger evidence than one.
 */
export function calculateConfidence(input: {
  sources: SourceReference[];
  actionType: CorporateActionType;
  oldRatio?: number | null;
  newRatio?: number | null;
  cashAmount?: number | null;
  recordDate?: Date | null;
  effectiveDate?: Date | null;
  conflicts?: SourceConflict[];
}): number {
  if (input.sources.length === 0) return 0;

  const best = input.sources.reduce((lowest, s) =>
    tierRank(s.tier) < tierRank(lowest.tier) ? s : lowest,
  );

  let score = SOURCE_TIERS[best.tier]?.confidence ?? 40;

  const agreeing = new Set(input.sources.map((s) => s.source)).size;
  if (agreeing >= 2 && (input.conflicts?.length ?? 0) === 0) {
    score = Math.min(100, score + 5);
  }

  if (RATIO_TYPES.has(input.actionType)) {
    const usable =
      Number.isFinite(input.oldRatio ?? NaN) &&
      Number.isFinite(input.newRatio ?? NaN) &&
      (input.oldRatio ?? 0) > 0 &&
      (input.newRatio ?? 0) > 0;
    if (!usable) score -= 30;
  }

  if (CASH_TYPES.has(input.actionType) && !Number.isFinite(input.cashAmount ?? NaN)) {
    score -= 30;
  }

  if (!input.effectiveDate) score -= 10;
  if (!input.recordDate && ENTITLEMENT_TYPES.has(input.actionType)) score -= 10;

  if ((input.conflicts?.length ?? 0) > 0) score = Math.min(score, 50);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Action types whose processing depends on a ratio. */
export const RATIO_TYPES: ReadonlySet<CorporateActionType> = new Set([
  'STOCK_SPLIT',
  'REVERSE_SPLIT',
  'BONUS_ISSUE',
  'STOCK_DIVIDEND',
  'RIGHTS_ISSUE',
  'SPIN_OFF',
] as CorporateActionType[]);

/** Action types whose processing depends on a per-share cash figure. */
export const CASH_TYPES: ReadonlySet<CorporateActionType> = new Set([
  'DIVIDEND',
  'SPECIAL_DIVIDEND',
  'CASH_DISTRIBUTION',
  'RETURN_OF_CAPITAL',
] as CorporateActionType[]);

/**
 * Action types where WHO holds the shares on a given date determines who gets
 * paid — so a missing record date is materially worse than for, say, a ticker
 * change.
 */
export const ENTITLEMENT_TYPES: ReadonlySet<CorporateActionType> = new Set([
  'DIVIDEND',
  'SPECIAL_DIVIDEND',
  'BONUS_ISSUE',
  'STOCK_DIVIDEND',
  'RIGHTS_ISSUE',
  'SPIN_OFF',
  'CASH_DISTRIBUTION',
  'RETURN_OF_CAPITAL',
] as CorporateActionType[]);
