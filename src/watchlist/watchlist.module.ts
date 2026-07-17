import { Module } from '@nestjs/common';
import { WatchlistService } from './watchlist.service';
import { WatchlistController } from './watchlist.controller';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [PrismaModule, MarketModule],
  controllers: [WatchlistController],
  providers: [WatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
