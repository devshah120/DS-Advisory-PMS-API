/**
 * PART 45 Tests 10 and 11, plus the confidence scoring of PART 33.
 *
 * Test 10: two providers report the same action -> ONE action, TWO sources.
 * Test 11: two providers disagree            -> DATA_CONFLICT, no processing.
 */
import type { CorporateActionType } from '@prisma/client';
import {
  calculateConfidence,
  detectConflicts,
  fingerprintOf,
  isNearDuplicate,
  isSameEvent,
  mergeSources,
  outranks,
  toSourceReference,
} from './corporate-action.dedupe';
import { NormalizedCorporateAction, SourceReference } from './corporate-action.types';

const APH_SPLIT = (overrides: Partial<NormalizedCorporateAction> = {}): NormalizedCorporateAction => ({
  symbol: 'APH',
  company: 'Amphenol',
  actionType: 'STOCK_SPLIT' as CorporateActionType,
  announcementDate: new Date('2026-08-06T00:00:00Z'),
  recordDate: new Date('2026-09-02T00:00:00Z'),
  exDate: new Date('2026-09-03T00:00:00Z'),
  effectiveDate: new Date('2026-09-03T00:00:00Z'),
  oldRatio: 1,
  newRatio: 2,
  source: 'fmp',
  tier: 'PRIMARY_API',
  sourceUrl: 'https://example.test/fmp',
  ...overrides,
});

describe('fingerprintOf', () => {
  it('is stable across repeated calls', () => {
    expect(fingerprintOf(APH_SPLIT())).toBe(fingerprintOf(APH_SPLIT()));
  });

  it('ignores the time of day — feeds report dates in different timezones', () => {
    const utcMidnight = APH_SPLIT({ effectiveDate: new Date('2026-09-03T00:00:00Z') });
    const laterSameDay = APH_SPLIT({ effectiveDate: new Date('2026-09-03T18:45:00Z') });
    expect(fingerprintOf(utcMidnight)).toBe(fingerprintOf(laterSameDay));
  });

  it('ignores the reporting source — identity is the EVENT, not the reporter', () => {
    const fromFmp = APH_SPLIT({ source: 'fmp' });
    const fromSec = APH_SPLIT({ source: 'sec', tier: 'REGULATORY_FILING' });
    expect(fingerprintOf(fromFmp)).toBe(fingerprintOf(fromSec));
  });

  it('separates a different ratio', () => {
    expect(fingerprintOf(APH_SPLIT())).not.toBe(
      fingerprintOf(APH_SPLIT({ oldRatio: 1, newRatio: 3 })),
    );
  });

  it('separates a different symbol, type and effective date', () => {
    const base = fingerprintOf(APH_SPLIT());
    expect(base).not.toBe(fingerprintOf(APH_SPLIT({ symbol: 'AAPL' })));
    expect(base).not.toBe(
      fingerprintOf(APH_SPLIT({ actionType: 'BONUS_ISSUE' as CorporateActionType })),
    );
    expect(base).not.toBe(
      fingerprintOf(APH_SPLIT({ effectiveDate: new Date('2026-09-10T00:00:00Z') })),
    );
  });

  it('distinguishes a missing record date from a present one', () => {
    expect(fingerprintOf(APH_SPLIT())).not.toBe(
      fingerprintOf(APH_SPLIT({ recordDate: null })),
    );
  });

  it('is case- and whitespace-insensitive on the symbol', () => {
    expect(fingerprintOf(APH_SPLIT({ symbol: '  aph ' }))).toBe(fingerprintOf(APH_SPLIT()));
  });
});

describe('PART 45 Test 10 — two providers, same action', () => {
  it('recognises the same event from two different sources', () => {
    const fromFmp = APH_SPLIT({ source: 'fmp', tier: 'PRIMARY_API' });
    const fromSec = APH_SPLIT({ source: 'sec', tier: 'REGULATORY_FILING' });

    expect(isSameEvent(fromFmp, fromSec)).toBe(true);
  });

  it('merges into one action carrying two sources, highest tier first', () => {
    const fmpRef = toSourceReference(APH_SPLIT({ source: 'fmp', tier: 'PRIMARY_API' }));
    const secRef = toSourceReference(APH_SPLIT({ source: 'sec', tier: 'REGULATORY_FILING' }));

    const merged = mergeSources([fmpRef], secRef);

    expect(merged).toHaveLength(2);
    // The SEC filing outranks the API and becomes primary.
    expect(merged[0].source).toBe('sec');
    expect(merged[1].source).toBe('fmp');
    expect(detectConflicts(merged)).toEqual([]);
  });

  it('replaces a source re-reporting rather than appending it twice', () => {
    const first = toSourceReference(APH_SPLIT({ source: 'fmp' }));
    const second = toSourceReference(APH_SPLIT({ source: 'fmp' }));

    const merged = mergeSources([first], second);

    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('fmp');
  });

  it('corroboration raises confidence by 5', () => {
    const single = calculateConfidence({
      sources: [toSourceReference(APH_SPLIT({ source: 'fmp', tier: 'PRIMARY_API' }))],
      actionType: 'STOCK_SPLIT' as CorporateActionType,
      oldRatio: 1,
      newRatio: 2,
      recordDate: new Date('2026-09-02'),
      effectiveDate: new Date('2026-09-03'),
    });

    const corroborated = calculateConfidence({
      sources: [
        toSourceReference(APH_SPLIT({ source: 'fmp', tier: 'PRIMARY_API' })),
        toSourceReference(APH_SPLIT({ source: 'finnhub', tier: 'SECONDARY_API' })),
      ],
      actionType: 'STOCK_SPLIT' as CorporateActionType,
      oldRatio: 1,
      newRatio: 2,
      recordDate: new Date('2026-09-02'),
      effectiveDate: new Date('2026-09-03'),
    });

    expect(single).toBe(90);
    expect(corroborated).toBe(95);
  });
});

describe('PART 45 Test 11 — two providers disagree', () => {
  it('detects a ratio conflict between two sources', () => {
    const sources = [
      toSourceReference(APH_SPLIT({ source: 'fmp', oldRatio: 1, newRatio: 2 })),
      toSourceReference(APH_SPLIT({ source: 'finnhub', oldRatio: 1, newRatio: 3 })),
    ];

    const conflicts = detectConflicts(sources);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('newRatio');
    expect(conflicts[0].values.map((v) => v.value)).toEqual([2, 3]);
  });

  it('caps confidence at 50 on a conflict, however good the source', () => {
    const sources = [
      // An SEC filing would otherwise score 100.
      toSourceReference(APH_SPLIT({ source: 'sec', tier: 'REGULATORY_FILING', newRatio: 2 })),
      toSourceReference(APH_SPLIT({ source: 'fmp', newRatio: 3 })),
    ];
    const conflicts = detectConflicts(sources);

    const score = calculateConfidence({
      sources,
      actionType: 'STOCK_SPLIT' as CorporateActionType,
      oldRatio: 1,
      newRatio: 2,
      recordDate: new Date('2026-09-02'),
      effectiveDate: new Date('2026-09-03'),
      conflicts,
    });

    expect(conflicts.length).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(50);
    // Well under the 90 default threshold, so it cannot auto-process.
    expect(score).toBeLessThan(90);
  });

  it('does not flag a conflict when one source simply omits a field', () => {
    // Incomplete is not the same as contradictory — see detectConflicts.
    const sources = [
      toSourceReference(APH_SPLIT({ source: 'fmp', recordDate: new Date('2026-09-02') })),
      toSourceReference(APH_SPLIT({ source: 'finnhub', recordDate: null })),
    ];

    expect(detectConflicts(sources)).toEqual([]);
  });

  it('does not flag two sources agreeing to within float noise', () => {
    const sources: SourceReference[] = [
      {
        source: 'a',
        tier: 'PRIMARY_API',
        fetchedAt: new Date().toISOString(),
        payload: { cashAmount: 0.3333333333 },
      },
      {
        source: 'b',
        tier: 'SECONDARY_API',
        fetchedAt: new Date().toISOString(),
        payload: { cashAmount: 0.33333333333333 },
      },
    ];

    expect(detectConflicts(sources)).toEqual([]);
  });

  it('treats dates reported at different times of day as agreeing', () => {
    const sources: SourceReference[] = [
      {
        source: 'a',
        tier: 'PRIMARY_API',
        fetchedAt: new Date().toISOString(),
        payload: { effectiveDate: '2026-09-03T00:00:00.000Z' },
      },
      {
        source: 'b',
        tier: 'SECONDARY_API',
        fetchedAt: new Date().toISOString(),
        payload: { effectiveDate: '2026-09-03T14:30:00.000Z' },
      },
    ];

    expect(detectConflicts(sources)).toEqual([]);
  });
});

describe('near-duplicate detection', () => {
  it('flags the same action reported two days apart', () => {
    const a = APH_SPLIT({ effectiveDate: new Date('2026-09-03') });
    const b = APH_SPLIT({ effectiveDate: new Date('2026-09-05') });

    // Different fingerprints — the unique index would let both in.
    expect(isSameEvent(a, b)).toBe(false);
    // But they are near-duplicates and must be reviewed.
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it('does not flag actions a fortnight apart', () => {
    const a = APH_SPLIT({ effectiveDate: new Date('2026-09-03') });
    const b = APH_SPLIT({ effectiveDate: new Date('2026-09-17') });
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it('never flags different symbols', () => {
    const a = APH_SPLIT({ symbol: 'APH' });
    const b = APH_SPLIT({ symbol: 'AAPL' });
    expect(isNearDuplicate(a, b)).toBe(false);
  });
});

describe('source priority (PART 5)', () => {
  it('ranks official and regulatory sources above APIs', () => {
    expect(outranks('COMPANY_IR', 'PRIMARY_API')).toBe(true);
    expect(outranks('REGULATORY_FILING', 'EXCHANGE')).toBe(true);
    expect(outranks('EXCHANGE', 'PRIMARY_API')).toBe(true);
    expect(outranks('PRIMARY_API', 'SECONDARY_API')).toBe(true);
    expect(outranks('SECONDARY_API', 'PRIMARY_API')).toBe(false);
  });
});

describe('confidence scoring (PART 33)', () => {
  const base = {
    actionType: 'STOCK_SPLIT' as CorporateActionType,
    oldRatio: 1,
    newRatio: 2,
    recordDate: new Date('2026-09-02'),
    effectiveDate: new Date('2026-09-03'),
  };

  it('assigns the tier scores the specification names', () => {
    const score = (tier: SourceReference['tier']) =>
      calculateConfidence({
        ...base,
        sources: [{ source: 's', tier, fetchedAt: new Date().toISOString(), payload: {} }],
      });

    expect(score('COMPANY_IR')).toBe(100);
    expect(score('REGULATORY_FILING')).toBe(100);
    expect(score('EXCHANGE')).toBe(95);
    expect(score('PRIMARY_API')).toBe(90);
    expect(score('SECONDARY_API')).toBe(75);
    expect(score('UNVERIFIED')).toBe(40);
  });

  it('deducts heavily when a ratio action has no usable ratio', () => {
    const score = calculateConfidence({
      ...base,
      oldRatio: null,
      newRatio: null,
      sources: [
        { source: 'sec', tier: 'REGULATORY_FILING', fetchedAt: new Date().toISOString(), payload: {} },
      ],
    });

    expect(score).toBe(70); // 100 - 30
    expect(score).toBeLessThan(90); // below the default threshold
  });

  it('deducts when a cash action has no amount', () => {
    const score = calculateConfidence({
      actionType: 'DIVIDEND' as CorporateActionType,
      cashAmount: null,
      recordDate: new Date('2026-09-02'),
      effectiveDate: new Date('2026-09-03'),
      sources: [
        { source: 'fmp', tier: 'PRIMARY_API', fetchedAt: new Date().toISOString(), payload: {} },
      ],
    });

    expect(score).toBe(60); // 90 - 30
  });

  it('returns zero when there is no source at all', () => {
    expect(calculateConfidence({ ...base, sources: [] })).toBe(0);
  });

  it('never exceeds 100 or falls below 0', () => {
    const high = calculateConfidence({
      ...base,
      sources: [
        { source: 'a', tier: 'COMPANY_IR', fetchedAt: new Date().toISOString(), payload: {} },
        { source: 'b', tier: 'REGULATORY_FILING', fetchedAt: new Date().toISOString(), payload: {} },
      ],
    });
    expect(high).toBe(100);

    const low = calculateConfidence({
      actionType: 'DIVIDEND' as CorporateActionType,
      cashAmount: null,
      recordDate: null,
      effectiveDate: null,
      sources: [
        { source: 'x', tier: 'UNVERIFIED', fetchedAt: new Date().toISOString(), payload: {} },
      ],
    });
    expect(low).toBeGreaterThanOrEqual(0);
  });
});
