import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { ClassificationService } from './classification.service';
import { HoldingsController } from './holdings.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { HistoricalPriceModule } from '../historical-price/historical-price.module';

@Module({
  imports: [PrismaModule, MarketModule, HistoricalPriceModule],
  controllers: [HoldingsController],
  providers: [HoldingsService, ClassificationService],
  exports: [HoldingsService, ClassificationService],
})
export class HoldingsModule {}
