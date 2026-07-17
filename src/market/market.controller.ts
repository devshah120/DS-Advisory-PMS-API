import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MarketService } from './market.service';

@Controller('market')
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(private marketService: MarketService) {}

  @Get('lookup/:ticker')
  lookup(@Param('ticker') ticker: string) {
    return this.marketService.lookup(ticker);
  }

  @Get('history/:ticker')
  history(@Param('ticker') ticker: string, @Query('from') from: string) {
    return this.marketService.history(ticker, from);
  }
}
