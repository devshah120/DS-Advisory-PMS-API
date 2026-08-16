import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { NewsRepository } from './news.repository';
import { NewsScheduler } from './news.scheduler';
import { YahooNewsProvider } from './providers/yahoo-news.provider';
import { BseFilingsProvider } from './providers/bse-filings.provider';
import { GoogleNewsProvider } from './providers/google-news.provider';

/**
 * The News Center. Self-contained: the providers here are news-specific and
 * share nothing with MarketModule's price/event services beyond the Yahoo host,
 * so this module does not import it.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NewsController],
  providers: [
    NewsService,
    NewsRepository,
    NewsScheduler,
    YahooNewsProvider,
    BseFilingsProvider,
    GoogleNewsProvider,
  ],
  exports: [NewsService],
})
export class NewsModule {}
