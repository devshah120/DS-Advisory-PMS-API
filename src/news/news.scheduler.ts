import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NewsService } from './news.service';

/**
 * Keeps the stored news feed current without anyone pressing Refresh.
 *
 * News differs from the event calendar in the one way that justifies a cron:
 * an earnings date announced a month out is still correct tomorrow, whereas a
 * buyback announcement is only useful the morning it lands. Manual refresh
 * remains available on the page; this makes the page worth opening cold.
 *
 * Times are UTC, chosen to sit just after each book's main news flow:
 *   03:30 UTC = 09:00 IST — after Indian pre-open filings.
 *   09:30 UTC = 15:00 IST — Indian post-close results and board outcomes.
 *   13:30 UTC = 09:30 ET  — US pre-market coverage.
 *   21:30 UTC = 17:30 ET  — US post-close.
 *
 * Each run covers both books (the store is shared), so these are staggered
 * refresh points rather than per-market jobs. Weekdays only: corporate news is
 * a trading-week phenomenon, and a weekend run mostly re-fetches Friday.
 */
@Injectable()
export class NewsScheduler {
  private readonly logger = new Logger(NewsScheduler.name);

  /** Guards against a slow run overlapping the next tick. */
  private running = false;

  constructor(private news: NewsService) {}

  @Cron('0 30 3 * * 1-5')
  async indiaPreOpen(): Promise<void> {
    await this.run('India pre-open');
  }

  @Cron('0 30 9 * * 1-5')
  async indiaPostClose(): Promise<void> {
    await this.run('India post-close');
  }

  @Cron('0 30 13 * * 1-5')
  async usPreMarket(): Promise<void> {
    await this.run('US pre-market');
  }

  @Cron('0 30 21 * * 1-5')
  async usPostClose(): Promise<void> {
    await this.run('US post-close');
  }

  /**
   * A refresh is one request per tracked ticker across three upstreams, so a
   * large book can outlast the gap to the next slot. Skipping rather than
   * queueing keeps the providers from being hit twice over.
   */
  private async run(label: string): Promise<void> {
    if (this.running) {
      this.logger.warn(`${label} news refresh skipped — previous run still in progress`);
      return;
    }

    this.running = true;
    try {
      const { created, pruned, tickers } = await this.news.refresh();
      this.logger.log(
        `${label} news refresh complete: ${created} new across ${tickers} tickers (pruned ${pruned})`,
      );
    } catch (error) {
      // Never rethrow: an unhandled rejection in a cron would take the process
      // down over a third-party outage.
      this.logger.error(`${label} news refresh failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
