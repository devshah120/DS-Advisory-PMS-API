import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseMarket } from '../common/market-scope';
import { NewsService } from './news.service';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('news')
@UseGuards(JwtAuthGuard)
export class NewsController {
  constructor(private news: NewsService) {}

  /**
   * Recent news and filings for the selected book — every ticker its clients
   * hold or watchlist, newest first. Served from the stored feed.
   */
  @Get()
  feed(
    @Req() req: AuthedRequest,
    @Query('market') market?: string,
    @Query('limit') limit?: string,
    @Query('ticker') ticker?: string,
  ) {
    // A bad ?limit= should not blank the page, so it is clamped rather than
    // rejected — same leniency as parseMarket.
    const parsed = Number(limit);
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), 500) : undefined;

    return this.news.feed(
      parseMarket(market),
      {
        limit: safeLimit,
        ticker: ticker?.trim() || undefined,
      },
      req.user,
    );
  }

  /**
   * Re-fetch every source and store new stories. The only route that hits the
   * network.
   *
   * Intentionally unscoped, like the Event Center's refresh: the article store
   * is shared and keyed by ticker, and it holds published news, not client
   * data. See NewsService.refresh.
   */
  @Post('refresh')
  refresh() {
    return this.news.refresh();
  }
}
