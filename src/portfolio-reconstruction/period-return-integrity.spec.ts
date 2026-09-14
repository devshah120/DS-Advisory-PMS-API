import { PerformanceBaselineService } from './performance-baseline.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ResolvedPeriod } from './periods';

/**
 * Two rules the Performance sheet's period return must obey, both pinned here
 * because both failed silently in production and neither is visible from a
 * reading of the number alone — a wrong return looks exactly like a right one.
 *
 *   1. The CLOSING VALUE is what the book is actually worth at the window's end.
 *      A stored snapshot that predates a trade must not be allowed to answer for
 *      that date.
 *
 *   2. The idle CASH BALANCE has no vote on any return. Setting it, adding to it
 *      or withdrawing from it must leave every reported figure untouched.
 */

const FROM = new Date('2026-07-16T00:00:00.000Z');
const TO = new Date('2026-09-14T00:00:00.000Z');

const PERIOD: ResolvedPeriod = {
  period: 'Q2-FY27',
  label: 'Q2 FY27 to date',
  from: FROM,
  to: TO,
  clampedToInception: false,
  daysClamped: 0,
  openPeriod: true,
};

describe('a snapshot may not outrank a trade booked after it', () => {
  /**
   * The exact production incident: the daily snapshot for 14-Sep ran at 16:00
   * and correctly recorded an empty book. The client's 59-share ANUP.NS
   * purchase was entered at 16:30. Because the snapshot was served
   * unconditionally, the closing value stayed 0 forever — the terminal flow
   * went in as zero, XIRR was handed an all-negative series it cannot solve,
   * and the sheet reported "Not available" on a book that had plainly traded.
   */
  const SNAPSHOT_WRITTEN = new Date('2026-09-14T16:00:41.930Z');
  const TRADE_ENTERED = new Date('2026-09-14T16:30:59.798Z');

  function build(opts: { snapshotDate: Date; today: Date }) {
    const staleSnapshot = {
      date: opts.snapshotDate,
      createdAt: SNAPSHOT_WRITTEN,
      securitiesValue: 0,
      cashValue: 0,
      totalValue: 0,
      totalCost: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      holdings: [] as Array<Record<string, unknown>>,
    };

    const prisma = {
      portfolioValuation: { findUnique: jest.fn().mockResolvedValue(staleSnapshot) },
      transaction: {
        // One BUY, dated inside the window but RECORDED after the snapshot.
        findFirst: jest.fn(async ({ where }: any) =>
          TRADE_ENTERED > where.createdAt.gt ? { id: 't1' } : null,
        ),
      },
    } as unknown as PrismaService;

    const reconstruction = {
      reconstruct: jest.fn().mockResolvedValue({
        holdingsValue: 98_353,
        portfolioValue: 98_353,
        positions: [{ ticker: 'ANUP.NS' }],
      }),
    } as unknown as PortfolioReconstructionService;

    const service = new PortfolioHistoryService(
      prisma,
      reconstruction,
      {} as unknown as BenchmarkHistoryService,
    );

    jest.useFakeTimers().setSystemTime(opts.today);
    return { service, reconstruction };
  }

  afterEach(() => jest.useRealTimers());

  it('replays rather than serving a snapshot the ledger has moved under', async () => {
    const { service, reconstruction } = build({
      snapshotDate: new Date('2026-09-14T00:00:00.000Z'),
      today: new Date('2026-09-20T09:00:00.000Z'),
    });

    const r = await service.getPortfolioAsOf('c1', new Date('2026-09-14T00:00:00.000Z'));

    expect(reconstruction.reconstruct).toHaveBeenCalled();
    expect(r.holdingsValue).toBe(98_353);
  });

  it('never trusts a snapshot for a day that has not closed yet', async () => {
    // Same day as the snapshot: more trades can still be booked against it and
    // prices are still moving, so it is a progress reading, not a settled one.
    const { service, reconstruction } = build({
      snapshotDate: new Date('2026-09-14T00:00:00.000Z'),
      today: new Date('2026-09-14T17:00:00.000Z'),
    });

    await service.getPortfolioAsOf('c1', new Date('2026-09-14T00:00:00.000Z'));

    expect(reconstruction.reconstruct).toHaveBeenCalled();
  });
});

describe('the cash balance has no vote on the return', () => {
  /**
   * Cash edits (CashFlowModal's set / add / withdraw) write `Client.cashBalance`
   * directly and never create a ledger row, so they can never appear in the flow
   * series. While the window's valuations included cash, that asymmetry was the
   * bug: the balance moved both ends of the window with no matching flow to
   * explain it, so XIRR solved it as performance — park cash and the book shows
   * a gain it did not earn.
   */
  function measure(cashAtBothEnds: number) {
    const portfolioAt = (holdings: number) => ({
      holdingsValue: holdings,
      portfolioValue: holdings + cashAtBothEnds,
    });

    const history = {
      getPortfolioAsOf: jest.fn(async (_c: string, date: Date) =>
        date.getTime() === FROM.getTime() ? portfolioAt(100_000) : portfolioAt(120_000),
      ),
    } as unknown as PortfolioHistoryService;

    const prisma = {
      client: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          benchmarkId: null,
          market: 'INDIA',
          cashBalance: cashAtBothEnds,
        }),
      },
      transaction: { findMany: jest.fn().mockResolvedValue([]) },
      portfolioBaseline: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    const benchmarkHistory = {
      windowReturn: jest.fn().mockResolvedValue(null),
    } as unknown as BenchmarkHistoryService;

    return new PerformanceBaselineService(prisma, history, benchmarkHistory).periodReturn(
      'c1',
      PERIOD,
    );
  }

  it('reports the same return whatever the cash balance is', async () => {
    const [none, some, lots] = await Promise.all([measure(0), measure(400_000), measure(5_000_000)]);

    expect(some.returnPct).toBeCloseTo(none.returnPct!, 12);
    expect(lots.returnPct).toBeCloseTo(none.returnPct!, 12);

    // And the same for every figure derived from it.
    expect(some.simpleReturnPct).toBeCloseTo(none.simpleReturnPct!, 12);
    expect(lots.annualizedReturnPct).toBeCloseTo(none.annualizedReturnPct!, 12);
  });

  it('measures the securities, so a 100k → 120k book returns 20% on the window', async () => {
    const r = await measure(400_000);

    expect(r.openingValue).toBe(100_000);
    expect(r.closingValue).toBe(120_000);
    expect(r.simpleReturnPct).toBeCloseTo(0.2, 12);
  });
});
