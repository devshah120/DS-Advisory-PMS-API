/**
 * Shared shapes for the Corporate Action Engine.
 *
 * Kept separate from the Prisma model so the provider adapters, the validator
 * and the processors all speak one normalised vocabulary that is NOT the
 * database row — a provider returns a `NormalizedCorporateAction`, never a
 * half-built Prisma object, which is what keeps ingestion from having to know
 * about fingerprints, statuses or confidence.
 */
import type { CorporateActionType, Market } from '@prisma/client';

/**
 * Source tiers, PART 5's hierarchy expressed as an ordered type. Lower
 * `rank` wins a conflict and sets the stored `source`.
 */
export type SourceTier =
  | 'COMPANY_IR'
  | 'REGULATORY_FILING'
  | 'EXCHANGE'
  | 'PRIMARY_API'
  | 'SECONDARY_API'
  | 'UNVERIFIED';

/**
 * PART 5 priority and PART 33 confidence in one table, because they are two
 * views of the same judgement and splitting them across two files is how they
 * drift apart.
 *
 * `confidence` is the score an action gets when this tier is its best source,
 * taken verbatim from PART 33: official filing and SEC both 100, exchange 95,
 * primary API 90, secondary 75, unverified 40.
 */
export const SOURCE_TIERS: Record<SourceTier, { rank: number; confidence: number; label: string }> = {
  COMPANY_IR: { rank: 1, confidence: 100, label: 'Official IR' },
  REGULATORY_FILING: { rank: 2, confidence: 100, label: 'SEC / Exchange Filing' },
  EXCHANGE: { rank: 3, confidence: 95, label: 'Exchange' },
  PRIMARY_API: { rank: 4, confidence: 90, label: 'Primary Market Data' },
  SECONDARY_API: { rank: 5, confidence: 75, label: 'Secondary Market Data' },
  UNVERIFIED: { rank: 6, confidence: 40, label: 'Unverified' },
};

/** One provider's report of one event, as stored in CorporateAction.sources[]. */
export interface SourceReference {
  /** Provider identifier, e.g. 'fmp' — matches CorporateActionProvider.name. */
  source: string;
  tier: SourceTier;
  url?: string | null;
  /** The provider's own id for the event, where it has one. */
  reference?: string | null;
  fetchedAt: string;
  /**
   * The normalised figures THIS source reported. Retained so a conflict can be
   * described field by field ("FMP says 2:1, Finnhub says 3:1") rather than as
   * an unhelpful "sources disagree".
   */
  payload?: Record<string, unknown>;
}

/** A field two sources disagree on (PART 32). */
export interface SourceConflict {
  field: string;
  values: Array<{ source: string; value: unknown }>;
}

/**
 * What every provider adapter returns — a corporate action expressed in the
 * engine's own vocabulary, with no provider quirks left in it.
 *
 * Note what is ABSENT: no status, no confidence, no fingerprint, no id. Those
 * are the engine's to assign, and a provider that could set them could
 * fast-track its own data past validation.
 */
export interface NormalizedCorporateAction {
  symbol: string;
  company?: string | null;
  market?: Market;
  actionType: CorporateActionType;

  announcementDate?: Date | null;
  declarationDate?: Date | null;
  recordDate?: Date | null;
  exDate?: Date | null;
  effectiveDate: Date;
  paymentDate?: Date | null;

  /** PART 6 storage convention: each `oldRatio` shares become `newRatio`. */
  oldRatio?: number | null;
  newRatio?: number | null;

  cashAmount?: number | null;
  currency?: string | null;

  newSymbol?: string | null;
  newCompany?: string | null;

  details?: Record<string, unknown> | null;

  source: string;
  tier: SourceTier;
  sourceUrl?: string | null;
  sourceReference?: string | null;
}

/** Severity decides whether a finding BLOCKS processing or merely annotates it. */
export type ValidationSeverity = 'ERROR' | 'WARNING';

export interface ValidationFinding {
  /** Stable machine code, e.g. 'RATIO_NON_POSITIVE'. Safe to switch on. */
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
}

export interface ValidationOutcome {
  valid: boolean;
  findings: ValidationFinding[];
}

/**
 * One client's projected or realised change — the row behind PART 40's Client
 * Impact table and the shape a processor returns per client.
 */
export interface ClientImpact {
  clientId: string;
  clientName: string;
  symbol: string;

  quantityBefore: number;
  quantityAfter: number;
  averageCostBefore: number;
  averageCostAfter: number;
  marketValueBefore: number;
  marketValueAfter: number;

  cashImpact: number;
  currency: string;
  fractionalShares: number;

  /** 'READY' before processing, then the ledger status afterwards. */
  status: string;
  errorMessage?: string | null;
  /** Human-readable note, e.g. 'Receives 20 shares of XYZ'. */
  note?: string | null;
}

/** PART 39's preview, and the dry-run half of every processor. */
export interface CorporateActionPreview {
  corporateActionId: string;
  symbol: string;
  company: string | null;
  actionType: CorporateActionType;
  /** Display form, e.g. '2:1' — already inverted for reading (see ratio.ts). */
  ratioLabel: string | null;

  affectedClients: number;
  sharesBefore: number;
  sharesAfter: number;

  averageCostBefore: number | null;
  averageCostAfter: number | null;

  /**
   * Market value across every affected client, before and after. For a ratio
   * action these are equal by construction and the delta below is 0 — which is
   * the number PART 39 asks the preview to display as proof the split creates
   * no value.
   */
  portfolioValueBefore: number;
  portfolioValueAfter: number;
  portfolioValueImpact: number;

  cashImpact: number;
  /** Always 0 for ratio actions; non-zero only where real cash moves. */
  performanceImpact: number;

  clients: ClientImpact[];
  warnings: string[];
}

/** What a processor reports back after a run (PART 35/38). */
export interface ProcessingResult {
  corporateActionId: string;
  clientsProcessed: number;
  transactionsCreated: number;
  totalSharesBefore: number;
  totalSharesAfter: number;
  totalCashImpact: number;
  reconciliation: ReconciliationResult;
}

/** PART 38. */
export interface ReconciliationResult {
  status: 'RECONCILED' | 'RECONCILIATION_FAILED' | 'NOT_APPLICABLE';
  expectedShares: number;
  actualShares: number;
  /** actual - expected. Zero on success. */
  variance: number;
  expectedCash?: number;
  actualCash?: number;
  message?: string;
}
