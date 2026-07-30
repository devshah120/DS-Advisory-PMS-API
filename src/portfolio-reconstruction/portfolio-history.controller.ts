import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PerformanceBaselineService, PerformancePeriod } from './performance-baseline.service';

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
  ) {}

  @Get('as-of/:date')
  asOf(@Param('clientId') clientId: string, @Param('date') date: string) {
    const parsed = this.parseDate(date);
    return this.history.getPortfolioAsOf(clientId, parsed);
  }

  /**
   * ?period=MTD|QTD|YTD, or ?from=YYYY-MM-DD&to=YYYY-MM-DD for CUSTOM.
   * Returns the opening/closing portfolio value and simple return over the
   * window — NOT the XIRR/benchmark figures on the Performance page
   * (analytics/services/performance.service.ts), which are unaffected by
   * this endpoint.
   */
  @Get('return')
  async periodReturn(
    @Param('clientId') clientId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const to_ = to ? this.parseDate(to) : new Date();

    if (period === 'MTD' || period === 'QTD' || period === 'YTD') {
      const range = PerformanceBaselineService.windowFor(period, to_);
      return this.performanceBaseline.periodReturn(clientId, period as PerformancePeriod, range);
    }

    if (!from) {
      throw new BadRequestException('Provide either ?period=MTD|QTD|YTD or ?from=YYYY-MM-DD (with optional &to=)');
    }

    return this.performanceBaseline.periodReturn(clientId, 'CUSTOM', {
      from: this.parseDate(from),
      to: to_,
    });
  }

  private parseDate(raw: string): Date {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid date "${raw}" — expected YYYY-MM-DD`);
    }
    return parsed;
  }
}
