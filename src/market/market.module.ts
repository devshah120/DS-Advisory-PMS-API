import { Module } from '@nestjs/common';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { EventsService } from './events.service';

@Module({
  controllers: [MarketController],
  providers: [MarketService, EventsService],
  exports: [MarketService, EventsService],
})
export class MarketModule {}
