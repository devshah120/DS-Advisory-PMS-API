import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { parseMarket } from '../common/market-scope';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  // `?market=` is optional everywhere: an omitted value resolves to the US book,
  // so existing callers (and any bookmarked URL) behave exactly as before.
  @Get('overview')
  getOverview(@Query('market') market?: string) {
    return this.dashboardService.getOverview(parseMarket(market));
  }

  @Get('market-overview')
  getMarketOverview(@Query('market') market?: string) {
    return this.dashboardService.marketOverview(parseMarket(market));
  }
}
