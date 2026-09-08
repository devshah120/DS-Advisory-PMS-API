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
