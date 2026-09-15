import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService, BenchmarkWindowResult } from './benchmark-history.service';
import { CashFlow, xirr } from '../analytics/calculators/xirr';
import { AccountingMethod, appliesHouseRebase, buildWindowFlows } from '../analytics/calculators/flows';
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
   *
   * ── SECURITIES ONLY — cash is never measured ──────────────────────────────
   * This returns `holdingsValue`, NOT `portfolioValue`, and the closing side of
   * the window does the same. The idle cash balance is a figure the manager
   * maintains for their own bookkeeping (see CashFlowModal: its three modes all
   * write `Client.cashBalance` directly and never create a ledger row), and it
   * MUST NOT move any reported return in any direction.
   *
   * Including it did exactly that. Cash sat inside both ends of the window, so
   * setting a balance, adding to it or withdrawing from it silently re-priced
   * the opening and closing values of a window whose trades had not changed at
   * all — and because the amount never appears in the flow series (a
   * transactional book has no CASH_DEPOSIT rows, by design), XIRR had no way to
   * recognise it as capital arriving. It was therefore solved as PERFORMANCE:
   * park a lakh of cash and the book reports a gain it did not earn; withdraw
   * it and the book reports a loss it did not suffer.
   *
   * Measuring securities alone makes the guarantee structural rather than
   * conventional — there is no cash term left in the arithmetic to leak. It
   * also matches what the Clients list already does (`deriveMetrics` sets the
   * terminal value to holdings only, "idle cash is excluded from the
   * transactional return"), so the two pages can no longer disagree.
   *
   * The cash balance is still reported everywhere it is genuinely informative —
   * portfolio value, allocation weights, the household total — it simply has no
   * vote on return.
   */
  async openingValue(clientId: string, periodStart: Date): Promise<number> {
    const portfolio = await this.history.getPortfolioAsOf(clientId, periodStart);
    return portfolio.holdingsValue;
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

    const closingValue = closingPortfolio.holdingsValue;
    const simpleReturnPct =
      openingValue > 0 ? (closingValue - openingValue) / openingValue : null;

    /**
     * The cash-flow method is retired product-wide (see PerformanceService,
     * which hardcodes this same override and explains why: a legacy row still
     * stored as CASH_FLOW must not compute differently here than it does on
     * the Clients list). This service previously read `client.accountingMethod`
     * directly, which is the exact split bug that override closes elsewhere —
     * left open here, so this fix must match it.
     */
    const method: AccountingMethod = 'TRANSACTIONAL';
    const flows = await this.windowFlows(clientId, from, to, openingValue, closingValue, method);
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
   * The flow series for one window: the opening value stands in for "money
   * invested at the start of the window" (negative - money in), the closing
   * value is the terminal flow (positive - money out / still held), and every
   * real flow strictly inside the window sits between them on its own date.
   *
   * Which ledger rows count as "a real flow" is decided by the CLIENT'S
   * ACCOUNTING METHOD, via the shared `buildWindowFlows` - not by a hardcoded
   * CASH_DEPOSIT/CASH_WITHDRAWAL filter. That filter is correct for a cash-flow
   * book and silently wrong for a transactional one, which has no cash rows at
   * all: the window then saw no flows, XIRR reduced to a two-point series, and
   * the headline "flow-adjusted" return became the naive (close - open) / open
   * figure - reporting freshly deployed capital as though it were gain. See the
   * doc comment on buildWindowFlows for the full account.
   */
  private async windowFlows(
    clientId: string,
    from: Date,
    to: Date,
    openingValue: number,
    closingValue: number,
    method: AccountingMethod,
  ): Promise<CashFlow[]> {
    const [ledger, baseline, firstTransaction] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { clientId, date: { gt: from, lt: to } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.portfolioBaseline.findUnique({
        where: { clientId },
        select: { baselineDate: true },
      }),
      /**
       * The client's FIRST transaction ever — deliberately unbounded by the
       * window, unlike `ledger` above.
       *
       * The window tells us nothing about whether this client was in the bulk
       * import; only their earliest history does. Querying it separately is
       * what lets a Q3-FY26 window on a December-2025 mandate know that the
       * house rebase does not apply to it, even though no row inside that
       * window would reveal it.
       */
      this.prisma.transaction.findFirst({
        where: { clientId },
        orderBy: { date: 'asc' },
        select: { date: true },
      }),
    ]);

    // The import-artifact filter only applies when this client's baseline IS
    // the shared house baseline — and a ledger reaching back before the house
    // date is proof that it is not, whatever the baseline row says. A client
    // with no baseline row and no earlier history falls back to the synthetic
    // house-dated one (PortfolioReconstructionService), so absence still counts
    // as "house baseline". See appliesHouseRebase and isImportArtifact.
    const isHouseBaseline = appliesHouseRebase({
      baselineDate: baseline?.baselineDate,
      firstTransactionDate: firstTransaction?.date ?? null,
    });
    const interior = buildWindowFlows(ledger, method, from, to, undefined, isHouseBaseline);

    return [
      { date: from, amount: -openingValue },
      ...interior,
      { date: to, amount: closingValue },
    ];
  }

}
