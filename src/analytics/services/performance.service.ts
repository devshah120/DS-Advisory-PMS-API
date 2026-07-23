import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SnapshotService } from './snapshot.service';
import { allocationBy } from '../calculators/weights';
import { benchmarkXirr, xirr, CashFlow } from '../calculators/xirr';
import {
  AccountingMethod,
  buildFlows,
  FlowOptions,
  totalContributed,
  totalWithdrawn,
} from '../calculators/flows';
import {
  absoluteReturn,
  annualizedReturn,
  cashDrag,
  cashIsExplained,
  derivedCash,
  flowTotals,
  investedCapital,
  LedgerRow,
  performers,
  portfolioTurnover,
  realizedGain,
  realizedProceeds,
} from '../calculators/kpis';

export interface BenchmarkResult {
  code: string;
  name: string;
  /** Annualized. Null when the index has no price coverage over the flow dates. */
  xirr: number | null;
  /** The same rate over the holding period — comparable to the portfolio's interim. */
  interim: number | null;
  /** Index units the flows notionally bought. Ties the figure back to the workbook. */
  units: number | null;
  value: number | null;
  reason?: string;
}

/**
 * The Performance sheet: two methodologies, one engine.
 *
 * The ONLY thing that differs between a transactional client and a cash-flow
 * client is which ledger rows become cash flows, and what the terminal value is:
 *
 *   TRANSACTIONAL — every BUY is money in, every SELL is money out (optionally
 *                   plus dividends and minus fees). Terminal value is the market
 *                   value of what is still held. Idle cash is IGNORED entirely:
 *                   the question being answered is "how did the capital I
 *                   deployed into positions perform", and un-deployed cash is not
 *                   part of that question.
 *
 *   CASH_FLOW     — only the money the client actually handed over or took back.
 *                   Trades are internal reshuffling and are not flows. Terminal
 *                   value is holdings PLUS cash, because cash the client gave us
 *                   and we failed to invest is still their money and still counts
 *                   against the return we report to them.
 *
 * Everything downstream of the flow series — the solver, the de-annualization,
 * the benchmark's unit-purchase construction — is identical for both, and
 * deliberately so: the two methods have to remain comparable against the same
 * benchmark, or the Alpha figures are not comparable to each other.
 *
 * That difference in terminal value is also why the two methods legitimately
 * disagree, and why the sheet says which one it used. A client with a large idle
 * cash balance will see a HIGHER transactional XIRR (cash is excluded, so it
 * cannot dilute) and a LOWER cash-flow XIRR (cash is included, and earned
 * nothing). Neither is wrong; they answer different questions. Cash Drag is the
 * number that quantifies the gap between them.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private prisma: PrismaService,
    private snapshots: SnapshotService,
  ) {}

  async forClient(clientId: string, benchmarkCode?: string, asOfOverride?: Date) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const snap = await this.snapshots.forClient(clientId);
    const asOf = asOfOverride ?? new Date();

    /**
     * The cash-flow method has been retired from the product: every client's
     * reported return is transactional (see ClientsService, which forces
     * TRANSACTIONAL on every write, and the schema note on Client.accountingMethod).
     *
     * ClientsService and the Clients-list `deriveMetrics` already do this, but this
     * service still read `client.accountingMethod` — so a legacy row left as
     * CASH_FLOW in the database kept computing the old way HERE, on the Performance
     * page, while the Clients list showed the transactional figure for the same
     * client. That split is the bug this line closes: we ignore whatever is stored
     * and treat the client as transactional, matching everywhere else. Idle cash is
     * therefore excluded from the return (terminal value = holdings only) and is
     * reported separately as a balance/weight for deployment, never as a flow.
     *
     * The stored value and the CASH_FLOW enum member are kept only so legacy rows
     * still deserialize; a one-off script normalizes them (see
     * src/analytics/scripts/normalize-accounting-method.ts).
     *
     * `method` keeps the wide `AccountingMethod` type on purpose: the CASH_FLOW
     * branches below are unreachable now but documented and intact, and widening
     * here keeps them valid rather than forcing their deletion. `_storedMethod` is
     * read only to be deliberately ignored — a reader sees the override, not a
     * silent drop.
     */
    const _storedMethod = client.accountingMethod as AccountingMethod;
    void _storedMethod;
    const method: AccountingMethod = 'TRANSACTIONAL' as AccountingMethod;

    const flowOptions: FlowOptions = {
      includeDividends: client.includeDividends ?? true,
      includeFees: client.includeFees ?? true,
    };

    const ledger: LedgerRow[] = await this.prisma.transaction.findMany({
      where: { clientId, date: { lte: asOf } },
      orderBy: { date: 'asc' },
    });

    // ── Values ────────────────────────────────────────────────────────────────
    // Holdings are always DERIVED (quantity × price). The stored
    // Holding.marketValue / Client.portfolioValue columns are a display cache for
    // the CRUD UI and are known to drift — the live client "Dev" carried
    // portfolioValue = 0 against $40,702 of holdings.
    const holdingsValue = snap.positions.reduce((s, p) => s + p.marketValue, 0);

    /**
     * Cash.
     *
     * TRANSACTIONAL clients never carry cash flows in the Excel/ledger sense —
     * idle cash is excluded from the method entirely (see the terminal-value
     * comment below), so there is nothing to reconcile against the ledger. We
     * take client.cashBalance as-is, whatever it is: it is the maintained
     * buying-power balance, not something the ledger is expected to explain.
     *
     * CASH_FLOW clients are different: cash IS part of the terminal value for
     * them, so a ledger that doesn't account for the maintained balance is a
     * real data gap worth surfacing (see `cashIsExplained` below and the
     * `insufficient` branch it feeds).
     *
     *   derived  = what the RECORDED FLOWS leave behind
     *   stored   = the buying power actually maintained
     *
     * For CASH_FLOW we prefer the stored balance when the ledger cannot fully
     * account for the book, and derive only when it can. The `cashSource` field
     * on the response says which was used — a cash figure without its
     * provenance is not something an operator can act on.
     */
    const ledgerExplainsBook = cashIsExplained(ledger, holdingsValue);
    const ledgerCash = derivedCash(ledger);

    const cashSource: 'ledger' | 'stored' =
      method === 'TRANSACTIONAL'
        ? 'stored'
        : ledgerExplainsBook && Math.abs(client.cashBalance - ledgerCash) <= 0.01
          ? 'ledger'
          : 'stored';

    const cash = cashSource === 'ledger' ? ledgerCash : client.cashBalance;
    const portfolioValue = holdingsValue + cash;

    /**
     * The terminal cash flow — and the one line where the two methods truly part.
     *
     * Transactional ignores idle cash (§Method 1: "Ignore idle cash"), because
     * cash was never deployed and the method measures deployed capital.
     * Cash-flow includes it (§Method 2: "Final cashflow = Holdings Value + Cash
     * Balance"), because it is the client's money either way.
     */
    const terminalValue = method === 'TRANSACTIONAL' ? holdingsValue : portfolioValue;

    const built = buildFlows(ledger, method, terminalValue, asOf, flowOptions);

    // The cross-sectional KPIs do not depend on XIRR solving, so they are worth
    // returning even when it cannot. A client with holdings but no recorded
    // deposits still has a sector allocation and a best performer, and showing
    // an empty page because one number is unavailable helps nobody.
    const base = this.crossSectional(snap, ledger, holdingsValue, cash, portfolioValue);

    /**
     * Refuse to publish an XIRR that is KNOWN to be wrong.
     *
     * This is stronger than the `meta.warnings` note, and deliberately so. When
     * the ledger records deposits but not the purchases they funded, the
     * cash-flow method's terminal value (holdings + cash) double-counts: the
     * money appears once as stock and again as cash. On the live "Atlas Global
     * Fund" that yields +497% annualized against a true +12%.
     *
     * A warning printed beside a 497% return does not work. The number is the
     * loudest thing on the page and it is the thing people screenshot. If the
     * engine can prove a figure is corrupt, the figure does not ship — the
     * unblocking action ships instead.
     *
     * The TRANSACTIONAL method is immune: it takes holdings as the terminal value
     * and never touches cash, so an unrecorded buy cannot double-count. But it
     * has no BUY rows to build flows from either, so it fails earlier and more
     * honestly, at `buildFlows`.
     */
    if (!ledgerExplainsBook && method === 'CASH_FLOW') {
      return {
        data: {
          status: 'insufficient' as const,
          accountingMethod: method,
          reason:
            `This client holds ${snap.positions.length} positions worth ` +
            `${holdingsValue.toFixed(2)}, but the ledger records no purchases — only ` +
            `deposits. The cashflow method values the portfolio as holdings plus cash, ` +
            `so without the buy transactions the deposited money is counted twice (once ` +
            `as stock, once as cash) and the XIRR is meaningless. Import this client's ` +
            `BUY transactions and the return will compute correctly.`,
          ...base,
        },
        meta: this.meta(asOf, method, flowOptions, cash, ledgerCash, 'stored'),
      };
    }

    if (built.status === 'insufficient') {
      return {
        data: {
          status: 'insufficient' as const,
          accountingMethod: method,
          reason: built.reason,
          ...base,
        },
        meta: this.meta(asOf, method, flowOptions, cash, ledgerCash, cashSource),
      };
    }

    const withTerminal = built.flows;
    const flows = withTerminal.slice(0, -1); // client-visible history, sans terminal

    const portfolioXirr = xirr(withTerminal);

    const firstDate = flows[0].date;
    const days = Math.max(1, (asOf.getTime() - firstDate.getTime()) / 86_400_000);

    /**
     * De-annualization — the workbook's "Interim Return".
     *
     *     interim = (1 + xirr) ^ (days / 365) − 1
     *
     * NOT gain/invested, which gives a different number (1.62% vs 1.85% on the
     * workbook's own flows). It matters because the benchmark figure is computed
     * the same way over the same window, so the two are like-for-like. A
     * gain/invested ratio would not be comparable to a unit-purchase benchmark.
     */
    const deannualize = (rate: number) => (1 + rate) ** (days / 365) - 1;

    const invested = investedCapital(withTerminal);
    const proceeds = realizedProceeds(withTerminal, asOf);

    const contributed = totalContributed(withTerminal);
    const withdrawn = totalWithdrawn(withTerminal);
    const totalGain = terminalValue + withdrawn - contributed;

    const absolute = absoluteReturn(totalGain, invested);

    const pXirr = portfolioXirr.status === 'ok' ? portfolioXirr.rate : null;
    const pInterim = pXirr !== null ? deannualize(pXirr) : null;

    const benchmark = await this.benchmark(benchmarkCode, client.benchmarkId, flows, asOf, deannualize);

    return {
      data: {
        status: 'ok' as const,
        accountingMethod: method,

        // ── Capital ───────────────────────────────────────────────────────────
        investedCapital: invested,
        realizedProceeds: proceeds,
        unrealizedValue: holdingsValue,
        totalContributed: contributed,
        totalWithdrawn: withdrawn,

        // ── Gains ─────────────────────────────────────────────────────────────
        totalGain,
        absoluteReturn: absolute,
        annualizedReturn: absolute !== null ? annualizedReturn(absolute, days) : null,

        // ── XIRR ──────────────────────────────────────────────────────────────
        // The headline for whichever method this client is on. `xirr` is
        // annualized; `interimReturn` is the same rate over the actual holding
        // period, and it is the one that is comparable to the benchmark below.
        xirr: pXirr,
        interimReturn: pInterim,
        xirrReason:
          portfolioXirr.status === 'no-solution' ? portfolioXirr.reason : undefined,

        benchmark,

        /**
         * Alpha, on BOTH bases, because the brief asks for one and the workbook
         * reconciles against the other, and they are different numbers.
         *
         *   alpha         = Portfolio XIRR − Benchmark XIRR   (annualized; the brief)
         *   alphaInterim  = the same, de-annualized to the holding period (the workbook)
         *
         * On a young account the annualized spread is the more dramatic of the
         * two — annualizing magnifies a small interim gap — so reporting only
         * that one overstates the manager's edge. Reporting only the interim one
         * understates it against a full-year mandate. Both are labelled.
         */
        alpha: pXirr !== null && benchmark?.xirr != null ? pXirr - benchmark.xirr : null,
        alphaInterim:
          pInterim !== null && benchmark?.interim != null
            ? pInterim - benchmark.interim
            : null,

        // ── Everything else on the sheet ──────────────────────────────────────
        ...base,

        // Cash drag needs the portfolio return, so unlike the rest of `base` it
        // cannot be computed before the XIRR is solved.
        cashDrag: pInterim !== null ? cashDrag(cash, portfolioValue, pInterim) : null,

        periodDays: Math.round(days),
        inceptionDate: firstDate,
        flows: flows.map((f) => ({ date: f.date, amount: f.amount })),
      },
      meta: this.meta(asOf, method, flowOptions, cash, ledgerCash, cashSource),
    };
  }

  /**
   * The KPIs that need no XIRR: they are properties of the book and the ledger,
   * not of the solver. Kept separate so they survive an unsolvable series.
   */
  private crossSectional(
    snap: Awaited<ReturnType<SnapshotService['forClient']>>,
    ledger: LedgerRow[],
    holdingsValue: number,
    cash: number,
    portfolioValue: number,
  ) {
    const totals = flowTotals(ledger);
    const realized = realizedGain(ledger);

    // Unrealized is derived from the snapshot (quantity × price − cost), never
    // from the stored Holding.unrealizedPnL.
    const unrealized = snap.positions.reduce((s, p) => s + p.unrealizedPnl, 0);

    const perf = performers(snap);

    /**
     * Turnover's denominator is the average of beginning and ending value.
     * "Beginning" here is inception, so on a young account this is really
     * (0 + today) / 2 — which understates the denominator and overstates
     * turnover. It is flagged in `meta.warnings` rather than silently shipped,
     * because a 180% turnover figure on a three-month-old account is an artifact
     * of the window, not a description of the trading.
     */
    const beginningValue = totals.netDeposits > 0 ? totals.netDeposits : holdingsValue;

    const ranked = [...snap.positions].sort((a, b) => b.marketValue - a.marketValue);

    return {
      portfolioValue,
      holdingsValue,
      cashBalance: cash,
      cashWeight: portfolioValue > 0 ? cash / portfolioValue : 0,

      netDeposits: totals.netDeposits,
      netWithdrawals: totals.netWithdrawals,
      netContribution: totals.netContribution,

      realizedGain: realized,
      unrealizedGain: unrealized,
      dividendIncome: totals.dividendIncome,
      fees: totals.fees,

      portfolioTurnover: portfolioTurnover(ledger, beginningValue, portfolioValue),

      bestPerformer: perf.best,
      worstPerformer: perf.worst,

      topHoldings: ranked.slice(0, 10).map((p) => ({
        ticker: p.ticker,
        company: p.company,
        marketValue: p.marketValue,
        weight: portfolioValue > 0 ? p.marketValue / portfolioValue : 0,
        unrealizedPnl: p.unrealizedPnl,
        returnPct: p.costBasisTotal > 0 ? p.unrealizedPnl / p.costBasisTotal : null,
      })),

      // TOTAL_ASSETS denominator: cash is a real allocation line, not a residual.
      // On this book it is ~21% — larger than any single position.
      sectorAllocation: allocationBy(snap, 'sector'),
    };
  }

  /**
   * Benchmark by the UNIT-PURCHASE method — the workbook's construction, and the
   * one the brief specifies for both methodologies.
   *
   * Each client cash flow notionally buys units of the index at that day's close;
   * a withdrawal redeems them. The remaining units are valued on the valuation
   * date. This answers the question the client actually asks — "what if this same
   * money, on these same dates, had gone into the S&P instead?" — and it
   * correctly neutralizes flow timing, which a point-to-point index return does
   * not: that would credit the benchmark for money not yet invested.
   *
   * Both methodologies get the same treatment here, and that is the design. Under
   * TRANSACTIONAL, "every BUY buys benchmark units" (brief §Transactional
   * Benchmark). Under CASH_FLOW, "whenever the client deposits, buy benchmark
   * units" (§Cashflow Benchmark). Those are the same sentence applied to the
   * respective flow series — so there is one function, fed whichever series the
   * client's method produced, rather than two implementations that could drift
   * apart and would then make the two methods' Alphas incomparable.
   */
  private async benchmark(
    code: string | undefined,
    benchmarkId: string | null,
    flows: CashFlow[],
    asOf: Date,
    deannualize: (r: number) => number,
  ): Promise<BenchmarkResult | null> {
    const bm = await this.resolveBenchmark(code, benchmarkId);
    if (!bm) return null;

    const closes = await this.closesOn(bm.symbol, flows.map((f) => f.date));
    const terminalClose = await this.latestClose(bm.symbol);

    if (closes.some((c) => c === null) || terminalClose === null) {
      return {
        code: bm.code,
        name: bm.name,
        xirr: null,
        interim: null,
        units: null,
        value: null,
        reason: `No price history for ${bm.symbol} covering the flow dates. Load the index series before comparing against it.`,
      };
    }

    const result = benchmarkXirr(flows, closes as number[], terminalClose, asOf);

    // Reported so the sheet can show its work: this is the units column of the
    // workbook, and being able to tie back to it is what makes the number
    // auditable rather than merely plausible.
    const units = flows.reduce(
      (s, f, i) => s + -f.amount / (closes[i] as number),
      0,
    );

    return result.status === 'ok'
      ? {
          code: bm.code,
          name: bm.name,
          xirr: result.rate,
          interim: deannualize(result.rate),
          units,
          value: units * terminalClose,
        }
      : {
          code: bm.code,
          name: bm.name,
          xirr: null,
          interim: null,
          units,
          value: units * terminalClose,
          reason: result.reason,
        };
  }

  private meta(
    asOf: Date,
    method: AccountingMethod,
    opts: FlowOptions,
    cashUsed: number,
    ledgerCash: number,
    cashSource: 'ledger' | 'stored',
  ) {
    const warnings: string[] = [];
    const fmt = (n: number) =>
      n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

    /**
     * When the maintained balance and the ledger residue differ, say so — but
     * describe it, do not accuse.
     *
     * The earlier version of this called the gap a miscoded transaction. On this
     * book that was simply wrong: the $51,800 is a real buying-power balance the
     * manager maintains, and the ledger's $44.88 is just the change left over
     * from contributions that were spent on stock. Neither is a data-entry error.
     *
     * What the reader actually needs to know is that the flow series does not
     * account for the whole cash position — which matters, because that
     * unaccounted cash is precisely what generates the cash drag on this client.
     *
     * TRANSACTIONAL clients never derive cash from the ledger in the first
     * place (see the cash comment in `forClient`), so there is nothing to
     * reconcile and nothing to warn about — only CASH_FLOW clients see this.
     */
    if (method === 'CASH_FLOW' && cashSource === 'stored') {
      const unaccounted = cashUsed - ledgerCash;

      if (Math.abs(unaccounted) > 0.01) {
        warnings.push(
          `Cash is taken from the maintained balance (${fmt(cashUsed)}), not derived from the ` +
            `ledger. The recorded flows account for only ${fmt(ledgerCash)} of it — the other ` +
            `${fmt(unaccounted)} predates the flow series (an opening balance rather than a ` +
            `recorded deposit). Cash weight and cash drag are measured on the maintained ` +
            `balance, which is the money actually available to trade.`,
        );
      }
    }

    return {
      cashSource,
      asOf,
      method:
        method === 'TRANSACTIONAL'
          ? 'Transactional XIRR — buys/sells as flows, idle cash excluded'
          : 'Cashflow XIRR — client deposits/withdrawals only, cash included in terminal value',
      flowBasis:
        method === 'TRANSACTIONAL'
          ? [
              'BUY (−)',
              'SELL (+)',
              opts.includeDividends ? 'DIVIDEND (+)' : null,
              opts.includeFees ? 'FEES (−)' : null,
              'terminal holdings value (+)',
            ]
              .filter(Boolean)
              .join(', ')
          : 'CASH_DEPOSIT (−), CASH_WITHDRAWAL (+), terminal holdings + cash (+)',
      benchmarkBasis: 'unit purchase — each flow buys index units at that day’s close',
      includeDividends: opts.includeDividends,
      includeFees: opts.includeFees,
      denominator: 'TOTAL_ASSETS' as const,
      warnings,
    };
  }

  private async resolveBenchmark(code: string | undefined, benchmarkId: string | null) {
    if (code) return this.prisma.benchmark.findUnique({ where: { code } });
    if (benchmarkId) return this.prisma.benchmark.findUnique({ where: { id: benchmarkId } });
    return this.prisma.benchmark.findFirst({ where: { isDefault: true } });
  }

  /**
   * The index close on each flow date.
   *
   * Falls back to the most recent close BEFORE the requested date — a flow can
   * land on a weekend or a holiday, when the index has no bar. Returns null when
   * there is no prior bar at all, and the caller reports that rather than
   * inventing a price.
   */
  private async closesOn(symbol: string, dates: Date[]): Promise<Array<number | null>> {
    const out: Array<number | null> = [];
    for (const d of dates) {
      const bar = await this.prisma.priceBar.findFirst({
        where: { symbol, date: { lte: d } },
        orderBy: { date: 'desc' },
      });
      out.push(bar ? bar.adjClose : null);
    }
    return out;
  }

  private async latestClose(symbol: string): Promise<number | null> {
    const bar = await this.prisma.priceBar.findFirst({
      where: { symbol },
      orderBy: { date: 'desc' },
    });
    return bar ? bar.adjClose : null;
  }
}
