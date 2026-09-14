import { FamilyPerformanceService } from './family-performance.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';
import { BenchmarkHistoryService } from './benchmark-history.service';
import { ResolvedPeriod } from './periods';
import { Actor } from '../common/ownership-scope';
import { xirr } from '../analytics/calculators/xirr';

/**
 * A Super Admin keeps the ownership guard satisfied without the mocked family
 * needing an owner, so these stay focused on the arithmetic. The boundary
 * itself is covered by ownership-scope.spec.ts.
 */
const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };

const FROM = new Date('2026-06-30T00:00:00.000Z');
const TO = new Date('2026-09-30T00:00:00.000Z');

const PERIOD: ResolvedPeriod = {
  period: 'Q2-FY27',
  label: 'Q2 FY27',
  from: FROM,
  to: TO,
  clampedToInception: false,
  daysClamped: 0,
  openPeriod: false,
};

interface MemberSpec {
  id: string;
  name: string;
  opening: number;
  closing: number;
  createdAt?: Date;
  /** Real cash flows inside the window, as [date, type, amount]. */
  flows?: Array<[Date, 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL', number]>;
}

function build(members: MemberSpec[]) {
  const prisma = {
    family: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fam1',
        name: 'Salecha Family',
        market: 'INDIA',
        ownerId: null,
        clients: members.map((m) => ({
          id: m.id,
          name: m.name,
          createdAt: m.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
          benchmarkId: null as string | null,
        })),
      }),
    },
    transaction: {
      findMany: jest.fn(async ({ where }: any) => {
        const m = members.find((x) => x.id === where.clientId);
        return (m?.flows ?? []).map(([date, type, amount]) => ({ date, type, amount }));
      }),
    },
    portfolioBaseline: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;

  const history = {
    getPortfolioAsOf: jest.fn(async (clientId: string, date: Date) => {
      const m = members.find((x) => x.id === clientId)!;
      const value = date.getTime() === FROM.getTime() ? m.opening : m.closing;
      // These fixtures describe fully-invested members holding no idle cash, so
      // the two figures coincide. Both are supplied because the engine measures
      // return on `holdingsValue` alone — a cash balance must never move a
      // reported return — while `portfolioValue` remains what the household is
      // WORTH. A stub that set only one would silently test the wrong one.
      return { portfolioValue: value, holdingsValue: value };
    }),
  } as unknown as PortfolioHistoryService;

  const benchmarkHistory = {
    windowReturn: jest.fn().mockResolvedValue(null),
  } as unknown as BenchmarkHistoryService;

  return {
    service: new FamilyPerformanceService(prisma, history, benchmarkHistory),
    benchmarkHistory,
  };
}

describe('FamilyPerformanceService.periodReturn', () => {
  it('sums the household opening and closing values across members', async () => {
    const { service } = build([
      { id: 'c1', name: 'Prashant', opening: 100_000, closing: 110_000 },
      { id: 'c2', name: 'Meena', opening: 300_000, closing: 330_000 },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.openingValue).toBe(400_000);
    expect(r.closingValue).toBe(440_000);
    expect(r.memberCount).toBe(2);
  });

  /**
   * The claim the whole service rests on. Two accounts with identical returns
   * but very different sizes must give a household return equal to that same
   * figure — a size-weighted result, not an unweighted mean of member rates.
   */
  it('solves ONE xirr over the combined flows rather than averaging member returns', async () => {
    const { service } = build([
      { id: 'c1', name: 'Small', opening: 10_000, closing: 11_000 },
      { id: 'c2', name: 'Large', opening: 990_000, closing: 1_089_000 },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    // Both accounts returned exactly 10%, so the household must too.
    expect(r.returnPct).toBeCloseTo(0.1, 6);
    // And it must equal a single solve over the summed endpoints.
    const direct = xirr([
      { date: FROM, amount: -1_000_000 },
      { date: TO, amount: 1_100_000 },
    ]);
    const days = Math.round((TO.getTime() - FROM.getTime()) / 86_400_000);
    const expected =
      direct.status === 'ok' ? (1 + direct.rate) ** (days / 365) - 1 : null;
    expect(r.returnPct).toBeCloseTo(expected!, 9);
  });

  /**
   * The case a weighted-average implementation gets visibly wrong: a small
   * account with a huge return must not drag the household up as though it
   * held the family's money.
   */
  it('does not let a tiny account with a large return distort the household', async () => {
    const { service } = build([
      // +100% on ₹1,000 — spectacular, and almost irrelevant to the family.
      { id: 'c1', name: 'Tiny', opening: 1_000, closing: 2_000 },
      // Flat on ₹999,000.
      { id: 'c2', name: 'Bulk', opening: 999_000, closing: 999_000 },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    // A plain mean of member returns would report ~+50%. The truth is +0.1%.
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.returnPct!).toBeLessThan(0.002);
  });

  /**
   * An internal transfer between two member accounts is not a household flow:
   * the family neither gained nor lost money by moving it, so the two legs must
   * cancel and the household return must be unaffected.
   */
  it('nets an internal transfer between members to zero', async () => {
    const mid = new Date('2026-08-15T00:00:00.000Z');
    const { service } = build([
      {
        id: 'c1',
        name: 'From',
        opening: 500_000,
        closing: 300_000,
        flows: [[mid, 'CASH_WITHDRAWAL', 250_000]],
      },
      {
        id: 'c2',
        name: 'To',
        opening: 500_000,
        closing: 800_000,
        flows: [[mid, 'CASH_DEPOSIT', 250_000]],
      },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.netFlows).toBeCloseTo(0, 6);
    // Household went 1,000,000 → 1,100,000 with no external money: +10%.
    expect(r.returnPct).toBeCloseTo(0.1, 6);
  });

  /**
   * The user's stated rule: an account that joins mid-window is added "from its
   * own date to date", with the family still treated as one account. Its
   * arriving balance is capital, not performance.
   */
  it('treats an account that joins mid-window as capital arriving on its entry date', async () => {
    const joined = new Date('2026-09-01T00:00:00.000Z');
    const { service } = build([
      { id: 'c1', name: 'Existing', opening: 1_000_000, closing: 1_100_000 },
      { id: 'c2', name: 'Newcomer', opening: 0, closing: 500_000, createdAt: joined },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.lateEntrants).toEqual([
      { clientId: 'c2', clientName: 'Newcomer', entryDate: joined },
    ]);
    // The newcomer's 500,000 is a deposit, so it is NOT counted as gain.
    expect(r.netFlows).toBeCloseTo(500_000, 6);
    // The household gained 100,000 on 1,000,000 — the newcomer's balance
    // arriving must not inflate that to +60%.
    expect(r.closingValue - r.openingValue - r.netFlows).toBeCloseTo(100_000, 6);
    expect(r.returnPct!).toBeLessThan(0.2);
    expect(r.returnPct!).toBeGreaterThan(0);
  });

  it('marks a late entrant as unmeasurable standalone without dropping it from the household', async () => {
    const joined = new Date('2026-09-01T00:00:00.000Z');
    const { service } = build([
      { id: 'c1', name: 'Existing', opening: 1_000_000, closing: 1_100_000 },
      { id: 'c2', name: 'Newcomer', opening: 0, closing: 500_000, createdAt: joined },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    const newcomer = r.members.find((m) => m.clientId === 'c2')!;
    expect(newcomer.returnPct).toBeNull();
    expect(newcomer.returnReason).toBe('Joined the household during this period');
    // Still present, and still counted in the household's closing value.
    expect(r.memberCount).toBe(2);
    expect(r.closingValue).toBe(1_600_000);
  });

  /**
   * The member table's reconciling column. Returns do not sum; gains do, and
   * the UI tells the reader so — this pins the claim the UI makes.
   */
  it('member gains sum to the household gain', async () => {
    const { service } = build([
      { id: 'c1', name: 'A', opening: 100_000, closing: 120_000 },
      { id: 'c2', name: 'B', opening: 200_000, closing: 190_000 },
      { id: 'c3', name: 'C', opening: 50_000, closing: 55_000 },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    const summed = r.members.reduce((s, m) => s + m.gain, 0);
    expect(summed).toBeCloseTo(r.closingValue - r.openingValue - r.netFlows, 6);
  });

  it('reports member weights against the household closing value', async () => {
    const { service } = build([
      { id: 'c1', name: 'A', opening: 100_000, closing: 250_000 },
      { id: 'c2', name: 'B', opening: 100_000, closing: 750_000 },
    ]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.members.find((m) => m.clientId === 'c1')!.weight).toBeCloseTo(0.25, 6);
    expect(r.members.find((m) => m.clientId === 'c2')!.weight).toBeCloseTo(0.75, 6);
  });

  /**
   * One index for the household, priced on the household's own flows — the
   * construction that makes alpha a like-for-like spread.
   */
  it('prices the benchmark on the household flow series, not per member', async () => {
    const { service, benchmarkHistory } = build([
      { id: 'c1', name: 'A', opening: 400_000, closing: 440_000 },
      { id: 'c2', name: 'B', opening: 600_000, closing: 660_000 },
    ]);

    await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(benchmarkHistory.windowReturn).toHaveBeenCalledTimes(1);
    const flows = (benchmarkHistory.windowReturn as jest.Mock).mock.calls[0][2];
    // Opening leg is the COMBINED household value, not either member's.
    expect(flows[0].amount).toBeCloseTo(-1_000_000, 6);
    expect(flows[flows.length - 1].amount).toBeCloseTo(1_100_000, 6);
  });

  it('measures a one-member family exactly as that member alone', async () => {
    const { service } = build([{ id: 'c1', name: 'Solo', opening: 500_000, closing: 550_000 }]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.returnPct).toBeCloseTo(r.members[0].returnPct!, 9);
  });

  it('reports an empty household as unmeasurable rather than as zero', async () => {
    const { service } = build([]);

    const r = await service.periodReturn('fam1', PERIOD, SUPER_ADMIN);

    expect(r.returnPct).toBeNull();
    expect(r.memberCount).toBe(0);
    expect(r.returnReason).toMatch(/no member accounts/i);
  });
});
