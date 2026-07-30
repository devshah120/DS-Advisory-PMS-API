import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { HistoricalPriceService } from './historical-price.service';

/**
 * Split out from portfolio-reconstruction/ so both LegacyBaselineModule
 * (BaselineService.autoSeed needs 30-June closes to value existing Holding
 * rows) and PortfolioReconstructionModule can depend on it without a
 * circular import — PortfolioReconstructionModule already imports
 * LegacyBaselineModule to read a client's baseline.
 */
@Module({
  imports: [PrismaModule, MarketModule],
  providers: [HistoricalPriceService],
  exports: [HistoricalPriceService],
})
export class HistoricalPriceModule {}
