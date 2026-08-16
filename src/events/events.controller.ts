import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseMarket } from '../common/market-scope';
import { PortfolioEventsService } from './portfolio-events.service';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private portfolioEvents: PortfolioEventsService) {}

  /**
   * Upcoming earnings/dividend/split events for the selected book — every
   * ticker its clients hold or watchlist. Served from the DB snapshot.
   */
  @Get()
  forHoldings(@Req() req: AuthedRequest, @Query('market') market?: string) {
    return this.portfolioEvents.forAllHoldings(parseMarket(market), req.user);
  }

  /**
   * Re-fetch the FMP calendars and replace the stored snapshot. The only route
   * that spends FMP budget.
   *
   * Intentionally takes no actor: the snapshot is a shared per-ticker store and
   * must be rebuilt from every manager's universe (see the note in
   * PortfolioEventsService.refresh). It writes no client data — only ticker
   * calendars — so refreshing it discloses nothing about whose book is whose.
   */
  @Post('refresh')
  refresh() {
    return this.portfolioEvents.refresh();
  }
}
