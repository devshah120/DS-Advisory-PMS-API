import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService, BenchmarkWindowResult } from './benchmark-history.service';
import { CashFlow } from '../analytics/calculators/xirr';

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
  /** The index over the SAME window, same unit-purchase method as the
   *  Current tab's Alpha card. Null when the client has no benchmark set. */
  benchmark: BenchmarkWindowResult | null;
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
  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
    private benchmarkHistory: BenchmarkHistoryService,
  ) {}

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
    const [client, openingValue, closingPortfolio] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId } }),
      this.openingValue(clientId, range.from),
      this.history.getPortfolioAsOf(clientId, range.to),
    ]);

    const closingValue = closingPortfolio.portfolioValue;
    const returnPct = openingValue > 0 ? (closingValue - openingValue) / openingValue : null;

    const flows = await this.windowFlows(clientId, range.from, range.to, openingValue, closingValue);
    const benchmark = client
      ? await this.benchmarkHistory.windowReturn(undefined, client.benchmarkId, flows, range.to)
      : null;

    return { period, from: range.from, to: range.to, openingValue, closingValue, returnPct, benchmark };
  }

  /**
   * The unit-purchase flow series for one window: the opening value stands
   * in for "money invested at the start of the window" (negative — money
   * in), the closing value is the terminal flow (positive — money out /
   * still held). Any real deposit/withdrawal that falls strictly inside the
   * window is added as its own flow, using the same TYPE → sign convention
   * as buildFlows in analytics/calculators/flows.ts (CASH_DEPOSIT is money
   * in, CASH_WITHDRAWAL is money out) — so a QTD window that happens to
   * contain a real contribution still prices the benchmark correctly rather
   * than pretending the whole window's money arrived on day one.
   */
  private async windowFlows(
    clientId: string,
    from: Date,
    to: Date,
    openingValue: number,
    closingValue: number,
  ): Promise<CashFlow[]> {
    const midWindowDeposits = await this.prisma.transaction.findMany({
      where: {
        clientId,
        type: { in: ['CASH_DEPOSIT', 'CASH_WITHDRAWAL'] },
        date: { gt: from, lt: to },
      },
      orderBy: { date: 'asc' },
    });

    const flows: CashFlow[] = [{ date: from, amount: -openingValue }];

    for (const t of midWindowDeposits) {
      flows.push({
        date: t.date,
        amount: t.type === 'CASH_DEPOSIT' ? -Math.abs(t.amount) : Math.abs(t.amount),
      });
    }

    flows.push({ date: to, amount: closingValue });
    return flows;
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
