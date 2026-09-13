import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { LegacyBaselineModule } from '../legacy-baseline/legacy-baseline.module';
import { HistoricalPriceModule } from '../historical-price/historical-price.module';
import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PerformanceBaselineService } from './performance-baseline.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { FamilyPerformanceService } from './family-performance.service';
import { SnapshotScheduler } from './snapshot.scheduler';
import { PortfolioHistoryController } from './portfolio-history.controller';
import { FamilyPerformanceController } from './family-performance.controller';

@Module({
  imports: [PrismaModule, MarketModule, LegacyBaselineModule, HistoricalPriceModule],
  controllers: [PortfolioHistoryController, FamilyPerformanceController],
  providers: [
    PortfolioReconstructionService,
    PortfolioHistoryService,
    PerformanceBaselineService,
    BenchmarkHistoryService,
    FamilyPerformanceService,
    SnapshotScheduler,
  ],
  // Exported so a future Reports/export feature can consume the read paths
  // without re-declaring these as its own providers. BenchmarkHistoryService
  // joined this list for ReviewPackModule, which needs the same benchmark
  // resolution (and the same market-scoped isDefault fix) that
  // PortfolioHistoryService and FamilyPerformanceService already use
  // internally — a second, re-declared instance would risk the two drifting
  // apart on exactly the bug benchmark-resolution.spec.ts guards against.
  exports: [
    PortfolioReconstructionService,
    PortfolioHistoryService,
    PerformanceBaselineService,
    BenchmarkHistoryService,
    FamilyPerformanceService,
  ],
})
export class PortfolioReconstructionModule {}
