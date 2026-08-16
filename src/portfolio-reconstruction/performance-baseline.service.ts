import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService, BenchmarkWindowResult } from './benchmark-history.service';
import { CashFlow, xirr } from '../analytics/calculators/xirr';
import { ResolvedPeriod } from './periods';
import { Market } from '../common/market-scope';

/**
 * Widened from the original four-value union to any code `resolvePeriod`
 * understands — which now includes 'INCEPTION' and named quarters like
 * 'Q3-CY26'. Kept as a string alias rather than a closed union because the
 * quarter codes are generated from the calendar, not enumerated.
 */
export type PerformancePeriod = string;

export interface PeriodReturn {
  period: PerformancePeriod;
  /** Human label for the selected window, e.g. "Q2 FY27". */
  label: string;
  from: Date;
  to: Date;
  /** True when `from` was pulled forward to the 30-June-2026 inception. */
  clampedToInception: boolean;
  /** Where the window would have opened without the inception clamp. */
  nominalFrom?: Date;
  /** Days lost to the clamp. Zero when the window is whole. */
  daysClamped: number;
  /** True when the period has not closed yet and `to` is today. */
  openPeriod: boolean;
  /** Calendar length of the measured window, in days. */
  periodDays: number;

  openingValue: number;
  closingValue: number;

  /**
   * Net external money added during the window (deposits − withdrawals).
   *
   * Reported because it is what separates the two return figures below, and a
   * reader who cannot see it cannot tell why they differ.
   */
  netFlows: number;

  /**
   * THE headline: money-weighted return over the window, de-annualized to the
   * window's own length.
   *
   * This is the number the sheet leads with, and it is flow-adjusted — a
   * mid-quarter deposit is treated as capital arriving, not as performance. See
   * the note on `simpleReturnPct` for why that distinction is not academic.
   */
  returnPct: number | null;
  /** The same money-weighted rate, annualized. Null on windows under 30 days. */
  annualizedReturnPct: number | null;
  /** Set when the solver could not find a rate, so the sheet can say why. */
  returnReason?: string;

  /**
   * The naive (closing − opening) / opening figure.
   *
   * Kept, clearly labelled, because it ties to a custody statement and operators
   * ask for it — but it is NOT the headline, because it counts deposits as
   * return. On a book that took a large mid-quarter contribution the two can
   * differ by tens of percent, and the simple figure is the flattering one.
   */
  simpleReturnPct: number | null;

  /** The index over the SAME window, same unit-purchase method. */
  benchmark: BenchmarkWindowResult | null;
  /** Portfolio − benchmark over this window. Both money-weighted, same flows. */
  alpha: number | null;
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
    const simpleReturnPct =
      openingValue > 0 ? (closingValue - openingValue) / openingValue : null;

    const flows = await this.windowFlows(clientId, from, to, openingValue, closingValue);
    // The client's own book decides the benchmark: an Indian mandate is measured
    // against the Nifty 50, not the S&P 500. Passing market here is what makes
    // the unset-benchmarkId case (every client seeded so far) resolve correctly.
    const benchmark = client
      ? await this.benchmarkHistory.windowReturn(
          undefined,
          client.benchmarkId,
          flows,
          to,
          client.market as Market,
        )
      : null;

    /**
     * The money-weighted return over this window — the headline figure.
     *
     * Solved on EXACTLY the flow series the benchmark is priced on (opening
     * value in, real mid-window deposits/withdrawals on their own dates, closing
     * value out). That identity is the point: alpha is only meaningful if both
     * sides saw the same money on the same days, and the previous
     * implementation compared a flow-contaminated portfolio number against a
     * flow-adjusted benchmark — so a client who deposited mid-quarter showed
     * fake alpha proportional to the size of their deposit.
     *
     * XIRR is annualized by construction, so it is de-annualized back onto the
     * window to give the figure that is comparable to the benchmark's interim.
     */
    const periodDays = Math.max(
      1,
      Math.round((to.getTime() - from.getTime()) / 86_400_000),
    );

    const solved = xirr(flows);
    const annualized = solved.status === 'ok' ? solved.rate : null;

    /**
     * De-annualization mirrors PerformanceService exactly — same formula, same
     * 365-day basis — so the two engines cannot report different numbers for the
     * same window.
     */
    const returnPct =
      annualized !== null ? (1 + annualized) ** (periodDays / 365) - 1 : null;

    /**
     * Annualizing a short window extrapolates noise: a 2% move over 11 days is
     * "+95% a year". The same 30-day floor PerformanceService applies.
     */
    const annualizedReturnPct = periodDays >= 30 ? annualized : null;

    const netFlows = flows
      .slice(1, -1)
      .reduce((sum, f) => sum - f.amount, 0);

    return {
      period: resolved.period,
      label: resolved.label,
      from,
      to,
      clampedToInception: resolved.clampedToInception,
      nominalFrom: resolved.nominalFrom,
      daysClamped: resolved.daysClamped,
      openPeriod: resolved.openPeriod,
      periodDays,
      openingValue,
      closingValue,
      netFlows,
      returnPct,
      annualizedReturnPct,
      returnReason: solved.status === 'no-solution' ? solved.reason : undefined,
      simpleReturnPct,
      benchmark,
      alpha:
        returnPct !== null && benchmark?.interim != null
          ? returnPct - benchmark.interim
          : null,
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
