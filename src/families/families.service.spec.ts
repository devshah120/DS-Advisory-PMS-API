import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { FamiliesService } from './families.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';

/**
 * The household roll-up is the whole point of the family feature, and its one
 * genuinely easy-to-get-wrong step is the blended cost: averaging the members'
 * average costs weights a 5-share lot the same as a 500-share one and reports a
 * price the family never paid. These tests pin that down.
 */
describe('FamiliesService.aggregate', () => {
  const RELIANCE = 'RELIANCE.NS';
  const TCS = 'TCS.NS';

  function build(clients: any[], prices: Record<string, number>) {
    const prisma = {
      family: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'fam1',
          name: 'Shah Family',
          market: 'INDIA',
          clients,
        }),
      },
    } as unknown as PrismaService;

    const market = {
      lookup: jest.fn(async (ticker: string) => {
        const currentPrice = prices[ticker];
        if (currentPrice === undefined) throw new Error(`no quote for ${ticker}`);
        return { currentPrice };
      }),
    } as unknown as MarketService;

    return new FamiliesService(prisma, market);
  }

  it('sums quantities and blends cost by size across the household', async () => {
    // Two accounts hold RELIANCE at very different sizes and prices. The
    // blended cost must be Σ(qty × cost) ÷ Σ(qty) = (10×1000 + 90×2000) / 100
    // = 1900 — NOT the plain mean of 1000 and 2000 (1500).
    const service = build(
      [
        {
          id: 'c1',
          name: 'Amit Shah',
          cashBalance: 5000,
          holdings: [
            { ticker: RELIANCE, company: 'Reliance', sector: 'Energy', industry: 'Oil & Gas', quantity: 10, averageCost: 1000, currentPrice: 1500, realizedPnL: 0 },
          ],
        },
        {
          id: 'c2',
          name: 'Priya Shah',
          cashBalance: 1000,
          holdings: [
            { ticker: RELIANCE, company: 'Reliance', sector: 'Energy', industry: 'Oil & Gas', quantity: 90, averageCost: 2000, currentPrice: 1500, realizedPnL: 0 },
          ],
        },
      ],
      { [RELIANCE]: 2500 },
    );

    const result = await service.aggregate('fam1');

    expect(result.positions).toHaveLength(1);
    const position = result.positions[0];

    expect(position.quantity).toBe(100);
    expect(position.averageCost).toBeCloseTo(1900, 6);
    expect(position.accounts).toBe(2);
    // Valued at the LIVE quote (2500), not the stored currentPrice (1500).
    expect(position.marketValue).toBeCloseTo(250_000, 6);
    expect(position.costBasis).toBeCloseTo(190_000, 6);
    expect(position.unrealizedPnL).toBeCloseTo(60_000, 6);

    // Cash is summed once per member, never once per lot.
    expect(result.totals.cashBalance).toBe(6000);
    expect(result.totals.portfolioValue).toBeCloseTo(256_000, 6);
    // One distinct name, from two account-level lots.
    expect(result.totals.positionCount).toBe(1);
    expect(result.totals.lotCount).toBe(2);
    expect(result.currency).toBe('INR');
  });

  it('drops fully-exited lots and reports sector weights over the merged book', async () => {
    const service = build(
      [
        {
          id: 'c1',
          name: 'Amit Shah',
          cashBalance: 0,
          holdings: [
            { ticker: RELIANCE, company: 'Reliance', sector: 'Energy', industry: 'Oil & Gas', quantity: 100, averageCost: 1000, currentPrice: 1000, realizedPnL: 0 },
            // Sold out: float dust, not a real position — must not appear.
            { ticker: 'WIPRO.NS', company: 'Wipro', sector: 'Technology', industry: 'IT', quantity: 7e-15, averageCost: 400, currentPrice: 400, realizedPnL: 250 },
          ],
        },
        {
          id: 'c2',
          name: 'Priya Shah',
          cashBalance: 0,
          holdings: [
            { ticker: TCS, company: 'TCS', sector: 'Technology', industry: 'IT', quantity: 100, averageCost: 3000, currentPrice: 3000, realizedPnL: 0 },
          ],
        },
      ],
      { [RELIANCE]: 1000, [TCS]: 3000 },
    );

    const result = await service.aggregate('fam1');

    expect(result.positions.map((p) => p.ticker)).toEqual([TCS, RELIANCE]);
    expect(result.totals.lotCount).toBe(2); // the closed WIPRO lot never counted

    // 300,000 TCS + 100,000 RELIANCE = 400,000 total.
    const [tech, energy] = result.sectorAllocation;
    expect(tech.sector).toBe('Technology');
    expect(tech.weight).toBeCloseTo(75, 6);
    expect(energy.sector).toBe('Energy');
    expect(energy.weight).toBeCloseTo(25, 6);
    // Weights are over merged names, so each sector counts one position.
    expect(tech.positions).toBe(1);
  });

  it('falls back to the stored price when a live quote is unavailable', async () => {
    const service = build(
      [
        {
          id: 'c1',
          name: 'Amit Shah',
          cashBalance: 0,
          holdings: [
            { ticker: RELIANCE, company: 'Reliance', sector: 'Energy', industry: 'Oil & Gas', quantity: 10, averageCost: 1000, currentPrice: 1200, realizedPnL: 0 },
          ],
        },
      ],
      {}, // every lookup throws
    );

    const result = await service.aggregate('fam1');

    // One unreachable ticker must degrade to the stored price, not fail the view.
    expect(result.positions[0].currentPrice).toBe(1200);
    expect(result.positions[0].marketValue).toBeCloseTo(12_000, 6);
  });

  it('refuses a member from another book', async () => {
    const prisma = {
      family: { create: jest.fn(), findUnique: jest.fn() },
      client: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c1', name: 'Amit Shah', market: 'INDIA' },
          { id: 'c2', name: 'John Doe', market: 'US' },
        ]),
        updateMany: jest.fn(),
      },
    } as unknown as PrismaService;

    const service = new FamiliesService(prisma, {} as MarketService);

    // setMembers is private; reached through the update path it guards.
    await expect(
      (service as any).setMembers('fam1', ['c1', 'c2'], 'INDIA'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
