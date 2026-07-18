import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ClientsModule } from './clients/clients.module';
import { HoldingsModule } from './holdings/holdings.module';
import { TransactionsModule } from './transactions/transactions.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ResearchModule } from './research/research.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { MarketModule } from './market/market.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ReportsModule } from './reports/reports.module';
import { EventsModule } from './events/events.module';
import { FundamentalsModule } from './fundamentals/fundamentals.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    ClientsModule,
    HoldingsModule,
    TransactionsModule,
    DashboardModule,
    ResearchModule,
    WatchlistModule,
    MarketModule,
    AnalyticsModule,
    ReportsModule,
    EventsModule,
    FundamentalsModule,
  ],
})
export class AppModule {}
