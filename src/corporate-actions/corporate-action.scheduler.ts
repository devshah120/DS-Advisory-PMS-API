/**
 * The daily sweep — PART 34.
 *
 * Fetches upcoming and recent corporate actions from every registered
 * provider, normalises, deduplicates, validates, scores and stores them, then
 * books every stored action whose effective date has arrived.
 *
 * ── Processing is automatic (firm decision, 2026-11-18) ─────────────────────
 *
 * PART 34 shipped with auto-processing OFF and a manual Review Center in front
 * of it. The firm dropped manual approval: nobody was approving, so no
 * dividend had ever been booked, and every client's return left out its
 * dividend income. Booking is now unconditional on the old
 * `caAutoProcessEnabled` toggle. The data-quality gates still apply, because
 * they protect the books rather than ask for consent: an action must pass
 * validation, carry no source conflict, meet the confidence threshold for its
 * type (75 for plain dividends, the general setting of 90 for everything
 * else; see minimumConfidenceFor), and have reached its effective date. One
 * that fails a gate stays unbooked and shows as "Not processed" in the Event
 * Center.
 *
 * ── Why the universe is "what the firm holds", not "the whole market" ───────
 *
 * The detection universe is every ticker any client holds or watches. Pulling
 * a whole-market calendar and storing thousands of irrelevant actions would
 * bury the four that matter, and every stored action is a candidate for
 * automatic booking, so storing irrelevant ones would only add work and risk.
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
      for (const incoming of collected) {
        try {
          const { action, created } = await this.service.ingest(incoming);
          if (created) result.created++;
          else result.merged++;

          const outcome = await this.service.validate(action.id);
          if (outcome.valid) result.validated++;

          const refreshed = await this.service.findOrThrow(action.id);
          if (refreshed.hasConflict) result.conflicts++;
        } catch (error) {
          const message = `${incoming.symbol} ${incoming.actionType}: ${(error as Error).message}`;
          result.errors.push(message);
          this.logger.warn(`Ingest failed for ${message}`);
        }
      }

      // Booking runs over the STORED actions, not only the ones fetched above.
      // See processDue() for why the fetch window alone would miss most of them.
      const due = await this.processDue();
      result.autoProcessed = due.processed;
      result.pendingReview = due.waiting;
      result.errors.push(...due.errors);

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Books every stored action whose effective date has arrived.
   *
   * ── Why this reads the table rather than the sweep's fetch ──────────────────
   *
   * FMP dates a dividend by its EX-date but sets its effectiveDate to the PAY
   * date, two to four weeks later. The sweep's fetch looks back only 14 days,
   * so by the time a dividend is payable it has usually left the window. A
   * gate that saw only freshly fetched actions would never be open on the day
   * the action became due. Visa's dividend (ex 10 Nov, paid 1 Dec) would never
   * be booked. Reading every open action from the table makes the booking
   * independent of what the provider happens to return that day.
   *
   * Oldest first, so that where two actions touch one name (a split, then a
   * dividend on the post-split shares) they apply in the order they happened.
   *
   * FAILED actions are retried on every run. process() is all-or-nothing and
   * idempotent per client, so a retry cannot double-book. An action that failed
   * because the ledger was missing a split row books itself once the row is
   * added, without anyone needing to remember to re-run it.
   */
  async processDue(): Promise<{ processed: number; waiting: number; errors: string[] }> {
    const settings = await this.service.settings();
    const now = new Date();
    const errors: string[] = [];
    let processed = 0;

    const due = await this.prisma.corporateAction.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        // Never act ahead of the effective date: a split announced for next
        // month must not be applied today.
        effectiveDate: { lte: now },
      },
      orderBy: { effectiveDate: 'asc' },
    });

    for (const action of due) {
      const name = `${action.symbol} ${action.actionType} (${action.id})`;

      // Two sources disagreeing means one record is wrong. Booking either
      // could be wrong, so a conflicted action waits for the data to be fixed.
      if (action.hasConflict) {
        errors.push(`${name}: sources conflict; not booked.`);
        continue;
      }
      const minimum = minimumConfidenceFor(action.actionType, settings.minimumConfidenceScore);
      if (action.confidenceScore < minimum) {
        errors.push(`${name}: confidence ${action.confidenceScore} is below ${minimum}; not booked.`);
        continue;
      }

      try {
        // A FAILED action was already approved before its run failed, and
        // process() accepts FAILED directly. Everything else goes through
        // validation and approval first. Approval re-validates, so an action
        // whose data went bad since detection is stopped here and not booked.
        if (action.status !== 'APPROVED' && action.status !== 'FAILED') {
          const outcome = await this.service.validate(action.id, SYSTEM_ACTOR);
          if (!outcome.valid) {
            errors.push(`${name}: failed validation; not booked.`);
            continue;
          }
          await this.service.approve(action.id, SYSTEM_ACTOR);
        }

        const run = await this.service.process(action.id, SYSTEM_ACTOR);
        processed++;
        this.logger.log(`Booked ${name}: ${run.clientsProcessed} client(s)`);
      } catch (error) {
        // process() has already marked the action FAILED and recorded why, so
        // it is picked up again on the next run.
        const message = `${name}: ${(error as Error).message}`;
        errors.push(message);
        this.logger.warn(`Automatic booking failed for ${message}`);
      }
    }

    // Open actions still ahead of their effective date. They book themselves
    // on the first run on or after that date.
    const waiting = await this.prisma.corporateAction.count({
      where: { status: { in: [...OPEN_STATUSES] }, effectiveDate: { gt: now } },
    });

    return { processed, waiting, errors };
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
 * Every status an action can sit in before it is booked.
 *
 * PROCESSED is done. REJECTED and CANCELLED mean the record was judged not
 * real. PROCESSING belongs to a run in flight, and picking it up would start a
 * second run on top of it. None of those four is retried.
 */
const OPEN_STATUSES = [
  'DETECTED',
  'PENDING_VALIDATION',
  'VALIDATED',
  'PENDING_APPROVAL',
  'APPROVED',
  'FAILED',
] as const;

/**
 * The confidence a plain cash dividend needs before it books itself (user
 * decision, 2026-11-18).
 *
 * 75 is what a dividend reported by Yahoo alone scores (SECONDARY_API tier).
 * Yahoo is the only provider that covers most of the book: the FMP plan
 * refuses anything older than about 25 days and most non-mega-cap symbols.
 * Under the general 90 gate, almost every dividend the firm's clients
 * receive would therefore never be booked.
 *
 * Dividends can take the lower bar because their processing is safe against a
 * wrong count. Entitlement is worked back to the ex-date eve, and a split that
 * is missing from the ledger blocks the run rather than being guessed at.
 */
const DIVIDEND_MINIMUM_CONFIDENCE = 75;

/**
 * Only these types take the dividend bar. Everything else keeps the general
 * setting (default 90):
 * - Ratio actions (STOCK_SPLIT, REVERSE_SPLIT, BONUS_ISSUE, STOCK_DIVIDEND,
 *   RIGHTS_ISSUE, SPIN_OFF). StockSplitProcessor multiplies TODAY's holding
 *   and does not look for a split row the desk keyed by hand, so a split from
 *   one secondary source could double a position, or over-multiply shares
 *   bought after the ex-date.
 * - RETURN_OF_CAPITAL, because it rewrites cost basis.
 * - CASH_DISTRIBUTION, because it is unclassified until someone decides what
 *   the payment actually is.
 */
const DIVIDEND_GATE_TYPES: ReadonlySet<string> = new Set(['DIVIDEND', 'SPECIAL_DIVIDEND']);

/**
 * The confidence an action of this type needs to book itself.
 *
 * For dividends it is the LOWER of the two bars, so a firm that drops the
 * general setting below 75 never ends up holding dividends to a stricter
 * standard than splits.
 */
export function minimumConfidenceFor(actionType: string, generalMinimum: number): number {
  return DIVIDEND_GATE_TYPES.has(actionType)
    ? Math.min(generalMinimum, DIVIDEND_MINIMUM_CONFIDENCE)
    : generalMinimum;
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
