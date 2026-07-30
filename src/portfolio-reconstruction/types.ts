import { AllocationResult } from '../analytics/calculators/weights';

/** One position's state as of the reconstruction/snapshot date. */
export interface ReconstructedPosition {
  ticker: string;
  quantity: number;
  averageCost: number;
  closingPrice: number;
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

  cash: number;
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
