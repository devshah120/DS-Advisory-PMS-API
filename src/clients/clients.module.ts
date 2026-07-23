import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';

@Module({
  // MarketModule supplies live quotes so the Clients-list XIRR values holdings the
  // same way the Performance page does (SnapshotService) — otherwise the list uses
  // the drift-prone stored marketValue and the two pages' XIRRs disagree.
  imports: [PrismaModule, MarketModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
