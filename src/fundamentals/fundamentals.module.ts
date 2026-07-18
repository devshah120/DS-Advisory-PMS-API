import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../common/prisma/prisma.module';
import { FundamentalsController } from './fundamentals.controller';
import { FundamentalService } from './fundamental.service';
import { ApiRepository } from './api.repository';
import { ScoringEngine } from './scoring/scoring-engine';
import { IndustryComparisonEngine } from './scoring/industry-comparison.engine';
import { ExplanationEngine } from './scoring/explanation.engine';
import { RefreshScheduler } from './refresh.scheduler';
import { FmpFundamentalsProvider } from './providers/fmp-fundamentals.provider';
import { FUNDAMENTALS_PROVIDER } from './fundamentals.tokens';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [FundamentalsController],
  providers: [
    FundamentalService,
    ApiRepository,
    ScoringEngine,
    IndustryComparisonEngine,
    ExplanationEngine,
    RefreshScheduler,
    FmpFundamentalsProvider,
    // Swap the provider for another source (Finnhub, AlphaVantage, Polygon)
    // by changing ONLY this binding — every consumer injects FUNDAMENTALS_PROVIDER.
    { provide: FUNDAMENTALS_PROVIDER, useExisting: FmpFundamentalsProvider },
  ],
  exports: [FundamentalService],
})
export class FundamentalsModule {}
