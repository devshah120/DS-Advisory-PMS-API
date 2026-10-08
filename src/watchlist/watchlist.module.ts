import { Module } from '@nestjs/common';
import { WatchlistService } from './watchlist.service';
import { WatchlistController } from './watchlist.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';
import { PortfolioReconstructionModule } from '../portfolio-reconstruction/portfolio-reconstruction.module';
import { ClientPortfolioWatchlistService } from './client-portfolio-watchlist.service';

@Module({
  imports: [PrismaModule, MarketModule, PortfolioReconstructionModule],
  controllers: [WatchlistController],
  providers: [WatchlistService, ClientPortfolioWatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
