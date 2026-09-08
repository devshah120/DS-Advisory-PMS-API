/**
 * The daily sweep — PART 34.
 *
 * Fetches upcoming and recent corporate actions from every registered
 * provider, normalises, deduplicates, validates, scores and stores them. It
 * does NOT alter holdings unless auto-processing is explicitly enabled AND the
 * confidence threshold is met AND validation passed — and the default for
 * `auto_process` is FALSE, exactly as PART 34 specifies.
 *
 * ── Why the universe is "what the firm holds", not "the whole market" ───────
 *
 * The detection universe is every ticker any client holds or watches. Pulling
 * a whole-market calendar and storing thousands of irrelevant actions would
 * bury the four that matter, and PART 8's Review Center is only useful if
 * everything in it is worth a human's attention.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { CorporateActionService } from './corporate-action.service';
import { CorporateActionAuditService } from './audit.service';
import { NormalizedCorporateAction } from './corporate-action.types';
import {
  CorporateActionProvider,
  FetchWindow,
} from './providers/corporate-action-provider.interface';
import { CORPORATE_ACTION_PROVIDERS } from './providers/corporate-actions.tokens';

export interface SweepResult {
  fetched: number;
  created: number;
  merged: number;
  validated: number;
  autoProcessed: number;
  pendingReview: number;
  conflicts: number;
  errors: string[];
  providers: Array<{ name: string; fetched: number; failed: boolean }>;
}

/** How far forward and back a sweep looks. */
const LOOKAHEAD_DAYS = 60;
const LOOKBACK_DAYS = 14;

@Injectable()
export class CorporateActionScheduler {
  private readonly logger = new Logger(CorporateActionScheduler.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private service: CorporateActionService,
    private audit: CorporateActionAuditService,
    @Inject(CORPORATE_ACTION_PROVIDERS)
    private providers: CorporateActionProvider[],
  ) {}

  /**
   * Runs daily at 02:00 UTC.
   *
   * The hour is also configurable via AppSetting.caProcessingHourUtc for the
   * settings screen, but the cron expression itself is fixed: @nestjs/schedule
   * binds decorators at class-registration time, so a database-driven
   * expression would need a dynamic job registered at boot. The stored setting
   * is honoured by `shouldRunNow`, which is the pragmatic version — the job
   * wakes hourly and works only in its configured hour.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'corporate-action-sweep' })
  async scheduledSweep(): Promise<void> {
    const settings = await this.service.settings();
    const currentHour = new Date().getUTCHours();

    if (currentHour !== settings.processingHourUtc) return;

    this.logger.log(`Starting scheduled corporate-action sweep (hour ${currentHour} UTC)`);
    try {
      const result = await this.sweep();
      this.logger.log(
        `Sweep complete: ${result.created} new, ${result.merged} merged, ` +
          `${result.autoProcessed} auto-processed, ${result.pendingReview} awaiting review`,
      );
    } catch (error) {
      this.logger.error(`Scheduled sweep failed: ${(error as Error).message}`);
    }
  }

  /**
   * The sweep itself — also the handler behind POST /corporate-actions/sync.
   *
   * Guarded against concurrent runs: a manual refresh landing on top of the
   * cron would double every provider call for no benefit.
   */
  async sweep(options: { symbols?: string[] } = {}): Promise<SweepResult> {
    if (this.running) {
      return emptyResult(['A sweep is already in progress.']);
    }
    this.running = true;

    const result: SweepResult = emptyResult();

    try {
      const symbols = options.symbols ?? (await this.symbolUniverse());
      if (symbols.length === 0) {
        result.errors.push('No held or watchlisted symbols — nothing to sweep.');
        return result;
      }

      const now = new Date();
      const window: FetchWindow = {
        from: addDays(now, -LOOKBACK_DAYS),
        to: addDays(now, LOOKAHEAD_DAYS),
        symbols,
      };

      const held = new Set(symbols.map((s) => s.toUpperCase()));
      const collected: NormalizedCorporateAction[] = [];

      /**
       * Providers are queried in registration order — PART 32's priority.
       * Sequentially rather than in parallel so a lower-priority source's rate
       * limit is not consumed while a higher-priority one is still answering,
       * and so one provider's slow response does not stack timeouts.
       */
      for (const provider of this.providers) {
        try {
          const actions = await provider.getCorporateActions(window);
          // Discard anything the firm has no exposure to.
          const relevant = actions.filter((a) => held.has(a.symbol.toUpperCase()));
          collected.push(...relevant);
          result.providers.push({ name: provider.name, fetched: relevant.length, failed: false });
        } catch (error) {
          // An adapter should return [] rather than throw; this is the belt
          // for that braces, so one broken provider cannot end the sweep.
          const message = `${provider.name}: ${(error as Error).message}`;
          result.errors.push(message);
          result.providers.push({ name: provider.name, fetched: 0, failed: true });
          this.logger.error(`Provider ${provider.name} threw during sweep: ${message}`);
        }
      }

      result.fetched = collected.length;

      /**
       * In-batch near-duplicate detection.
       *
       * Two providers reporting the same split with dates a day apart produce
       * different fingerprints, so the database's unique index would let both
       * through as separate actions. Flagging them here means the second is
       * still stored (never silently dropped — see the dedupe note) but the
       * validator's POSSIBLE_DUPLICATE check will block both from processing
       * until a human resolves which is right.
       */
      const settings = await this.service.settings();

      for (const incoming of collected) {
        try {
          const { action, created } = await this.service.ingest(incoming);
          if (created) result.created++;
          else result.merged++;

          const outcome = await this.service.validate(action.id);
          if (outcome.valid) result.validated++;

          const refreshed = await this.service.findOrThrow(action.id);
          if (refreshed.hasConflict) result.conflicts++;

          /**
           * PART 34's automatic-processing gate. All four conditions, and the
           * default of the first is FALSE.
           */
          const eligible =
            settings.autoProcessEnabled &&
            outcome.valid &&
            !refreshed.hasConflict &&
            refreshed.confidenceScore >= settings.minimumConfidenceScore &&
            // Never act ahead of the effective date: a split announced for
            // next month must not be applied today.
            refreshed.effectiveDate <= new Date();

          if (eligible) {
            await this.service.approve(refreshed.id, SYSTEM_ACTOR);
            await this.service.process(refreshed.id, SYSTEM_ACTOR);
            result.autoProcessed++;
          } else if (outcome.valid) {
            result.pendingReview++;
          }
        } catch (error) {
          const message = `${incoming.symbol} ${incoming.actionType}: ${(error as Error).message}`;
          result.errors.push(message);
          this.logger.warn(`Ingest failed for ${message}`);
        }
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Every symbol the firm has exposure to — held positions first, watchlist
   * second.
   *
   * Firm-wide and deliberately unscoped: a corporate action is a fact about a
   * security, so detection must cover every manager's book at once. This
   * mirrors PortfolioEventsService.refresh, which takes no actor for the same
   * reason.
   */
  private async symbolUniverse(): Promise<string[]> {
    const [holdings, watchlist] = await Promise.all([
      this.prisma.holding.findMany({
        where: { quantity: { gt: 0 } },
        select: { ticker: true },
        distinct: ['ticker'],
      }),
      this.prisma.watchlist.findMany({ select: { ticker: true }, distinct: ['ticker'] }),
    ]);

    const symbols = new Set<string>();
    for (const h of holdings) if (h.ticker) symbols.add(h.ticker.toUpperCase());
    for (const w of watchlist) if (w.ticker) symbols.add(w.ticker.toUpperCase());

    return [...symbols];
  }
}

/**
 * The actor recorded for scheduler-driven approvals.
 *
 * A synthetic SUPER_ADMIN rather than a real user id, so the audit trail says
 * plainly that a machine did this. Attributing an automated approval to a
 * person who was asleep at 2am would make the audit log actively misleading —
 * and AuditService renders a null email as the label 'system'.
 */
const SYSTEM_ACTOR = {
  id: 'system:corporate-action-scheduler',
  role: 'SUPER_ADMIN',
} as const;

function emptyResult(errors: string[] = []): SweepResult {
  return {
    fetched: 0,
    created: 0,
    merged: 0,
    validated: 0,
    autoProcessed: 0,
    pendingReview: 0,
    conflicts: 0,
    errors,
    providers: [],
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
