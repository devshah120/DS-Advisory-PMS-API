/**
 * Processor-level tests — PART 45 Tests 6, 7 and 8, plus the APH 2-for-1 case
 * the brief names as the primary scenario (PART 39/40).
 *
 * These exercise `plan()` directly. That is the whole point of the plan/apply
 * split: the calculation that decides what happens to a client's book is
 * provable without a database, a transaction, or a Nest context.
 */
import type { CorporateAction, CorporateActionType } from '@prisma/client';
import { BonusProcessor } from './bonus.processor';
import { DividendProcessor, entitlementWarning } from './dividend.processor';
import { MergerProcessor } from './merger.processor';
import { RightsIssueProcessor } from './rights-issue.processor';
import { SpinOffProcessor } from './spin-off.processor';
import { StockSplitProcessor } from './stock-split.processor';
import { TickerChangeProcessor } from './ticker-change.processor';
import {
  AffectedHolding,
  ProcessorContext,
  ProcessorSettings,
} from './processor.interface';

// ── fixtures ────────────────────────────────────────────────────────────────

const SETTINGS: ProcessorSettings = {
  fractionalSharePolicy: 'RETAIN',
  cashInLieuPolicy: 'MARKET_PRICE',
};

function action(overrides: Partial<CorporateAction> = {}): CorporateAction {
  return {
    id: 'ca1',
    securityId: null,
    symbol: 'APH',
    company: 'Amphenol',
    market: 'US',
    actionType: 'STOCK_SPLIT' as CorporateActionType,
    announcementDate: new Date('2026-08-06'),
    declarationDate: null,
    recordDate: new Date('2026-09-02'),
    exDate: new Date('2026-09-03'),
    effectiveDate: new Date('2026-09-03'),
    paymentDate: null,
    processingDate: null,
    oldRatio: 1,
    newRatio: 2,
    cashAmount: null,
    currency: 'USD',
    newSecurityId: null,
    newSymbol: null,
    newCompany: null,
    details: null,
    source: 'company_ir',
    sourceUrl: 'https://investors.amphenol.com/',
    sourceReference: null,
    sources: null,
    status: 'APPROVED',
    confidenceScore: 100,
    hasConflict: false,
    conflicts: null,
    fingerprint: 'fp1',
    validationErrors: null,
    validatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    notes: null,
    ...overrides,
  } as CorporateAction;
}

function holding(overrides: Partial<AffectedHolding> = {}): AffectedHolding {
  return {
    holdingId: 'h1',
    clientId: 'c1',
    clientName: 'Ketan',
    clientCurrency: 'USD',
    ticker: 'APH',
    company: 'Amphenol',
    quantity: 100,
    averageCost: 100,
    currentPrice: 160,
    marketValue: 16000,
    sector: 'Technology',
    industry: 'Electronic Components',
    country: 'United States',
    exchange: 'NYSE',
    ...overrides,
  };
}

function context(
  holdings: AffectedHolding[],
  ca: CorporateAction = action(),
  settings: ProcessorSettings = SETTINGS,
): ProcessorContext {
  return {
    action: ca,
    holdings,
    settings,
    tx: {} as ProcessorContext['tx'],
    runReference: 'test-run',
  };
}

// ── the primary scenario ────────────────────────────────────────────────────

describe('StockSplitProcessor — the APH 2-for-1 case (PART 2/39/40)', () => {
  const processor = new StockSplitProcessor();

  it('doubles the shares, halves the average cost, and preserves the cost', () => {
    const [change] = processor.plan(context([holding()]));

    expect(change.impact.quantityBefore).toBe(100);
    expect(change.impact.quantityAfter).toBe(200);
    expect(change.impact.averageCostBefore).toBe(100);
    expect(change.impact.averageCostAfter).toBe(50);

    // The invariant: $10,000 before, $10,000 after.
    expect(change.impact.quantityBefore * change.impact.averageCostBefore).toBe(10000);
    expect(change.impact.quantityAfter * change.impact.averageCostAfter).toBe(10000);
  });

  it('writes a SPLIT row carrying the DELTA shares, not the total', () => {
    const [change] = processor.plan(context([holding()]));
    const [tx] = change.transactions;

    expect(tx.type).toBe('SPLIT');
    // +100 additional, matching the existing replay's convention. A 200 here
    // would triple the position on the next historical reconstruction.
    expect(tx.quantity).toBe(100);
    expect(tx.ticker).toBe('APH');
    expect(tx.date).toEqual(new Date('2026-09-03'));
  });

  it('records ZERO cash — this is what keeps a split out of performance', () => {
    const [change] = processor.plan(context([holding()]));

    expect(change.transactions[0].amount).toBe(0);
    expect(change.impact.cashImpact).toBe(0);
  });

  it('never emits a BUY or SELL row', () => {
    const [change] = processor.plan(context([holding()]));
    for (const tx of change.transactions) {
      expect(['BUY', 'SELL']).not.toContain(tx.type);
    }
  });

  it('handles the four-client book from PART 39 (1,240 -> 2,480 shares)', () => {
    const book = [
      holding({ holdingId: 'h1', clientId: 'c1', clientName: 'Ketan', quantity: 100 }),
      holding({ holdingId: 'h2', clientId: 'c2', clientName: 'Asha', quantity: 340 }),
      holding({ holdingId: 'h3', clientId: 'c3', clientName: 'Rohan', quantity: 500 }),
      holding({ holdingId: 'h4', clientId: 'c4', clientName: 'Meera', quantity: 300 }),
    ];

    const changes = processor.plan(context(book));

    const before = changes.reduce((s, c) => s + c.impact.quantityBefore, 0);
    const after = changes.reduce((s, c) => s + c.impact.quantityAfter, 0);

    expect(changes).toHaveLength(4);
    expect(before).toBe(1240);
    expect(after).toBe(2480);

    // No cash moves for any client, and total cost is preserved for each.
    for (const c of changes) {
      expect(c.impact.cashImpact).toBe(0);
      expect(c.impact.quantityAfter * c.impact.averageCostAfter).toBeCloseTo(
        c.impact.quantityBefore * c.impact.averageCostBefore,
        6,
      );
    }
  });

  it('refuses to plan when the ratio is unusable rather than silently no-opping', () => {
    expect(() =>
      processor.plan(context([holding()], action({ oldRatio: 0, newRatio: 2 }))),
    ).toThrow(/unusable/);

    expect(() =>
      processor.plan(context([holding()], action({ oldRatio: null, newRatio: null }))),
    ).toThrow(/unusable/);
  });
});

describe('StockSplitProcessor — reverse splits (PART 10)', () => {
  const processor = new StockSplitProcessor();

  it('halves the shares and doubles the cost on a 1-for-2', () => {
    const [change] = processor.plan(
      context([holding()], action({ oldRatio: 2, newRatio: 1 })),
    );

    expect(change.impact.quantityAfter).toBe(50);
    expect(change.impact.averageCostAfter).toBe(200);
    expect(change.transactions[0].type).toBe('REVERSE_SPLIT');
    // The delta is NEGATIVE — shares were removed.
    expect(change.transactions[0].quantity).toBe(-50);
  });

  it('settles a fraction in cash when the policy says so (PART 11)', () => {
    const [change] = processor.plan(
      context(
        [holding({ quantity: 15, averageCost: 20, currentPrice: 44 })],
        action({ oldRatio: 2, newRatio: 1 }),
        { fractionalSharePolicy: 'CASH_IN_LIEU', cashInLieuPolicy: 'MARKET_PRICE' },
      ),
    );

    expect(change.impact.quantityAfter).toBe(7);
    expect(change.impact.fractionalShares).toBe(0.5);
    expect(change.impact.cashImpact).toBe(22);

    const cashRow = change.transactions.find((t) => t.type === 'CASH_IN_LIEU');
    expect(cashRow).toBeDefined();
    expect(cashRow!.amount).toBe(22);
  });

  it('reports a retained fraction even though no cash moved', () => {
    const [change] = processor.plan(
      context([holding({ quantity: 15, averageCost: 20 })], action({ oldRatio: 2, newRatio: 1 })),
    );

    expect(change.impact.quantityAfter).toBe(7.5);
    expect(change.impact.fractionalShares).toBe(0.5); // never rounded silently
    expect(change.impact.cashImpact).toBe(0);
  });
});

// ── PART 45 Tests 6 and 7 ───────────────────────────────────────────────────

describe('DividendProcessor — PART 45 Tests 6 and 7', () => {
  const processor = new DividendProcessor();

  const dividend = action({
    symbol: 'AAPL',
    actionType: 'DIVIDEND' as CorporateActionType,
    oldRatio: null,
    newRatio: null,
    cashAmount: 1,
    paymentDate: new Date('2026-09-15'),
  });

  it('Test 6: 10 AAPL shares at $1/share pays $10', () => {
    const [change] = processor.plan(
      context([holding({ ticker: 'AAPL', quantity: 10, averageCost: 150 })], dividend),
    );

    expect(change.impact.cashImpact).toBe(10);
    expect(change.transactions[0].type).toBe('DIVIDEND');
    expect(change.transactions[0].amount).toBe(10);
    expect(change.transactions[0].date).toEqual(new Date('2026-09-15'));
  });

  it('Test 7: a client with zero shares generates NO transaction at all', () => {
    const changes = processor.plan(
      context([holding({ ticker: 'AAPL', quantity: 0, averageCost: 0 })], dividend),
    );

    expect(changes).toHaveLength(0);
  });

  it('does not modify the share count or the average cost (PART 13)', () => {
    const [change] = processor.plan(
      context([holding({ ticker: 'AAPL', quantity: 10, averageCost: 150 })], dividend),
    );

    expect(change.impact.quantityAfter).toBe(10);
    expect(change.impact.averageCostAfter).toBe(150);
    expect(change.holdingUpdate).toBeNull();
  });

  it('books a special dividend under its own transaction type', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'AAPL', quantity: 10 })],
        action({
          ...dividend,
          actionType: 'SPECIAL_DIVIDEND' as CorporateActionType,
          cashAmount: 5,
        }),
      ),
    );

    expect(change.transactions[0].type).toBe('SPECIAL_DIVIDEND');
    expect(change.impact.cashImpact).toBe(50);
  });

  it('reduces cost basis for a return of capital rather than booking income', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'AAPL', quantity: 10, averageCost: 150 })],
        action({
          ...dividend,
          actionType: 'RETURN_OF_CAPITAL' as CorporateActionType,
          cashAmount: 10,
        }),
      ),
    );

    expect(change.impact.cashImpact).toBe(100); // 10 shares x $10
    expect(change.impact.averageCostAfter).toBe(140); // basis reduced
    expect(change.holdingUpdate).not.toBeNull();
  });

  it('floors basis at zero and flags the excess rather than going negative', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'AAPL', quantity: 10, averageCost: 5 })],
        action({
          ...dividend,
          actionType: 'RETURN_OF_CAPITAL' as CorporateActionType,
          cashAmount: 8,
        }),
      ),
    );

    expect(change.impact.averageCostAfter).toBe(0);
    expect(change.impact.note).toMatch(/exceeds the remaining cost basis/i);
  });

  it('warns when a record date is stale enough for entitlement to have drifted', () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    expect(entitlementWarning(longAgo)).toMatch(/CURRENT share counts/);

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    expect(entitlementWarning(yesterday)).toBeNull();
  });
});

// ── Bonus ───────────────────────────────────────────────────────────────────

describe('BonusProcessor (PART 12)', () => {
  const processor = new BonusProcessor();

  const bonus = (oldRatio: number, newRatio: number) =>
    action({ actionType: 'BONUS_ISSUE' as CorporateActionType, oldRatio, newRatio });

  it('1:1 bonus on 100 shares issues 100 more, halving average cost', () => {
    const [change] = processor.plan(context([holding()], bonus(1, 1)));

    expect(change.impact.quantityAfter).toBe(200);
    expect(change.impact.averageCostAfter).toBe(50);
    expect(change.transactions[0].type).toBe('BONUS');
    expect(change.transactions[0].quantity).toBe(100); // delta
  });

  it('uses BONUS semantics, not SPLIT semantics, for the same stored ratio', () => {
    // A 1:2 BONUS is one new share per two held -> 150.
    const [bonusChange] = processor.plan(context([holding()], bonus(2, 1)));
    expect(bonusChange.impact.quantityAfter).toBe(150);

    // The identical stored ratio read as a SPLIT would give 50. Proving the
    // two conventions are genuinely distinguished, not accidentally aliased.
    const splitChange = new StockSplitProcessor().plan(
      context([holding()], action({ oldRatio: 2, newRatio: 1 })),
    )[0];
    expect(splitChange.impact.quantityAfter).toBe(50);
  });

  it('never writes a BUY row and moves no cash', () => {
    const [change] = processor.plan(context([holding()], bonus(1, 1)));
    expect(change.transactions.every((t) => t.type !== 'BUY')).toBe(true);
    expect(change.transactions[0].amount).toBe(0);
    expect(change.impact.cashImpact).toBe(0);
  });

  it('preserves total economic cost', () => {
    const [change] = processor.plan(context([holding()], bonus(1, 1)));
    expect(change.impact.quantityAfter * change.impact.averageCostAfter).toBeCloseTo(10000, 6);
  });
});

// ── PART 45 Test 8 ──────────────────────────────────────────────────────────

describe('TickerChangeProcessor — PART 45 Test 8 (PART 19/20/21)', () => {
  const processor = new TickerChangeProcessor();

  const rename = action({
    symbol: 'ABC',
    actionType: 'TICKER_CHANGE' as CorporateActionType,
    oldRatio: null,
    newRatio: null,
    newSymbol: 'XYZ',
  });

  it('Test 8: renames the current holding without touching the economics', () => {
    const [change] = processor.plan(
      context([holding({ ticker: 'ABC', quantity: 100, averageCost: 50 })], rename),
    );

    expect(change.holdingUpdate!.ticker).toBe('XYZ');
    // Every economic field is identical either side.
    expect(change.impact.quantityBefore).toBe(change.impact.quantityAfter);
    expect(change.impact.averageCostBefore).toBe(change.impact.averageCostAfter);
    expect(change.impact.marketValueBefore).toBe(change.impact.marketValueAfter);
    expect(change.impact.cashImpact).toBe(0);
  });

  it('Test 8: creates no economic position — no shares and no cash on the row', () => {
    const [change] = processor.plan(context([holding({ ticker: 'ABC' })], rename));
    const [tx] = change.transactions;

    expect(tx.type).toBe('TICKER_CHANGE');
    expect(tx.quantity).toBeNull();
    expect(tx.amount).toBe(0);
  });

  it('Test 8: the marker row records the OLD symbol so history stays readable', () => {
    const [change] = processor.plan(context([holding({ ticker: 'ABC' })], rename));

    expect(change.transactions[0].description).toContain('ABC');
    expect(change.transactions[0].description).toContain('XYZ');
    // New rows use the new symbol.
    expect(change.transactions[0].ticker).toBe('XYZ');
  });

  it('handles a company name change without renaming the ticker', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'FB', company: 'Facebook Inc' })],
        action({
          symbol: 'FB',
          actionType: 'NAME_CHANGE' as CorporateActionType,
          oldRatio: null,
          newRatio: null,
          newCompany: 'Meta Platforms Inc',
        }),
      ),
    );

    expect(change.holdingUpdate!.company).toBe('Meta Platforms Inc');
    expect(change.holdingUpdate!.ticker).toBe('FB');
  });
});

// ── Spin-off, merger, rights ────────────────────────────────────────────────

describe('SpinOffProcessor (PART 17)', () => {
  const processor = new SpinOffProcessor();

  const spinOff = action({
    actionType: 'SPIN_OFF' as CorporateActionType,
    oldRatio: null,
    newRatio: null,
    newSymbol: 'NEWCO',
    newCompany: 'NewCo Inc',
    details: { distributionRatio: 0.2 },
  });

  it('distributes 20 new shares on 100 parent shares at a 1-for-5 ratio', () => {
    const [change] = processor.plan(context([holding()], spinOff));

    expect(change.newHolding).not.toBeNull();
    expect(change.newHolding!.ticker).toBe('NEWCO');
    expect(change.newHolding!.quantity).toBe(20);
  });

  it('does not treat the new security as a purchase', () => {
    const [change] = processor.plan(context([holding()], spinOff));
    const spinRow = change.transactions.find((t) => t.ticker === 'NEWCO');

    expect(spinRow!.type).toBe('SPINOFF');
    expect(spinRow!.amount).toBe(0);
  });

  it('leaves the parent share count untouched', () => {
    const [change] = processor.plan(context([holding()], spinOff));
    expect(change.impact.quantityAfter).toBe(change.impact.quantityBefore);
  });

  it('allocates basis when the issuer allocation is known', () => {
    const [change] = processor.plan(
      context(
        [holding()],
        action({ ...spinOff, details: { distributionRatio: 0.2, basisAllocationPercent: 25 } }),
      ),
    );

    // 25% of $10,000 moves to 20 NewCo shares -> $125/share.
    expect(change.newHolding!.averageCost).toBe(125);
    // The parent keeps 75% over its unchanged 100 shares.
    expect(change.impact.averageCostAfter).toBe(75);
  });
});

describe('MergerProcessor (PART 18)', () => {
  const processor = new MergerProcessor();

  it('converts 1 share into 0.75 new shares plus $10 cash', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'OLD', quantity: 100, averageCost: 50, marketValue: 8000 })],
        action({
          symbol: 'OLD',
          actionType: 'MERGER' as CorporateActionType,
          oldRatio: null,
          newRatio: null,
          newSymbol: 'NEW',
          details: { exchangeRatio: 0.75, cashPerShare: 10 },
        }),
      ),
    );

    expect(change.newHolding!.ticker).toBe('NEW');
    expect(change.newHolding!.quantity).toBe(75);
    expect(change.impact.cashImpact).toBe(1000); // 100 x $10
    // The old position closes.
    expect(change.impact.quantityAfter).toBe(0);
    expect(change.holdingUpdate!.quantity).toBe(0);
  });

  it('records the share leg and the cash leg as separate rows (PART 18)', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'OLD', quantity: 100, averageCost: 50, marketValue: 8000 })],
        action({
          symbol: 'OLD',
          actionType: 'MERGER' as CorporateActionType,
          oldRatio: null,
          newRatio: null,
          newSymbol: 'NEW',
          details: { exchangeRatio: 0.75, cashPerShare: 10 },
        }),
      ),
    );

    const shareLeg = change.transactions.find((t) => t.ticker === 'NEW' && t.quantity! > 0);
    const cashLeg = change.transactions.find((t) => t.amount > 0);

    expect(shareLeg).toBeDefined();
    expect(shareLeg!.amount).toBe(0); // non-economic
    expect(cashLeg).toBeDefined();
    expect(cashLeg!.amount).toBe(1000); // economic
  });

  it('handles an all-cash acquisition with no target symbol', () => {
    const [change] = processor.plan(
      context(
        [holding({ ticker: 'OLD', quantity: 100, averageCost: 50, marketValue: 8000 })],
        action({
          symbol: 'OLD',
          actionType: 'ACQUISITION' as CorporateActionType,
          oldRatio: null,
          newRatio: null,
          details: { cashPerShare: 90 },
        }),
      ),
    );

    expect(change.newHolding).toBeNull();
    expect(change.impact.cashImpact).toBe(9000);
    expect(change.holdingUpdate!.quantity).toBe(0);
  });
});

describe('RightsIssueProcessor (PART 16)', () => {
  const processor = new RightsIssueProcessor();

  const rights = action({
    actionType: 'RIGHTS_ISSUE' as CorporateActionType,
    oldRatio: null,
    newRatio: null,
    details: { subscriptionRatio: 0.1, subscriptionPrice: 45 },
  });

  it('accrues 10 rights on 100 shares at 1-per-10', () => {
    const [change] = processor.plan(context([holding()], rights));
    expect(change.impact.note).toContain('10 right(s)');
  });

  it('does NOT subscribe automatically — no cash and no shares move', () => {
    const [change] = processor.plan(context([holding()], rights));

    expect(change.impact.cashImpact).toBe(0);
    expect(change.impact.quantityAfter).toBe(change.impact.quantityBefore);
    expect(change.holdingUpdate).toBeNull();
    expect(change.transactions[0].type).toBe('RIGHTS_ENTITLEMENT');
    expect(change.transactions[0].amount).toBe(0);
    expect(change.transactions[0].quantity).toBeNull();
  });
});
