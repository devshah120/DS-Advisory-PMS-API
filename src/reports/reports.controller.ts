import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { CapitalGainsService } from './capital-gains.service';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private reportsService: ReportsService,
    private capitalGains: CapitalGainsService,
  ) {}

  /**
   * The quarter dropdown's options, newest first. Served from the backend so
   * the list cannot drift from what `feesForQuarter` will actually accept.
   *
   * Declared BEFORE `fees/:clientId` — Nest matches routes in declaration
   * order, so the parameterised route would otherwise swallow "quarters" as a
   * client id.
   */
  @Get('fees/quarters')
  quarters() {
    return this.reportsService.availableQuarters();
  }

  /**
   * ?quarter=Q3-CY26 for a historical quarter; omitted means the current one.
   * A closed quarter is served from its frozen ClientFeeSchedule rows.
   */
  @Get('fees')
  fees(
    @Req() req: AuthedRequest,
    @Query('quarter') quarter?: string,
    @Query('market') market?: string
  ) {
    // Market unscoped when absent (both books); ownership always applied, so a
    // manager's fee run covers their own mandates only.
    return this.reportsService.feesForQuarter(
      quarter,
      market ? parseMarket(market) : undefined,
      req.user,
    );
  }

  /** One client's fee for one quarter — what the per-client export downloads. */
  @Get('fees/:clientId')
  clientFee(
    @Param('clientId') clientId: string,
    @Req() req: AuthedRequest,
    @Query('quarter') quarter?: string
  ) {
    return this.reportsService.clientFee(clientId, quarter, req.user);
  }

  /**
   * The fiscal-year dropdown for one client's capital-gains statement.
   *
   * Declared BEFORE `capital-gains/:clientId` for the same reason
   * `fees/quarters` precedes `fees/:clientId` — Nest matches in declaration
   * order, so the parameterised route would otherwise swallow "years".
   */
  @Get('capital-gains/:clientId/years')
  capitalGainsYears(@Param('clientId') clientId: string, @Req() req: AuthedRequest) {
    return this.capitalGains.availableYears(clientId, req.user);
  }

  /**
   * One client's FIFO capital-gains statement for one fiscal year.
   *
   * `?fiscalYear=2027` selects the year (full four digits, matching
   * market-scope's convention — "FY27" is only ever a display label). Omitted
   * means the most recent year with activity.
   *
   * The period boundary follows the client's own book: April–March for an
   * Indian mandate, January–December for a US one.
   */
  @Get('capital-gains/:clientId')
  capitalGainsReport(
    @Param('clientId') clientId: string,
    @Req() req: AuthedRequest,
    @Query('fiscalYear') fiscalYear?: string,
  ) {
    // A non-numeric year falls back to the default rather than 400ing, matching
    // how parseMarket treats a stray ?market= — a bad value here is a UI bug,
    // and blanking the page is a worse answer than showing the latest year.
    const parsed = fiscalYear ? Number(fiscalYear) : undefined;
    const year = parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;

    return this.capitalGains.forClient(clientId, req.user, year);
  }
}
