import { HoldingsService } from './holdings.service';

/**
 * The lot rebuild must agree with the reconstruction replay about share-count
 * corporate actions. It read BUY/SELL only, so the first lot edit after a split
 * rebuilt the position at its pre-split size.
 */
describe('HoldingsService.recomputeFromLedger — corporate-action rows', () => {
  function serviceWith(rows: Array<{ type: string; quantity: number; amount: number; date: string }>) {
    const update = jest.fn(async ({ data }) => data);
    const prisma = {
      transaction: {
        findMany: jest.fn(async ({ where }) =>
          rows
            .filter((r) => where.type.in.includes(r.type))
            .map((r) => ({ ...r, date: new Date(r.date) })),
        ),
      },
      holding: {
        findUnique: jest.fn(async () => ({ currentPrice: 80 })),
        update,
      },
    };
    const service = new HoldingsService(prisma as any, {} as any, {} as any);
    const recompute = (service as any).recomputeFromLedger.bind(service);
    return { recompute, update };
  }

  it('applies a 2-for-1 split delta and keeps the cost basis whole', async () => {
    // Om Patel's APH: 58.1561 shares imported on 1-July, 2-for-1 on 3-Sep.
    const { recompute } = serviceWith([
      { type: 'BUY', quantity: 58.1561, amount: 5015.38, date: '2026-07-01' },
      { type: 'SPLIT', quantity: 58.1561, amount: 0, date: '2026-09-03' },
    ]);

    const out = await recompute('h1', 'c1', 'APH');

    expect(out.quantity).toBeCloseTo(116.3122, 6);
    expect(out.averageCost).toBeCloseTo(5015.38 / 116.3122, 6);
    expect(out.realizedPnL).toBe(0);
  });

  it('costs a post-split sale against the post-split average', async () => {
    const { recompute } = serviceWith([
      { type: 'BUY', quantity: 100, amount: 10_000, date: '2026-07-01' },
      { type: 'SPLIT', quantity: 100, amount: 0, date: '2026-09-03' },
      { type: 'SELL', quantity: 50, amount: 3_000, date: '2026-10-01' },
    ]);

    const out = await recompute('h1', 'c1', 'X');

    // 200 shares at $50 average; selling 50 for $3,000 realises $500.
    expect(out.quantity).toBeCloseTo(150, 9);
    expect(out.averageCost).toBeCloseTo(50, 9);
    expect(out.realizedPnL).toBeCloseTo(500, 9);
  });

  it('applies a negative delta (reverse split) as recorded', async () => {
    const { recompute } = serviceWith([
      { type: 'BUY', quantity: 100, amount: 1_000, date: '2026-07-01' },
      { type: 'REVERSE_SPLIT', quantity: -90, amount: 0, date: '2026-09-03' },
    ]);

    const out = await recompute('h1', 'c1', 'X');

    expect(out.quantity).toBeCloseTo(10, 9);
    expect(out.averageCost).toBeCloseTo(100, 9);
  });
});
