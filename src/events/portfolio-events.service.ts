import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Market, DEFAULT_MARKET, ALL_MARKETS } from '../common/market-scope';
import { Actor, clientWhere, ownedWhere } from '../common/ownership-scope';
import { WatchlistEvent } from '../market/events.service';
import { YahooEventsService } from '../market/yahoo-events.service';
import { EventSnapshotRepository } from './event-snapshot.repository';
// The Corporate Action Engine's own display helper, reused rather than
// reimplemented — a stored 1:2 must read as '2:1' identically here and in the
// Review Center, and two independent formatters is how one of them inverts.
import { formatRatioLabel } from '../corporate-actions/ratio';

/** One client's exposure to a single event — the rows behind the Held By hover. */
export interface EventHolder {
  clientId: string;
  clientName: string;
  /** Shares held right now, which is what the entitlement is priced on. */
  quantity: number;
  /**
   * `quantity x dividendRate` — this client's ANNUAL dividend income from the
   * name, in the book's currency. Null for non-dividend events and whenever
   * the upstream had no rate.
   */
  annualAmount: number | null;
  /**
   * The single payment this event represents, `annualAmount / payoutsPerYear`.
   * Null when the frequency could not be inferred — an estimate is offered
   * only where there is a real basis for one.
   */
  estimatedAmount: number | null;
}

export interface PortfolioEvent extends Omit<WatchlistEvent, 'type' | 'code'> {
  /**
   * Widened beyond WatchlistEvent's three kinds to carry corporate actions.
   *
   * The first three come from the Yahoo calendar (EventSnapshot); everything
   * from BONUS onward comes from the Corporate Action Engine. They are merged
   * into one feed rather than shown on separate screens because an advisor
   * asking "what is happening to this position" does not care which system
   * detected it.
   */
  type: WatchlistEvent['type'] | CorporateActionEventType;
  /** PART 54's badge codes: E/D/S plus B, R, M, T, C. */
  code: string;
  company: string;
  /** How many clients currently hold this ticker — a rough measure of exposure. */
  clientCount: number;
  /**
   * Set only on rows sourced from the Corporate Action Engine, so the UI can
   * deep-link to the Review Center and show processing state. Absent on the
   * Yahoo-sourced earnings/dividend/split rows.
   */
  corporateActionId?: string;
  corporateActionStatus?: string;
  /** Human-readable ratio or per-share amount, e.g. '2:1' or '$1.00/share'. */
  detail?: string | null;
  source?: string;
  /**
   * Restated explicitly rather than inherited.
   *
   * Both are optional on WatchlistEvent, and an optional property whose type is
   * only reachable through the base interface loses its annotation when a
   * widened object literal is checked against this one — TypeScript then infers
   * `any` for it under noImplicitAny. Naming them here keeps the corporate-action
   * rows (which always set both to null) type-checked rather than silently
   * untyped.
   */
  dividendRate: number | null;
  payoutsPerYear: number | null;
  /** Which book the ticker trades in, so the UI never mixes the two. */
  market: Market;
  /** True when the ticker is only watchlisted, i.e. no client holds it yet. */
  watchlistOnly: boolean;
  /** Per-client breakdown behind the count, largest holder first. */
  holders: EventHolder[];
  /** Shares held across every client — the hover's footer total. */
  totalQuantity: number;
  /** Annual dividend across every client. Null when there is no rate. */
  totalAnnualAmount: number | null;
  /** Estimated single payment across every client. Null without a frequency. */
  totalEstimatedAmount: number | null;
}

export interface EventRefreshResult {
  refreshed: number;
  tickers: number;
}

/** The Event Center's own grouping of corporate actions (PART 29/54). */
export type CorporateActionEventType =
  | 'BONUS'
  | 'RIGHTS'
  | 'MERGER'
  | 'TICKER_CHANGE'
  | 'OTHER_CORPORATE_ACTION';

/**
 * Corporate-action type -> the Event Center's filter group and badge letter
 * (PART 29's filters and PART 54's icons).
 *
 * SPLIT and DIVIDEND deliberately reuse the codes the Yahoo-sourced rows
 * already use, so a split detected by the engine and one detected by the
 * calendar look identical to the advisor. They are the same kind of event; the
 * fact that two subsystems can find them is an implementation detail.
 */
const CA_EVENT_MAP: Record<
  string,
  { type: PortfolioEvent['type']; code: string; label: string }
> = {
  STOCK_SPLIT: { type: 'SPLIT', code: 'S', label: 'Stock Split' },
  REVERSE_SPLIT: { type: 'SPLIT', code: 'S', label: 'Reverse Split' },
  BONUS_ISSUE: { type: 'BONUS', code: 'B', label: 'Bonus Issue' },
  STOCK_DIVIDEND: { type: 'BONUS', code: 'B', label: 'Stock Dividend' },
  DIVIDEND: { type: 'DIVIDEND', code: 'D', label: 'Dividend' },
  SPECIAL_DIVIDEND: { type: 'DIVIDEND', code: 'D', label: 'Special Dividend' },
  CASH_DISTRIBUTION: { type: 'DIVIDEND', code: 'D', label: 'Cash Distribution' },
  RETURN_OF_CAPITAL: { type: 'DIVIDEND', code: 'D', label: 'Return of Capital' },
  RIGHTS_ISSUE: { type: 'RIGHTS', code: 'R', label: 'Rights Issue' },
  SPIN_OFF: { type: 'MERGER', code: 'M', label: 'Spin-off' },
  MERGER: { type: 'MERGER', code: 'M', label: 'Merger' },
  ACQUISITION: { type: 'MERGER', code: 'M', label: 'Acquisition' },
  TICKER_CHANGE: { type: 'TICKER_CHANGE', code: 'T', label: 'Ticker Change' },
  NAME_CHANGE: { type: 'TICKER_CHANGE', code: 'T', label: 'Name Change' },
  EXCHANGE_CHANGE: { type: 'TICKER_CHANGE', code: 'T', label: 'Exchange Change' },
  DELISTING: { type: 'OTHER_CORPORATE_ACTION', code: 'C', label: 'Delisting' },
};

/** One ticker's event universe entry, keyed by clientId so lots merge per client. */
interface TrackedTicker {
  company: string;
  holders: Map<string, { clientName: string; quantity: number }>;
}

/**
 * The Event Center's data source: every ticker any client currently holds
 * (deduplicated), not the watchlist and not S&P 500 constituents. A client's
 * money is at stake in a holding whether or not anyone remembered to also
 * watchlist it, so that is the list this page has to be complete over.
 *
 * DB-first, exactly like the Fundamentals page: reads serve the EventSnapshot
 * store and never call upstream, so the page keeps rendering when Yahoo is
 * throttling or the API just restarted. Yahoo is only ever touched by
 * refresh(), which the manual POST /events/refresh endpoint triggers.
 */
@Injectable()
export class PortfolioEventsService {
  private readonly logger = new Logger(PortfolioEventsService.name);

  constructor(
    private prisma: PrismaService,
    private events: YahooEventsService,
    private snapshots: EventSnapshotRepository,
  ) {}

  /**
   * DB-first read — serves the last saved snapshot, no upstream call.
   *
   * Scoped to one book. An event whose ticker is not in the selected market's
   * universe is dropped rather than shown greyed out: the Indian desk reviewing
   * corporate actions has no use for an Apple ex-date, and a mixed calendar is
   * actively confusing when the two books' dates sit side by side.
   */
  async forAllHoldings(
    market: Market = DEFAULT_MARKET,
    actor?: Actor,
  ): Promise<PortfolioEvent[]> {
    const byTicker = await this.trackedTickers(market, actor);
    const stored = await this.snapshots.listAll();

    const calendarEvents = stored
      .filter((e) => byTicker.has(e.ticker))
      .map((e) => {
        const entry = byTicker.get(e.ticker)!;

        // Only a dividend carries cash. A split changes the share count, not
        // the client's money, so its holders are listed with quantities and no
        // amount rather than a misleading zero.
        const rate = e.type === 'DIVIDEND' ? e.dividendRate : null;
        const frequency = e.type === 'DIVIDEND' ? e.payoutsPerYear : null;

        const holders: EventHolder[] = [...entry.holders.entries()]
          .map(([clientId, h]) => {
            const annualAmount = rate != null ? h.quantity * rate : null;
            return {
              clientId,
              clientName: h.clientName,
              quantity: h.quantity,
              annualAmount,
              estimatedAmount:
                annualAmount != null && frequency ? annualAmount / frequency : null,
            };
          })
          // Largest position first: the advisor wants the most exposed client
          // at the top of the hover, not whichever row Mongo returned first.
          .sort((a, b) => b.quantity - a.quantity);

        const totalQuantity = holders.reduce((sum, h) => sum + h.quantity, 0);

        return {
          ticker: e.ticker,
          type: e.type as WatchlistEvent['type'],
          code: e.code as WatchlistEvent['code'],
          label: e.label,
          date: e.date,
          status: e.status as WatchlistEvent['status'],
          dividendRate: rate,
          payoutsPerYear: frequency,
          company: entry.company,
          clientCount: entry.holders.size,
          market,
          watchlistOnly: entry.holders.size === 0,
          holders,
          totalQuantity,
          totalAnnualAmount: rate != null ? totalQuantity * rate : null,
          totalEstimatedAmount:
            rate != null && frequency ? (totalQuantity * rate) / frequency : null,
        };
      });

    const corporateActions = await this.corporateActionEvents(market, byTicker);

    /**
     * One feed, sorted by date.
     *
     * A corporate action detected by the engine and a split from the Yahoo
     * calendar can describe the SAME event, so engine rows win where both
     * exist: they carry a source, a confidence score and a processing status,
     * which the calendar row does not, and showing both would have the advisor
     * reconcile two lines about one split.
     */
    const engineKeys = new Set(corporateActions.map((e) => `${e.ticker}|${e.type}|${e.date}`));

    return [
      ...calendarEvents.filter((e) => !engineKeys.has(`${e.ticker}|${e.type}|${e.date}`)),
      ...corporateActions,
    ].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Corporate actions as Event Center rows (PART 29).
   *
   * Read straight from the engine's own table rather than being copied into
   * EventSnapshot. Duplicating them would create two records of one event that
   * could drift — and the engine's row is the one carrying status, source and
   * confidence, which is exactly what makes a corporate action worth showing
   * here rather than merely noting that it exists.
   *
   * Rejected and cancelled actions are excluded: they describe something the
   * desk decided was not real, and surfacing them as upcoming events would
   * undo that decision on screen.
   */
  private async corporateActionEvents(
    market: Market,
    byTicker: Map<string, TrackedTicker>,
  ): Promise<PortfolioEvent[]> {
    // A window wide enough to cover what is coming and what just happened,
    // matching the scheduler's own sweep window.
    const from = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = new Date(Date.now() + 90 * 24 * 3600 * 1000);

    const actions = await this.prisma.corporateAction.findMany({
      where: {
        market,
        status: { notIn: ['REJECTED', 'CANCELLED'] },
        effectiveDate: { gte: from, lte: to },
      },
      orderBy: { effectiveDate: 'asc' },
    });

    return actions
      .filter((a) => byTicker.has(a.symbol))
      // Return type annotated on the callback rather than left to `satisfies`
      // at the end of the literal: inference runs first, so an optional field
      // set to a bare `null` resolves to `any` before the check happens.
      .map((a): PortfolioEvent => {
        const entry = byTicker.get(a.symbol)!;
        const meta = CA_EVENT_MAP[a.actionType] ?? {
          type: 'OTHER_CORPORATE_ACTION' as const,
          code: 'C',
          label: a.actionType,
        };

        const holders: EventHolder[] = [...entry.holders.entries()]
          .map(([clientId, h]) => ({
            clientId,
            clientName: h.clientName,
            quantity: h.quantity,
            // Only a cash action pays anything; a split's holders are listed
            // with quantities and no amount rather than a misleading zero.
            annualAmount: a.cashAmount != null ? h.quantity * a.cashAmount : null,
            estimatedAmount: a.cashAmount != null ? h.quantity * a.cashAmount : null,
          }))
          .sort((x, y) => y.quantity - x.quantity);

        const totalQuantity = holders.reduce((sum, h) => sum + h.quantity, 0);

        return {
          ticker: a.symbol,
          type: meta.type,
          code: meta.code,
          label: meta.label,
          // The ex-date is what an advisor watches for an entitlement; the
          // effective date is what matters for everything else.
          date: (a.exDate ?? a.effectiveDate).toISOString().slice(0, 10),
          status: a.status === 'PROCESSED' ? 'Confirmed' : 'Upcoming',
          dividendRate: null,
          payoutsPerYear: null,
          company: a.company ?? entry.company,
          clientCount: entry.holders.size,
          market,
          watchlistOnly: entry.holders.size === 0,
          holders,
          totalQuantity,
          totalAnnualAmount: a.cashAmount != null ? totalQuantity * a.cashAmount : null,
          totalEstimatedAmount: a.cashAmount != null ? totalQuantity * a.cashAmount : null,
          corporateActionId: a.id,
          corporateActionStatus: a.status,
          detail: describeAction(a),
          source: a.source,
        };
      });
  }

  /**
   * Fetches Yahoo's calendar for every tracked ticker and replaces the snapshot.
   * The one place in the Event Center that goes out to the network — one
   * request per ticker, since Yahoo has no whole-market calendar feed.
   */
  async refresh(): Promise<EventRefreshResult> {
    // Deliberately refreshes BOTH books in one pass, even though reads are
    // scoped to one. The snapshot is a single shared store, so fetching only the
    // active market would delete the other book's events on every replaceAll —
    // switching the selector would then show an empty calendar until someone
    // refreshed again from that side.
    // Deliberately UNSCOPED (no actor): the snapshot is one shared store keyed
    // by ticker, so it must be built from every manager's tracked universe.
    // Scoping this would make whichever manager refreshed last delete everyone
    // else's events. Privacy is enforced on the READ path instead — a manager
    // only ever sees the rows whose tickers they actually hold or watch.
    const universes = await Promise.all(ALL_MARKETS.map((m) => this.trackedTickers(m)));
    const tickers = [...new Set(universes.flatMap((u) => [...u.keys()]))];

    const raw = await this.events.forTickers(tickers);
    const refreshed = await this.snapshots.replaceAll(raw);

    this.logger.log(
      `Event snapshot refreshed: ${refreshed} events across ${tickers.length} tracked tickers (all books)`,
    );
    return { refreshed, tickers: tickers.length };
  }

  /**
   * One book's event universe: every ticker held by a client in that market,
   * plus every ticker on that market's watchlist, deduplicated.
   *
   * "Held" means an open position. A sold-out lot keeps its row for the
   * realized P&L it booked, but its earnings and dividend dates are no longer
   * this desk's business — surfacing them would alert an advisor about a name
   * their client has already exited.
   *
   * Watchlisted names are in scope because the desk tracks a candidate's
   * earnings date before it ever buys — the same rule the US book already
   * follows. They carry clientCount 0, which is what marks them watchlist-only.
   *
   * Holdings are scoped through `client.market` rather than a column on Holding
   * itself: the position belongs to whichever book its mandate does, and that is
   * how /holdings scopes too.
   */
  private async trackedTickers(
    market: Market,
    actor?: Actor,
  ): Promise<Map<string, TrackedTicker>> {
    const [stored, watched] = await Promise.all([
      this.prisma.holding.findMany({
        where: {
          client: { market, ...(actor ? clientWhere(actor) : {}) },
        },
        // The client relation is what turns a bare count into a named
        // breakdown; quantity is what prices each holder's entitlement.
        select: {
          ticker: true,
          company: true,
          clientId: true,
          quantity: true,
          client: { select: { name: true } },
        },
      }),
      this.prisma.watchlist.findMany({
        where: { market, ...(actor ? ownedWhere(actor) : {}) },
        select: { ticker: true, company: true },
      }),
    ]);

    const byTicker = new Map<string, TrackedTicker>();

    for (const h of stored.filter((h) => Math.abs(h.quantity) > 1e-9)) {
      const entry = byTicker.get(h.ticker) ?? { company: h.company, holders: new Map() };
      // A client can hold the same ticker across several lots; the entitlement
      // is on the combined position, so quantities accumulate per client rather
      // than the last lot overwriting the earlier ones.
      const held = entry.holders.get(h.clientId);
      if (held) {
        held.quantity += h.quantity;
      } else {
        entry.holders.set(h.clientId, {
          clientName: h.client?.name ?? 'Unknown client',
          quantity: h.quantity,
        });
      }
      byTicker.set(h.ticker, entry);
    }

    // Added after the holdings so a name that is both held and watchlisted keeps
    // its real clientCount instead of being reset to a watchlist-only zero.
    for (const w of watched) {
      if (byTicker.has(w.ticker)) continue;
      byTicker.set(w.ticker, { company: w.company, holders: new Map() });
    }

    return byTicker;
  }
}

/**
 * One-line human summary of what an action does — the Event Center's detail
 * column and hover text.
 *
 * Ratios are rendered through the engine's own formatRatioLabel so a 2-for-1
 * reads as "2:1" here exactly as it does in the Review Center. Two places
 * formatting the same stored pair independently is how a display inverts.
 */
function describeAction(a: {
  actionType: string;
  oldRatio: number | null;
  newRatio: number | null;
  cashAmount: number | null;
  currency: string | null;
  newSymbol: string | null;
  symbol: string;
}): string | null {
  if (a.oldRatio !== null && a.newRatio !== null) {
    return formatRatioLabel(a.oldRatio, a.newRatio);
  }
  if (a.cashAmount !== null) {
    const symbol = a.currency === 'INR' ? '\u20B9' : '$';
    return `${symbol}${a.cashAmount}/share`;
  }
  if (a.newSymbol) return `${a.symbol} \u2192 ${a.newSymbol}`;
  return null;
}
