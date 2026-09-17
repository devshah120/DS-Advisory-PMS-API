import { TransactionsService } from './transactions.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor } from '../common/ownership-scope';

const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };

/**
 * The lot breakdown is read to AUDIT a cost basis, so the query behind it has
 * to be exactly right: the wrong rows, the wrong order, or the wrong casing
 * all produce a page that looks authoritative and states a basis the client
 * never paid. These pin the query itself rather than the arithmetic, which
 * lives in the component.
 */
describe('TransactionsService.findLots', () => {
  function build(rows: any[] = []) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { transaction: { findMany } } as unknown as PrismaService;
    return { service: new TransactionsService(prisma), findMany };
  }

  it('asks for only the trades that move the position', async () => {
    const { service, findMany } = build();

    await service.findLots('c1', 'STT', SUPER_ADMIN);

    const where = findMany.mock.calls[0][0].where;
    // A dividend or fee against the same ticker is real money, but it buys no
    // shares — in a cost-basis table it would contribute no cost and no basis.
    expect(where.type).toEqual({ in: ['BUY', 'SELL'] });
    expect(where.clientId).toBe('c1');
  });

  it('reads the story forwards, oldest fill first', async () => {
    const { service, findMany } = build();

    await service.findLots('c1', 'STT', SUPER_ADMIN);

    // Deliberately the opposite of the blotter views, which lead with the most
    // recent activity. A cost basis is assembled in the order it was bought.
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ date: 'asc' });
  });

  it('matches the ticker in the casing every write path stores', async () => {
    const { service, findMany } = build();

    // Indian symbols arrive suffixed, and a querystring can carry any casing.
    await service.findLots('c1', 'reliance.ns', SUPER_ADMIN);

    expect(findMany.mock.calls[0][0].where.ticker).toBe('RELIANCE.NS');
  });

  it('constrains a scoped actor to their own book', async () => {
    const { service, findMany } = build();
    // A client login: the narrowest scope there is, and the case where a leak
    // would be worst - it must never see another mandate's fills.
    const viewer: Actor = { id: 'u_v', role: 'VIEWER', clientId: 'c1' };

    await service.findLots('c1', 'STT', viewer);

    // Merged into the same query, so an unowned clientId returns an empty list
    // rather than distinguishing "no lots" from "not your client".
    expect(findMany.mock.calls[0][0].where.client).toEqual({ id: 'c1' });
  });

  it('does not traverse the relation for a firm-wide actor', async () => {
    const { service, findMany } = build();

    await service.findLots('c1', 'STT', SUPER_ADMIN);

    // relatedClientWhere returns {} firm-wide precisely to avoid the join.
    expect(findMany.mock.calls[0][0].where.client).toBeUndefined();
  });

  it('lowercases the type so the frontend union matches', async () => {
    const { service } = build([
      { id: 't1', type: 'BUY', quantity: 39, price: 162.95 },
      { id: 't2', type: 'SELL', quantity: 1, price: 190 },
    ]);

    const lots = await service.findLots('c1', 'STT', SUPER_ADMIN);

    expect(lots.map((l) => l.type)).toEqual(['buy', 'sell']);
  });
});

/**
 * An edit rewrites a row the XIRR engine replays, so the risk here is not that
 * a save fails loudly - it is that it succeeds and writes MORE than the operator
 * changed. These pin the patch the service actually sends to Prisma.
 */
describe('TransactionsService.update', () => {
  const ROW: any = {
    id: 't1',
    clientId: 'c1',
    ticker: 'ICICIBANK.NS',
    type: 'BUY',
    quantity: 70,
    price: 1354.4,
    amount: 94808,
    date: new Date('2026-09-17T12:00:00Z'),
    description: null,
    reference: null,
  };

  function build(count = 1, row: any = ROW) {
    const updateMany = jest.fn().mockResolvedValue({ count });
    const findUnique = jest.fn().mockResolvedValue(row);
    const findFirst = jest.fn().mockResolvedValue(row);
    const prisma = {
      transaction: { updateMany, findUnique, findFirst },
    } as unknown as PrismaService;
    return { service: new TransactionsService(prisma), updateMany, findUnique, findFirst };
  }

  it('writes only the keys the caller sent', async () => {
    const { service, updateMany } = build();

    await service.update('t1', { amount: 95000 }, SUPER_ADMIN);

    // The whole point of the key-by-key assembly: spreading the DTO would push
    // `undefined` over ticker, price and quantity as well. Prisma treats an
    // absent key as "leave it", so the patch must contain nothing else.
    expect(updateMany.mock.calls[0][0].data).toEqual({ amount: 95000 });
  });

  it('keeps an explicit null as a clear rather than dropping it', async () => {
    const { service, updateMany } = build();

    await service.update('t1', { reference: null }, SUPER_ADMIN);

    // `undefined` cannot express "empty this column" - only null can, so the
    // distinction has to survive the assembly.
    expect(updateMany.mock.calls[0][0].data).toEqual({ reference: null });
  });

  it('parses the date into a Date, not the string it arrived as', async () => {
    const { service, updateMany } = build();

    await service.update('t1', { date: '2026-09-15T12:00:00.000Z' }, SUPER_ADMIN);

    const { date } = updateMany.mock.calls[0][0].data;
    expect(date).toBeInstanceOf(Date);
    expect((date as Date).toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });

  it('proves ownership in the update itself', async () => {
    const { service, updateMany } = build();
    const manager: Actor = { id: 'u_m', role: 'FUND_MANAGER' };

    await service.update('t1', { amount: 1 }, manager);

    // Same relation filter `remove` uses. A read-then-write would leave a
    // window between the check and the update.
    const where = updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('t1');
    expect(where.client).toEqual({ ownerId: 'u_m' });
  });

  it('404s when the row is absent or in another book', async () => {
    const { service } = build(0);

    // count 0 is indistinguishable between "gone" and "not yours" on purpose.
    await expect(service.update('t1', { amount: 1 }, SUPER_ADMIN)).rejects.toThrow(
      'Transaction not found'
    );
  });

  it('does not touch the row when nothing changed', async () => {
    const { service, updateMany, findFirst } = build();

    await service.update('t1', {}, SUPER_ADMIN);

    // An empty patch would otherwise bump `updatedAt` on a ledger row and
    // report a save that changed nothing.
    expect(updateMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalled();
  });

  it('returns the stored row, lowercased for the frontend union', async () => {
    const { service } = build();

    const updated = await service.update('t1', { amount: 95000 }, SUPER_ADMIN);

    // Re-read rather than echoing the patch: updateMany returns a count, and
    // the caller splices this whole record into its table.
    expect(updated.type).toBe('buy');
    expect(updated.ticker).toBe('ICICIBANK.NS');
  });
});
