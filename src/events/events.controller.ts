import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PortfolioEventsService } from './portfolio-events.service';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private portfolioEvents: PortfolioEventsService) {}

  /** Upcoming earnings/dividend/split events across every ticker any client holds. */
  @Get()
  forHoldings() {
    return this.portfolioEvents.forAllHoldings();
  }
}
