import { Injectable, Logger } from '@nestjs/common';
import { NewsArticle } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Market } from '../common/market-scope';
import { NewsItem } from './news.types';

/** Rows older than this are pruned on each refresh. */
const RETENTION_DAYS = 90;

/**
 * The only class in the News Center that touches Prisma for articles. Mirrors
 * EventSnapshotRepository, with one deliberate difference: this store is
 * append-only.
 *
 * EventSnapshot can replace-all because an event calendar is a statement about
 * the future that is wholly superseded by each refresh. A news timeline is the
 * opposite — last week's stories remain true after they fall out of the
 * upstream's window, so refreshes upsert and a separate age-based prune bounds
 * the collection.
 */
@Injectable()
export class NewsRepository {
  private readonly logger = new Logger(NewsRepository.name);

  constructor(private prisma: PrismaService) {}

  /**
   * One book's feed, newest first.
   *
   * Scoped to the market and, optionally, to a set of tickers — the caller
   * passes the book's tracked universe so a name that has since been sold or
   * removed from the watchlist stops appearing without its rows being deleted.
   */
  async list(
    market: Market,
    opts: { tickers?: string[]; limit?: number; since?: Date } = {},
  ): Promise<NewsArticle[]> {
    const { tickers, limit = 200, since } = opts;

    // An empty universe means "this book tracks nothing" — return nothing
    // rather than dropping the filter and showing the whole market's news.
    if (tickers && tickers.length === 0) return [];

    return this.prisma.newsArticle.findMany({
      where: {
        market,
        ...(tickers ? { ticker: { in: tickers } } : {}),
        ...(since ? { publishedAt: { gte: since } } : {}),
      },
      orderBy: { publishedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Upserts fetched stories, keyed on url. Returns how many rows were new,
   * which is what the refresh reports — "48 new stories" is meaningful,
   * whereas the number fetched is mostly a restatement of the batch size.
   *
   * Writes run sequentially rather than through $transaction: this is a
   * best-effort sync of an external feed, and one malformed row must not roll
   * back an otherwise good refresh.
   */
  async upsertMany(items: NewsItem[]): Promise<number> {
    // The same story can arrive twice in one pass (two tickers in the same
    // article, or BSE and Google News landing on one URL). Collapsing here
    // keeps the loop from racing itself on a unique key.
    const byUrl = new Map<string, NewsItem>();
    for (const item of items) {
      if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
    }

    const refreshedAt = new Date();
    let created = 0;

    for (const item of byUrl.values()) {
      try {
        const existing = await this.prisma.newsArticle.findUnique({
          where: { url: item.url },
          select: { id: true },
        });

        if (existing) {
          // Refresh the volatile fields only. publishedAt and ticker are left
          // alone so a re-fetch never reorders the timeline or re-attributes a
          // story to a different holding.
          await this.prisma.newsArticle.update({
            where: { url: item.url },
            data: {
              title: item.title,
              summary: item.summary,
              tag: item.tag,
              category: item.category,
              refreshedAt,
            },
          });
          continue;
        }

        await this.prisma.newsArticle.create({
          data: {
            ticker: item.ticker,
            market: item.market,
            title: item.title,
            publisher: item.publisher,
            url: item.url,
            summary: item.summary,
            publishedAt: item.publishedAt,
            kind: item.kind,
            category: item.category,
            tag: item.tag,
            source: item.source,
            refreshedAt,
          },
        });
        created += 1;
      } catch (error) {
        // A duplicate url from a concurrent refresh is expected and benign.
        this.logger.warn(`Could not store article (${item.url}): ${(error as Error).message}`);
      }
    }

    return created;
  }

  /** Drops articles past the retention window. Returns how many were removed. */
  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const { count } = await this.prisma.newsArticle.deleteMany({
      where: { publishedAt: { lt: cutoff } },
    });
    return count;
  }
}
