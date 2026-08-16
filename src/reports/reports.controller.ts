import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

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
}
