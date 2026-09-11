import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService, BenchmarkWindowResult } from './benchmark-history.service';
import { CashFlow, xirr } from '../analytics/calculators/xirr';
import { AccountingMethod, buildWindowFlows } from '../analytics/calculators/flows';
import { ResolvedPeriod } from './periods';
import { Market, currencyForMarket } from '../common/market-scope';
import { Actor, assertOwns } from '../common/ownership-scope';

/**
 * One member account's contribution to the household figure.
 *
 * Reported alongside the household number rather than instead of it: the
 * aggregate answers "how is this family doing", and this table answers the
 * immediate follow-up, "which account moved it". Each member's `returnPct` is
 * that account measured on its own — the same figure its own client sheet
 * shows — so a reader can cross-check a member row against the individual page
 * and get the same number back.
 */
export interface FamilyMemberPerformance {
  clientId: string;
  clientName: string;

  openingValue: number;
  closingValue: number;
  netFlows: number;

  /**
   * The account's own money-weighted return over the window, or null when it
   * cannot be solved for this member alone.
   *
   * A null here does NOT remove the member from the household total — see the
   * class doc. An account that joined mid-window has no meaningful standalone
   * return for the whole window, but its capital and its gain still belong in
   * the family's.
   */
  returnPct: number | null;
  returnReason?: string;

  /** What the account gained over the window, net of its own deposits. */
  gain: number;

  /**
   * Set when this member's measurement window opens later than the
   * household's, because the account itself starts later.
   */
  entryDate?: Date;

  /** Share of the household's closing value — what this account is, as a weight. */
  weight: number;
}

export interface FamilyPeriodReturn {
  familyId: string;
  familyName: string;
  market: Market;
  currency: string;

  period: string;
  label: string;
  from: Date;
  to: Date;
  clampedToInception: boolean;
  nominalFrom?: Date;
  daysClamped: number;
  openPeriod: boolean;
  periodDays: number;

  /** Sum over members of their opening value at the window's start. */
  openingValue: number;
  /** Sum over members of their closing value at the window's end. */
  closingValue: number;
  /**
   * Net external money into the HOUSEHOLD over the window.
   *
   * Covers both real member deposits/withdrawals and the arrival of an account
   * that joins mid-window — see `householdFlows`, where the two are
   * deliberately treated as the same kind of event.
   */
  netFlows: number;

  /** THE headline: money-weighted return for the household as one account. */
  returnPct: number | null;
  annualizedReturnPct: number | null;
  returnReason?: string;
  /** (closing − opening) / opening. A reconciliation line, never the headline. */
  simpleReturnPct: number | null;

  /** The household's index over the same window, priced on the same flows. */
  benchmark: BenchmarkWindowResult | null;
  alpha: number | null;

  memberCount: number;
  members: FamilyMemberPerformance[];

  /**
   * Members whose measurement window opens after the household's, with the
   * date each one enters. Surfaced so the sheet can say so in words rather
   * than leaving a reader to wonder why the parts do not look like the whole.
   */
  lateEntrants: Array<{ clientId: string; clientName: string; entryDate: Date }>;
}

/**
 * Performance for a FAMILY, computed as though the household were one account.
 *
 * The decision that governs everything here: the household return is solved
 * ONCE, on the household's combined cash-flow series. It is NOT an average of
 * the members' returns, weighted or otherwise.
 *
 * That distinction is not a refinement, it is the difference between a right
 * and a wrong number. A weighted mean of member XIRRs answers no question — it
 * has no reading as a rate of return on the family's money, because each
 * member's rate is already normalised by its own capital and its own timing.
 * Two accounts that each returned 10% do not make a household that returned
 * 10% if one held ten times the capital for half as long. Solving one XIRR
 * over the merged flows is the only construction under which the household
 * figure means what the individual figures mean.
 *
 * MEMBERS THAT START MID-WINDOW. An account that opens after the window does
 * is handled the way the engine already handles any other capital arriving
 * mid-period: it enters the household's flow series as a deposit, dated the
 * day it joins. Nothing is excluded and no window is shortened. This is what
 * "treat the whole family as one account" requires — a household that took on
 * a new account in August has genuinely received money in August, and its
 * return for the quarter should reflect having held that money for part of the
 * quarter rather than all of it. The alternatives (dropping the member, or
 * clamping the whole household back to its latest entrant) would either
 * understate the family's assets or throw away real measured performance from
 * every other account.
 *
 * BENCHMARK. One index for the household, resolved from the family's market —
 * not blended per member. It is priced on the household's own flow series, so
 * the index is bought and sold on exactly the days the family's money moved,
 * including the day a new account joined. Alpha is therefore like-for-like:
 * same money, same days, both sides money-weighted.
 */
@Injectable()
export class FamilyPerformanceService {
  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
    private benchmarkHistory: BenchmarkHistoryService,
  ) {}

  async periodReturn(
    familyId: string,
    resolved: ResolvedPeriod,
    actor: Actor,
  ): Promise<FamilyPeriodReturn> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: {
        clients: {
          // accountingMethod is selected because it decides which ledger rows
          // are flows for this member's window - a transactional book's BUYs,
          // a cash-flow book's deposits. See buildWindowFlows.
          select: {
            id: true,
            name: true,
            createdAt: true,
            benchmarkId: true,
            accountingMethod: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    // Same 404-for-absent-and-for-someone-else's rule as the other family
    // routes: a household's performance discloses its member roster.
    assertOwns(actor, family, 'Family');
    if (!family) throw new NotFoundException(`Family ${familyId} not found`);

    const { from, to } = resolved;
    const market = family.market as Market;
    const periodDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));

    if (family.clients.length === 0) {
      return this.emptyHousehold(family, resolved, periodDays, market);
    }

    // Value every member at both ends of the window, in parallel. Each call
    // goes through the same snapshot-first / reconstruct-fallback path a single
    // client's sheet uses, so a member's contribution here and that member's
    // own page are answered by the same code rather than by two engines.
    const measured = await Promise.all(
      family.clients.map(async (c) => {
        const [openPortfolio, closePortfolio, flows] = await Promise.all([
          this.history.getPortfolioAsOf(c.id, from),
          this.history.getPortfolioAsOf(c.id, to),
          this.memberFlows(
            c.id,
            from,
            to,
            (c.accountingMethod ?? 'TRANSACTIONAL') as AccountingMethod,
          ),
        ]);
        return {
          client: c,
          openingValue: openPortfolio.portfolioValue,
          closingValue: closePortfolio.portfolioValue,
          flows,
        };
      }),
    );

    const openingValue = measured.reduce((s, m) => s + m.openingValue, 0);
    const closingValue = measured.reduce((s, m) => s + m.closingValue, 0);

    /**
     * An account with nothing at the window's open but something at its close,
     * and no deposit inside the window to explain it, joined the household
     * mid-window. Its balance arrived as capital rather than as return, so it
     * is carried into the flow series as a deposit on its entry date.
     *
     * `createdAt` supplies that date when it falls inside the window — the
     * account record's own start is the best evidence available of when the
     * money joined. Where it does not, the account is left as an ordinary
     * zero-opening member, which credits the household with having held the
     * money for the whole window: the conservative direction, understating the
     * return rather than flattering it.
     */
    const lateEntrants: FamilyPeriodReturn['lateEntrants'] = [];
    for (const m of measured) {
      if (m.openingValue > 0 || m.closingValue <= 0 || m.flows.length > 0) continue;
      const created = m.client.createdAt;
      if (created && created > from && created < to) {
        lateEntrants.push({
          clientId: m.client.id,
          clientName: m.client.name,
          entryDate: created,
        });
      }
    }

    const flows = this.householdFlows(measured, lateEntrants, from, to, openingValue, closingValue);

    /**
     * One benchmark for the whole household, taken from the family's book.
     *
     * Deliberately NOT blended across members' individual `benchmarkId`s: the
     * family is being measured as one account, and one account has one index.
     * Where every member already shares the book's default (the Indian book's
     * NIFTY 50) this is the same index each is measured against on its own
     * page, which keeps a member row and the household row comparable.
     */
    const benchmark = await this.benchmarkHistory.windowReturn(
      undefined,
      this.householdBenchmarkId(family.clients),
      flows,
      to,
      market,
    );

    const solved = xirr(flows);
    const annualized = solved.status === 'ok' ? solved.rate : null;
    // Same de-annualization, same 365-day basis and same 30-day floor as the
    // single-client engine, so a one-member family reports exactly what that
    // member's own sheet reports.
    const returnPct = annualized !== null ? (1 + annualized) ** (periodDays / 365) - 1 : null;
    const annualizedReturnPct = periodDays >= 30 ? annualized : null;

    const netFlows = flows.slice(1, -1).reduce((sum, f) => sum - f.amount, 0);

    return {
      familyId: family.id,
      familyName: family.name,
      market,
      currency: currencyForMarket(market),
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
      simpleReturnPct: openingValue > 0 ? (closingValue - openingValue) / openingValue : null,
      benchmark,
      alpha:
        returnPct !== null && benchmark?.interim != null ? returnPct - benchmark.interim : null,
      memberCount: family.clients.length,
      members: this.memberRows(measured, lateEntrants, from, to, closingValue),
      lateEntrants,
    };
  }

  /**
   * The household's flow series — the single input the headline is solved on.
   *
   * Built in the same unit-purchase convention the single-client engine uses
   * (money in negative, money out positive):
   *
   *   1. The summed opening value of every member, at the window's start.
   *   2. Every real member deposit/withdrawal inside the window, on its own
   *      date, from every account, merged into ONE series and sorted. This is
   *      the step that makes the household one account: a transfer out of one
   *      member and into another on the same day nets to zero here, which is
   *      right — the family neither gained nor lost money by moving it.
   *   3. The arriving balance of any account that JOINED mid-window, as a
   *      deposit on its entry date. Capital arriving, exactly like (2).
   *   4. The summed closing value of every member, at the window's end.
   */
  private householdFlows(
    measured: Array<{ client: { id: string }; closingValue: number; flows: CashFlow[] }>,
    lateEntrants: FamilyPeriodReturn['lateEntrants'],
    from: Date,
    to: Date,
    openingValue: number,
    closingValue: number,
  ): CashFlow[] {
    const interior: CashFlow[] = measured.flatMap((m) => m.flows);

    for (const entrant of lateEntrants) {
      const m = measured.find((x) => x.client.id === entrant.clientId);
      if (!m) continue;
      // What the account was worth on the day it joined is not knowable without
      // pricing it on that date; its closing value is the amount that must not
      // be booked as household return, and dating it at entry is what stops the
      // family from counting a new account's whole balance as performance. Any
      // growth it earned after joining is still measured, because it is the
      // difference between this dated deposit and the closing total.
      interior.push({ date: entrant.entryDate, amount: -Math.abs(m.closingValue) });
    }

    interior.sort((a, b) => a.date.getTime() - b.date.getTime());

    return [{ date: from, amount: -openingValue }, ...interior, { date: to, amount: closingValue }];
  }

  /**
   * One member's real external flows inside the window.
   *
   * Delegates to the shared `buildWindowFlows` so a member contributes the
   * SAME flows to the household series that its own sheet is solved on - the
   * property the household figure depends on, since it is one XIRR over the
   * merged flows rather than an average of member returns.
   *
   * The method matters: this previously looked only for CASH_DEPOSIT /
   * CASH_WITHDRAWAL rows, which a transactional book never has, so every
   * member contributed an empty flow list and the household's fresh capital
   * was reported as household return. See buildWindowFlows.
   */
  private async memberFlows(
    clientId: string,
    from: Date,
    to: Date,
    method: AccountingMethod,
  ): Promise<CashFlow[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { clientId, date: { gt: from, lt: to } },
      orderBy: { date: 'asc' },
    });

    return buildWindowFlows(rows, method, from, to);
  }

  /**
   * Per-member rows for the breakdown table.
   *
   * Each member's own return is solved on that member's own flows — the same
   * construction its individual sheet uses — so the two agree. These do NOT
   * sum or average to the household figure above, and are not meant to: the
   * household is solved on merged flows for the reasons in the class doc. The
   * column that DOES reconcile to the household is `gain`, which sums exactly.
   */
  private memberRows(
    measured: Array<{
      client: { id: string; name: string };
      openingValue: number;
      closingValue: number;
      flows: CashFlow[];
    }>,
    lateEntrants: FamilyPeriodReturn['lateEntrants'],
    from: Date,
    to: Date,
    householdClosing: number,
  ): FamilyMemberPerformance[] {
    return measured
      .map((m) => {
        const entrant = lateEntrants.find((e) => e.clientId === m.client.id);
        const memberFrom = entrant?.entryDate ?? from;
        const memberDays = Math.max(
          1,
          Math.round((to.getTime() - memberFrom.getTime()) / 86_400_000),
        );

        const netFlows = m.flows.reduce((sum, f) => sum - f.amount, 0);

        // A late entrant has no opening value to solve against, so its
        // standalone return is not measurable for this window even though its
        // gain still counts in the household's. Reported as such, not as a zero.
        const solved =
          m.openingValue > 0
            ? xirr([
                { date: from, amount: -m.openingValue },
                ...m.flows,
                { date: to, amount: m.closingValue },
              ])
            : null;

        const annualized = solved?.status === 'ok' ? solved.rate : null;
        const returnPct = annualized !== null ? (1 + annualized) ** (memberDays / 365) - 1 : null;

        return {
          clientId: m.client.id,
          clientName: m.client.name,
          openingValue: m.openingValue,
          closingValue: m.closingValue,
          netFlows,
          returnPct,
          returnReason: entrant
            ? 'Joined the household during this period'
            : solved?.status === 'no-solution'
              ? solved.reason
              : m.openingValue <= 0
                ? 'No opening value for this window'
                : undefined,
          gain: m.closingValue - m.openingValue - netFlows,
          entryDate: entrant?.entryDate,
          weight: householdClosing > 0 ? m.closingValue / householdClosing : 0,
        };
      })
      .sort((a, b) => b.closingValue - a.closingValue);
  }

  /**
   * The household's benchmark id.
   *
   * The family is one account and gets one index. Where the members agree, it
   * is the index they agree on; where they do not, null hands the choice to
   * `resolveBenchmark`, which returns the family MARKET'S default — the right
   * answer for a household, rather than one member's override imposed on
   * everyone else's money.
   */
  private householdBenchmarkId(clients: Array<{ benchmarkId: string | null }>): string | null {
    const ids = new Set(clients.map((c) => c.benchmarkId).filter(Boolean) as string[]);
    return ids.size === 1 ? [...ids][0] : null;
  }

  private emptyHousehold(
    family: { id: string; name: string },
    resolved: ResolvedPeriod,
    periodDays: number,
    market: Market,
  ): FamilyPeriodReturn {
    return {
      familyId: family.id,
      familyName: family.name,
      market,
      currency: currencyForMarket(market),
      period: resolved.period,
      label: resolved.label,
      from: resolved.from,
      to: resolved.to,
      clampedToInception: resolved.clampedToInception,
      nominalFrom: resolved.nominalFrom,
      daysClamped: resolved.daysClamped,
      openPeriod: resolved.openPeriod,
      periodDays,
      openingValue: 0,
      closingValue: 0,
      netFlows: 0,
      returnPct: null,
      annualizedReturnPct: null,
      returnReason: 'This household has no member accounts yet.',
      simpleReturnPct: null,
      benchmark: null,
      alpha: null,
      memberCount: 0,
      members: [],
      lateEntrants: [],
    };
  }
}
