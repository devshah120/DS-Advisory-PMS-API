/**
 * Ex-date entitlement as CorporateActionService works it out from the
 * database, for a dividend that goes ex on 1 July 2026: the house import date.
 *
 * Bulk-import clients' positions were written as BUY rows stamped 1 July, but
 * they are the position held at the 30-June close. A dividend going ex on 1
 * July must count them as held on its eve. A client with no house baseline
 * really did buy on 1 July, and is not entitled.
 */
import type { CorporateActionType } from '@prisma/client';
import { CorporateActionService } from './corporate-action.service';

const HOUSE_BASELINE = new Date('2026-06-30T00:00:00.000Z');
const ON_IMPORT_DAY = new Date('2026-07-01T00:00:00.000Z');

function holding(clientId: string, quantity: number) {
  return {
    id: `h-${clientId}`,
    clientId,
    ticker: 'STT',
    company: 'State Street',
    quantity,
    averageCost: 80,
    currentPrice: 100,
    marketValue: quantity * 100,
    sector: 'Financial Services',
    industry: 'Asset Management',
    country: 'United States',
    exchange: 'NYSE',
    client: {
      id: clientId,
      name: clientId,
      currency: 'USD',
      dividendWithholdingPercent: null as number | null,
    },
  };
}

const buy = (clientId: string, quantity: number) => ({
  clientId,
  ticker: 'STT',
  type: 'BUY',
  quantity,
  date: ON_IMPORT_DAY,
});

describe('CorporateActionService.entitledHolders: a dividend going ex on the import day', () => {
  const prisma = {
    holding: {
      findMany: jest.fn(async () => [
        holding('bulk', 4),
        // Its import row appears twice in the ledger; the holding matches one copy.
        holding('bulk-duplicated', 6.2914),
        holding('new-client', 10),
      ]),
    },
    transaction: {
      findMany: jest.fn(async () => [
        buy('bulk', 4),
        buy('bulk-duplicated', 4.9089),
        buy('bulk-duplicated', 6.2914),
        buy('new-client', 10),
      ]),
    },
    corporateAction: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    portfolioBaseline: {
      findMany: jest.fn(async () => [
        { clientId: 'bulk', baselineDate: HOUSE_BASELINE },
        { clientId: 'bulk-duplicated', baselineDate: HOUSE_BASELINE },
        // 'new-client' has no stored baseline: its 1-July BUY is a real trade.
      ]),
    },
    client: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
  };

  const service = new CorporateActionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('counts the import position as held on the eve, and a real 1-July purchase as not', async () => {
    const holders = await service.entitledHolders({
      symbol: 'STT',
      actionType: 'DIVIDEND' as CorporateActionType,
      exDate: ON_IMPORT_DAY,
      recordDate: ON_IMPORT_DAY,
      market: 'US',
      company: null,
    });

    const byClient = Object.fromEntries(
      holders.map((h) => [h.clientId, [h.entitlement?.shares, h.entitlement?.status]]),
    );
    expect(byClient).toEqual({
      bulk: [4, 'OK'],
      // Worked back from the holding, the duplicate row no longer goes negative.
      'bulk-duplicated': [6.2914, 'OK'],
      'new-client': [0, 'OK'],
    });
  });
});
