import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { FundamentalsController } from './fundamentals.controller';
import { FundamentalService } from './fundamental.service';
import { ApiRepository } from './api.repository';
import { ScoringEngine } from './scoring/scoring-engine';
import { IndustryComparisonEngine } from './scoring/industry-comparison.engine';
import { ExplanationEngine } from './scoring/explanation.engine';
import { RefreshScheduler } from './refresh.scheduler';
import { FmpFundamentalsProvider } from './providers/fmp-fundamentals.provider';
import { FinnhubFundamentalsProvider } from './providers/finnhub-fundamentals.provider';
import { CompositeFundamentalsProvider } from './providers/composite-fundamentals.provider';
import { FUNDAMENTALS_PROVIDER } from './fundamentals.tokens';

@Module({
  imports: [PrismaModule],
  controllers: [FundamentalsController],
  providers: [
    FundamentalService,
    ApiRepository,
    ScoringEngine,
    IndustryComparisonEngine,
    ExplanationEngine,
    RefreshScheduler,
    FmpFundamentalsProvider,
    FinnhubFundamentalsProvider,
    CompositeFundamentalsProvider,
    // Active source: Finnhub-primary with FMP backfill. Finnhub's free tier
    // covers the whole equity universe (FMP's free tier whitelists only
    // mega-caps), and FMP enriches the few symbols it's allowed to serve.
    // Swap to a single source by pointing this at that provider instead.
    { provide: FUNDAMENTALS_PROVIDER, useExisting: CompositeFundamentalsProvider },
  ],
  exports: [FundamentalService],
})
export class FundamentalsModule {}
