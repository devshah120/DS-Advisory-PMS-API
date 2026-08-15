import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MarketService } from './market.service';
import { ALL_MARKETS, MARKETS, parseMarket } from '../common/market-scope';

@Controller('market')
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(private marketService: MarketService) {}

  /**
   * The market catalogue the UI renders its country selector from, so the list
   * of books and their currencies/indices lives in one place on the server
   * rather than being duplicated as a frontend constant that can drift.
   */
  @Get('markets')
  markets() {
    return ALL_MARKETS.map((code) => ({
      code,
      label: MARKETS[code].label,
      currency: MARKETS[code].currency,
      defaultSuffix: MARKETS[code].defaultSuffix,
    }));
  }

  @Get('lookup/:ticker')
  lookup(@Param('ticker') ticker: string, @Query('market') market?: string) {
    // Undefined when the caller sends no `market`, which keeps a bare US ticker
    // resolving exactly as before instead of being suffixed by a default.
    return this.marketService.lookup(ticker, market ? parseMarket(market) : undefined);
  }

  @Get('history/:ticker')
  history(@Param('ticker') ticker: string, @Query('from') from: string) {
    return this.marketService.history(ticker, from);
  }
}
