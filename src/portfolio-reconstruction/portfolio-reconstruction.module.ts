import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { LegacyBaselineModule } from '../legacy-baseline/legacy-baseline.module';
import { HistoricalPriceModule } from '../historical-price/historical-price.module';
import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PerformanceBaselineService } from './performance-baseline.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { SnapshotScheduler } from './snapshot.scheduler';
import { PortfolioHistoryController } from './portfolio-history.controller';

@Module({
  imports: [PrismaModule, MarketModule, LegacyBaselineModule, HistoricalPriceModule],
  controllers: [PortfolioHistoryController],
  providers: [
    PortfolioReconstructionService,
    PortfolioHistoryService,
    PerformanceBaselineService,
    BenchmarkHistoryService,
    SnapshotScheduler,
  ],
  // Exported so a future Reports/export feature can consume the read paths
  // without re-declaring these as its own providers.
  exports: [PortfolioReconstructionService, PortfolioHistoryService, PerformanceBaselineService],
})
export class PortfolioReconstructionModule {}
