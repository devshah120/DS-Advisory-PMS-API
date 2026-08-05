import { ReportsService } from './reports.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';

/**
 * These cover the two things that decide what a client is actually charged:
 * which quarter a code resolves to, and how many days of it are billable.
 * The proration bug class this guards against is the one that made a
 * mid-quarter read show "36 / 92" — correct for an estimate, wrong for a
 * closed quarter, which must always bill the full days it was open.
 */
describe('ReportsService', () => {
  const clientRow = {
    id: 'c1',
    name: 'Hudson Family Office',
    feeRatePercent: 2,
    inceptionDate: new Date(Date.UTC(2026, 5, 30)), // 30 Jun 2026
    status: 'ACTIVE',
    holdings: [{ marketValue: 1_000_000 }],
  };

  function build(overrides: {
    clients?: any[];
    stored?: any[];
    snapshot?: any;
    created?: any[];
  } = {}) {
    const created: any[] = overrides.created ?? [];

    const prisma = {
      client: { findMany: jest.fn().mockResolvedValue(overrides.clients ?? [clientRow]) },
      clientFeeSchedule: {
        findMany: jest.fn().mockResolvedValue(overrides.stored ?? []),
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    } as unknown as PrismaService;

    const history = {
      getSnapshot: jest.fn().mockResolvedValue(
        overrides.snapshot === undefined ? { totalValue: 1_200_000 } : overrides.snapshot,
      ),
      getPortfolioAsOf: jest.fn().mockResolvedValue({ portfolioValue: 1_150_000 }),
    } as unknown as PortfolioHistoryService;

    return { service: new ReportsService(prisma, history), prisma, history, created };
  }

  describe('availableQuarters', () => {
    it('lists every quarter from inception to today, newest first', () => {
      const { service } = build();
      const quarters = service.availableQuarters(new Date(Date.UTC(2026, 10, 15))); // Nov 2026 → Q4

      expect(quarters.map((q) => q.code)).toEqual(['Q4-CY26', 'Q3-CY26', 'Q2-CY26']);
      // Only the quarter containing "today" is still open.
      expect(quarters.map((q) => q.closed)).toEqual([false, true, true]);
    });

    it('spans year boundaries', () => {
      const { service } = build();
      const codes = service
        .availableQuarters(new Date(Date.UTC(2027, 1, 10))) // Feb 2027 → Q1 CY27
        .map((q) => q.code);

      expect(codes).toEqual(['Q1-CY27', 'Q4-CY26', 'Q3-CY26', 'Q2-CY26']);
    });
  });

  describe('feesForQuarter — closed quarter', () => {
    // Q3 CY26 only counts as closed once the calendar has passed 30 Sep, so
    // these run on a fixed clock rather than whatever "today" happens to be.
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 10, 15))); // 15 Nov 2026
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('bills the FULL quarter and values it on the quarter-end snapshot', async () => {
      const { service, created } = build();
      const rows = await service.feesForQuarter('Q3-CY26');

      expect(rows).toHaveLength(1);
      const [row] = rows;

      // Q3 = Jul+Aug+Sep = 31+31+30 = 92 days, all billable (inception 30 Jun
      // precedes the quarter), NOT the 36 a mid-quarter estimate would show.
      expect(row.daysInQuarter).toBe(92);
      expect(row.daysBilled).toBe(92);
      expect(row.isEstimate).toBe(false);
      expect(row.valuationSource).toBe('snapshot');
      expect(row.portfolioValue).toBe(1_200_000);
      // 1.2m * (2% / 4) * (92/92) = 6,000
      expect(row.feeAmount).toBeCloseTo(6_000, 6);

      // …and the first read freezes it.
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ quarter: 'Q3-CY26', feeAmount: row.feeAmount });
    });

    it('prorates a mandate that began mid-quarter', async () => {
      const { service } = build({
        clients: [{ ...clientRow, inceptionDate: new Date(Date.UTC(2026, 7, 1)) }], // 1 Aug
      });
      const [row] = await service.feesForQuarter('Q3-CY26');

      // 1 Aug–30 Sep inclusive = 31 + 30 = 61 days of 92.
      expect(row.daysBilled).toBe(61);
      expect(row.feeAmount).toBeCloseTo(1_200_000 * 0.005 * (61 / 92), 6);
    });

    it('falls back to reconstruction when no quarter-end snapshot was written', async () => {
      const { service } = build({ snapshot: null });
      const [row] = await service.feesForQuarter('Q3-CY26');

      expect(row.valuationSource).toBe('reconstruction');
      expect(row.portfolioValue).toBe(1_150_000);
    });

    it('omits a client whose mandate began after the quarter ended', async () => {
      const { service } = build({
        clients: [{ ...clientRow, inceptionDate: new Date(Date.UTC(2026, 11, 1)) }], // Dec
      });
      expect(await service.feesForQuarter('Q3-CY26')).toHaveLength(0);
    });
  });

  describe('feesForQuarter — stored rows are authoritative', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 10, 15)));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the frozen figure even after the client rate changes', async () => {
      const { service, created } = build({
        // Client rate has since been renegotiated 2% -> 1%.
        clients: [{ ...clientRow, feeRatePercent: 1 }],
        stored: [
          {
            clientId: 'c1',
            quarter: 'Q3-CY26',
            quarterLabel: 'Q3 CY26',
            quarterStart: new Date(Date.UTC(2026, 6, 1)),
            quarterEnd: new Date(Date.UTC(2026, 8, 30)),
            feeRatePercent: 2, // what was actually billed
            portfolioValue: 1_200_000,
            daysBilled: 92,
            daysInQuarter: 92,
            feeAmount: 6_000,
            valuationSource: 'snapshot',
          },
        ],
      });

      const [row] = await service.feesForQuarter('Q3-CY26');

      expect(row.feeRatePercent).toBe(2);
      expect(row.feeAmount).toBe(6_000);
      expect(row.isEstimate).toBe(false);
      // An already-frozen quarter must never be re-written.
      expect(created).toHaveLength(0);
    });
  });

  describe('feesForQuarter — open quarter', () => {
    it('estimates on live value, bills only elapsed days, and stores nothing', async () => {
      const { service, created } = build();
      jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 7, 5))); // 5 Aug 2026, mid-Q3

      try {
        const [row] = await service.feesForQuarter('Q3-CY26');

        expect(row.isEstimate).toBe(true);
        expect(row.valuationSource).toBe('live');
        expect(row.portfolioValue).toBe(1_000_000); // live holdings, not the snapshot
        // 1 Jul – 5 Aug inclusive = 31 + 5 = 36 of 92 — the figure the desk saw.
        expect(row.daysBilled).toBe(36);
        expect(row.daysInQuarter).toBe(92);
        expect(created).toHaveLength(0); // an open quarter is never frozen
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('rejects a malformed quarter code', async () => {
    const { service } = build();
    await expect(service.feesForQuarter('2026-Q3')).rejects.toThrow(/Unknown quarter/);
  });
});
