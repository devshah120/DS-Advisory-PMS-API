import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { BaselineController } from './baseline.controller';
import { BaselineService } from './baseline.service';
import { BaselineAdminService } from './baseline-admin.service';

@Module({
  imports: [PrismaModule],
  controllers: [BaselineController],
  providers: [BaselineService, BaselineAdminService],
  // Exported so PortfolioReconstructionService (a different module) can load
  // a client's baseline without re-declaring BaselineService as its own
  // provider.
  exports: [BaselineService, BaselineAdminService],
})
export class LegacyBaselineModule {}
