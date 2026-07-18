import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FundamentalService } from './fundamental.service';
import { ApiRepository } from './api.repository';
import { RefreshScheduler } from './refresh.scheduler';

@Controller('fundamentals')
@UseGuards(JwtAuthGuard)
export class FundamentalsController {
  constructor(
    private fundamentalService: FundamentalService,
    private repository: ApiRepository,
    private refreshScheduler: RefreshScheduler,
  ) {}

  /** Every symbol the engine has fundamentals for, scored under `strategy` (default GARP). Powers the Fundamentals watchlist. */
  @Get()
  list(@Query('strategy') strategy?: string, @Query('symbols') symbols?: string) {
    return this.fundamentalService.list(strategy, symbols ? symbols.split(',') : undefined);
  }

  /** Every strategy currently authored in ScoringRule — lets the UI populate a strategy switcher without hardcoding the list. */
  @Get('strategies')
  strategies() {
    return this.repository.listStrategies();
  }

  @Get(':symbol')
  getOne(@Param('symbol') symbol: string, @Query('strategy') strategy?: string) {
    return this.fundamentalService.getBySymbol(symbol, strategy);
  }

  /** Manual trigger for the same pipeline the daily cron runs — useful right after adding a new holding/watchlist ticker rather than waiting for 1am. */
  @Post('refresh')
  refresh() {
    return this.refreshScheduler.refreshAll();
  }
}
