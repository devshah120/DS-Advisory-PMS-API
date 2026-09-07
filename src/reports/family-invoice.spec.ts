import { ReportsService } from './reports.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { Actor } from '../common/ownership-scope';

const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };

/** Q3 CY26 is Jul–Sep 2026; "today" inside it makes the quarter open. */
const IN_Q3 = new Date(Date.UTC(2026, 8, 7)); // 07 Sep 2026
const QUARTER_END = new Date(Date.UTC(2026, 8, 30));

interface MemberSpec {
  id: string;
  name: string;
  feeRatePercent: number;
  marketValue: number;
  inceptionDate: Date;
  status?: string;
}

function build(members: MemberSpec[], opts: { familyMarket?: string } = {}) {
  const clientRows = members.map((m) => ({
    id: m.id,
    name: m.name,
    feeRatePercent: m.feeRatePercent,
    inceptionDate: m.inceptionDate,
    status: m.status ?? 'ACTIVE',
    currency: 'INR',
    market: opts.familyMarket ?? 'INDIA',
    holdings: [{ marketValue: m.marketValue }],
  }));

  const prisma = {
    family: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fam1',
        name: 'Salecha Family',
        market: opts.familyMarket ?? 'INDIA',
        ownerId: null,
        clients: members.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status ?? 'ACTIVE',
          inceptionDate: m.inceptionDate,
        })),
      }),
    },
    client: {
      // feesForQuarter filters ACTIVE itself via the where clause; mirror that.
      findMany: jest.fn().mockResolvedValue(clientRows.filter((c) => c.status === 'ACTIVE')),
    },
    clientFeeSchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => data),
    },
  } as unknown as PrismaService;

  const history = {
    getSnapshot: jest.fn().mockResolvedValue(null),
    getPortfolioAsOf: jest.fn().mockResolvedValue({ portfolioValue: 0 }),
  } as unknown as PortfolioHistoryService;

  return { service: new ReportsService(prisma, history), prisma };
}

/** The Salecha household as it appears in the live book. */
const SALECHA: MemberSpec[] = [
  { id: 'c1', name: 'Prashant Salecha', feeRatePercent: 1.5, marketValue: 9_73_307.88, inceptionDate: new Date(Date.UTC(2026, 6, 16)) },
  { id: 'c2', name: 'Prashant Salecha HUF', feeRatePercent: 1.5, marketValue: 25_32_606.56, inceptionDate: new Date(Date.UTC(2026, 7, 11)) },
  { id: 'c3', name: 'Meena Salecha', feeRatePercent: 1.5, marketValue: 19_56_602.47, inceptionDate: new Date(Date.UTC(2026, 6, 16)) },
  { id: 'c4', name: 'Ratandevi Salecha', feeRatePercent: 1.5, marketValue: 3_97_512.17, inceptionDate: new Date(Date.UTC(2026, 6, 16)) },
];

describe('ReportsService.familyInvoice', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(IN_Q3);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists every member account as its own invoice line', async () => {
    const { service } = build(SALECHA);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.familyName).toBe('Salecha Family');
    expect(inv.totals.memberCount).toBe(4);
    expect(inv.totals.billedCount).toBe(4);
    expect(inv.lines.map((l) => l.clientName)).toEqual([
      'Meena Salecha',
      'Prashant Salecha',
      'Prashant Salecha HUF',
      'Ratandevi Salecha',
    ]);
  });

  /**
   * The guarantee the whole design rests on: the household bill is the sum of
   * the very rows the individual statements are built from, so the two
   * documents cannot disagree.
   */
  it('totals exactly the sum of the members own fee rows', async () => {
    const { service } = build(SALECHA);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);
    const perClient = await Promise.all(
      SALECHA.map((m) => service.clientFee(m.id, 'Q3-CY26', SUPER_ADMIN)),
    );

    const summed = perClient.reduce((s, r) => s + r.feeAmount, 0);
    expect(inv.totals.feeAmount).toBeCloseTo(summed, 10);

    // And line-by-line, not merely in aggregate.
    for (const line of inv.lines) {
      const own = perClient.find((r) => r.clientId === line.clientId)!;
      expect(line.feeAmount).toBeCloseTo(own.feeAmount, 10);
      expect(line.portfolioValue).toBeCloseTo(own.portfolioValue, 10);
      expect(line.daysBilled).toBe(own.daysBilled);
    }
  });

  /** Each account keeps its own rate — no blended household rate is applied. */
  it('bills each account at its own annual rate', async () => {
    const { service } = build([
      { id: 'c1', name: 'A', feeRatePercent: 1.5, marketValue: 1_000_000, inceptionDate: new Date(Date.UTC(2026, 5, 30)) },
      { id: 'c2', name: 'B', feeRatePercent: 2.0, marketValue: 1_000_000, inceptionDate: new Date(Date.UTC(2026, 5, 30)) },
    ]);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.lines.find((l) => l.clientName === 'A')!.feeRatePercent).toBe(1.5);
    expect(inv.lines.find((l) => l.clientName === 'B')!.feeRatePercent).toBe(2.0);
    // Equal values, different rates → B pays exactly a third more than A.
    const a = inv.lines.find((l) => l.clientName === 'A')!.feeAmount;
    const b = inv.lines.find((l) => l.clientName === 'B')!.feeAmount;
    expect(b / a).toBeCloseTo(2.0 / 1.5, 8);
  });

  /**
   * Members are prorated individually, so an account that joined mid-quarter
   * pays for the days it existed — not the household's longest tenure.
   */
  it('prorates each member by its own inception date', async () => {
    const { service } = build(SALECHA);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    const huf = inv.lines.find((l) => l.clientName === 'Prashant Salecha HUF')!;
    const meena = inv.lines.find((l) => l.clientName === 'Meena Salecha')!;
    // The HUF's mandate began 11 Aug, Meena's 16 Jul — fewer billed days.
    expect(huf.daysBilled).toBeLessThan(meena.daysBilled);
  });

  /**
   * A household bill that quietly omits an account still looks complete, and
   * the client is least able to detect it. The omission must be on the invoice.
   */
  it('names a member that was not billable rather than dropping it', async () => {
    const { service } = build([
      ...SALECHA,
      {
        id: 'c5',
        name: 'Newcomer Salecha',
        feeRatePercent: 1.5,
        marketValue: 500_000,
        // Mandate begins after Q3 ended — genuinely not billable for it.
        inceptionDate: new Date(Date.UTC(2026, 10, 1)),
      },
    ]);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.totals.memberCount).toBe(5);
    expect(inv.totals.billedCount).toBe(4);
    expect(inv.unbilled).toHaveLength(1);
    expect(inv.unbilled[0].clientName).toBe('Newcomer Salecha');
    expect(inv.unbilled[0].reason).toMatch(/after this quarter ended/i);
  });

  it('explains an inactive mandate as inactive, not as a date problem', async () => {
    const { service } = build([
      ...SALECHA,
      {
        id: 'c6',
        name: 'Closed Account',
        feeRatePercent: 1.5,
        marketValue: 0,
        inceptionDate: new Date(Date.UTC(2026, 5, 30)),
        status: 'INACTIVE',
      },
    ]);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.unbilled.map((u) => u.clientName)).toEqual(['Closed Account']);
    expect(inv.unbilled[0].reason).toMatch(/inactive/i);
  });

  /**
   * Back-solved against the value-weighted proration, not the raw value — else
   * a household billed for half the quarter reports half its true rate.
   */
  it('reports an effective rate that recovers a uniform members rate', async () => {
    const { service } = build([
      { id: 'c1', name: 'A', feeRatePercent: 1.5, marketValue: 1_000_000, inceptionDate: new Date(Date.UTC(2026, 7, 15)) },
      { id: 'c2', name: 'B', feeRatePercent: 1.5, marketValue: 4_000_000, inceptionDate: new Date(Date.UTC(2026, 5, 30)) },
    ]);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    // Both on 1.5% despite very different billed days — the effective rate must
    // come back to 1.5%, not to something diluted by the proration.
    expect(inv.totals.effectiveAnnualRatePercent).toBeCloseTo(1.5, 6);
  });

  it('sums the portfolio value the fee was actually charged on', async () => {
    const { service } = build(SALECHA);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    const expected = SALECHA.reduce((s, m) => s + m.marketValue, 0);
    expect(inv.totals.portfolioValue).toBeCloseTo(expected, 6);
  });

  /** An open quarter is an estimate, and the invoice must say so. */
  it('marks an in-progress quarter as an estimate', async () => {
    const { service } = build(SALECHA);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.isEstimate).toBe(true);
    expect(inv.lines.every((l) => l.isEstimate)).toBe(true);
  });

  it('marks a closed quarter as final', async () => {
    const { service } = build(SALECHA);
    jest.setSystemTime(new Date(Date.UTC(2026, 10, 15))); // Nov — Q3 has closed

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.isEstimate).toBe(false);
  });

  /** A family lives in one book; the invoice is denominated in that book. */
  it('denominates the invoice in the family own book currency', async () => {
    const { service } = build(SALECHA, { familyMarket: 'INDIA' });

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.currency).toBe('INR');
    expect(inv.market).toBe('INDIA');
  });

  it('scopes the fee run to the family own market, not the viewer selection', async () => {
    const { service, prisma } = build(SALECHA, { familyMarket: 'INDIA' });

    await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    const where = (prisma.client.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.market).toBe('INDIA');
  });

  it('handles a household with nothing billable without producing a zero bill', async () => {
    const { service } = build([
      {
        id: 'c1',
        name: 'Future Account',
        feeRatePercent: 1.5,
        marketValue: 100_000,
        inceptionDate: new Date(Date.UTC(2026, 11, 1)),
      },
    ]);

    const inv = await service.familyInvoice('fam1', 'Q3-CY26', SUPER_ADMIN);

    expect(inv.lines).toHaveLength(0);
    expect(inv.totals.feeAmount).toBe(0);
    expect(inv.totals.effectiveAnnualRatePercent).toBeNull();
    expect(inv.unbilled).toHaveLength(1);
  });
});
