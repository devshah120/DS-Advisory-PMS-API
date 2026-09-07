import { BadRequestException } from '@nestjs/common';
import { ClassificationService } from './classification.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor } from '../common/ownership-scope';
import { isUnclassified, normalizeSector, SECTORS } from '../common/sectors';

const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };

interface HoldingSpec {
  ticker: string;
  company?: string;
  sector: string;
  quantity: number;
  currentPrice: number;
  clientId: string;
  clientName: string;
  market?: string;
}

function build(holdings: HoldingSpec[]) {
  const rows = holdings.map((h, i) => ({
    id: `h${i}`,
    ticker: h.ticker,
    company: h.company ?? h.ticker,
    sector: h.sector,
    industry: 'Unclassified',
    country: 'India',
    exchange: 'NSE',
    quantity: h.quantity,
    currentPrice: h.currentPrice,
    client: { id: h.clientId, name: h.clientName, market: h.market ?? 'INDIA' },
  }));

  const updateMany = jest.fn(async ({ where }: any) => ({
    count: rows.filter((r) => r.ticker === where.ticker).length,
  }));
  const upsert = jest.fn(async (args: any) => args);

  const prisma = {
    holding: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.ticker === where.ticker) ?? null),
      updateMany,
    },
    instrumentProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert,
    },
  } as unknown as PrismaService;

  return { service: new ClassificationService(prisma), upsert, updateMany };
}

describe('sectors vocabulary', () => {
  it('treats every provider placeholder as unclassified', () => {
    for (const v of ['', '   ', 'Unclassified', 'uncategorized', 'UNKNOWN', 'n/a', '-']) {
      expect(isUnclassified(v)).toBe(true);
    }
    expect(isUnclassified('Healthcare')).toBe(false);
  });

  /**
   * The defect this guards: a hand-typed 'healthcare' next to Yahoo's
   * 'Healthcare' would render as two separate pie wedges that look like
   * different sectors.
   */
  it('normalises case onto the canonical spelling', () => {
    expect(normalizeSector('healthcare')).toBe('Healthcare');
    expect(normalizeSector('  FINANCIAL SERVICES ')).toBe('Financial Services');
    expect(normalizeSector('Miscellaneous')).toBe('Miscellaneous');
  });

  it('rejects anything outside the vocabulary', () => {
    expect(normalizeSector('Pharma')).toBeNull();
    expect(normalizeSector('Unclassified')).toBeNull();
    expect(normalizeSector('')).toBeNull();
  });

  /** Miscellaneous must be offered, since it is the deliberate escape hatch. */
  it('offers Miscellaneous as a real choice', () => {
    expect(SECTORS).toContain('Miscellaneous');
  });
});

describe('ClassificationService.queue', () => {
  it('groups unclassified positions by symbol across accounts', async () => {
    const { service } = build([
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 1200, currentPrice: 98.45, clientId: 'c1', clientName: 'Radhika' },
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 800, currentPrice: 98.45, clientId: 'c2', clientName: 'Abhishek' },
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 400, currentPrice: 98.45, clientId: 'c3', clientName: 'Keyur' },
    ]);

    const q = await service.queue(SUPER_ADMIN);

    // One decision to make, not three.
    expect(q.totals.symbolCount).toBe(1);
    expect(q.symbols[0].symbol).toBe('SAHAJSOLAR.NS');
    expect(q.symbols[0].quantity).toBe(2400);
    expect(q.symbols[0].holders).toHaveLength(3);
  });

  it('excludes already-classified holdings', async () => {
    const { service } = build([
      { ticker: 'RELIANCE.NS', sector: 'Energy', quantity: 100, currentPrice: 1000, clientId: 'c1', clientName: 'A' },
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 400, currentPrice: 906.3, clientId: 'c1', clientName: 'A' },
    ]);

    const q = await service.queue(SUPER_ADMIN);

    expect(q.symbols.map((s) => s.symbol)).toEqual(['REMUS-SM.NS']);
  });

  /**
   * The weight must answer "how much of the book is unlabelled" — a share of
   * the WHOLE book, not of the unclassified subset (which is always 100%).
   */
  it('weights unclassified exposure against the whole book', async () => {
    const { service } = build([
      { ticker: 'RELIANCE.NS', sector: 'Energy', quantity: 900, currentPrice: 1000, clientId: 'c1', clientName: 'A' },
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 100, currentPrice: 1000, clientId: 'c1', clientName: 'A' },
    ]);

    const q = await service.queue(SUPER_ADMIN);

    expect(q.totals.weight).toBeCloseTo(0.1, 6);
    expect(q.symbols[0].weight).toBeCloseTo(0.1, 6);
  });

  it('orders the queue by exposure so the biggest gap is worked first', async () => {
    const { service } = build([
      { ticker: 'SMALL.NS', sector: 'Unclassified', quantity: 10, currentPrice: 100, clientId: 'c1', clientName: 'A' },
      { ticker: 'BIG.NS', sector: 'Unclassified', quantity: 1000, currentPrice: 100, clientId: 'c1', clientName: 'A' },
    ]);

    const q = await service.queue(SUPER_ADMIN);

    expect(q.symbols.map((s) => s.symbol)).toEqual(['BIG.NS', 'SMALL.NS']);
  });

  it('ignores closed positions, which need no decision', async () => {
    const { service } = build([
      { ticker: 'SOLD.NS', sector: 'Unclassified', quantity: 0, currentPrice: 100, clientId: 'c1', clientName: 'A' },
    ]);

    const q = await service.queue(SUPER_ADMIN);

    expect(q.symbols).toHaveLength(0);
  });

  it('offers the sector vocabulary alongside the queue', async () => {
    const { service } = build([]);
    const q = await service.queue(SUPER_ADMIN);
    expect(q.sectors).toContain('Miscellaneous');
    expect(q.sectors).toContain('Healthcare');
  });
});

describe('ClassificationService.setSector', () => {
  /**
   * The core claim: the decision is written to the profile with reviewedAt set,
   * which is what stops the nightly provider sync reverting it.
   */
  it('writes the decision to InstrumentProfile as a reviewed manual record', async () => {
    const { service, upsert } = build([
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 1200, currentPrice: 98.45, clientId: 'c1', clientName: 'Radhika' },
    ]);

    await service.setSector('SAHAJSOLAR.NS', 'Utilities', SUPER_ADMIN);

    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0];
    expect(args.where).toEqual({ symbol: 'SAHAJSOLAR.NS' });
    expect(args.create.sector).toBe('Utilities');
    expect(args.create.source).toBe('manual');
    expect(args.create.reviewedAt).toBeInstanceOf(Date);
    expect(args.update.reviewedAt).toBeInstanceOf(Date);
  });

  /** One decision must cover every account holding the symbol. */
  it('refreshes every holding row of that symbol, across accounts', async () => {
    const { service, updateMany } = build([
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 1200, currentPrice: 98, clientId: 'c1', clientName: 'Radhika' },
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 800, currentPrice: 98, clientId: 'c2', clientName: 'Abhishek' },
      { ticker: 'SAHAJSOLAR.NS', sector: 'Unclassified', quantity: 400, currentPrice: 98, clientId: 'c3', clientName: 'Keyur' },
    ]);

    const r = await service.setSector('SAHAJSOLAR.NS', 'Utilities', SUPER_ADMIN);

    expect(r.holdingsUpdated).toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data).toEqual({ sector: 'Utilities' });
  });

  it('normalises a differently-cased sector onto the canonical spelling', async () => {
    const { service, upsert } = build([
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 400, currentPrice: 906, clientId: 'c1', clientName: 'A' },
    ]);

    const r = await service.setSector('REMUS-SM.NS', 'healthcare', SUPER_ADMIN);

    expect(r.sector).toBe('Healthcare');
    expect(upsert.mock.calls[0][0].create.sector).toBe('Healthcare');
  });

  it('accepts Miscellaneous as a deliberate decision', async () => {
    const { service } = build([
      { ticker: 'ODD.NS', sector: 'Unclassified', quantity: 10, currentPrice: 100, clientId: 'c1', clientName: 'A' },
    ]);

    const r = await service.setSector('ODD.NS', 'Miscellaneous', SUPER_ADMIN);

    expect(r.sector).toBe('Miscellaneous');
  });

  it('rejects a sector outside the vocabulary rather than opening a new wedge', async () => {
    const { service } = build([
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 400, currentPrice: 906, clientId: 'c1', clientName: 'A' },
    ]);

    await expect(service.setSector('REMUS-SM.NS', 'Pharma', SUPER_ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * The profile row is firm-wide, so classifying a symbol the actor does not
   * hold would be a write into a book they cannot see.
   */
  it('refuses to classify a symbol the actor does not hold', async () => {
    const { service } = build([
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 400, currentPrice: 906, clientId: 'c1', clientName: 'A' },
    ]);

    await expect(
      service.setSector('SOMEONE-ELSES.NS', 'Healthcare', SUPER_ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uppercases the symbol so casing cannot fork the profile row', async () => {
    const { service, upsert } = build([
      { ticker: 'REMUS-SM.NS', sector: 'Unclassified', quantity: 400, currentPrice: 906, clientId: 'c1', clientName: 'A' },
    ]);

    await service.setSector('  remus-sm.ns  ', 'Healthcare', SUPER_ADMIN);

    expect(upsert.mock.calls[0][0].where).toEqual({ symbol: 'REMUS-SM.NS' });
  });
});
