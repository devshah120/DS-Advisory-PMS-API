import * as XLSX from 'xlsx';
import { HoldingsService } from './holdings.service';

/**
 * Uploading the same blotter twice booked every trade twice: Prashant Salecha
 * HUF's 71 AXISBANK became 142. A trade already on the ledger must be skipped.
 */
describe('HoldingsService.bulkImport — re-upload', () => {
  const SUPER_ADMIN: any = { id: 'u', role: 'SUPER_ADMIN' };

  function file(rows: Array<[string, string, string, string, number, number]>) {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Action', 'Date', 'Client Name', 'Symbol', 'Quantity', 'Amount Invested'],
      ...rows,
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Transactions');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  function serviceWith(ledger: Array<{ ticker: string; type: string; quantity: number; date: Date }>) {
    const prisma = {
      client: {
        findMany: jest.fn(async () => [{ id: 'c1', name: 'Prashant Salecha HUF', market: 'INDIA' }]),
      },
      transaction: { findMany: jest.fn(async () => ledger.map((t) => ({ ...t }))) },
    };
    const service = new HoldingsService(prisma as any, {} as any, {} as any);
    const recordTrade = jest.spyOn(service, 'recordTrade').mockResolvedValue({} as any);
    return { service, recordTrade };
  }

  const blotter = file([
    ['BUY', '02-09-2026', 'Prashant Salecha HUF', 'AXISBANK', 71, 89815],
    ['BUY', '02-09-2026', 'Prashant Salecha HUF', 'KNACK', 480, 90837.85],
  ]);

  it('books a first upload', async () => {
    const { service, recordTrade } = serviceWith([]);

    const out = await service.bulkImport(blotter, SUPER_ADMIN);

    expect(out).toMatchObject({ imported: 2, skipped: 0, failed: 0 });
    expect(recordTrade).toHaveBeenCalledTimes(2);
  });

  it('skips trades the ledger already holds, including IST-midnight rows', async () => {
    const { service, recordTrade } = serviceWith([
      { ticker: 'AXISBANK.NS', type: 'BUY', quantity: 71, date: new Date('2026-09-02T00:00:00Z') },
      // 18:30 UTC the evening before is IST midnight on 2-Sep.
      { ticker: 'KNACK.NS', type: 'BUY', quantity: 480, date: new Date('2026-09-01T18:30:00Z') },
    ]);

    const out = await service.bulkImport(blotter, SUPER_ADMIN);

    expect(out).toMatchObject({ imported: 0, skipped: 2, failed: 0 });
    expect(recordTrade).not.toHaveBeenCalled();
  });

  it('still books a second identical fill when the ledger holds only one', async () => {
    const { service, recordTrade } = serviceWith([
      { ticker: 'AXISBANK.NS', type: 'BUY', quantity: 71, date: new Date('2026-09-02T00:00:00Z') },
    ]);

    const out = await service.bulkImport(
      file([
        ['BUY', '02-09-2026', 'Prashant Salecha HUF', 'AXISBANK', 71, 89815],
        ['BUY', '02-09-2026', 'Prashant Salecha HUF', 'AXISBANK', 71, 89815],
      ]),
      SUPER_ADMIN,
    );

    expect(out).toMatchObject({ imported: 1, skipped: 1 });
    expect(recordTrade).toHaveBeenCalledTimes(1);
  });

  it('books a different day, side or size', async () => {
    const { service, recordTrade } = serviceWith([
      { ticker: 'AXISBANK.NS', type: 'BUY', quantity: 70, date: new Date('2026-09-02T00:00:00Z') },
      { ticker: 'KNACK.NS', type: 'BUY', quantity: 480, date: new Date('2026-09-03T00:00:00Z') },
    ]);

    const out = await service.bulkImport(blotter, SUPER_ADMIN);

    expect(out).toMatchObject({ imported: 2, skipped: 0 });
    expect(recordTrade).toHaveBeenCalledTimes(2);
  });
});
