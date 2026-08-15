import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseMarket } from '../common/market-scope';
import { PortfolioEventsService } from './portfolio-events.service';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private portfolioEvents: PortfolioEventsService) {}

  /**
   * Upcoming earnings/dividend/split events for the selected book — every
   * ticker its clients hold or watchlist. Served from the DB snapshot.
   */
  @Get()
  forHoldings(@Query('market') market?: string) {
    return this.portfolioEvents.forAllHoldings(parseMarket(market));
  }

  /** Re-fetch the FMP calendars and replace the stored snapshot. The only route that spends FMP budget. */
  @Post('refresh')
  refresh() {
    return this.portfolioEvents.refresh();
  }
}
