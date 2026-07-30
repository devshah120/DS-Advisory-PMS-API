import { Injectable } from '@nestjs/common';
import { PortfolioHistoryService } from './portfolio-history.service';

export type PerformancePeriod = 'MTD' | 'QTD' | 'YTD' | 'CUSTOM';

export interface PeriodReturn {
  period: PerformancePeriod;
  from: Date;
  to: Date;
  openingValue: number;
  closingValue: number;
  /** Simple (openingValue -> closingValue) return. Not flow-adjusted TWRR —
   *  callers wanting a flow-adjusted figure feed `openingValue` into their
   *  own TWRR chain instead of using this field directly. */
  returnPct: number | null;
}

/**
 * Resolves the ONE number the task's Part 5 is built around: the opening
 * portfolio value for a performance period, which must never be assumed to
 * be zero and must never be confused with accounting cost.
 *
 * This is intentionally a separate service from PerformanceService
 * (analytics/services/performance.service.ts), which is NOT modified here.
 * That service already computes XIRR/interim-return/benchmark alpha for the
 * "since inception" window using its own 30-June rebase; this service
 * answers a different question — "what was the portfolio worth at the START
 * of THIS period" — for MTD/QTD/YTD/custom windows, using the baseline +
 * snapshot infrastructure that didn't exist when PerformanceService was
 * written.
 *
 * Accounting-cost fields (Holding.averageCost, realized P&L) are never read
 * or written here — see the module doc comment on why the two concepts are
 * kept apart.
 */
@Injectable()
export class PerformanceBaselineService {
  constructor(private history: PortfolioHistoryService) {}

  /**
   * PART 5 resolution order:
   *   1. Daily Snapshot at `periodStart`, if one exists.
   *   2. Otherwise, Portfolio Reconstruction as of `periodStart`.
   *
   * PortfolioHistoryService.getPortfolioAsOf already implements exactly this
   * fallback (PART 7) — reused here rather than reimplemented, so "opening
   * value for a return period" and "portfolio as of a historical date" can
   * never disagree about which source they used for the same date.
   */
  async openingValue(clientId: string, periodStart: Date): Promise<number> {
    const portfolio = await this.history.getPortfolioAsOf(clientId, periodStart);
    return portfolio.portfolioValue;
  }

  async periodReturn(
    clientId: string,
    period: PerformancePeriod,
    range: { from: Date; to: Date },
  ): Promise<PeriodReturn> {
    const [openingValue, closingPortfolio] = await Promise.all([
      this.openingValue(clientId, range.from),
      this.history.getPortfolioAsOf(clientId, range.to),
    ]);

    const closingValue = closingPortfolio.portfolioValue;
    const returnPct = openingValue > 0 ? (closingValue - openingValue) / openingValue : null;

    return { period, from: range.from, to: range.to, openingValue, closingValue, returnPct };
  }

  /** Convenience windows — calendar MTD/QTD/YTD anchored on `asOf` (defaults to now). */
  static windowFor(period: 'MTD' | 'QTD' | 'YTD', asOf: Date = new Date()): { from: Date; to: Date } {
    const y = asOf.getUTCFullYear();
    const m = asOf.getUTCMonth();

    if (period === 'MTD') {
      return { from: new Date(Date.UTC(y, m, 1)), to: asOf };
    }
    if (period === 'QTD') {
      const q = Math.floor(m / 3);
      return { from: new Date(Date.UTC(y, q * 3, 1)), to: asOf };
    }
    return { from: new Date(Date.UTC(y, 0, 1)), to: asOf }; // YTD
  }
}
