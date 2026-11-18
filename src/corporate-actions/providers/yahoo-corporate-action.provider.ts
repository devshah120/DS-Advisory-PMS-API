/**
 * Yahoo Finance adapter for corporate actions: dividends and splits, read per
 * symbol from the chart endpoint's `events=div|split`.
 *
 * ── Why a second source ─────────────────────────────────────────────────────
 *
 * The firm's FMP plan does not cover this book (probed 2026-11-18). Its
 * dividend calendar refuses any `from` older than about 25 days with a 402, and
 * the plan has a symbol whitelist: AAPL is served, OKE gets 402. Its
 * whole-market calendar returned 13 rows for 1–18 November, all mega-caps. So
 * the engine had detected 7 of the book's dividends since inception, and
 * nothing could be backfilled. Yahoo served every US name tested, free and
 * without a crumb.
 *
 * ── What Yahoo does not give, and how each gap is handled ───────────────────
 *
 *  - Pay date: none. The effective date falls back to the ex-date, so the
 *    DIVIDEND row is dated on the ex-date unless FMP reports the same event
 *    with a pay date and merges in. Accepted when this source was chosen.
 *  - Record date: none. Set to the ex-date, as the FMP adapter does when FMP
 *    omits one. That is exact under T+1 settlement (India since 2023, the US
 *    since May 2024), where the ex-date is the record date. If a source
 *    reports a different record date, the two conflict and the action waits
 *    instead of being booked, which is the safe outcome.
 *  - The amount actually paid: Yahoo restates past dividends for later splits
 *    (it lists AAPL's Feb-2020 dividend as 0.1925; 0.77 was paid). The request
 *    always runs to today, so every later split is in the same response, and
 *    `asPaidPerShare` undoes them.
 *  - Special vs regular: not distinguished, the same as FMP.
 *
 * SECONDARY_API tier, so it scores 75 or less on its own and never
 * auto-processes. FMP outranks it whenever both report the same event.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CorporateActionType } from '@prisma/client';
import { marketForSymbol } from '../../common/market-scope';
import { NormalizedCorporateAction, SourceTier } from '../corporate-action.types';
import { asPaidPerShare, SplitEvent } from '../dividend-entitlement';
import {
  CorporateActionProvider,
  FetchWindow,
  ratioFromMarketConvention,
} from './corporate-action-provider.interface';

const YAHOO = 'https://query2.finance.yahoo.com';
const REQUEST_TIMEOUT_MS = 10_000;
// Yahoo rejects requests that don't look like a browser.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Per-symbol endpoint: a few at a time with a short gap, as YahooEventsService does.
const BATCH_SIZE = 4;
const BATCH_PAUSE_MS = 150;

/** NSE Emerge (SME) symbols quote as 'X-SM.NS', but their history sits on the bare symbol. */
const EMERGE_SYMBOL = /^(.+)-(SM|ST)\.NS$/;

/** The parts of a chart response this adapter reads. */
export interface ChartEvents {
  /** Seconds east of UTC for the exchange; Yahoo stamps events at the session open. */
  gmtOffset: number;
  currency: string | null;
  dividends: Array<{ date: number; amount: number }>;
  splits: Array<{ date: number; numerator: number; denominator: number }>;
}

@Injectable()
export class YahooCorporateActionProvider implements CorporateActionProvider {
  readonly name = 'yahoo';
  readonly tier: SourceTier = 'SECONDARY_API';

  readonly supports: ReadonlySet<CorporateActionType> = new Set<CorporateActionType>([
    'DIVIDEND',
    'STOCK_SPLIT',
    'REVERSE_SPLIT',
  ]);

  private readonly logger = new Logger(YahooCorporateActionProvider.name);

  async getCorporateActions(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const symbols = [
      ...new Set((window.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean)),
    ];
    const out: NormalizedCorporateAction[] = [];

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((s) => this.forSymbol(s, window)));
      for (const list of results) out.push(...list);
      if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_PAUSE_MS);
    }
    return out;
  }

  async getDividends(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    return (await this.getCorporateActions(window)).filter((a) => a.actionType === 'DIVIDEND');
  }

  async getSplits(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    return (await this.getCorporateActions(window)).filter((a) => a.actionType !== 'DIVIDEND');
  }

  /** Not in Yahoo's chart events. */
  async getMergers(): Promise<NormalizedCorporateAction[]> {
    return [];
  }

  /** Not in Yahoo's chart events. */
  async getSymbolChanges(): Promise<NormalizedCorporateAction[]> {
    return [];
  }

  /**
   * One held symbol's actions. Stamped with the HELD symbol even when the data
   * came from a fallback listing, because the action joins to Holding.ticker.
   */
  private async forSymbol(symbol: string, window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    for (const candidate of candidatesFor(symbol)) {
      const chart = await this.chartEvents(candidate, window.from);
      if (chart) return actionsFromChart(symbol, chart, window, this.chartUrl(candidate, window.from));
    }
    return [];
  }

  /** The chart's events from `from` to today, or null when Yahoo has no such symbol. Never throws. */
  private async chartEvents(symbol: string, from: Date): Promise<ChartEvents | null> {
    try {
      const response = await fetch(this.chartUrl(symbol, from), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;

      const result = (await response.json())?.chart?.result?.[0];
      if (!result) return null;

      return {
        gmtOffset: typeof result.meta?.gmtoffset === 'number' ? result.meta.gmtoffset : 0,
        currency: typeof result.meta?.currency === 'string' ? result.meta.currency : null,
        dividends: Object.values<{ date: number; amount: number }>(result.events?.dividends ?? {}),
        splits: Object.values<{ date: number; numerator: number; denominator: number }>(
          result.events?.splits ?? {},
        ),
      };
    } catch (error) {
      this.logger.warn(`Yahoo chart events failed for ${symbol}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Always runs to TODAY, whatever the window's end. Yahoo restates a dividend
   * for every later split but only returns split events inside the requested
   * range, so a shorter range would leave a restated amount uncorrected.
   */
  private chartUrl(symbol: string, from: Date): string {
    const period1 = Math.floor(from.getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    return (
      `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`
    );
  }
}

/**
 * Turns one chart response into normalised actions inside `window`. Pure, so
 * the restatement and date handling can be tested without the network.
 */
export function actionsFromChart(
  heldSymbol: string,
  chart: ChartEvents,
  window: Pick<FetchWindow, 'from' | 'to'>,
  sourceUrl: string | null = null,
): NormalizedCorporateAction[] {
  const market = marketForSymbol(heldSymbol);
  const from = iso(window.from);
  const to = iso(window.to);

  // Events are dated in the exchange's own calendar; the offset makes that
  // explicit instead of relying on where each session happens to open.
  const localDay = (epochSeconds: number) =>
    new Date((epochSeconds + chart.gmtOffset) * 1000).toISOString().slice(0, 10);
  const atMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);
  const inWindow = (day: string) => day >= from && day <= to;

  const validSplits = chart.splits.filter(
    (s) => Number.isFinite(s.numerator) && Number.isFinite(s.denominator) && s.numerator > 0 && s.denominator > 0,
  );
  // Every split in the response, in or out of the window: all of them restate earlier dividends.
  const splitEvents: SplitEvent[] = validSplits.map((s) => ({
    ticker: heldSymbol,
    exDate: atMidnight(localDay(s.date)),
    multiplier: s.numerator / s.denominator,
  }));

  const actions: NormalizedCorporateAction[] = [];

  for (const s of validSplits) {
    const day = localDay(s.date);
    if (!inWindow(day) || s.numerator === s.denominator) continue;
    const date = atMidnight(day);
    // Yahoo's numerator is what the holder receives: 2/1 is a 2-for-1.
    const ratio = ratioFromMarketConvention(s.numerator, s.denominator);

    actions.push({
      symbol: heldSymbol,
      market,
      actionType: (s.numerator < s.denominator ? 'REVERSE_SPLIT' : 'STOCK_SPLIT') as CorporateActionType,
      exDate: date,
      effectiveDate: date,
      oldRatio: ratio.oldRatio,
      newRatio: ratio.newRatio,
      source: 'yahoo',
      tier: 'SECONDARY_API',
      sourceUrl,
      sourceReference: `${heldSymbol}:${day}:${s.numerator}/${s.denominator}`,
    });
  }

  for (const d of chart.dividends) {
    if (!Number.isFinite(d.amount) || d.amount <= 0) continue;
    const day = localDay(d.date);
    if (!inWindow(day)) continue;
    const exDate = atMidnight(day);

    const perShare = asPaidPerShare(
      { ticker: heldSymbol, exDate, perShare: d.amount, basis: 'SPLIT_ADJUSTED' },
      splitEvents,
      market,
    );

    actions.push({
      symbol: heldSymbol,
      market,
      actionType: 'DIVIDEND' as CorporateActionType,
      exDate,
      recordDate: exDate,
      paymentDate: null,
      // No pay date from this source; see the header.
      effectiveDate: exDate,
      cashAmount: perShare,
      currency: chart.currency ?? (market === 'INDIA' ? 'INR' : 'USD'),
      // Kept so a reviewer can see the restatement Yahoo applied.
      details: perShare !== d.amount ? { yahooSplitAdjustedAmount: d.amount } : null,
      source: 'yahoo',
      tier: 'SECONDARY_API',
      sourceUrl,
      sourceReference: `${heldSymbol}:${day}`,
    });
  }

  return actions;
}

/**
 * Yahoo listings to try for a held symbol, in order. Mirrors MarketService:
 * a '.NS' name Yahoo does not carry often trades as '.BO', and an Emerge
 * symbol's history sits on the bare name.
 */
function candidatesFor(symbol: string): string[] {
  const emerge = EMERGE_SYMBOL.exec(symbol);
  if (emerge) return [`${emerge[1]}.NS`, `${emerge[1]}.BO`, symbol];
  if (symbol.endsWith('.NS')) return [symbol, `${symbol.slice(0, -3)}.BO`];
  return [symbol];
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
