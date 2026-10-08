import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { PerformanceBaselineService } from '../portfolio-reconstruction/performance-baseline.service';
import { ResolvedPeriod, resolvePeriod } from '../portfolio-reconstruction/periods';
import { ReconstructedPortfolio, ReconstructedPosition } from '../portfolio-reconstruction/types';
import { LedgerEntry, buildWindowFlows } from '../analytics/calculators/flows';
import { CashFlow, xirr } from '../analytics/calculators/xirr';
import { Market, parseMarket } from '../common/market-scope';
import { Actor, assertCanAccessClient } from '../common/ownership-scope';
import { computePeriodReturn, trackedBenchmarks } from './watchlist.service';

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

export type WatchlistWindow = 'mtd' | 'qtd' | 'ytd';
const WINDOWS: ReadonlyArray<[WatchlistWindow, string]> = [
  ['mtd', 'MTD'],
  ['qtd', 'QTD'],
  // `YTD` resolves on the client's own reporting calendar: April–March for the
  // Indian book (FYTD), January–December for the US one. See periods.ts.
  ['ytd', 'YTD'],
];

export interface PositionWindowReturn {
  /**
   * Money-weighted return of this one position over the part of the window it
   * was held, in PERCENT — the watchlist's unit, not the fraction the
   * Performance sheet uses. Null when there is nothing to measure; see `reason`.
   */
  returnPct: number | null;
  openingValue: number;
  closingValue: number;
  /** Net capital put into the position inside the window (buys − sells − income). */
  netFlows: number;
  /**
   * Where measurement starts: the window's own open, or the first purchase when
   * the position was opened inside the window. A later date here means the
   * figure covers a shorter span than the benchmark's, and the UI says so.
   */
  measuredFrom: string;
  reason?: string;
}

export interface WatchlistWindowMeta {
  label: string;
  from: string;
  to: string;
  clampedToInception: boolean;
  nominalFrom: string | null;
}

export interface ClientWatchlistRow {
  symbol: string;
  company: string | null;
  sector: string;
  industry: string;
  quantity: number;
  price: number;
  priceDate: string | null;
  /** `missing` means no close was found and cost stood in for the price. */
  priceStatus: string | null;
  marketValue: number;
  mtd: PositionWindowReturn;
  qtd: PositionWindowReturn;
  ytd: PositionWindowReturn;
}

export interface ClientWatchlistBenchmark {
  code: string;
  label: string;
  symbol: string;
  mtd: number | null;
  qtd: number | null;
  ytd: number | null;
}

export interface ClientPortfolioWatchlist {
  clientId: string;
  clientName: string;
  market: Market;
  currency: string;
  asOf: string;
  windows: Record<WatchlistWindow, WatchlistWindowMeta>;
  rows: ClientWatchlistRow[];
  benchmarks: ClientWatchlistBenchmark[];
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The instant before which a ledger row is already inside the valuation of
 * `date`, or null when every recorded row is (the live book).
 *
 * This restates PortfolioReconstructionService's replay bound and must stay in
 * step with it: a historical date replays rows up to the END of that day, and
 * today replays everything already entered, including rows dated ahead. Flow
 * bounds that disagree with the valuation bounds either drop a trade the
 * valuation saw (a top-up booked today reads as gain) or count one twice.
 */
export function valuationCutoff(date: Date, now: Date = new Date()): Date | null {
  const day = utcDay(date);
  if (day.getTime() >= utcDay(now).getTime()) return null;
  return new Date(day.getTime() + MS_PER_DAY);
}

/**
 * One position's money-weighted return over one window.
 *
 * The same construction as PerformanceBaselineService.periodReturn, narrowed
 * to a single symbol: the opening market value goes in at the window's open,
 * every flow for that symbol in between sits on its own date, and the closing
 * market value comes out at the close. Same flow rules (`buildWindowFlows`,
 * transactional method, same-day netting, import artifacts dropped), same
 * solver, same de-annualization. It is NOT (close − open) / open: a position
 * topped up mid-month would report the top-up as gain.
 *
 * Two things differ from the portfolio-level engine, both because a single
 * position exposes them where a whole book mostly does not:
 *
 *  1. **De-annualized over the span actually held.** A book almost always has
 *     an opening value, so its series starts on the window's open. A position
 *     bought on the 7th starts on the 7th, and stretching its rate back over
 *     the whole month would compound a one-day 1% gain into roughly 7%.
 *
 *  2. **Flow bounds follow the valuation bounds** (see `valuationCutoff`)
 *     rather than `from < date < to` on midnight instants. That is what puts
 *     a trade booked today into both the closing value and the flow series,
 *     not just the former.
 */
export function positionWindowReturn(input: {
  from: Date;
  to: Date;
  openingValue: number;
  closingValue: number;
  /** Every ledger row for this symbol that might fall in the window. */
  rows: LedgerEntry[];
  /** Rows before this are inside the opening value; null = all of them are. */
  openedThrough: Date | null;
  /** Rows before this are inside the closing value; null = all of them are. */
  closedThrough: Date | null;
  isHouseBaseline: boolean;
}): PositionWindowReturn {
  const { from, to, openingValue, closingValue, openedThrough, closedThrough } = input;

  const interiorRows =
    openedThrough === null
      ? []
      : input.rows
          .filter((r) => r.date >= openedThrough && (closedThrough === null || r.date < closedThrough))
          // A row the live book already holds but dated after today is priced
          // into the closing value, so its cash belongs on the closing date.
          .map((r) => (r.date > to ? { ...r, date: to } : r));

  // Bounds are already applied above; these only keep buildWindowFlows' own
  // strict filter from re-trimming the rows that sit on the closing date.
  const interior = buildWindowFlows(
    interiorRows,
    'TRANSACTIONAL',
    new Date(from.getTime() - 1),
    new Date(to.getTime() + 1),
    undefined,
    input.isHouseBaseline,
  );

  const flows: CashFlow[] = [
    ...(openingValue > 0 ? [{ date: from, amount: -openingValue }] : []),
    ...interior,
    { date: to, amount: closingValue },
  ];

  const measuredFrom = flows[0].date;
  const base = {
    openingValue,
    closingValue,
    netFlows: interior.reduce((sum, f) => sum - f.amount, 0),
    measuredFrom: iso(measuredFrom),
  };

  const invested = flows.filter((f) => f.amount < 0).reduce((sum, f) => sum - f.amount, 0);
  if (invested === 0) {
    return {
      ...base,
      returnPct: null,
      reason:
        'No opening value or purchase in this window to measure from — the position arrived ' +
        'without a priced trade (a transfer in or a ticker change).',
    };
  }

  const years = (to.getTime() - measuredFrom.getTime()) / (DAYS_PER_YEAR * MS_PER_DAY);
  if (years <= 0) {
    // Everything happened on the closing date: a position opened today, or a
    // live window on its first day. There is no span to compound over, so the
    // honest figure is the plain gain on what went in, which is 0 for the
    // latter, since its opening and closing values are the same valuation.
    const gain = flows.reduce((sum, f) => sum + f.amount, 0);
    return { ...base, returnPct: (gain / invested) * 100 };
  }

  const solved = xirr(flows);
  if (solved.status !== 'ok') {
    return { ...base, returnPct: null, reason: solved.reason };
  }
  return { ...base, returnPct: ((1 + solved.rate) ** years - 1) * 100 };
}

/**
 * The watchlist, populated from a client's book instead of typed in: every
 * position they hold today, with MTD / QTD / YTD for THEIR holding of it, and
 * the book's benchmark indices measured over the same windows.
 *
 * The book is valued once per distinct window edge, through the same
 * snapshot-or-reconstruct path the Performance sheet uses, and each position is
 * read off those valuations. Valuing per symbol would replay the full ledger
 * N × 4 times for an N-position book.
 */
@Injectable()
export class ClientPortfolioWatchlistService {
  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
    private performanceBaseline: PerformanceBaselineService,
    private market: MarketService,
  ) {}

  async forClient(clientId: string, actor: Actor): Promise<ClientPortfolioWatchlist> {
    const found = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, ownerId: true, name: true, market: true, currency: true, inceptionDate: true },
    });
    assertCanAccessClient(actor, found);
    const client = found!;

    const market = parseMarket(client.market);
    const now = new Date();
    const resolved = Object.fromEntries(
      WINDOWS.map(([key, code]) => [
        key,
        resolvePeriod(code, { asOf: now, market, clientInception: client.inceptionDate }),
      ]),
    ) as Record<WatchlistWindow, ResolvedPeriod>;

    // Every window here is live, so they share one closing date (today).
    const to = resolved.mtd.to;
    const openDates = [...new Set(WINDOWS.map(([key]) => resolved[key].from.getTime()))].map(
      (t) => new Date(t),
    );
    const earliestFrom = new Date(Math.min(...openDates.map((d) => d.getTime())));

    const [closing, openings, ledger, isHouseBaseline, holdings, benchmarks] = await Promise.all([
      this.history.getPortfolioAsOf(clientId, to),
      Promise.all(
        openDates.map((d) =>
          // A window whose opening valuation cannot be produced (a date before
          // this client's baseline, say) is reported as unavailable rather than
          // taking the other two windows down with it.
          this.history.getPortfolioAsOf(clientId, d).catch((): ReconstructedPortfolio | null => null),
        ),
      ),
      this.prisma.transaction.findMany({
        where: { clientId, date: { gte: earliestFrom } },
        select: { ticker: true, type: true, amount: true, date: true },
        orderBy: { date: 'asc' },
      }),
      this.performanceBaseline.isHouseBaseline(clientId),
      this.prisma.holding.findMany({ where: { clientId }, select: { ticker: true, company: true } }),
      this.benchmarkRows(market, resolved, earliestFrom),
    ]);

    const openingByDate = new Map<number, Map<string, ReconstructedPosition> | null>(
      openDates.map((d, i) => [
        d.getTime(),
        openings[i] ? new Map(openings[i]!.positions.map((p) => [p.ticker, p])) : null,
      ]),
    );

    const rowsByTicker = new Map<string, LedgerEntry[]>();
    for (const t of ledger) {
      if (!t.ticker) continue; // ticker-less rows (fees, cash) belong to the book, not a position
      const list = rowsByTicker.get(t.ticker) ?? [];
      list.push(t);
      rowsByTicker.set(t.ticker, list);
    }

    const companies = new Map(holdings.map((h) => [h.ticker, h.company]));
    const closedThrough = valuationCutoff(to, now);

    const rows = closing.positions
      .filter((p) => p.quantity > 0)
      .sort((a, b) => b.marketValue - a.marketValue)
      .map((p): ClientWatchlistRow => {
        const measure = (key: WatchlistWindow): PositionWindowReturn => {
          const { from } = resolved[key];
          const opening = openingByDate.get(from.getTime());
          if (!opening) {
            return {
              returnPct: null,
              openingValue: 0,
              closingValue: p.marketValue,
              netFlows: 0,
              measuredFrom: iso(from),
              reason: `The book could not be valued on ${iso(from)}, so this window has no opening value.`,
            };
          }
          return positionWindowReturn({
            from,
            to,
            openingValue: opening.get(p.ticker)?.marketValue ?? 0,
            closingValue: p.marketValue,
            rows: rowsByTicker.get(p.ticker) ?? [],
            openedThrough: valuationCutoff(from, now),
            closedThrough,
            isHouseBaseline,
          });
        };

        return {
          symbol: p.ticker,
          company: companies.get(p.ticker) ?? null,
          sector: p.sector,
          industry: p.industry,
          quantity: p.quantity,
          price: p.closingPrice,
          priceDate: p.priceDate ?? null,
          priceStatus: p.priceStatus ?? null,
          marketValue: p.marketValue,
          mtd: measure('mtd'),
          qtd: measure('qtd'),
          ytd: measure('ytd'),
        };
      });

    const windows = Object.fromEntries(
      WINDOWS.map(([key]) => {
        const w = resolved[key];
        return [
          key,
          {
            label: w.label,
            from: iso(w.from),
            to: iso(w.to),
            clampedToInception: w.clampedToInception,
            nominalFrom: w.nominalFrom ? iso(w.nominalFrom) : null,
          },
        ];
      }),
    ) as Record<WatchlistWindow, WatchlistWindowMeta>;

    return {
      clientId,
      clientName: client.name,
      market,
      currency: client.currency,
      asOf: iso(to),
      windows,
      rows,
      benchmarks,
    };
  }

  /**
   * The book's indices over the CLIENT'S windows — not the calendar windows the
   * manual watchlist uses. On the Indian book "YTD" here is FYTD, and every
   * window is clamped to the 30-June-2026 inception, so the index must be
   * measured over exactly those dates or the comparison is meaningless.
   *
   * An index has no flows, so its price return over the window is already the
   * money-weighted figure.
   */
  private async benchmarkRows(
    market: Market,
    resolved: Record<WatchlistWindow, ResolvedPeriod>,
    earliestFrom: Date,
  ): Promise<ClientWatchlistBenchmark[]> {
    // A week of headroom so an opening date on a holiday still has a prior bar.
    const historyFrom = iso(new Date(earliestFrom.getTime() - 7 * MS_PER_DAY));
    return Promise.all(
      trackedBenchmarks(market).map(async (b) => {
        try {
          const bars = await this.market.history(b.symbol, historyFrom);
          const pct = (key: WatchlistWindow) => computePeriodReturn(bars, iso(resolved[key].from)).returnPct;
          return { ...b, mtd: pct('mtd'), qtd: pct('qtd'), ytd: pct('ytd') };
        } catch {
          return { ...b, mtd: null, qtd: null, ytd: null };
        }
      }),
    );
  }
}
