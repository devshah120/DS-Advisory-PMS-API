import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ClientsModule } from './clients/clients.module';
import { FamiliesModule } from './families/families.module';
import { HoldingsModule } from './holdings/holdings.module';
import { TransactionsModule } from './transactions/transactions.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ResearchModule } from './research/research.module';
import { WatchlistModule } from './watchlist/watchlist.module';
import { MarketModule } from './market/market.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ReportsModule } from './reports/reports.module';
import { EventsModule } from './events/events.module';
import { NewsModule } from './news/news.module';
import { FundamentalsModule } from './fundamentals/fundamentals.module';
import { LegacyBaselineModule } from './legacy-baseline/legacy-baseline.module';
import { PortfolioReconstructionModule } from './portfolio-reconstruction/portfolio-reconstruction.module';
import { SubscriptionModule } from './subscription/subscription.module';

@Module({
  imports: [
    ConfigModule,
    // Enables @Cron() in SnapshotScheduler (portfolio-reconstruction module).
    // Not used anywhere else in the codebase before this change.
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    ClientsModule,
    FamiliesModule,
    HoldingsModule,
    TransactionsModule,
    DashboardModule,
    ResearchModule,
    WatchlistModule,
    MarketModule,
    AnalyticsModule,
    ReportsModule,
    EventsModule,
    NewsModule,
    FundamentalsModule,
    LegacyBaselineModule,
    PortfolioReconstructionModule,
    SubscriptionModule,
  ],
})
export class AppModule {}
