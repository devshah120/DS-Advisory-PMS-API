import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AnalyticsController } from './analytics.controller';
import { SnapshotService } from './services/snapshot.service';
import { ExposureService } from './services/exposure.service';
import { HouseService } from './services/house.service';
import { PerformanceService } from './services/performance.service';
import { WorkbookImportService } from './ingestion/workbook-import.service';

@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController],
  providers: [
    SnapshotService,
    ExposureService,
    HouseService,
    PerformanceService,
    WorkbookImportService,
  ],
  // Exported so the dashboard module can reuse them rather than reimplementing
  // allocation and performance a second time.
  exports: [SnapshotService, ExposureService, HouseService, PerformanceService],
})
export class AnalyticsModule {}
