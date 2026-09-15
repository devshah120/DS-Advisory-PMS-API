import { PortfolioReconstructionService } from './portfolio-reconstruction.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { BaselineService } from '../legacy-baseline/baseline.service';
import { HistoricalPriceService } from '../historical-price/historical-price.service';

/**
 * An account opened AFTER 30-June-2026 has no Legacy Portfolio Baseline and
 * never will — there was no legacy position to import. Reconstruction used to
 * refuse it outright, which did not just fail that account's own page: it took
 * down every FAMILY containing it, because the household values each member at
 * both ends of the window and one throw aborted the whole figure.
 *
 * These pin the behaviour that replaced it — such an account reconstructs from
 * an empty opening position, so it is worth nothing until it actually trades.
 */
describe('PortfolioReconstructionService — account opened after the baseline date', () => {
  const CLIENT = 'c_new';

  function build(transactions: Array<Record<string, any>> = []) {
    const prisma = {
      client: {
        findUnique: jest.fn().mockResolvedValue({
          id: CLIENT,
          name: 'Meet Salecha',
          currency: 'INR',
          createdAt: new Date('2026-09-11T05:34:51.000Z'),
        }),
      },
      transaction: {
        findMany: jest.fn(async ({ where }: any) =>
          transactions.filter((t) => t.date > where.date.gt && t.date <= where.date.lte),
        ),
        // The synthetic baseline is anchored to the account's FIRST ledger row,
        // so the stand-in has to answer that question the way the real ledger
        // would: earliest transaction, or none at all.
        findFirst: jest.fn(async () => {
          const sorted = [...transactions].sort(
            (a, b) => a.date.getTime() - b.date.getTime(),
          );
          return sorted[0] ?? null;
        }),
      },
      instrumentProfile: { findMany: jest.fn().mockResolvedValue([]) },
      holding: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    // The account has no baseline row at all — the case under test.
    const baseline = { findOrNull: jest.fn().mockResolvedValue(null) } as unknown as BaselineService;

    const prices = {
      closesOn: jest.fn(async (tickers: string[]) => new Map(tickers.map((t) => [t, 150]))),
      closeOn: jest.fn().mockResolvedValue(150),
    } as unknown as HistoricalPriceService;

    return new PortfolioReconstructionService(prisma, baseline, prices);
  }

  it('reports an empty portfolio instead of throwing, before the account has traded', async () => {
    const service = build();

    const r = await service.reconstruct(CLIENT, new Date('2026-09-11T00:00:00.000Z'));

    expect(r.portfolioValue).toBe(0);
    expect(r.cash).toBe(0);
    expect(r.positions).toHaveLength(0);
  });

  /**
   * The window a family is actually measured over opens BEFORE such an account
   * existed. Dating the stand-in baseline at the account's own createdAt would
   * trip the pre-baseline guard here and re-break the household, so the opening
   * valuation has to answer zero rather than raise.
   */
  it('values as zero at a window that opens before the account was created', async () => {
    const service = build();

    const r = await service.reconstruct(CLIENT, new Date('2026-07-01T00:00:00.000Z'));

    expect(r.portfolioValue).toBe(0);
  });

  /**
   * Once it buys, it stops being worth nothing — the trades replay onto the
   * empty opening exactly as they would onto an imported one. This is the half
   * that keeps the fix honest: an empty baseline must not mean "always zero".
   */
  it('replays real trades on top of the empty opening position', async () => {
    const service = build([
      {
        id: 't1',
        clientId: CLIENT,
        type: 'BUY',
        ticker: 'TCS.NS',
        quantity: 10,
        amount: 1_400,
        date: new Date('2026-09-11T09:15:00.000Z'),
      },
    ]);

    const r = await service.reconstruct(CLIENT, new Date('2026-09-30T00:00:00.000Z'));

    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].ticker).toBe('TCS.NS');
    expect(r.positions[0].quantity).toBe(10);
    // 10 shares marked at the 150 close, and cash floored at zero rather than
    // going negative on a purchase the empty opening balance could not fund.
    expect(r.holdingsValue).toBe(1_500);
    expect(r.cash).toBe(0);
  });

  /**
   * THE PRE-CUTOVER ACCOUNT — the case that made this file's stand-in baseline
   * wrong rather than merely incomplete.
   *
   * A client can have no baseline row and still have traded for months BEFORE
   * the house cutover. Abhishek Oberoi did: 30 real transactions from Dec-2025,
   * no baseline. Anchoring the stand-in at the house date broke him twice over
   * —
   *
   *   1. the replay reads `date > baselineDate`, so every one of those rows
   *      fell outside the window and a fully-invested book valued at ZERO; and
   *   2. the stand-in date equalled the house baseline, so `isImportArtifact`
   *      discarded his genuine 1-July BUYs as bulk-import rows while keeping
   *      the SELLs beside them.
   *
   * Sales with no position to sell from drove the billable base NEGATIVE
   * (-68,441), which the fee floor then reported as a 0.00 fee on a live ~22L
   * book. Anchoring the stand-in to the account's first trade fixes both.
   */
  it('replays a book that began BEFORE the house cutover, and keeps its real pre-cutover buys', async () => {
    const service = build([
      {
        id: 'dec',
        clientId: CLIENT,
        type: 'BUY',
        ticker: 'CGCL.NS',
        quantity: 100,
        amount: 10_000,
        date: new Date('2025-12-18T00:00:00.000Z'),
      },
      {
        // Dated on the import cutover but a REAL trade: it must survive, because
        // this client's baseline is not the house baseline.
        id: 'jul',
        clientId: CLIENT,
        type: 'BUY',
        ticker: 'NLCINDIA.NS',
        quantity: 50,
        amount: 5_000,
        date: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);

    const r = await service.reconstruct(CLIENT, new Date('2026-09-15T00:00:00.000Z'));

    const tickers = r.positions.map((p) => p.ticker).sort();
    expect(tickers).toEqual(['CGCL.NS', 'NLCINDIA.NS']);
    // 150 positions worth: the December book survives the replay window AND the
    // 1-July buy survives the import-artifact filter.
    expect(r.holdingsValue).toBe(22_500);
  });

  /**
   * The guard that keeps the anchor from drifting later than the house date:
   * an account whose first trade is AFTER cutover keeps the house anchor, so
   * a window opening before it still answers zero instead of throwing.
   */
  it('keeps the house anchor for an account whose first trade is after cutover', async () => {
    const service = build([
      {
        id: 'aug',
        clientId: CLIENT,
        type: 'BUY',
        ticker: 'TCS.NS',
        quantity: 10,
        amount: 1_400,
        date: new Date('2026-08-20T00:00:00.000Z'),
      },
    ]);

    const r = await service.reconstruct(CLIENT, new Date('2026-06-30T00:00:00.000Z'));

    expect(r.portfolioValue).toBe(0);
    expect(r.positions).toHaveLength(0);
  });
});
