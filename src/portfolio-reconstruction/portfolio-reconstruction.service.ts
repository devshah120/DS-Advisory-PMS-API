import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BaselineService } from '../legacy-baseline/baseline.service';
import { HistoricalPriceService } from '../historical-price/historical-price.service';
import { allocationBy } from '../analytics/calculators/weights';
import { JUN30_REBASE_DATE, isImportArtifact, isHouseBaselineDate } from '../analytics/calculators/flows';
import { Classification, PortfolioSnapshot, Position } from '../analytics/calculators/types';
import { ReconstructedPortfolio, ReconstructedPosition } from './types';

interface WorkingPosition {
  ticker: string;
  quantity: number;
  /** Total cost basis, not per-share — updated on every BUY, untouched on SELL. */
  costBasisTotal: number;
  currency: string;
  sector: string;
  industry: string;
  country: string;
}

/**
 * Rebuilds a client's portfolio as of any date after its baseline, by
 * replaying every Transaction since the baseline onto BaselineHolding[].
 *
 * This is a pure read/compute service: it never writes to Transaction,
 * Holding, or anything else. PortfolioHistoryService is the layer that
 * decides whether to call this at all (it prefers a cached HoldingSnapshot
 * first) and the layer that persists this service's output.
 *
 * Country/asset/sector allocation reuse `allocationBy` from
 * analytics/calculators/weights.ts — the same function the live book
 * (SnapshotService) and PerformanceService use — so a reconstructed
 * portfolio's allocation math cannot drift from the live one; only the input
 * positions differ (replayed-as-of-date vs. current Holding rows).
 */
@Injectable()
export class PortfolioReconstructionService {
  constructor(
    private prisma: PrismaService,
    private baseline: BaselineService,
    private prices: HistoricalPriceService,
  ) {}

  async reconstruct(clientId: string, asOfDate: Date): Promise<ReconstructedPortfolio> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    /**
     * An account opened after tracking began never had a legacy position to
     * import, so it has no baseline and never will. That is not missing data —
     * its opening position is KNOWN, and it is nothing: no holdings, no cash.
     *
     * Standing in an empty baseline is what makes such an account
     * reconstructible on the ordinary path. Everything
     * below then works unchanged: the replay starts from zero positions and
     * zero cash and applies the account's real trades, so the day it buys its
     * first stock is the day it stops being worth nothing. Refusing instead
     * (the previous behaviour) took down every caller that has to value the
     * account — most visibly a FAMILY, where one such member threw and left the
     * whole household unmeasurable even though its correct contribution to the
     * opening total is simply zero.
     *
     * The synthetic baseline is dated at the house tracking date, NOT at the
     * account's `createdAt`. Using `createdAt` looks more precise and is the
     * wrong choice: it trips the pre-baseline guard below for any window that
     * opens before the account was created — exactly the common case, a
     * quarter already under way when the account joins — which would refuse the
     * very family measurement this change exists to allow. Anchoring at the
     * house date is also the truthful statement: on 30-June this account held
     * nothing, and so did every date between then and its first trade.
     */
    const baselineRow = (await this.baseline.findOrNull(clientId)) ?? {
      baselineDate: JUN30_REBASE_DATE,
      openingCash: 0,
      holdings: [] as Array<{
        ticker: string;
        quantity: number;
        averageCost: number;
        currency: string;
        sector: string;
        industry: string;
      }>,
    };

    if (asOfDate < baselineRow.baselineDate) {
      throw new BadRequestException(
        `Requested date ${asOfDate.toISOString().slice(0, 10)} is before the baseline date ` +
          `${baselineRow.baselineDate.toISOString().slice(0, 10)}. Nothing can be reconstructed ` +
          `before the baseline — history prior to it was not tracked.`,
      );
    }

    const positions = new Map<string, WorkingPosition>();
    for (const h of baselineRow.holdings) {
      positions.set(h.ticker, {
        ticker: h.ticker,
        quantity: h.quantity,
        costBasisTotal: h.quantity * h.averageCost,
        currency: h.currency,
        sector: h.sector,
        industry: h.industry,
        country: (h as { country?: string }).country ?? 'Unknown',
      });
    }

    let cash = baselineRow.openingCash;
    let realizedGain = 0;

    const ledger = await this.prisma.transaction.findMany({
      where: { clientId, date: { gt: baselineRow.baselineDate, lte: asOfDate } },
      orderBy: { date: 'asc' },
    });

    /**
     * Drop the bulk-import BUY rows before replaying.
     *
     * Those rows are stamped 2026-07-01 but describe positions the client already
     * held on 30 June — the import wrote the opening book as a day of trading. The
     * baseline loaded above ALREADY contains every one of those shares, so
     * replaying the BUYs adds nothing to `positions` that isn't there and simply
     * subtracts their cost from cash a second time. See `isImportArtifact`.
     *
     * Filtering here rather than in the Prisma `where` is deliberate: the query
     * stays a plain date-window read, and the one rule that decides what counts as
     * an import artifact lives in flows.ts next to the rebase that follows the same
     * convention — so the Current tab and this tab cannot disagree about which
     * rows are real trades.
     *
     * The filter is gated on whether THIS client's baseline is the shared
     * house baseline (`isHouseBaselineDate`), not just its date. A client
     * swept up in the original bulk import has a baseline dated exactly at
     * the house date, so the gate is true and their 2026-07-01 bulk-import
     * BUYs are correctly dropped as artifacts already represented by that
     * baseline's holdings.
     *
     * A client onboarded afterward with no legacy position has a distinct
     * baseline dated at their own first transaction — the gate is false, so
     * NOTHING is treated as an artifact for them, regardless of calendar
     * date. Using a date-only comparison here (e.g. "on or before the house
     * cutover") is the bug this replaced: a client whose real trading began
     * in December 2025, well before the house's 2026-07-01 import date,
     * would have every one of those genuine BUYs misclassified as import
     * artifacts and silently dropped — exactly what left a fully-invested
     * client's reconstructed book empty.
     */
    const replayable = ledger.filter(
      (t) => !isImportArtifact(t, isHouseBaselineDate(baselineRow.baselineDate)),
    );

    for (const t of replayable) {
      realizedGain += this.applyTransaction(positions, t, (delta) => (cash += delta));
    }

    const open = [...positions.values()].filter((p) => p.quantity !== 0);
    const closes = await this.prices.closesOn(
      open.map((p) => p.ticker),
      asOfDate,
    );
    const profiles = await this.profiles(clientId);

    const reconstructedPositions: ReconstructedPosition[] = [];
    let holdingsValue = 0;
    let totalCost = 0;
    let unrealizedGain = 0;

    for (const p of open) {
      const price = closes.get(p.ticker) ?? p.costBasisTotal / p.quantity;
      const marketValue = p.quantity * price;
      const averageCost = p.costBasisTotal / p.quantity;
      const gain = marketValue - p.costBasisTotal;

      holdingsValue += marketValue;
      totalCost += p.costBasisTotal;
      unrealizedGain += gain;

      reconstructedPositions.push({
        ticker: p.ticker,
        quantity: p.quantity,
        averageCost,
        closingPrice: price,
        marketValue,
        costBasisTotal: p.costBasisTotal,
        unrealizedGain: gain,
        // Classification comes from the profile/holding map, falling back to
        // whatever the replay carried. The replay seeds a position created by a
        // BUY with 'Unclassified' (it has only a ledger row, which has no
        // sector column), so preferring the map here is what stops an entire
        // Indian book reporting as 100% Unclassified.
        sector: profiles.get(p.ticker)?.sector ?? p.sector,
        industry: profiles.get(p.ticker)?.industry ?? p.industry,
        country: profiles.get(p.ticker)?.country ?? p.country ?? 'Unknown',
        assetClass: profiles.get(p.ticker)?.assetClass ?? 'EQUITY',
        weight: 0, // filled in below once portfolioValue is known
      });
    }

    /**
     * Never report a negative cash balance.
     *
     * With the import artifacts filtered out above, replayed cash should now track
     * the real maintained balance. A residual negative can still arise from a
     * genuine data gap — a SELL recorded without its matching BUY, say — and if it
     * reached the response it would understate `portfolioValue` and inflate every
     * position weight computed from it, which is the visible symptom this whole
     * change exists to remove.
     *
     * A negative buying-power balance is not a thing this book models: cash is
     * floored at zero and the shortfall is surfaced on `cashShortfall` so the gap
     * is reported rather than silently absorbed into the weights.
     */
    const cashShortfall = cash < 0 ? -cash : 0;
    if (cash < 0) cash = 0;

    const portfolioValue = holdingsValue + cash;
    for (const p of reconstructedPositions) {
      p.weight = portfolioValue > 0 ? p.marketValue / portfolioValue : 0;
    }

    const snap: PortfolioSnapshot = {
      clientId,
      clientName: client.name,
      asOf: asOfDate,
      baseCurrency: client.currency,
      cash,
      positions: reconstructedPositions.map((p) => this.toCalcPosition(p, profiles)),
    };

    return {
      clientId,
      asOfDate,
      baselineDate: baselineRow.baselineDate,
      cash,
      cashShortfall,
      holdingsValue,
      portfolioValue,
      totalCost,
      unrealizedGain,
      realizedGain,
      positions: reconstructedPositions,
      sectorAllocation: allocationBy(snap, 'sector'),
      countryAllocation: allocationBy(snap, 'country', { lookThrough: true }),
      assetAllocation: allocationBy(snap, 'assetClass'),
      source: 'reconstruction',
    };
  }

  /**
   * Mutates `positions` in place and returns the realized gain this single
   * transaction contributed (zero for anything that isn't a SELL). Cash is
   * reported back through the callback rather than returned, since callers
   * need to accumulate it alongside realized gain in the same loop.
   */
  private applyTransaction(
    positions: Map<string, WorkingPosition>,
    t: { ticker: string | null; type: string; quantity: number | null; price: number | null; amount: number },
    addCash: (delta: number) => void,
  ): number {
    switch (t.type) {
      case 'BUY': {
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        const cost = t.amount; // total cost of the buy
        if (existing) {
          existing.quantity += t.quantity;
          existing.costBasisTotal += cost;
        } else {
          positions.set(t.ticker, {
            ticker: t.ticker,
            quantity: t.quantity,
            costBasisTotal: cost,
            currency: 'USD',
            // A ledger row carries no classification. These are placeholders
            // only — the real sector/industry/country is attached from the
            // profile/holding map when the position is materialised (see
            // `profiles`), never left as written here.
            sector: 'Unclassified',
            industry: 'Unclassified',
            country: 'Unknown',
          });
        }
        addCash(-Math.abs(t.amount));
        return 0;
      }

      case 'SELL': {
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        addCash(Math.abs(t.amount));
        if (!existing || existing.quantity <= 0) return 0;

        // Average-cost accounting: realized gain is proceeds minus the cost
        // basis of the shares actually sold, at the position's average cost
        // per share *before* this sale — never the baseline's original
        // average cost, which may already have been diluted by prior BUYs.
        const avgCostPerShare = existing.costBasisTotal / existing.quantity;
        const soldQty = Math.min(t.quantity, existing.quantity);
        const costOfSold = avgCostPerShare * soldQty;

        existing.quantity -= soldQty;
        existing.costBasisTotal -= costOfSold;

        return Math.abs(t.amount) - costOfSold;
      }

      case 'DIVIDEND':
        addCash(Math.abs(t.amount));
        return 0;

      case 'FEES':
        addCash(-Math.abs(t.amount));
        return 0;

      case 'CASH_DEPOSIT':
        addCash(Math.abs(t.amount));
        return 0;

      case 'CASH_WITHDRAWAL':
        addCash(-Math.abs(t.amount));
        return 0;

      case 'SPLIT':
      case 'BONUS':
      case 'REVERSE_SPLIT':
      case 'SPINOFF':
      case 'MERGER':
      case 'ACQUISITION':
      case 'DELISTING_SETTLEMENT': {
        /**
         * Corporate actions change share count, not cash or cost basis total —
         * t.quantity here is the DELTA shares (matches how the Transactions
         * module already records a bonus/split entry, and how the Corporate
         * Action Engine's processors write every share-moving row).
         *
         * Negative deltas are expected and correct: a reverse split, a merger
         * closing the outgoing position, and a delisting all reduce the count.
         * A merger's incoming leg arrives as a separate positive row stamped
         * with the NEW ticker, which is why this one branch handles both sides
         * without needing to know which is which.
         *
         * Cost basis total is deliberately untouched for all of these. That is
         * what preserves the economic value of the position through a split
         * (200 shares at half the average cost is the same $10,000) and what
         * stops a corporate action manufacturing a return — see the Corporate
         * Action Engine's schema note.
         *
         * A row for a ticker this replay has not seen creates the position at
         * zero cost. That is the spin-off and merger case: the client received
         * shares they never bought, and until the issuer publishes a basis
         * allocation, zero is the honest figure rather than an invented one.
         */
        if (!t.ticker || !t.quantity) return 0;
        const existing = positions.get(t.ticker);
        if (existing) {
          existing.quantity += t.quantity;
        } else if (t.quantity > 0) {
          positions.set(t.ticker, {
            ticker: t.ticker,
            quantity: t.quantity,
            costBasisTotal: 0,
            currency: 'USD',
            sector: 'Unclassified',
            industry: 'Unclassified',
            country: 'Unknown',
          });
        }
        return 0;
      }

      case 'SPECIAL_DIVIDEND':
      case 'CASH_IN_LIEU':
        // Real money arriving, exactly like an ordinary DIVIDEND. Cash rises;
        // no shares move and no basis changes.
        addCash(Math.abs(t.amount));
        return 0;

      case 'RETURN_OF_CAPITAL':
        /**
         * Cash arrives AND the position's cost basis falls by the same amount
         * — the company is handing back capital, not paying income. Floored at
         * zero: once basis is exhausted the excess is a capital gain, which
         * needs tax-lot treatment the Corporate Action Engine flags for manual
         * handling rather than guessing at here.
         */
        addCash(Math.abs(t.amount));
        if (t.ticker) {
          const existing = positions.get(t.ticker);
          if (existing) {
            existing.costBasisTotal = Math.max(
              0,
              existing.costBasisTotal - Math.abs(t.amount),
            );
          }
        }
        return 0;

      case 'RIGHTS_SUBSCRIPTION': {
        // The client paid to take up rights: cash out, shares in at the
        // subscription price. This one IS a purchase in all but name.
        if (!t.ticker || !t.quantity) {
          addCash(-Math.abs(t.amount));
          return 0;
        }
        const existing = positions.get(t.ticker);
        if (existing) {
          existing.quantity += t.quantity;
          existing.costBasisTotal += Math.abs(t.amount);
        } else {
          positions.set(t.ticker, {
            ticker: t.ticker,
            quantity: t.quantity,
            costBasisTotal: Math.abs(t.amount),
            currency: 'USD',
            sector: 'Unclassified',
            industry: 'Unclassified',
            country: 'Unknown',
          });
        }
        addCash(-Math.abs(t.amount));
        return 0;
      }

      case 'TRANSFER':
        // Changes custody, not money or shares held for this reconstruction's
        // purposes — no cash, cost basis, or quantity effect.
        return 0;

      case 'RIGHTS_ENTITLEMENT':
      case 'TICKER_CHANGE':
      case 'CORPORATE_ACTION':
        /**
         * Deliberately inert.
         *
         * RIGHTS_ENTITLEMENT records an OPTION the client holds, not shares
         * they own — adding its figure to a quantity would invent a position.
         * TICKER_CHANGE is a relabelling with no economic content. Bare
         * CORPORATE_ACTION rows are explanatory (a basis reallocation note),
         * and any cash they carry is booked by the specific row beside them.
         *
         * Listed explicitly rather than falling through to `default` so that a
         * reader can see these were considered and are meant to do nothing.
         */
        return 0;

      default:
        return 0;
    }
  }

  /**
   * Ticker -> classification, from InstrumentProfile FIRST and the client's own
   * Holding rows second.
   *
   * InstrumentProfile is the canonical table, but it is populated only by the
   * workbook importer and so covers the US book alone — every Indian symbol is
   * absent from it. The Holding rows, by contrast, are written by
   * HoldingsService.create with the sector/industry/country Yahoo returned at
   * trade time, and those ARE correct for Indian tickers (AJANTPHARM.NS is
   * stored as Healthcare / India).
   *
   * Reconstruction previously read profiles only, so an Indian book resolved to
   * nothing and every position fell back to the hardcoded 'Unclassified' /
   * 'Unknown' that the replay seeds a new BUY with — which is why the whole
   * portfolio rendered as one 100% Unclassified bar. Falling back to the
   * holding row recovers the real classification without inventing one.
   *
   * Profiles still win where both exist: the profile carries assetClass and the
   * ETF lookThrough map, which a holding row has no column for.
   */
  private async profiles(clientId?: string): Promise<Map<string, Classification>> {
    const [rows, holdings] = await Promise.all([
      this.prisma.instrumentProfile.findMany(),
      clientId
        ? this.prisma.holding.findMany({ where: { clientId } })
        : Promise.resolve([] as Array<Record<string, any>>),
    ]);

    const map = new Map<string, Classification>();

    // Seed from holdings first so a real InstrumentProfile can overwrite it.
    for (const h of holdings) {
      map.set(h.ticker, {
        sector: h.sector || 'Unclassified',
        industry: h.industry || 'Unclassified',
        region: 'Unknown',
        country: h.country || 'Unknown',
        assetClass: 'EQUITY',
        lookThrough: null,
      });
    }

    for (const r of rows) {
      map.set(r.symbol, {
        sector: r.sector,
        industry: r.industry,
        region: r.region,
        country: r.country,
        assetClass: r.assetClass as Classification['assetClass'],
        lookThrough: (r.lookThrough as Classification['lookThrough']) ?? null,
      });
    }
    return map;
  }

  private toCalcPosition(p: ReconstructedPosition, profiles: Map<string, Classification>): Position {
    const classification: Classification = profiles.get(p.ticker) ?? {
      sector: p.sector || 'Unclassified',
      industry: p.industry || 'Unclassified',
      region: 'Unknown',
      country: p.country || 'Unknown',
      assetClass: 'EQUITY',
      lookThrough: null,
    };

    return {
      ticker: p.ticker,
      company: p.ticker,
      quantity: p.quantity,
      costBasis: p.averageCost,
      price: p.closingPrice,
      marketValue: p.marketValue,
      costBasisTotal: p.costBasisTotal,
      realizedPnl: 0,
      unrealizedPnl: p.unrealizedGain,
      dividends: 0,
      classification,
      targetWeight: null,
    };
  }
}
