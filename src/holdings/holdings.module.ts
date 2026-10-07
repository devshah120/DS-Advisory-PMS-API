import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { ClassificationService } from './classification.service';
import { HoldingsController } from './holdings.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { PortfolioReconstructionModule } from '../portfolio-reconstruction/portfolio-reconstruction.module';

@Module({
  // PortfolioReconstructionModule supplies the replay the as-of-date statement
  // is built from, so it cannot drift from the one Performance values with.
  imports: [PrismaModule, MarketModule, PortfolioReconstructionModule],
  controllers: [HoldingsController],
  providers: [HoldingsService, ClassificationService],
  exports: [HoldingsService, ClassificationService],
})
export class HoldingsModule {}
