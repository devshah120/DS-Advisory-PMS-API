import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { ApiRepository } from './api.repository';
import { FundamentalService } from './fundamental.service';
import { FundamentalsProvider } from './providers/fundamentals-provider.interface';
import { FUNDAMENTALS_PROVIDER } from './fundamentals.tokens';

// A snapshot newer than this is left alone on boot — a routine redeploy (or,
// in dev, `nest --watch` restarting on every file save) must not re-burn
// provider quota re-fetching data that's still within the day's freshness
// window. The daily @Cron job is what guarantees a refresh eventually
// happens regardless of deploy cadence.
const BOOT_REFRESH_STALE_AFTER_MS = 20 * 60 * 60 * 1000; // 20h — leaves headroom before the 24h @Cron

/**
 * The "automatically refresh every day" requirement. Pulls the symbol
 * universe from the modules the Fundamentals Engine is explicitly allowed to
 * READ from (Holdings, Watchlist) without ever writing back to them, fetches
 * fresh data through whichever FundamentalsProvider is bound (FMP today),
 * persists snapshots, then recomputes scores for every known strategy so a
 * stale score is never served after a refresh.
 *
 * Runs once on boot (OnModuleInit) ONLY if the existing data has gone stale,
 * so a fresh deploy isn't blank until midnight without re-fetching data that
 * was refreshed an hour ago — then once a day thereafter via @Cron
 * regardless of staleness.
 */
@Injectable()
export class RefreshScheduler implements OnModuleInit {
  private readonly logger = new Logger(RefreshScheduler.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private repository: ApiRepository,
    private fundamentalService: FundamentalService,
    @Inject(FUNDAMENTALS_PROVIDER) private provider: FundamentalsProvider,
  ) {}

  async onModuleInit() {
    const staleBefore = new Date(Date.now() - BOOT_REFRESH_STALE_AFTER_MS);
    const freshCount = await this.prisma.fundamentalSnapshot.count({
      where: { refreshedAt: { gte: staleBefore } },
    });
    const totalCount = await this.prisma.fundamentalSnapshot.count();

    if (totalCount > 0 && freshCount === totalCount) {
      this.logger.log(`Skipping startup refresh — all ${totalCount} snapshots are still fresh`);
      return;
    }

    // Fire-and-forget: a slow first refresh must not block API startup.
    this.refreshAll().catch((err) => this.logger.error(`Startup refresh failed: ${err.message}`));
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduledRefresh() {
    await this.refreshAll();
  }

  async refreshAll(): Promise<{ refreshed: number; failed: string[] }> {
    if (this.running) {
      this.logger.warn('Refresh already in progress — skipping this trigger');
      return { refreshed: 0, failed: [] };
    }
    this.running = true;

    try {
      const symbols = await this.symbolUniverse();
      this.logger.log(`Refreshing fundamentals for ${symbols.length} symbols via ${this.provider.name}`);

      // Sequential by design: pacing against the provider's rate limit is the
      // PROVIDER's concern (see FmpFundamentalsProvider's request gate), not
      // this scheduler's — running symbols one at a time here just avoids
      // piling up N unbounded in-flight fetches on top of whatever pacing the
      // provider already enforces internally.
      const failed: string[] = [];
      for (const symbol of symbols) {
        try {
          const raw = await this.provider.fetchOne(symbol);
          if (!raw) {
            failed.push(symbol);
            continue;
          }
          await this.repository.upsertSnapshot(raw, this.provider.name);
        } catch (err) {
          failed.push(symbol);
          this.logger.warn(`Snapshot refresh failed for ${symbol}: ${(err as Error).message}`);
        }
      }

      await this.rescoreAll();

      this.logger.log(`Refresh complete: ${symbols.length - failed.length} ok, ${failed.length} failed`);
      return { refreshed: symbols.length - failed.length, failed };
    } finally {
      this.running = false;
    }
  }

  /** Recomputes every known strategy for every snapshot, grouped by industry so IndustryComparisonEngine sees one consistent peer set per group instead of refetching it per symbol. */
  private async rescoreAll() {
    const [snapshots, strategies] = await Promise.all([
      this.repository.listSnapshots(),
      this.repository.listStrategies(),
    ]);

    const byIndustry = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      const list = byIndustry.get(s.industry) ?? [];
      list.push(s);
      byIndustry.set(s.industry, list);
    }

    for (const strategy of strategies) {
      for (const peers of byIndustry.values()) {
        for (const snapshot of peers) {
          await this.fundamentalService.computeAndPersist(snapshot, peers, strategy);
        }
      }
    }
  }

  /** Every ticker on any client's holdings, plus every ticker on any watchlist slot — deduplicated. */
  private async symbolUniverse(): Promise<string[]> {
    const [holdings, watchlist] = await Promise.all([
      this.prisma.holding.findMany({ select: { ticker: true } }),
      this.prisma.watchlist.findMany({ select: { ticker: true } }),
    ]);
    const symbols = new Set<string>([...holdings.map((h) => h.ticker), ...watchlist.map((w) => w.ticker)]);
    return [...symbols];
  }
}
