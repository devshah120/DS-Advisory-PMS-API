import { AllocationResult } from '../analytics/calculators/weights';
import { PriceStatus } from '../historical-price/historical-price.service';

/** One position's state as of the reconstruction/snapshot date. */
export interface ReconstructedPosition {
  ticker: string;
  quantity: number;
  averageCost: number;
  closingPrice: number;
  /**
   * The session `closingPrice` is the close of, and how it was resolved —
   * `missing` when the ticker has no price history and cost stood in. Set by a
   * live reconstruction; absent on a position read back from a stored snapshot,
   * which never recorded them.
   */
  priceDate?: string | null;
  priceStatus?: PriceStatus | 'missing';
  marketValue: number;
  costBasisTotal: number;
  unrealizedGain: number;
  sector: string;
  industry: string;
  country: string;
  assetClass: string;
  weight: number;
}

/**
 * The output of PortfolioReconstructionService.reconstruct() and the shape
 * PortfolioHistoryService reads a HoldingSnapshot row back into — the two
 * paths described in PART 7 (snapshot-or-reconstruct) return this same
 * shape so a caller cannot tell which one served it.
 */
export interface ReconstructedPortfolio {
  clientId: string;
  asOfDate: Date;
  baselineDate: Date;

  /** Floored at zero — a negative buying-power balance is never reported. */
  cash: number;
  /**
   * How far below zero the replayed cash went before being floored, or 0 when it
   * never did. Non-zero means the replay was never given the money the purchases
   * were funded with. The usual causes are an unrecorded opening balance or
   * deposits (a transactional book has no CASH_DEPOSIT rows, so a client funded
   * outside the ledger replays as though it bought from nothing), or a trade
   * entered twice under two spellings of the same symbol.
   *
   * Deliberately NOT attributed to a specific cause here: the replay knows only
   * the magnitude, not which of the above produced it, and the UI copy must not
   * claim more than that.
   */
  cashShortfall: number;
  holdingsValue: number;
  portfolioValue: number;

  totalCost: number;
  unrealizedGain: number;
  /** Cumulative realized gain from every SELL replayed since the baseline. */
  realizedGain: number;

  positions: ReconstructedPosition[];

  sectorAllocation: AllocationResult;
  countryAllocation: AllocationResult;
  assetAllocation: AllocationResult;

  /** True when this came from a stored HoldingSnapshot rather than a live replay. */
  source: 'snapshot' | 'reconstruction';
}
