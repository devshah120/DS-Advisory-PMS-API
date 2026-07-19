import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { PortfolioEventsService } from './portfolio-events.service';
import { EventSnapshotRepository } from './event-snapshot.repository';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [PrismaModule, MarketModule],
  controllers: [EventsController],
  providers: [PortfolioEventsService, EventSnapshotRepository],
})
export class EventsModule {}
