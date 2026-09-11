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
});
