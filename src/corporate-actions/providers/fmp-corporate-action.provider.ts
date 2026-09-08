/**
 * Financial Modeling Prep adapter for corporate actions.
 *
 * FMP is a PRIMARY_API tier source (confidence 90 under PART 33), which sits
 * below the auto-process threshold of 90... at exactly 90. That is deliberate:
 * an FMP-only split reaches the threshold and can auto-process when the firm
 * turns auto-processing on, but any missing field or source disagreement drops
 * it below and sends it to review.
 *
 * ── Rate limiting, caching and backoff (PART 48) ────────────────────────────
 *
 * The gate below is the same shape as FmpFundamentalsProvider's, and shares
 * its reasoning: FMP rate-limits per API KEY, not per endpoint, so serialising
 * every outbound call behind one interval is the only thing that reliably
 * prevents a 429. A response cache sits in front of it so that a sweep
 * repeated within the TTL costs nothing, and 429/5xx responses retry with
 * exponential backoff rather than being discarded.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CorporateActionType } from '@prisma/client';
import { marketForSymbol } from '../../common/market-scope';
import { NormalizedCorporateAction, SourceTier } from '../corporate-action.types';
import {
  CorporateActionProvider,
  FetchWindow,
  ratioFromMarketConvention,
  parseRatioLabel,
} from './corporate-action-provider.interface';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const REQUEST_TIMEOUT_MS = 10_000;

/** One outbound request per this interval, across every endpoint and symbol. */
const MIN_REQUEST_INTERVAL_MS = 350;
let nextSlot = 0;

function reserveSlot(): Promise<void> {
  const now = Date.now();
  const runAt = Math.max(now, nextSlot);
  nextSlot = runAt + MIN_REQUEST_INTERVAL_MS;
  const delay = runAt - now;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

/**
 * Response cache (PART 48's "do not repeatedly request the same corporate
 * action").
 *
 * Six hours: corporate-action calendars change slowly — an announcement made
 * this morning is still there this evening — and a scheduler running daily
 * plus a few manual refreshes should not cost more than a couple of calls per
 * endpoint per day. Process-local, so a restart re-warms it; that is
 * acceptable for a cache whose miss cost is one HTTP request.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown[] }>();

/** In-flight request dedupe: two callers asking for one URL share one fetch. */
const inflight = new Map<string, Promise<unknown[]>>();

const MAX_RETRIES = 3;

@Injectable()
export class FmpCorporateActionProvider implements CorporateActionProvider {
  readonly name = 'fmp';
  readonly tier: SourceTier = 'PRIMARY_API';

  readonly supports: ReadonlySet<CorporateActionType> = new Set<CorporateActionType>([
    'STOCK_SPLIT',
    'REVERSE_SPLIT',
    'DIVIDEND',
    'SPECIAL_DIVIDEND',
    'MERGER',
    'ACQUISITION',
    'TICKER_CHANGE',
  ]);

  private readonly logger = new Logger(FmpCorporateActionProvider.name);
  private readonly apiKey = process.env.FMP_API_KEY;

  async getCorporateActions(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const [splits, dividends, mergers, symbolChanges] = await Promise.all([
      this.getSplits(window),
      this.getDividends(window),
      this.getMergers(window),
      this.getSymbolChanges(window),
    ]);
    return [...splits, ...dividends, ...mergers, ...symbolChanges];
  }

  async getSplits(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const rows = await this.get(
      `splits-calendar?from=${iso(window.from)}&to=${iso(window.to)}`,
    );

    return rows.flatMap((row) => {
      const raw = row as Record<string, unknown>;
      const symbol = str(raw.symbol);
      if (!symbol) return [];

      const effectiveDate = date(raw.date);
      if (!effectiveDate) return [];

      /**
       * FMP reports splits as numerator/denominator in MARKET convention: a
       * 2-for-1 arrives as numerator 2, denominator 1. Converting through the
       * one shared helper is what keeps a 2-for-1 from being stored as a
       * halving — see ratioFromMarketConvention.
       */
      const numerator = num(raw.numerator);
      const denominator = num(raw.denominator);

      let ratio: { oldRatio: number; newRatio: number } | null = null;
      if (numerator !== null && denominator !== null) {
        try {
          ratio = ratioFromMarketConvention(numerator, denominator);
        } catch {
          ratio = null;
        }
      }
      ratio ??= parseRatioLabel(str(raw.label));

      if (!ratio) {
        this.logger.warn(`FMP split for ${symbol} on ${iso(effectiveDate)} had no usable ratio`);
        return [];
      }

      const isReverse = ratio.newRatio / ratio.oldRatio < 1;

      return [
        {
          symbol,
          company: str(raw.companyName) ?? null,
          market: marketForSymbol(symbol),
          actionType: (isReverse ? 'REVERSE_SPLIT' : 'STOCK_SPLIT') as CorporateActionType,
          // The split calendar's `date` is the ex-date, which for a split is
          // also when the new share count takes effect.
          exDate: effectiveDate,
          effectiveDate,
          recordDate: date(raw.recordDate),
          announcementDate: date(raw.announcementDate),
          oldRatio: ratio.oldRatio,
          newRatio: ratio.newRatio,
          source: this.name,
          tier: this.tier,
          sourceUrl: `${FMP_BASE}/splits-calendar?from=${iso(window.from)}&to=${iso(window.to)}`,
          sourceReference: `${symbol}:${iso(effectiveDate)}`,
        } satisfies NormalizedCorporateAction,
      ];
    });
  }

  async getDividends(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const rows = await this.get(
      `dividends-calendar?from=${iso(window.from)}&to=${iso(window.to)}`,
    );

    return rows.flatMap((row) => {
      const raw = row as Record<string, unknown>;
      const symbol = str(raw.symbol);
      const amount = num(raw.dividend) ?? num(raw.adjDividend);
      if (!symbol || amount === null) return [];

      const exDate = date(raw.date);
      if (!exDate) return [];

      /**
       * FMP does not distinguish special from regular dividends on this
       * endpoint. Everything is ingested as DIVIDEND; a reviewer reclassifies
       * where it matters. Guessing from the amount ("unusually large, must be
       * special") would be a heuristic dressed as data.
       */
      return [
        {
          symbol,
          market: marketForSymbol(symbol),
          actionType: 'DIVIDEND' as CorporateActionType,
          exDate,
          recordDate: date(raw.recordDate) ?? exDate,
          paymentDate: date(raw.paymentDate),
          declarationDate: date(raw.declarationDate),
          // A dividend takes effect on holdings the day it is paid.
          effectiveDate: date(raw.paymentDate) ?? exDate,
          cashAmount: amount,
          currency: marketForSymbol(symbol) === 'INDIA' ? 'INR' : 'USD',
          source: this.name,
          tier: this.tier,
          sourceUrl: `${FMP_BASE}/dividends-calendar?from=${iso(window.from)}&to=${iso(window.to)}`,
          sourceReference: `${symbol}:${iso(exDate)}`,
        } satisfies NormalizedCorporateAction,
      ];
    });
  }

  /**
   * FMP's M&A endpoint is gated on paid plans; on the free tier it returns
   * 402 and the shared `get` below turns that into an empty array. Mergers are
   * then entered by hand through the manual-entry endpoint, which is the
   * honest outcome — better than a stub that silently reports "no mergers".
   */
  async getMergers(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const rows = await this.get('mergers-acquisitions-latest?page=0&limit=100');

    return rows.flatMap((row) => {
      const raw = row as Record<string, unknown>;
      const symbol = str(raw.targetedSymbol) ?? str(raw.symbol);
      const acquirer = str(raw.symbol) ?? str(raw.acquirerSymbol);
      if (!symbol || !acquirer || symbol === acquirer) return [];

      const effectiveDate = date(raw.transactionDate) ?? date(raw.acceptedDate);
      if (!effectiveDate) return [];
      if (effectiveDate < window.from || effectiveDate > window.to) return [];

      return [
        {
          symbol,
          company: str(raw.targetedCompanyName) ?? null,
          market: marketForSymbol(symbol),
          actionType: 'ACQUISITION' as CorporateActionType,
          effectiveDate,
          announcementDate: date(raw.acceptedDate),
          newSymbol: acquirer,
          newCompany: str(raw.companyName) ?? null,
          // Terms are not in this payload; a reviewer supplies the exchange
          // ratio and cash before the action can pass validation.
          details: {},
          source: this.name,
          tier: this.tier,
          sourceUrl: str(raw.url) ?? `${FMP_BASE}/mergers-acquisitions-latest`,
          sourceReference: `${symbol}->${acquirer}:${iso(effectiveDate)}`,
        } satisfies NormalizedCorporateAction,
      ];
    });
  }

  async getSymbolChanges(window: FetchWindow): Promise<NormalizedCorporateAction[]> {
    const rows = await this.get('symbol-change?limit=100');

    return rows.flatMap((row) => {
      const raw = row as Record<string, unknown>;
      const oldSymbol = str(raw.oldSymbol);
      const newSymbol = str(raw.newSymbol);
      const effectiveDate = date(raw.date);

      if (!oldSymbol || !newSymbol || !effectiveDate) return [];
      if (oldSymbol === newSymbol) return [];
      if (effectiveDate < window.from || effectiveDate > window.to) return [];

      return [
        {
          symbol: oldSymbol,
          company: str(raw.companyName) ?? null,
          market: marketForSymbol(oldSymbol),
          actionType: 'TICKER_CHANGE' as CorporateActionType,
          effectiveDate,
          newSymbol,
          source: this.name,
          tier: this.tier,
          sourceUrl: `${FMP_BASE}/symbol-change`,
          sourceReference: `${oldSymbol}->${newSymbol}`,
        } satisfies NormalizedCorporateAction,
      ];
    });
  }

  /**
   * One cached, rate-limited, retrying GET.
   *
   * Returns [] on every failure path rather than throwing — see the interface
   * note on why a provider must never take the sweep down.
   */
  private async get(path: string): Promise<unknown[]> {
    if (!this.apiKey) {
      this.logger.warn('FMP_API_KEY is not set; corporate-action fetches are disabled.');
      return [];
    }

    const cached = cache.get(path);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    // Request deduplication: concurrent callers for one path share one fetch.
    const existing = inflight.get(path);
    if (existing) return existing;

    const request = this.fetchWithRetry(path)
      .then((value) => {
        cache.set(path, { at: Date.now(), value });
        return value;
      })
      .finally(() => inflight.delete(path));

    inflight.set(path, request);
    return request;
  }

  private async fetchWithRetry(path: string): Promise<unknown[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await reserveSlot();

      const sep = path.includes('?') ? '&' : '?';
      try {
        const response = await fetch(`${FMP_BASE}/${path}${sep}apikey=${this.apiKey}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        }

        /**
         * 402 is FMP's "your plan does not include this endpoint". Retrying
         * cannot help and would burn the rate limit, so it returns
         * immediately — the caller treats an empty result as "this source has
         * nothing", which for a gated endpoint is exactly true.
         */
        if (response.status === 402 || response.status === 403) {
          this.logger.warn(`FMP endpoint not available on this plan (${response.status}): ${path}`);
          return [];
        }

        // 429 and 5xx are transient: back off and retry.
        if (response.status === 429 || response.status >= 500) {
          const backoff = 2 ** attempt * 1000;
          this.logger.warn(
            `FMP ${response.status} on ${path}; retrying in ${backoff}ms ` +
              `(attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await sleep(backoff);
          continue;
        }

        this.logger.warn(`FMP request failed (${response.status}): ${path}`);
        return [];
      } catch (error) {
        const backoff = 2 ** attempt * 1000;
        this.logger.warn(
          `FMP request errored (${path}): ${(error as Error).message}; retrying in ${backoff}ms`,
        );
        if (attempt === MAX_RETRIES - 1) return [];
        await sleep(backoff);
      }
    }

    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Parses a provider date, returning null for anything unusable. */
function date(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
