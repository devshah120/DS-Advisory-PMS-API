import { Market } from '../common/market-scope';

/**
 * Shared shapes for the Review Pack engine.
 *
 * These are the contracts between ReviewPackAnalysisService (verified numbers,
 * from PortfolioHistoryService / FamilyPerformanceService / BenchmarkHistoryService
 * and arithmetic over Holding rows) and everything downstream that turns them
 * into prose. Nothing in this file is ever populated by an AI call — see
 * CommentaryInput below, which is the ONLY thing handed to a provider.
 */

export type ReviewSubjectKind = 'client' | 'family';

export type DataQuality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ContributorRow {
  symbol: string;
  company: string;
  /** The holding's own return over the window, for context only — never the ranking key. */
  returnPct: number | null;
  /** P&L contributed over the window, in the subject's currency. */
  pnlContribution: number;
  /** pnlContribution / opening portfolio value — THE ranking key (spec §11/§59). */
  portfolioContributionPct: number;
  /** Closing weight in the portfolio. */
  weight: number;
}

export interface SectorRow {
  sector: string;
  weight: number;
  previousWeight: number | null;
  changePct: number | null;
  portfolioContributionPct: number | null;
}

export interface PositionChange {
  symbol: string;
  company: string;
  kind: 'NEW_POSITION' | 'EXITED_POSITION' | 'MAJOR_ADDITION' | 'MAJOR_REDUCTION';
  previousWeight: number;
  currentWeight: number;
  weightChangePct: number;
}

export interface ConcentrationMetrics {
  numberOfHoldings: number;
  numberOfSectors: number;
  top1WeightPct: number;
  top5WeightPct: number;
  top10WeightPct: number;
}

export interface DividendSummary {
  totalAmount: number;
  isMaterial: boolean;
}

export interface CorporateActionSummary {
  symbol: string;
  company: string;
  actionType: string;
  effectiveDate: Date;
}

/**
 * The verified analysis for one subject/period — every field here traces back
 * to PerformanceEngine, BenchmarkHistoryService or arithmetic over Holding/
 * Transaction/CorporateActionLedger rows. This is the object
 * ReviewPackAnalysisService returns and CommentaryInput is built FROM.
 */
export interface PortfolioAnalysis {
  subjectType: ReviewSubjectKind;
  subjectId: string;
  subjectName: string;
  market: Market;
  currency: string;

  periodCode: string;
  periodLabel: string;
  periodStart: Date;
  periodEnd: Date;
  openPeriod: boolean;

  portfolioValueStart: number;
  portfolioValueEnd: number;

  /** Money-weighted (XIRR), de-annualized to the window. Null when unmeasurable. */
  portfolioReturnPct: number | null;
  returnUnavailableReason?: string;

  benchmarkName: string | null;
  benchmarkReturnPct: number | null;
  /** portfolioReturnPct - benchmarkReturnPct. Null unless both sides exist. */
  differencePct: number | null;

  investmentGainLoss: number | null;

  cashWeight: number;
  cashValue: number;

  topHoldings: Array<{ symbol: string; company: string; weight: number }>;
  topContributors: ContributorRow[];
  topDetractors: ContributorRow[];

  sectorAllocation: SectorRow[];
  topSectors: SectorRow[];
  largestSectorIncrease: SectorRow | null;
  largestSectorDecrease: SectorRow | null;

  newPositions: PositionChange[];
  exitedPositions: PositionChange[];
  majorAdditions: PositionChange[];
  majorReductions: PositionChange[];

  concentration: ConcentrationMetrics;

  dividends: DividendSummary | null;
  corporateActions: CorporateActionSummary[];

  dataQuality: DataQuality;
  warnings: string[];
}

/**
 * Configurable materiality thresholds — spec §14. Kept as constants here
 * rather than a settings UI in this phase; every threshold is named so a
 * future settings screen can bind to these one at a time.
 */
export const MATERIALITY_THRESHOLDS = {
  newPositionMinWeight: 0.01,
  positionWeightChangePct: 0.01,
  sectorChangePct: 0.02,
  cashChangePct: 0.02,
  pnlContributionPct: 0.005,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// AI-facing contract. CommentaryInput is the ONLY object ever sent to a
// provider — never a Prisma row, never raw transactions or price history.
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroDataPoint {
  indicator: string;
  value: number;
  unit: string;
  observationDate: string;
  source: string;
}

export interface MacroEventPoint {
  title: string;
  summary: string;
  eventDate: string;
  importance: 'HIGH' | 'MEDIUM';
  source: string;
}

export interface CommentaryInput {
  subjectType: ReviewSubjectKind;
  subjectName: string;
  marketRegion: Market;
  currency: string;

  periodStart: string;
  periodEnd: string;

  portfolioValueStart: number;
  portfolioValueEnd: number;
  portfolioReturn: number | null;
  benchmarkName: string | null;
  benchmarkReturn: number | null;
  performanceDifference: number | null;

  numberOfHoldings: number;
  numberOfSectors: number;
  cashWeight: number;

  topHoldings: Array<{ symbol: string; company: string; weight: number }>;
  topContributors: Array<{
    symbol: string;
    company: string;
    portfolioContributionPct: number;
    weight: number;
  }>;
  topDetractors: Array<{
    symbol: string;
    company: string;
    portfolioContributionPct: number;
    weight: number;
  }>;

  sectorAllocation: Array<{ sector: string; weight: number }>;
  sectorChanges: Array<{ sector: string; changePct: number }>;

  newPositions: string[];
  exitedPositions: string[];
  majorAdditions: string[];
  majorReductions: string[];

  dividendsMaterial: boolean;
  corporateActions: Array<{ company: string; actionType: string }>;

  concentration: ConcentrationMetrics;

  macroData: MacroDataPoint[];
  macroEvents: MacroEventPoint[];

  dataQuality: DataQuality;
  warnings: string[];
}

/** The AI's required output shape — spec §37. Anything else is rejected. */
export interface AICommentaryOutput {
  portfolio_commentary: string;
  market_macro_commentary: string;
  positioning_commentary: string;
  headline: string;
  key_points: string[];
}
