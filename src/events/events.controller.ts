import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PortfolioEventsService } from './portfolio-events.service';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private portfolioEvents: PortfolioEventsService) {}

  /** Upcoming earnings/dividend/split events across every ticker any client holds. Served from the DB snapshot. */
  @Get()
  forHoldings() {
    return this.portfolioEvents.forAllHoldings();
  }

  /** Re-fetch the FMP calendars and replace the stored snapshot. The only route that spends FMP budget. */
  @Post('refresh')
  refresh() {
    return this.portfolioEvents.refresh();
  }
}
