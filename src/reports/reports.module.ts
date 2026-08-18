import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { CapitalGainsService } from './capital-gains.service';
import { ReportsController } from './reports.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PortfolioReconstructionModule } from '../portfolio-reconstruction/portfolio-reconstruction.module';
import { FeeCloseScheduler } from './fee-close.scheduler';

@Module({
  // PortfolioReconstructionModule supplies PortfolioHistoryService — the
  // snapshot-first/reconstruct-fallback read path a closed quarter's fee is
  // valued from. It already exports it for this exact use.
  imports: [PrismaModule, PortfolioReconstructionModule],
  controllers: [ReportsController],
  providers: [ReportsService, CapitalGainsService, FeeCloseScheduler],
  exports: [ReportsService, CapitalGainsService],
})
export class ReportsModule {}
