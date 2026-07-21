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

    // Freshness alone is not enough to skip: a table full of recently-written
    // rows for symbols nobody holds is exactly the state this guard used to
    // preserve. Require that every symbol in the universe actually HAS a
    // snapshot before deciding there is nothing to do.
    const universe = await this.repository.listUniverseSymbols();
    const covered = await this.prisma.fundamentalSnapshot.count({
      where: { symbol: { in: universe } },
    });
    const fullyCovered = covered === universe.length && totalCount === universe.length;

    if (totalCount > 0 && freshCount === totalCount && fullyCovered) {
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

  async refreshAll(): Promise<{ refreshed: number; failed: string[]; skipped: string[] }> {
    if (this.running) {
      this.logger.warn('Refresh already in progress — skipping this trigger');
      return { refreshed: 0, failed: [], skipped: [] };
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
      const skipped: string[] = [];
      for (const symbol of symbols) {
        try {
          const raw = await this.provider.fetchOne(symbol);
          if (!raw) {
            // A null here means the provider has no COMPANY behind the symbol —
            // an ETF/fund or a dead ticker. Both are "nothing to score", not a
            // transient failure, so they're tracked separately from `failed`.
            skipped.push(symbol);
            continue;
          }
          await this.repository.upsertSnapshot(raw, this.provider.name);
        } catch (err) {
          failed.push(symbol);
          this.logger.warn(`Snapshot refresh failed for ${symbol}: ${(err as Error).message}`);
        }
      }

      // Drop snapshots for symbols the providers now decline to serve. Without
      // this, a row written under an older provider config (the FMP-only era,
      // which persisted ETFs) survives forever: refreshAll only ever upserts,
      // so an unscoreable row is never revisited and keeps rendering as a 0.
      await this.pruneUnscoreable(skipped);

      // Then drop anything outside the universe entirely — a symbol that was
      // sold or removed from the watchlist is never in `symbols`, so it is
      // never fetched, never "skipped", and pruneUnscoreable above can never
      // reach it. Only this sweep clears it.
      const orphans = await this.repository.pruneSnapshotsOutside(symbols);
      if (orphans.length > 0) {
        this.logger.log(`Pruned ${orphans.length} out-of-universe snapshot(s): ${orphans.join(', ')}`);
      }

      await this.rescoreAll();

      const refreshed = symbols.length - failed.length - skipped.length;
      this.logger.log(
        `Refresh complete: ${refreshed} ok, ${failed.length} failed, ${skipped.length} skipped (funds/unknown)`,
      );
      return { refreshed, failed, skipped };
    } finally {
      this.running = false;
    }
  }

  /**
   * Deletes snapshots (and their cached scores) for symbols the provider
   * declined to serve this run — ETFs, commodity funds and dead tickers.
   *
   * Scores are removed alongside the snapshot because FundamentalScore is keyed
   * by symbol with no relation to clean it up: leaving one behind would let
   * `list()` keep serving a score for a symbol that no longer has a snapshot.
   */
  private async pruneUnscoreable(symbols: string[]) {
    if (symbols.length === 0) return;

    const stale = await this.prisma.fundamentalSnapshot.findMany({
      where: { symbol: { in: symbols } },
      select: { symbol: true },
    });
    if (stale.length === 0) return;

    const staleSymbols = stale.map((s) => s.symbol);
    await this.prisma.fundamentalScore.deleteMany({ where: { symbol: { in: staleSymbols } } });
    await this.prisma.fundamentalSnapshot.deleteMany({ where: { symbol: { in: staleSymbols } } });

    this.logger.log(`Pruned ${staleSymbols.length} unscoreable snapshot(s): ${staleSymbols.join(', ')}`);
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

  /**
   * Every ticker on any client's holdings, plus every watchlist slot.
   *
   * Delegates to ApiRepository so the write path here and the read path in
   * FundamentalService.list resolve the universe from one definition — when
   * these were computed separately, the read path was free to serve symbols
   * this job had never fetched.
   */
  private symbolUniverse(): Promise<string[]> {
    return this.repository.listUniverseSymbols();
  }
}
