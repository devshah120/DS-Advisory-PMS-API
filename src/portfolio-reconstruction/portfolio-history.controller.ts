import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PerformanceBaselineService, PerformancePeriod } from './performance-baseline.service';
import { availablePeriods, resolvePeriod } from './periods';
import { Market, parseMarket } from '../common/market-scope';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * PART 7 / PART 9's read side: "portfolio as it existed on any date after
 * the baseline", served identically whether a snapshot exists or has to be
 * reconstructed. File export (Excel/PDF) is out of scope for this pass —
 * this controller returns the same DTO an exporter would consume later.
 */
@Controller('clients/:clientId/portfolio-history')
@UseGuards(JwtAuthGuard)
export class PortfolioHistoryController {
  constructor(
    private history: PortfolioHistoryService,
    private performanceBaseline: PerformanceBaselineService,
    private prisma: PrismaService,
  ) {}

  /**
   * The reporting calendar for a client, taken from the CLIENT RECORD rather
   * than from a `?market=` query param.
   *
   * The param would work, but it can be stale or absent — and getting it wrong
   * is not a cosmetic error: it would report an Indian mandate's Q2 on the
   * calendar quarter, silently mislabelling a statutory FY figure. The client's
   * own market is the fact of the matter, so it is what decides. An explicit
   * param is still honoured as an override for the rare cross-book comparison.
   */
  private async marketFor(clientId: string, override?: string): Promise<Market> {
    if (override) return parseMarket(override);
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { market: true },
    });
    return parseMarket(client?.market);
  }

  @Get('as-of/:date')
  asOf(@Param('clientId') clientId: string, @Param('date') date: string) {
    const parsed = this.parseDate(date);
    return this.history.getPortfolioAsOf(clientId, parsed);
  }

  /**
   * The period vocabulary the sheet's dropdown renders — inception, the rolling
   * windows, and every quarter from inception to today, newest first. Served
   * from the backend rather than hard-coded in the UI so the list cannot drift
   * from what `resolvePeriod` will actually accept.
   */
  @Get('periods')
  async periods(
    @Param('clientId') clientId: string,
    @Query('market') market?: string,
  ) {
    return availablePeriods(new Date(), await this.marketFor(clientId, market));
  }

  /**
   * ?period=INCEPTION|MTD|QTD|YTD|Q3-CY26|…, or ?from=YYYY-MM-DD&to=YYYY-MM-DD
   * for a custom range.
   *
   * Every window is clamped so it can never open before the 30-June-2026
   * inception (see periods.ts). Returns the opening/closing portfolio value and
   * the simple return over the window, plus the benchmark over the same window.
   */
  @Get('return')
  async periodReturn(
    @Param('clientId') clientId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('market') market?: string,
  ) {
    const to_ = to ? this.parseDate(to) : undefined;
    const from_ = from ? this.parseDate(from) : undefined;

    // An explicit ?from= with no ?period= is the custom-range call.
    const code: PerformancePeriod = period ?? (from_ ? 'CUSTOM' : 'INCEPTION');

    const resolved = resolvePeriod(code, {
      from: from_,
      to: to_,
      market: await this.marketFor(clientId, market),
    });
    return this.performanceBaseline.periodReturn(clientId, resolved);
  }

  private parseDate(raw: string): Date {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid date "${raw}" — expected YYYY-MM-DD`);
    }
    return parsed;
  }
}
