import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { HistoricalPriceService } from '../historical-price/historical-price.service';
import { benchmarkXirr, CashFlow } from '../analytics/calculators/xirr';

export interface BenchmarkWindowResult {
  code: string;
  name: string;
  /** Annualized. Null when price coverage is missing over the window. */
  xirr: number | null;
  /** The same rate de-annualized to the window — comparable to a client's interim return. */
  interim: number | null;
  reason?: string;
}

/**
 * Generalizes PerformanceService.benchmark() (analytics/services/performance.service.ts)
 * from "since inception" to an arbitrary [from, to] window, using the SAME
 * unit-purchase construction and the SAME benchmarkXirr() solver — so the
 * Historical tab's benchmark figure and the Current tab's Alpha card can
 * never quietly disagree about what "benchmark return" means. Only the flow
 * series differs: the Current tab's is the client's full transaction
 * history; this one is whatever window the caller is asking about (often
 * just two points — opening and closing value — for a calendar window with
 * no cash flows in it).
 *
 * PerformanceService itself is NOT modified — this is a parallel,
 * independent implementation that happens to call the same lower-level
 * calculator (benchmarkXirr), not a wrapper around that service.
 */
@Injectable()
export class BenchmarkHistoryService {
  constructor(
    private prisma: PrismaService,
    private prices: HistoricalPriceService,
  ) {}

  async windowReturn(
    code: string | undefined,
    benchmarkId: string | null,
    flows: CashFlow[],
    asOf: Date,
  ): Promise<BenchmarkWindowResult | null> {
    const bm = await this.resolveBenchmark(code, benchmarkId);
    if (!bm) return null;

    const closes = await Promise.all(flows.map((f) => this.prices.closeOn(bm.symbol, f.date)));
    const terminalClose = await this.prices.closeOn(bm.symbol, asOf);

    if (closes.some((c) => c === null) || terminalClose === null) {
      return {
        code: bm.code,
        name: bm.name,
        xirr: null,
        interim: null,
        reason: `No price history for ${bm.symbol} covering this window.`,
      };
    }

    const result = benchmarkXirr(flows, closes as number[], terminalClose, asOf);
    if (result.status !== 'ok') {
      return { code: bm.code, name: bm.name, xirr: null, interim: null, reason: result.reason };
    }

    const days = Math.max(
      1,
      (asOf.getTime() - flows[0].date.getTime()) / 86_400_000,
    );
    const interim = (1 + result.rate) ** (days / 365) - 1;

    return { code: bm.code, name: bm.name, xirr: result.rate, interim };
  }

  /**
   * The dollar value today of `openingValue` notionally invested in the
   * benchmark at `from` — what PerformanceService.benchmark() calls `value`.
   * Used to populate PortfolioValuation.benchmarkValue for a stored
   * snapshot; a single two-point flow (buy at `from`, nothing since) rather
   * than the full windowReturn/XIRR path, since a snapshot row only needs
   * the notional value, not an annualized rate.
   */
  async notionalValue(
    code: string | undefined,
    benchmarkId: string | null,
    openingValue: number,
    from: Date,
    to: Date,
  ): Promise<number | null> {
    const bm = await this.resolveBenchmark(code, benchmarkId);
    if (!bm) return null;

    const openClose = await this.prices.closeOn(bm.symbol, from);
    const closeAtTo = await this.prices.closeOn(bm.symbol, to);
    if (!openClose || !closeAtTo) return null;

    const units = openingValue / openClose;
    return units * closeAtTo;
  }

  /** Same code -> benchmarkId -> isDefault chain as PerformanceService.resolveBenchmark. */
  private async resolveBenchmark(code: string | undefined, benchmarkId: string | null) {
    if (code) return this.prisma.benchmark.findUnique({ where: { code } });
    if (benchmarkId) return this.prisma.benchmark.findUnique({ where: { id: benchmarkId } });
    return this.prisma.benchmark.findFirst({ where: { isDefault: true } });
  }
}
