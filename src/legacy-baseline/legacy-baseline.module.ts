import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { HistoricalPriceModule } from '../historical-price/historical-price.module';
import { BaselineController } from './baseline.controller';
import { BaselineBulkController } from './baseline-bulk.controller';
import { BaselineService } from './baseline.service';
import { BaselineAdminService } from './baseline-admin.service';

@Module({
  imports: [PrismaModule, HistoricalPriceModule],
  controllers: [BaselineController, BaselineBulkController],
  providers: [BaselineService, BaselineAdminService],
  // Exported so PortfolioReconstructionService (a different module) can load
  // a client's baseline without re-declaring BaselineService as its own
  // provider.
  exports: [BaselineService, BaselineAdminService],
})
export class LegacyBaselineModule {}
