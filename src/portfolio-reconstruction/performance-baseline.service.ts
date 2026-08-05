import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService, BenchmarkWindowResult } from './benchmark-history.service';
import { CashFlow } from '../analytics/calculators/xirr';
import { ResolvedPeriod } from './periods';

/**
 * Widened from the original four-value union to any code `resolvePeriod`
 * understands — which now includes 'INCEPTION' and named quarters like
 * 'Q3-CY26'. Kept as a string alias rather than a closed union because the
 * quarter codes are generated from the calendar, not enumerated.
 */
export type PerformancePeriod = string;

export interface PeriodReturn {
  period: PerformancePeriod;
  /** Human label for the selected window, e.g. "Q3 CY26". */
  label: string;
  from: Date;
  to: Date;
  /** True when `from` was pulled forward to the 30-June-2026 inception. */
  clampedToInception: boolean;
  /** True when the period has not closed yet and `to` is today. */
  openPeriod: boolean;
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

  /**
   * Accepts a resolved window (see periods.ts) rather than a bare code, so the
   * inception clamp and the open-quarter clamp are applied in exactly one place
   * and this service never has to re-derive a calendar boundary.
   */
  async periodReturn(clientId: string, resolved: ResolvedPeriod): Promise<PeriodReturn> {
    const { from, to } = resolved;

    const [client, openingValue, closingPortfolio] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: clientId } }),
      this.openingValue(clientId, from),
      this.history.getPortfolioAsOf(clientId, to),
    ]);

    const closingValue = closingPortfolio.portfolioValue;
    const returnPct = openingValue > 0 ? (closingValue - openingValue) / openingValue : null;

    const flows = await this.windowFlows(clientId, from, to, openingValue, closingValue);
    const benchmark = client
      ? await this.benchmarkHistory.windowReturn(undefined, client.benchmarkId, flows, to)
      : null;

    return {
      period: resolved.period,
      label: resolved.label,
      from,
      to,
      clampedToInception: resolved.clampedToInception,
      openPeriod: resolved.openPeriod,
      openingValue,
      closingValue,
      returnPct,
      benchmark,
    };
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

}
