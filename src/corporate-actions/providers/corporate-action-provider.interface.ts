/**
 * The contract every corporate-action data source fills in — PART 31.
 *
 * Nothing in CorporateActionService, the validator, the processors or the
 * scheduler imports a provider directly or knows FMP exists. They depend on
 * this interface and on `NormalizedCorporateAction`, never on a vendor's
 * response shape. Adding a source means writing one class and registering it;
 * no other file changes. This is the same discipline
 * `FundamentalsProvider` already establishes in this codebase, and it is
 * followed here deliberately rather than reinvented.
 *
 * ── Why every method returns [] rather than throwing ────────────────────────
 *
 * A provider that throws takes the whole nightly sweep down with it, so one
 * vendor's outage becomes a total detection failure — and a missed split is a
 * client's book silently wrong. Adapters therefore log and return empty, and
 * the scheduler treats "no results" as a fallback trigger rather than an
 * error. PART 32's provider fallback only works if failure is a value, not an
 * exception.
 */
import { CorporateActionType } from '@prisma/client';
import { NormalizedCorporateAction, SourceTier } from '../corporate-action.types';

/** The window a fetch covers. Both bounds inclusive. */
export interface FetchWindow {
  from: Date;
  to: Date;
  /**
   * Symbols to fetch for. An adapter whose upstream only offers a
   * whole-market calendar may ignore this and filter the response instead —
   * the scheduler discards anything the firm does not hold either way.
   */
  symbols?: string[];
}

export interface CorporateActionProvider {
  /** Identifier stamped onto CorporateAction.source. Lowercase, stable. */
  readonly name: string;

  /** Where this provider sits in PART 5's hierarchy. Drives confidence. */
  readonly tier: SourceTier;

  /** Types this provider can supply, so the scheduler skips pointless calls. */
  readonly supports: ReadonlySet<CorporateActionType>;

  /** Everything in the window. Implementations may fan out to the methods below. */
  getCorporateActions(window: FetchWindow): Promise<NormalizedCorporateAction[]>;

  getDividends(window: FetchWindow): Promise<NormalizedCorporateAction[]>;

  getSplits(window: FetchWindow): Promise<NormalizedCorporateAction[]>;

  getMergers(window: FetchWindow): Promise<NormalizedCorporateAction[]>;

  getSymbolChanges(window: FetchWindow): Promise<NormalizedCorporateAction[]>;
}

/**
 * Parses a ratio label into this engine's STORAGE convention (PART 6):
 * `oldRatio` shares become `newRatio` shares.
 *
 * ── Why this is the trickiest function in the ingestion layer ───────────────
 *
 * Vendors express the same split three different ways, and two of them are
 * ambiguous:
 *
 *   "2:1" / "2-for-1"  — spoken form. TWO new shares for ONE old.
 *                        Stored oldRatio=1, newRatio=2.
 *   numerator=2,
 *   denominator=1      — FMP's shape, same meaning as above.
 *   "1:10"             — usually a REVERSE split (one new for ten old),
 *                        stored oldRatio=10, newRatio=1.
 *
 * The market convention is that the FIRST number is what the holder RECEIVES
 * and the second is what they GIVE UP, which inverts against our storage. Get
 * this backwards and a 2-for-1 split halves every client's position instead of
 * doubling it — which is why the conversion lives in exactly one place, is
 * exported, and is unit-tested rather than being written inline in each
 * adapter.
 */
export function ratioFromMarketConvention(
  received: number,
  surrendered: number,
): { oldRatio: number; newRatio: number } {
  if (!Number.isFinite(received) || !Number.isFinite(surrendered)) {
    throw new Error(`Unparseable split ratio: ${received}-for-${surrendered}`);
  }
  if (received <= 0 || surrendered <= 0) {
    throw new Error(`Split ratio legs must be positive: ${received}-for-${surrendered}`);
  }

  // "N-for-M": surrender M, receive N. Each M shares become N.
  return { oldRatio: surrendered, newRatio: received };
}

/**
 * Parses a textual ratio ("2:1", "2-for-1", "3 for 2") into storage form.
 * Returns null rather than throwing, so a single malformed row in a feed does
 * not discard the batch it arrived in.
 */
export function parseRatioLabel(
  label: string | null | undefined,
): { oldRatio: number; newRatio: number } | null {
  if (!label) return null;

  const match = String(label)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(?::|-?\s*for\s*-?|\/)\s*(\d+(?:\.\d+)?)$/i);

  if (!match) return null;

  const received = Number(match[1]);
  const surrendered = Number(match[2]);

  try {
    return ratioFromMarketConvention(received, surrendered);
  } catch {
    return null;
  }
}
