import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { ReconstructedPortfolio } from './types';
import { Market } from '../common/market-scope';

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Reads and writes the historical snapshot store (PortfolioValuation +
 * HoldingSnapshot). This is the ONLY place that decides "cached row, or
 * reconstruct" (PART 7) — a caller (a future Reports export, a Performance
 * baseline lookup) never has to know which one actually answered it.
 *
 * Writing is always upsert-by-[clientId, date] plus a full
 * delete-and-reinsert of that date's HoldingSnapshot children, matching the
 * idempotent-and-safely-re-runnable convention PriceBar already uses
 * elsewhere in this codebase. A snapshot is immutable to *callers* (nothing
 * exposes an edit endpoint), but the write path itself must tolerate being
 * re-run — e.g. the scheduler retrying after a partial failure.
 */
@Injectable()
export class PortfolioHistoryService {
  private readonly logger = new Logger(PortfolioHistoryService.name);

  constructor(
    private prisma: PrismaService,
    private reconstruction: PortfolioReconstructionService,
    private benchmarkHistory: BenchmarkHistoryService,
  ) {}

  /** Exact-date lookup only — no fallback. Used by getPortfolioAsOf and PerformanceBaselineService. */
  async getSnapshot(clientId: string, date: Date) {
    return this.prisma.portfolioValuation.findUnique({
      where: { clientId_date: { clientId, date: utcDay(date) } },
      include: { holdings: true },
    });
  }

  /**
   * PART 7: snapshot-first, reconstruction-fallback, same output shape
   * either way — but only for a snapshot that is still ENTITLED to answer.
   *
   * A stored row is a cache of a replay, not an independent record, so it is
   * only as true as the ledger it was replayed from. Trusting it unconditionally
   * (the previous behaviour) meant a snapshot written at 16:00 permanently
   * outranked a trade booked at 16:30 for the same day — the row said the book
   * was empty, and it stayed empty forever no matter what was entered
   * afterwards. That is exactly how a client holding 59 ANUP.NS worth ~98,353
   * came to report a CLOSING VALUE OF ZERO, which in turn made the window's
   * terminal flow zero and left XIRR with an all-negative series it cannot
   * solve — the "Not available" return on a book that had plainly made a trade.
   *
   * So the snapshot is used only when nothing has been written since that could
   * change it. `isStale` asks that question against the ledger itself rather
   * than against a TTL: a date whose transactions all predate the snapshot is
   * genuinely settled and the cache is served, and any other date is replayed.
   * Correctness is restored without giving up the cache on the historical dates
   * it exists for.
   */
  async getPortfolioAsOf(clientId: string, date: Date): Promise<ReconstructedPortfolio> {
    const snapshot = await this.getSnapshot(clientId, date);
    if (snapshot && !(await this.isStale(clientId, snapshot))) {
      return this.fromSnapshotRow(clientId, snapshot);
    }
    return this.reconstruction.reconstruct(clientId, date);
  }

  /**
   * Has anything been recorded since this snapshot was taken that would change
   * what it says?
   *
   * Four independent reasons a row cannot be trusted:
   *
   *  1. **The day is not over.** A snapshot for today (or any future date) is a
   *     reading taken mid-session: more trades can still be booked against it,
   *     and prices are still moving. It is a progress figure, never a settled
   *     one, so it is always replayed.
   *
   *  2. **The ledger moved underneath it.** A transaction dated on or before the
   *     snapshot's date but CREATED after the snapshot was written was not seen
   *     by the replay that produced it. This catches the ordinary back-dated
   *     entry — a manager booking Thursday's trade on Monday — which is the
   *     common case on this desk and silently corrupted every window that
   *     touched the affected date.
   *
   *  3. **An entry was edited.** `createdAt` never moves when an existing row is
   *     corrected, so an insert-only check declares a snapshot fresh however
   *     much the ledger underneath it was rewritten. This is the gap that let a
   *     member holding three positions keep reporting the single one its
   *     snapshot was written from - a closing value of 96,583 against a real
   *     4,92,466 - because the other two trades arrived as edits to existing
   *     rows rather than as new ones. `updatedAt` is the matching question.
   *
   *  4. **An entry was deleted.** Neither timestamp exists to be compared once
   *     the row is gone, so this one is caught by reconciling the stored
   *     `ledgerCount` against a live count.
   *
   * `createdAt` is the right comparison on both sides of reasons 2 and 3: it is
   * when we LEARNED the fact, whereas `date` is when the fact happened, and
   * staleness is a question about knowledge, not about chronology. The
   * snapshot's own `createdAt` is preserved across upserts, so a re-run of the
   * daily job does not reset the window it compares against.
   */
  private async isStale(
    clientId: string,
    snapshot: { date: Date; createdAt: Date; ledgerCount: number | null },
  ): Promise<boolean> {
    const today = utcDay(new Date());
    if (utcDay(snapshot.date).getTime() >= today.getTime()) return true;

    // Reasons 2 and 3: an entry that appeared, or an existing entry that was
    // rewritten, after this snapshot was taken. `createdAt` alone answers only
    // the first question, and an EDIT leaves it untouched - which is how a
    // member holding GRAPHITE.NS, ANUP.NS and MBEL.NS kept reporting only the
    // single position its snapshot happened to be written from.
    const newerEntry = await this.prisma.transaction.findFirst({
      where: {
        clientId,
        date: { lte: snapshot.date },
        OR: [{ createdAt: { gt: snapshot.createdAt } }, { updatedAt: { gt: snapshot.createdAt } }],
      },
      select: { id: true },
    });

    if (newerEntry !== null) return true;

    /**
     * Reason 4: a row was DELETED. A deletion leaves nothing behind to compare
     * a timestamp against, so neither clause above can see it, and the count is
     * the only evidence left. `ledgerCount` is recorded at write time for
     * exactly this comparison; a snapshot whose stored count no longer matches
     * the ledger it claims to summarise is replayed.
     *
     * A row written before that column existed has a null count, which is not
     * evidence of agreement - it is the absence of evidence. Those are replayed
     * once and the fresh write records a count, so the cache re-earns its place
     * rather than being trusted on a field it never stored.
     */
    const ledgerCount = await this.prisma.transaction.count({
      where: { clientId, date: { lte: snapshot.date } },
    });

    return snapshot.ledgerCount !== ledgerCount;
  }

  /**
   * Builds and persists one day's snapshot for a client. Always reconstructs
   * — even for "today" — so the stored row and an on-demand reconstruction
   * for the same date can never disagree (they are, literally, produced by
   * the same code path).
   */
  async writeSnapshot(
    clientId: string,
    date: Date,
    opts: { isQuarterEnd?: boolean } = {},
  ): Promise<void> {
    const day = utcDay(date);
    const portfolio = await this.reconstruction.reconstruct(clientId, day);
    const benchmarkValue = await this.benchmarkValueFor(clientId, portfolio.baselineDate, day, portfolio);

    // Counted AFTER the replay above, so the stored count can only ever be
    // conservative: a row inserted between the two reads makes this snapshot
    // look stale on the next lookup and earns a replay, which is the safe
    // direction to be wrong in. See isStale.
    const ledgerCount = await this.prisma.transaction.count({
      where: { clientId, date: { lte: day } },
    });

    const valuation = await this.prisma.portfolioValuation.upsert({
      where: { clientId_date: { clientId, date: day } },
      create: {
        clientId,
        date: day,
        securitiesValue: portfolio.holdingsValue,
        cashValue: portfolio.cash,
        totalValue: portfolio.portfolioValue,
        totalCost: portfolio.totalCost,
        unrealizedPnL: portfolio.unrealizedGain,
        realizedPnL: portfolio.realizedGain,
        benchmarkValue,
        positionCount: portfolio.positions.length,
        ledgerCount,
        isQuarterEnd: opts.isQuarterEnd ?? false,
        source: 'snapshot-scheduler',
      },
      update: {
        securitiesValue: portfolio.holdingsValue,
        cashValue: portfolio.cash,
        totalValue: portfolio.portfolioValue,
        totalCost: portfolio.totalCost,
        unrealizedPnL: portfolio.unrealizedGain,
        realizedPnL: portfolio.realizedGain,
        benchmarkValue,
        positionCount: portfolio.positions.length,
        ledgerCount,
        // Re-running the daily job must not un-flag a quarter-end snapshot
        // that already ran for the same date; only turn it on, never off.
        isQuarterEnd: opts.isQuarterEnd ? true : undefined,
      },
    });

    // Idempotent child rewrite: drop and reinsert rather than diff, so a
    // retried run can never leave stale positions mixed with fresh ones.
    await this.prisma.holdingSnapshot.deleteMany({ where: { snapshotId: valuation.id } });

    if (portfolio.positions.length > 0) {
      await this.prisma.holdingSnapshot.createMany({
        data: portfolio.positions.map((p) => ({
          snapshotId: valuation.id,
          ticker: p.ticker,
          quantity: p.quantity,
          averageCost: p.averageCost,
          closingPrice: p.closingPrice,
          marketValue: p.marketValue,
          allocation: p.weight,
          sector: p.sector,
          industry: p.industry,
          country: p.country,
          assetClass: p.assetClass,
        })),
      });
    }

    this.logger.log(
      `Snapshot written: client=${clientId} date=${day.toISOString().slice(0, 10)} ` +
        `value=${portfolio.portfolioValue.toFixed(2)} quarterEnd=${opts.isQuarterEnd ?? false}`,
    );
  }

  /**
   * Benchmark units notionally bought at the baseline date with the
   * baseline's opening value, valued at this snapshot's date — gives every
   * stored snapshot its own "what if this had been the index instead"
   * comparison point without a live recompute later. Returns null (not an
   * error) when the client has no benchmark set or price coverage is
   * missing — a snapshot must still write successfully either way.
   */
  private async benchmarkValueFor(
    clientId: string,
    baselineDate: Date,
    snapshotDate: Date,
    portfolio: ReconstructedPortfolio,
  ): Promise<number | undefined> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return undefined;

    const baseline = await this.prisma.portfolioBaseline.findUnique({ where: { clientId } });
    const openingValue = baseline?.openingPortfolioValue ?? portfolio.portfolioValue;

    const value = await this.benchmarkHistory.notionalValue(
      undefined,
      client.benchmarkId,
      openingValue,
      baselineDate,
      snapshotDate,
      client.market as Market,
    );
    return value ?? undefined;
  }

  private fromSnapshotRow(
    clientId: string,
    row: Awaited<ReturnType<PortfolioHistoryService['getSnapshot']>>,
  ): ReconstructedPortfolio {
    if (!row) throw new Error('fromSnapshotRow called with a null row');

    const positions = row.holdings.map((h) => ({
      ticker: h.ticker,
      quantity: h.quantity,
      averageCost: h.averageCost,
      closingPrice: h.closingPrice,
      marketValue: h.marketValue,
      costBasisTotal: h.averageCost * h.quantity,
      unrealizedGain: h.marketValue - h.averageCost * h.quantity,
      sector: h.sector,
      industry: h.industry,
      country: h.country,
      assetClass: h.assetClass,
      weight: h.allocation,
    }));

    /**
     * Rows written before the import-artifact fix can carry a negative
     * `cashValue` (and a `totalValue` depressed by it). Apply the same floor the
     * live reconstruction applies, and recompute the total from its parts, so a
     * stale stored row cannot reintroduce the negative-cash weights through the
     * snapshot path — the two paths are supposed to be indistinguishable.
     */
    const cash = Math.max(0, row.cashValue);
    const cashShortfall = row.cashValue < 0 ? -row.cashValue : 0;
    const portfolioValue = row.securitiesValue + cash;

    // Cash is a real allocation line everywhere else in this codebase
    // (weights.ts#allocationBy) — included here too so a snapshot-served
    // breakdown matches a reconstructed one exactly, not just for holdings.
    const total = portfolioValue || 1;
    const group = (key: (p: (typeof positions)[number]) => string) => {
      const byKey = new Map<string, number>();
      for (const p of positions) byKey.set(key(p), (byKey.get(key(p)) ?? 0) + p.marketValue);
      if (cash > 0) byKey.set('Cash', (byKey.get('Cash') ?? 0) + cash);

      const slices = [...byKey.entries()]
        .map(([k, value]) => ({ key: k, value, weight: value / total }))
        .sort((a, b) => b.value - a.value);

      return { slices, denominator: 'TOTAL_ASSETS' as const, unclassifiedWeight: 0 };
    };

    return {
      clientId,
      asOfDate: row.date,
      baselineDate: row.date, // not tracked per-row; not needed for a snapshot-served read
      cash,
      cashShortfall,
      holdingsValue: row.securitiesValue,
      portfolioValue,
      totalCost: row.totalCost,
      unrealizedGain: row.unrealizedPnL,
      realizedGain: row.realizedPnL,
      positions,
      sectorAllocation: group((p) => p.sector),
      countryAllocation: group((p) => p.country),
      assetAllocation: group((p) => p.assetClass),
      source: 'snapshot',
    };
  }
}
