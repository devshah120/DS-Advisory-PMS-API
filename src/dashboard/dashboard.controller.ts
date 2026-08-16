import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  // `?market=` is optional everywhere: an omitted value resolves to the US book,
  // so existing callers (and any bookmarked URL) behave exactly as before.
  // The caller's identity is never optional — the rollup is their book, not the
  // firm's, unless they are a Super Admin.
  @Get('overview')
  getOverview(@Req() req: AuthedRequest, @Query('market') market?: string) {
    return this.dashboardService.getOverview(parseMarket(market), req.user);
  }

  // Deliberately unscoped: this returns index/commodity quotes (Nifty, S&P,
  // gold) for the selected book. It touches no client data, so there is nothing
  // to scope — and passing an actor would imply otherwise to a future reader.
  @Get('market-overview')
  getMarketOverview(@Query('market') market?: string) {
    return this.dashboardService.marketOverview(parseMarket(market));
  }
}
