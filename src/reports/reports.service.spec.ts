import { ReportsService } from './reports.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';

/**
 * These cover the things that decide what a client is actually charged: which
 * quarter a code resolves to, how many days of it are billable, and — since
 * fees moved onto deployed capital — that capital put to work mid-quarter is
 * billed only for the days it was at work.
 *
 * The proration bug class this guards against is the one that made a
 * mid-quarter read show "36 / 92" — correct for an estimate, wrong for a
 * closed quarter, which must always bill the full days it was open.
 *
 * Note the history mock now supplies the quarter's OPENING value rather than a
 * closing one: the fee prorates forward from the start of the quarter, so that
 * is the figure the service asks for.
 */
describe('ReportsService', () => {
  const clientRow = {
    id: 'c1',
    name: 'Hudson Family Office',
    feeRatePercent: 2,
    inceptionDate: new Date(Date.UTC(2026, 5, 30)), // 30 Jun 2026
    status: 'ACTIVE',
  };

  function build(overrides: {
    clients?: any[];
    stored?: any[];
    snapshot?: any;
    created?: any[];
    /** BUY/SELL rows inside the quarter. Default: an untraded book. */
    ledger?: any[];
  } = {}) {
    const created: any[] = overrides.created ?? [];

    const prisma = {
      client: { findMany: jest.fn().mockResolvedValue(overrides.clients ?? [clientRow]) },
      transaction: { findMany: jest.fn().mockResolvedValue(overrides.ledger ?? []) },
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

    it('bills the FULL quarter on an untraded book', async () => {
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

      // …and the first read freezes it, breakdown included.
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ quarter: 'Q3-CY26', feeAmount: row.feeAmount });
      expect(created[0].openingValue).toBe(1_200_000);
      expect(created[0].segments).toHaveLength(1);
    });

    /**
     * THE CASE THE PRORATION EXISTS FOR, at the service level.
     *
     * 500k deployed on 11 Sep is at work for 20 of the quarter's 92 days. The
     * old basis billed closing NAV flat and would have charged the full 2,500.
     */
    it('bills capital deployed mid-quarter only for the days it was at work', async () => {
      const { service } = build({
        ledger: [{ type: 'BUY', amount: 500_000, date: new Date(Date.UTC(2026, 8, 11)) }],
      });
      const [row] = await service.feesForQuarter('Q3-CY26');

      const opening = 1_200_000 * 0.005; // full quarter
      const deployed = 500_000 * 0.005 * (20 / 92); // 11–30 Sep inclusive

      expect(row.feeAmount).toBeCloseTo(opening + deployed, 6);
      expect(row.feeAmount).toBeLessThan(opening + 500_000 * 0.005);
      expect(row.openingValue).toBe(1_200_000);
      // The base charged against is opening + deployed capital.
      expect(row.portfolioValue).toBeCloseTo(1_700_000, 6);
      expect(row.segments.map((s) => s.kind)).toEqual(['opening', 'flow']);
    });

    it('does not bill the 1-July bulk-import artifacts as fresh deployment', async () => {
      const { service } = build({
        // The legacy book, imported as BUYs stamped 1 Jul — inside Q3.
        ledger: [{ type: 'BUY', amount: 1_200_000, date: new Date(Date.UTC(2026, 6, 1)) }],
      });
      const [row] = await service.feesForQuarter('Q3-CY26');

      // Charged once, on the opening value — not twice.
      expect(row.feeAmount).toBeCloseTo(6_000, 6);
      expect(row.segments).toHaveLength(1);
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

    it('falls back to reconstruction when no opening snapshot was written', async () => {
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
            openingValue: null,
            segments: null,
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

    /**
     * Rows frozen before segmented proration shipped carry no breakdown. They
     * must still READ — the invoice they represent was really issued — and
     * must not fabricate segments they were never billed on.
     */
    it('reads a pre-proration frozen row without inventing a breakdown', async () => {
      const { service } = build({
        stored: [
          {
            clientId: 'c1',
            quarter: 'Q3-CY26',
            quarterLabel: 'Q3 CY26',
            quarterStart: new Date(Date.UTC(2026, 6, 1)),
            quarterEnd: new Date(Date.UTC(2026, 8, 30)),
            feeRatePercent: 2,
            portfolioValue: 1_200_000,
            openingValue: null,
            segments: null,
            daysBilled: 92,
            daysInQuarter: 92,
            feeAmount: 6_000,
            valuationSource: 'snapshot',
          },
        ],
      });

      const [row] = await service.feesForQuarter('Q3-CY26');

      expect(row.feeAmount).toBe(6_000);
      expect(row.segments).toEqual([]);
      expect(row.openingValue).toBeNull();
    });
  });

  describe('feesForQuarter — open quarter', () => {
    it('bills only elapsed days and stores nothing', async () => {
      const { service, created } = build();
      jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 7, 5))); // 5 Aug 2026, mid-Q3

      try {
        const [row] = await service.feesForQuarter('Q3-CY26');

        expect(row.isEstimate).toBe(true);
        // 1 Jul – 5 Aug inclusive = 31 + 5 = 36 of 92 — the figure the desk saw.
        expect(row.daysBilled).toBe(36);
        expect(row.daysInQuarter).toBe(92);
        expect(row.feeAmount).toBeCloseTo(1_200_000 * 0.005 * (36 / 92), 6);
        expect(created).toHaveLength(0); // an open quarter is never frozen
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * An estimate must never bill days that have not happened. A buy made
     * today has worked for exactly one day, not for the rest of the quarter.
     */
    it('bills a deployment made today for a single day', async () => {
      const { service } = build({
        ledger: [{ type: 'BUY', amount: 500_000, date: new Date(Date.UTC(2026, 7, 5)) }],
      });
      jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 7, 5))); // 5 Aug

      try {
        const [row] = await service.feesForQuarter('Q3-CY26');

        const opening = 1_200_000 * 0.005 * (36 / 92);
        const deployed = 500_000 * 0.005 * (1 / 92);
        expect(row.feeAmount).toBeCloseTo(opening + deployed, 6);
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
