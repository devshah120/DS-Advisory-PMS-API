/**
 * One dividend, two sources. FMP dates a dividend's effective date on its pay
 * date and Yahoo on its ex-date, so their fingerprints differ. These tests pin
 * that the second report merges into the first instead of creating a second
 * action that would be paid again, and that a merge never reopens an action
 * that is booked or closed.
 */
import type { CorporateAction, CorporateActionStatus } from '@prisma/client';
import {
  detectConflicts,
  fingerprintOf,
  sameDayRange,
  toSourceReference,
} from './corporate-action.dedupe';
import { CorporateActionService } from './corporate-action.service';
import { NormalizedCorporateAction } from './corporate-action.types';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** GM's September dividend as FMP reports it: ex 4-Sep, paid 17-Sep. */
const fmpReport: NormalizedCorporateAction = {
  symbol: 'GM',
  market: 'US',
  actionType: 'DIVIDEND',
  exDate: day('2026-09-04'),
  recordDate: day('2026-09-04'),
  paymentDate: day('2026-09-17'),
  effectiveDate: day('2026-09-17'),
  cashAmount: 0.18,
  currency: 'USD',
  source: 'fmp',
  tier: 'PRIMARY_API',
};

/** The same dividend as Yahoo reports it: no pay date, so dated on the ex-date. */
const yahooReport: NormalizedCorporateAction = {
  ...fmpReport,
  paymentDate: null,
  effectiveDate: day('2026-09-04'),
  source: 'yahoo',
  tier: 'SECONDARY_API',
};

describe('sameDayRange', () => {
  const range = sameDayRange(day('2026-09-04'));
  const inside = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= range.gte.getTime() && t < range.lt.getTime();
  };

  it('contains both ways a date-only value is stored', () => {
    expect(inside('2026-09-04T00:00:00Z')).toBe(true); // UTC midnight
    expect(inside('2026-09-03T18:30:00Z')).toBe(true); // IST midnight
  });

  it('contains neither encoding of the days either side', () => {
    expect(inside('2026-09-03T00:00:00Z')).toBe(false);
    expect(inside('2026-09-02T18:30:00Z')).toBe(false);
    expect(inside('2026-09-05T00:00:00Z')).toBe(false);
    expect(inside('2026-09-04T18:30:00Z')).toBe(false);
  });

  it('gives the same range whichever encoding it is handed', () => {
    expect(sameDayRange(new Date('2026-09-03T18:30:00Z'))).toEqual(range);
  });
});

describe('conflict detection across a source with a pay date and one without', () => {
  it('does not read a missing pay date as a disagreement', () => {
    expect(fingerprintOf(fmpReport)).not.toBe(fingerprintOf(yahooReport));
    expect(detectConflicts([toSourceReference(fmpReport), toSourceReference(yahooReport)])).toEqual([]);
  });

  it('still flags a real disagreement on the amount', () => {
    const conflicts = detectConflicts([
      toSourceReference(fmpReport),
      toSourceReference({ ...yahooReport, cashAmount: 0.36 }),
    ]);
    expect(conflicts.map((c) => c.field)).toEqual(['cashAmount']);
  });
});

describe('CorporateActionService.ingest: merging a second source', () => {
  function stored(status: CorporateActionStatus): CorporateAction {
    return {
      id: 'ca-gm',
      symbol: 'GM',
      actionType: 'DIVIDEND',
      status,
      exDate: fmpReport.exDate!,
      recordDate: fmpReport.recordDate!,
      paymentDate: fmpReport.paymentDate!,
      effectiveDate: fmpReport.effectiveDate,
      cashAmount: 0.18,
      oldRatio: null,
      newRatio: null,
      currency: 'USD',
      source: 'fmp',
      confidenceScore: 90,
      sources: [toSourceReference(fmpReport)],
    } as unknown as CorporateAction;
  }

  function harness(existing: CorporateAction) {
    const update = jest.fn(
      async (args: { data: Record<string, unknown> }): Promise<CorporateAction> =>
        ({ ...existing, ...args.data }) as CorporateAction,
    );
    const create = jest.fn(async (): Promise<CorporateAction> => existing);
    const findFirst = jest.fn(
      async (_args: { where: Record<string, unknown> }): Promise<CorporateAction> => existing,
    );
    const prisma = {
      corporateAction: {
        // The fingerprints differ, so only the ex-date lookup can find it.
        findUnique: jest.fn(async (): Promise<CorporateAction | null> => null),
        findFirst,
        update,
        create,
      },
    };
    const audit = { record: jest.fn(async (): Promise<void> => undefined) };
    const service = new CorporateActionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
    );
    return { service, update, create, findFirst };
  }

  it('merges Yahoo’s report into FMP’s action by ex-date instead of creating a second one', async () => {
    const { service, update, create, findFirst } = harness(stored('PENDING_APPROVAL'));

    const result = await service.ingest(yahooReport);

    expect(result).toMatchObject({ created: false, merged: true });
    expect(create).not.toHaveBeenCalled();
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ symbol: 'GM', actionType: 'DIVIDEND' });
    // Corroborated by a second source with no conflict.
    expect(update.mock.calls[0][0].data).toMatchObject({ hasConflict: false, confidenceScore: 95 });
  });

  it('never reopens a booked action, even when the new source disagrees', async () => {
    const { service, update } = harness(stored('PROCESSED'));

    await service.ingest({ ...yahooReport, cashAmount: 0.36 });

    const data = update.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    // Nor does it rewrite the figures that were booked.
    expect(data.cashAmount).toBeUndefined();
  });

  it('never reopens a cancelled action, which automatic booking would then pay', async () => {
    const { service, update } = harness(stored('CANCELLED'));

    await service.ingest({ ...yahooReport, cashAmount: 0.36 });

    expect(update.mock.calls[0][0].data.status).toBeUndefined();
  });

  it('keeps a booked action’s own provenance and score when it never recorded its sources', async () => {
    // The APH split written by its repair script: manual, scored 100, `sources` null.
    const aph = {
      ...stored('PROCESSED'),
      symbol: 'APH',
      actionType: 'STOCK_SPLIT',
      source: 'manual',
      sourceUrl: null,
      sourceReference: null,
      confidenceScore: 100,
      sources: null,
      oldRatio: 1,
      newRatio: 2,
      cashAmount: null,
      newSymbol: null,
      exDate: day('2026-09-03'),
      recordDate: null,
      paymentDate: null,
      effectiveDate: day('2026-09-03'),
      createdAt: new Date('2026-10-31T00:00:00Z'),
    } as unknown as CorporateAction;
    const { service, update } = harness(aph);

    await service.ingest({
      symbol: 'APH',
      market: 'US',
      actionType: 'STOCK_SPLIT',
      exDate: day('2026-09-03'),
      effectiveDate: day('2026-09-03'),
      oldRatio: 1,
      newRatio: 2,
      source: 'yahoo',
      tier: 'SECONDARY_API',
    });

    const data = update.mock.calls[0][0].data as {
      sources: Array<{ source: string; tier: string }>;
      confidenceScore: number;
      status?: string;
    };
    expect(data.sources.map((s) => [s.source, s.tier])).toEqual([
      ['manual', 'COMPANY_IR'],
      ['yahoo', 'SECONDARY_API'],
    ]);
    expect(data.confidenceScore).toBe(100);
    expect(data.status).toBeUndefined();
  });

  it('sends an approved action back for review when a source disputes it', async () => {
    const { service, update } = harness(stored('APPROVED'));

    await service.ingest({ ...yahooReport, cashAmount: 0.36 });

    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'PENDING_APPROVAL', hasConflict: true });
  });
});
