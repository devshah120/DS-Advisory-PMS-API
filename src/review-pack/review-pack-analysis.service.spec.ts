import { NotFoundException } from '@nestjs/common';
import { ReviewPackAnalysisService } from './review-pack-analysis.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { FamilyPerformanceService } from '../portfolio-reconstruction/family-performance.service';
import { BenchmarkHistoryService } from '../portfolio-reconstruction/benchmark-history.service';
import { ResolvedPeriod } from '../portfolio-reconstruction/periods';
import { Actor } from '../common/ownership-scope';
import { ReconstructedPosition } from '../portfolio-reconstruction/types';

const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };
const OWNING_MANAGER: Actor = { id: 'u_owner', role: 'PORTFOLIO_MANAGER' };
const OTHER_MANAGER: Actor = { id: 'u_other', role: 'PORTFOLIO_MANAGER' };

const FROM = new Date('2026-07-01T00:00:00.000Z');
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

function position(overrides: Partial<ReconstructedPosition>): ReconstructedPosition {
  return {
    ticker: 'X',
    quantity: 100,
    averageCost: 10,
    closingPrice: 10,
    marketValue: 1000,
    costBasisTotal: 1000,
    unrealizedGain: 0,
    sector: 'Financials',
    industry: '',
    country: 'IN',
    assetClass: 'EQUITY',
    weight: 0.1,
    ...overrides,
  };
}

function build(opts: {
  openPositions: ReconstructedPosition[];
  closePositions: ReconstructedPosition[];
  openValue: number;
  closeValue: number;
  txns?: Array<{ type: string; amount: number; ticker: string | null; date: Date }>;
  ownerId?: string | null;
}) {
  const prisma = {
    client: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'c1',
        name: 'Test Client',
        market: 'INDIA',
        currency: 'INR',
        ownerId: opts.ownerId ?? null,
        benchmarkId: null,
        accountingMethod: 'TRANSACTIONAL',
        includeDividends: true,
        includeFees: true,
      }),
    },
    transaction: {
      findMany: jest.fn().mockResolvedValue(opts.txns ?? []),
    },
    corporateActionLedger: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    family: {
      findUnique: jest.fn(),
    },
  } as unknown as PrismaService;

  const history = {
    getPortfolioAsOf: jest.fn(async (_clientId: string, date: Date) => {
      const isOpen = date.getTime() === FROM.getTime();
      return {
        portfolioValue: isOpen ? opts.openValue : opts.closeValue,
        positions: isOpen ? opts.openPositions : opts.closePositions,
        cash: isOpen ? opts.openValue - sum(opts.openPositions) : opts.closeValue - sum(opts.closePositions),
      };
    }),
  } as unknown as PortfolioHistoryService;

  const familyPerformance = {} as FamilyPerformanceService;

  const benchmarkHistory = {
    windowReturn: jest.fn().mockResolvedValue({ code: 'NIFTY50', name: 'Nifty 50', xirr: 0.06, interim: 0.06 }),
  } as unknown as BenchmarkHistoryService;

  return new ReviewPackAnalysisService(prisma, history, familyPerformance, benchmarkHistory);
}

function sum(positions: ReconstructedPosition[]): number {
  return positions.reduce((s, p) => s + p.marketValue, 0);
}

describe('ReviewPackAnalysisService', () => {
  // Test 11: contribution methodology, not raw stock return.
  it('ranks contributors by P&L contribution to the portfolio, not by the holding\'s own return', async () => {
    // Stock A: tiny position (0.5% weight opening) that doubled — huge % return, tiny P&L.
    // Stock B: large position (40% weight opening) that returned 10% — smaller % return, huge P&L.
    const openA = position({ ticker: 'A', marketValue: 5000, weight: 0.005 });
    const closeA = position({ ticker: 'A', marketValue: 10000, weight: 0.01 });
    const openB = position({ ticker: 'B', marketValue: 400000, weight: 0.4 });
    const closeB = position({ ticker: 'B', marketValue: 440000, weight: 0.42 });

    const service = build({
      openPositions: [openA, openB],
      closePositions: [closeA, closeB],
      openValue: 1000000,
      closeValue: 1044000,
    });

    const analysis = await service.analyse('client', 'c1', PERIOD, SUPER_ADMIN);

    expect(analysis.topContributors[0].symbol).toBe('B');
    expect(analysis.topContributors[0].portfolioContributionPct).toBeCloseTo(40000 / 1000000, 5);

    // A's contribution is real but tiny relative to the portfolio; it must not
    // outrank B merely because A's own percentage return (100%) is bigger.
    const aRow = analysis.topContributors.find((c) => c.symbol === 'A');
    if (aRow) {
      expect(aRow.portfolioContributionPct).toBeLessThan(analysis.topContributors[0].portfolioContributionPct);
    }
  });

  it('detects a new position above the materiality threshold', async () => {
    const openPositions: ReconstructedPosition[] = [];
    const closePositions = [position({ ticker: 'NEW', marketValue: 20000, weight: 0.02 })];

    const service = build({ openPositions, closePositions, openValue: 1000000, closeValue: 1020000 });
    const analysis = await service.analyse('client', 'c1', PERIOD, SUPER_ADMIN);

    expect(analysis.newPositions.map((p) => p.symbol)).toContain('NEW');
  });

  it('does not flag a new position below the 1% materiality threshold', async () => {
    const openPositions: ReconstructedPosition[] = [];
    const closePositions = [position({ ticker: 'TINY', marketValue: 2000, weight: 0.002 })];

    const service = build({ openPositions, closePositions, openValue: 1000000, closeValue: 1002000 });
    const analysis = await service.analyse('client', 'c1', PERIOD, SUPER_ADMIN);

    expect(analysis.newPositions.map((p) => p.symbol)).not.toContain('TINY');
  });

  // Test 5 (data-quality side): no measurable return → LOW quality, no fabricated 0%.
  it('marks data quality LOW and does not fabricate a return when opening value is zero', async () => {
    const service = build({ openPositions: [], closePositions: [], openValue: 0, closeValue: 0 });
    const analysis = await service.analyse('client', 'c1', PERIOD, SUPER_ADMIN);

    expect(analysis.portfolioReturnPct).toBeNull();
    expect(analysis.dataQuality).toBe('LOW');
  });

  // Tests 1/2: the analysis service must pass the CLIENT'S OWN market through
  // to BenchmarkHistoryService rather than defaulting or hard-coding one —
  // the resolver itself (tested in benchmark-resolution.spec.ts) is what
  // actually picks Nifty 50 vs S&P 500, but this is the one place a bug could
  // silently stop passing the right market and reintroduce the old defect.
  it('passes the client\'s own market through to the benchmark resolver', async () => {
    const service = build({ openPositions: [], closePositions: [], openValue: 1000000, closeValue: 1000000 });
    await service.analyse('client', 'c1', PERIOD, SUPER_ADMIN);

    const benchmarkHistory = (service as any).benchmarkHistory as BenchmarkHistoryService;
    expect(benchmarkHistory.windowReturn).toHaveBeenCalledWith(
      undefined,
      null,
      expect.any(Array),
      expect.any(Date),
      'INDIA',
    );
  });

  // Ownership boundary: a manager cannot pull another manager's client into a
  // review pack. 404, never 403 — see common/ownership-scope.ts's
  // existence-disclosure rationale, followed exactly here.
  it('returns NotFound (not Forbidden) when a manager who does not own the client tries to analyse it', async () => {
    const service = build({
      openPositions: [],
      closePositions: [],
      openValue: 1000000,
      closeValue: 1000000,
      ownerId: OWNING_MANAGER.id,
    });

    await expect(service.analyse('client', 'c1', PERIOD, OTHER_MANAGER)).rejects.toThrow(NotFoundException);
  });

  it('allows the owning manager to analyse their own client', async () => {
    const service = build({
      openPositions: [],
      closePositions: [],
      openValue: 1000000,
      closeValue: 1000000,
      ownerId: OWNING_MANAGER.id,
    });

    await expect(service.analyse('client', 'c1', PERIOD, OWNING_MANAGER)).resolves.toBeDefined();
  });
});
