import { parseContractNote, UnrecognisedStatementError } from './contract-note.parser';
import { ContractNoteService } from './contract-note.service';
import { TextItem } from './pdf-text';

/**
 * A Kotak Neo statement page, laid out the way pdfjs reports the real one:
 * x/y from the bottom-left, the header on two lines, and narrow cells wrapping
 * a long ISIN or name onto extra lines around the row's centre.
 */
const t = (str: string, x: number, y: number, width = str.length * 4): TextItem => ({ str, x, y, width });

const HEADER: TextItem[] = [
  t('Trade Date', 22, 560, 36),
  t('Time', 32, 552, 16),
  t('Security', 80, 560, 28),
  t('Name', 84, 552, 20),
  t('ISIN', 140, 556, 14),
  t('Exchange', 184, 556, 33),
  t('Transaction', 234, 560, 40),
  t('Type', 245, 552, 16),
  t('Product', 294, 560, 26),
  t('Type', 299, 552, 16),
  t('Order', 350, 560, 19),
  t('Source', 348, 552, 24),
  t('Quantity', 399, 556, 28),
  t('Market Rate', 447, 556, 40),
  t('Total', 512, 556, 17),
  t('Charges', 559, 556, 28),
];

function row(
  y: number,
  r: { date: string; time: string; name: string[]; isin: string[]; side: string; qty: string; rate: string; total: string; charges: string },
): TextItem[] {
  return [
    t(r.date, 18, y + 4, 35),
    t(r.time, 18, y - 4, 29),
    ...r.name.map((n, i) => t(n, 72, y + 8 - i * 8, 45)),
    ...r.isin.map((s, i) => t(s, 125, y + 4 - i * 8, s.length * 4)),
    t('NSE', 193, y, 17),
    t(r.side, 232, y, 15),
    t('Cash', 285, y, 18),
    t('Kotak Neo', 338, y, 36),
    t(r.qty, 435 - r.qty.length * 4, y, r.qty.length * 4),
    t(r.rate, 456, y, 34),
    t(r.total, 509, y, 34),
    t(r.charges, 574, y, 20),
  ];
}

const MBEL = {
  date: '26/10/2026', time: '10:04:53', name: ['M & B', 'Engineering', 'Ltd'],
  isin: ['INE08N60101', '5'], side: 'Buy', qty: '220', rate: '253.2680', total: '55718.96', charges: '76.21',
};
const AXIS = {
  date: '27/10/2026', time: '14:20:00', name: ['Axis Bank Ltd'],
  isin: ['INE238A01034'], side: 'Sell', qty: '40', rate: '1226.7950', total: '49071.80', charges: '67.11',
};

describe('parseContractNote — Kotak Neo layout', () => {
  it('rebuilds wrapped ISINs and names from their fragments', () => {
    const note = parseContractNote([[...HEADER, ...row(526, MBEL), ...row(496, AXIS)]],
      'Transaction_Statement_V8FSU_20261026_20261027 (1).pdf');

    expect(note).toMatchObject({ broker: 'Kotak Neo', clientCode: 'V8FSU', periodFrom: '2026-10-26', errors: [] });
    expect(note.trades).toHaveLength(2);
    expect(note.trades[0]).toMatchObject({
      tradeDate: '2026-10-26', tradeTime: '10:04:53', securityName: 'M & B Engineering Ltd',
      isin: 'INE08N601015', side: 'BUY', quantity: 220, rate: 253.268, total: 55718.96, charges: 76.21,
      warnings: [],
    });
    expect(note.trades[1]).toMatchObject({ isin: 'INE238A01034', side: 'SELL', tradeDate: '2026-10-27' });
  });

  it('builds the reference from the statement only, never the file name', () => {
    const a = parseContractNote([[...HEADER, ...row(526, MBEL)]], 'Transaction_Statement_V8FSU_20261026_20261027.pdf');
    const b = parseContractNote([[...HEADER, ...row(526, MBEL)]], 'renamed.pdf');
    expect(a.trades[0].reference).toBe('CN:2026-10-26T10:04:53:INE08N601015:BUY:220@253.2680');
    expect(b.trades[0].reference).toBe(a.trades[0].reference);
    expect(b.clientCode).toBeNull();
  });

  it('flags a total that quantity × rate does not explain', () => {
    const note = parseContractNote([[...HEADER, ...row(526, { ...MBEL, total: '55000.00' })]]);
    expect(note.trades[0].warnings[0]).toMatch(/prints 55000\.00/);
  });

  it('reports an unreadable row instead of dropping it', () => {
    const note = parseContractNote([[...HEADER, ...row(526, { ...MBEL, isin: ['INE08N'] }), ...row(496, AXIS)]]);
    expect(note.trades).toHaveLength(1);
    expect(note.errors).toEqual([expect.stringMatching(/^Row 1: could not read the ISIN/)]);
  });

  it('rejects a PDF with no recognisable trade table', () => {
    expect(() => parseContractNote([[t('Some other statement', 20, 700)]])).toThrow(UnrecognisedStatementError);
  });
});

describe('ContractNoteService.commit', () => {
  const ADMIN = { id: 'u1', role: 'SUPER_ADMIN' };

  function serviceWith(ledger: Array<{ ticker: string; type: string; quantity: number; date: string; reference?: string }>) {
    const recordTrade = jest.fn(async (_trade: any) => ({}));
    const prisma = {
      client: { findUnique: jest.fn(async () => ({ id: 'c1', ownerId: null as string | null, market: 'INDIA' })) },
      transaction: {
        findMany: jest.fn(async ({ where }) =>
          where.reference
            ? ledger.filter((l) => l.reference && where.reference.in.includes(l.reference))
            : ledger.map((l) => ({ ...l, date: new Date(l.date) })),
        ),
      },
    };
    const service = new ContractNoteService(prisma as any, { recordTrade } as any, {} as any);
    return { service, recordTrade };
  }

  const trade = (o: Partial<{ line: number; date: string; side: 'BUY' | 'SELL'; symbol: string; quantity: number; total: number; charges: number; reference: string }>) => ({
    line: 1, date: '2026-10-26', side: 'BUY' as const, symbol: 'MBEL', quantity: 220,
    total: 55718.96, charges: 76.21, reference: 'CN:ref-1', ...o,
  });

  it('books at quantity × rate by default and adds charges only when asked', async () => {
    const { service, recordTrade } = serviceWith([]);
    await service.commit({ clientId: 'c1', includeCharges: false, trades: [trade({})] }, ADMIN);
    await service.commit({ clientId: 'c1', includeCharges: true, trades: [trade({ side: 'SELL' })] }, ADMIN);

    expect(recordTrade.mock.calls[0][0]).toMatchObject({ symbol: 'MBEL.NS', amount: 55718.96, reference: 'CN:ref-1' });
    // A sell's charges come out of the proceeds.
    expect((recordTrade.mock.calls[1][0] as any).amount).toBeCloseTo(55718.96 - 76.21, 6);
  });

  it('skips a trade already imported, and one already typed in by hand (stored at IST midnight)', async () => {
    const { service, recordTrade } = serviceWith([
      { ticker: 'AXISBANK.NS', type: 'BUY', quantity: 40, date: '2026-10-26T00:00:00Z', reference: 'CN:ref-1' },
      { ticker: 'MBEL.NS', type: 'BUY', quantity: 220, date: '2026-10-25T18:30:00Z' },
    ]);

    const out = await service.commit({
      clientId: 'c1',
      includeCharges: false,
      trades: [
        trade({ line: 1, symbol: 'AXISBANK.NS', quantity: 40, reference: 'CN:ref-1' }),
        trade({ line: 2, reference: 'CN:ref-2' }),
        // A second identical fill: the one manual row only accounts for one.
        trade({ line: 3, reference: 'CN:ref-3' }),
      ],
    }, ADMIN);

    expect(out).toMatchObject({ imported: 1, skipped: 2, failed: 0 });
    expect(out.results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'imported']);
    expect(recordTrade).toHaveBeenCalledTimes(1);
  });

  it('books in trade order so a sell follows the buy it draws on', async () => {
    const { service, recordTrade } = serviceWith([]);
    await service.commit({
      clientId: 'c1',
      includeCharges: false,
      trades: [
        trade({ line: 1, side: 'SELL', date: '2026-10-27', reference: 'CN:2026-10-27T09:00:00' }),
        trade({ line: 2, side: 'BUY', date: '2026-10-26', reference: 'CN:2026-10-26T15:00:00' }),
      ],
    }, ADMIN);
    expect(recordTrade.mock.calls.map((c) => (c[0] as any).side)).toEqual(['BUY', 'SELL']);
  });

  it('refuses a client outside the India book', async () => {
    const { service } = serviceWith([]);
    (service as any).prisma.client.findUnique = jest.fn(async () => ({ id: 'c1', ownerId: null as string | null, market: 'US' }));
    await expect(
      service.commit({ clientId: 'c1', includeCharges: false, trades: [trade({})] }, ADMIN),
    ).rejects.toThrow(/India book/);
  });
});
