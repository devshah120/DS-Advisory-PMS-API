import { BadRequestException } from '@nestjs/common';
import { displaySymbol } from '../common/market-scope';
import { PriceStatus } from '../historical-price/historical-price.service';
import { ReconstructedPortfolio } from './types';

/**
 * The holdings statement as of a past date, for one account or a household.
 *
 * Built from PortfolioReconstructionService — the same replay Performance
 * values every period with — rather than from a second, simpler replay of its
 * own. The one the export used to run read BUY/SELL rows only, so a split or
 * bonus recorded by the Corporate Action Engine never reached it: the share
 * count stayed pre-split while the price was post-split, and the statement was
 * off by the ratio for every date after the action.
 */

/** Below this a replayed quantity is float dust from a full exit, not a holding. */
const CLOSED_POSITION_EPSILON = 1e-9;

export interface HoldingsAsOfPosition {
  ticker: string;
  /** Suffix stripped for display — 'RELIANCE.NS' reads as 'RELIANCE'. */
  displayTicker: string;
  company: string;
  sector: string;
  industry: string;
  quantity: number;
  /** Σ(qty × avgCost) ÷ Σ(qty) across accounts — never a mean of the accounts' averages. */
  averageCost: number;
  costBasis: number;
  /** The close the position is valued at. Equals marketValue ÷ quantity. */
  closingPrice: number;
  /** The session `closingPrice` is the close of; null when no price history exists. */
  priceDate: string | null;
  priceStatus: PriceStatus | 'missing';
  marketValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  /**
   * Percent (0–100) of the portfolio value INCLUDING cash — the denominator
   * every client report uses, so the positions and the cash line sum to 100%.
   */
  weight: number;
  /** How many accounts hold it. Always 1 for a single client. */
  accounts: number;
  holders: Array<{
    clientId: string;
    clientName: string;
    quantity: number;
    averageCost: number;
    marketValue: number;
  }>;
}

export interface HoldingsAsOf {
  /** YYYY-MM-DD. */
  asOfDate: string;
  currency: string;
  members: Array<{
    clientId: string;
    clientName: string;
    holdingsValue: number;
    cash: number;
    cashShortfall: number;
    portfolioValue: number;
  }>;
  positions: HoldingsAsOfPosition[];
  totals: {
    costBasis: number;
    marketValue: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    cash: number;
    /** Σ of the members' shortfalls — non-zero means the cash figure is a floor, not a balance. */
    cashShortfall: number;
    portfolioValue: number;
  };
  /**
   * Every position NOT valued at a verified close for the date: `stale` (the
   * best available price, older than the session it should be) or `missing`
   * (no price history; valued at cost). A statement that goes to a client must
   * say so for each of these rather than print them as market prices.
   */
  priceExceptions: Array<{
    ticker: string;
    displayTicker: string;
    priceDate: string | null;
    priceStatus: 'stale' | 'missing';
  }>;
}

export interface HoldingsAsOfMember {
  clientId: string;
  clientName: string;
  portfolio: ReconstructedPortfolio;
  /** Ticker → company name, from the account's Holding rows. A replay carries none. */
  companies: Map<string, string>;
}

const STATUS_RANK: Record<HoldingsAsOfPosition['priceStatus'], number> = {
  live: 0,
  close: 0,
  stale: 1,
  missing: 2,
};

/**
 * Parses the `YYYY-MM-DD` an as-of route receives, as midnight UTC of that day.
 *
 * Strict on shape because `new Date()` is not: it accepts '2026-6-3' and
 * '06/03/2026' and reads them in the server's local zone, which shifts the day
 * on a host that is not UTC. A day ahead of UTC today is allowed — that is
 * still today for an IST user after midnight local time — but nothing later,
 * since a future date has no close to value it at.
 */
export function parseAsOfDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${value} is not a calendar date.`);
  }

  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (date.getTime() > tomorrow) {
    throw new BadRequestException(`${value} is in the future — there is no closing price to value it at.`);
  }
  return date;
}

/**
 * Merges one or more accounts' reconstructed books into one statement.
 *
 * A single client is passed as a household of one, so the individual and the
 * family statements share every line of arithmetic below and cannot disagree
 * about how a figure is derived.
 */
export function buildHoldingsAsOf(
  asOfDate: Date,
  currency: string,
  members: HoldingsAsOfMember[],
): HoldingsAsOf {
  type Working = Omit<HoldingsAsOfPosition, 'averageCost' | 'closingPrice' | 'unrealizedPnLPercent' | 'weight'>;
  const merged = new Map<string, Working>();

  for (const m of members) {
    for (const p of m.portfolio.positions) {
      if (Math.abs(p.quantity) <= CLOSED_POSITION_EPSILON) continue;

      const status = p.priceStatus ?? 'missing';
      const cur: Working = merged.get(p.ticker) ?? {
        ticker: p.ticker,
        displayTicker: displaySymbol(p.ticker),
        company: m.companies.get(p.ticker) ?? displaySymbol(p.ticker),
        sector: p.sector || 'Unclassified',
        industry: p.industry || 'Unclassified',
        quantity: 0,
        costBasis: 0,
        priceDate: p.priceDate ?? null,
        priceStatus: status,
        marketValue: 0,
        unrealizedPnL: 0,
        accounts: 0,
        holders: [],
      };

      cur.quantity += p.quantity;
      cur.costBasis += p.costBasisTotal;
      cur.marketValue += p.marketValue;
      cur.unrealizedPnL += p.marketValue - p.costBasisTotal;
      cur.accounts += 1;
      // Every account resolves the same ticker on the same date to the same
      // close; the worst outcome is kept so one account's cost fallback can't
      // hide behind another's verified price.
      if (STATUS_RANK[status] > STATUS_RANK[cur.priceStatus]) {
        cur.priceStatus = status;
        cur.priceDate = p.priceDate ?? null;
      }
      if (cur.company === cur.displayTicker && m.companies.has(p.ticker)) {
        cur.company = m.companies.get(p.ticker)!;
      }
      cur.holders.push({
        clientId: m.clientId,
        clientName: m.clientName,
        quantity: p.quantity,
        averageCost: p.averageCost,
        marketValue: p.marketValue,
      });

      merged.set(p.ticker, cur);
    }
  }

  const marketValue = [...merged.values()].reduce((s, p) => s + p.marketValue, 0);
  // Summed per account, never per position — a balance counts once.
  const cash = members.reduce((s, m) => s + m.portfolio.cash, 0);
  const cashShortfall = members.reduce((s, m) => s + m.portfolio.cashShortfall, 0);
  const portfolioValue = marketValue + cash;

  const positions: HoldingsAsOfPosition[] = [...merged.values()]
    .map((p) => ({
      ...p,
      averageCost: p.quantity !== 0 ? p.costBasis / p.quantity : 0,
      closingPrice: p.quantity !== 0 ? p.marketValue / p.quantity : 0,
      unrealizedPnLPercent: p.costBasis !== 0 ? (p.unrealizedPnL / p.costBasis) * 100 : 0,
      weight: portfolioValue > 0 ? (p.marketValue / portfolioValue) * 100 : 0,
      holders: p.holders.sort((a, b) => b.marketValue - a.marketValue),
    }))
    .sort((a, b) => b.marketValue - a.marketValue);

  const costBasis = positions.reduce((s, p) => s + p.costBasis, 0);
  const unrealizedPnL = positions.reduce((s, p) => s + p.unrealizedPnL, 0);

  return {
    asOfDate: asOfDate.toISOString().slice(0, 10),
    currency,
    members: members.map((m) => ({
      clientId: m.clientId,
      clientName: m.clientName,
      holdingsValue: m.portfolio.holdingsValue,
      cash: m.portfolio.cash,
      cashShortfall: m.portfolio.cashShortfall,
      portfolioValue: m.portfolio.portfolioValue,
    })),
    positions,
    totals: {
      costBasis,
      marketValue,
      unrealizedPnL,
      unrealizedPnLPercent: costBasis !== 0 ? (unrealizedPnL / costBasis) * 100 : 0,
      cash,
      cashShortfall,
      portfolioValue,
    },
    priceExceptions: positions
      .filter((p) => p.priceStatus === 'stale' || p.priceStatus === 'missing')
      .map((p) => ({
        ticker: p.ticker,
        displayTicker: p.displayTicker,
        priceDate: p.priceDate,
        priceStatus: p.priceStatus as 'stale' | 'missing',
      })),
  };
}
