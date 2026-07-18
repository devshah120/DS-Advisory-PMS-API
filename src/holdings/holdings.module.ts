import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { HoldingsController } from './holdings.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [PrismaModule, MarketModule],
  controllers: [HoldingsController],
  providers: [HoldingsService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
