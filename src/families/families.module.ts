import { Module } from '@nestjs/common';
import { FamiliesService } from './families.service';
import { FamiliesController } from './families.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { PortfolioReconstructionModule } from '../portfolio-reconstruction/portfolio-reconstruction.module';

@Module({
  // MarketModule supplies the live quotes the household roll-up is valued at,
  // so a family total agrees with each member's own page rather than with the
  // drift-prone stored marketValue cache. PortfolioReconstructionModule
  // replays each member for the as-of-date statement.
  imports: [PrismaModule, MarketModule, PortfolioReconstructionModule],
  controllers: [FamiliesController],
  providers: [FamiliesService],
  exports: [FamiliesService],
})
export class FamiliesModule {}
