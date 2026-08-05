import { Module } from '@nestjs/common';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { EventsService } from './events.service';
import { YahooEventsService } from './yahoo-events.service';

@Module({
  controllers: [MarketController],
  providers: [MarketService, EventsService, YahooEventsService],
  exports: [MarketService, EventsService, YahooEventsService],
})
export class MarketModule {}
