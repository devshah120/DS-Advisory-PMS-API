/**
 * The ratio arithmetic, proven against PART 45's Tests 1-5 plus the edge cases
 * those tests imply but do not state.
 *
 * Every split/reverse-split assertion here checks THREE things, not one:
 * quantity, average cost, and — the one that actually matters — that total
 * economic cost is unchanged. A processor that got quantity right and basis
 * wrong would pass a naive quantity-only test while quietly corrupting every
 * downstream gain/loss figure.
 */
import {
  applyRatio,
  bonusShares,
  formatRatioLabel,
  normalize,
  ratioMultiplier,
  rightsEntitlement,
  spinOffShares,
} from './ratio';

describe('ratioMultiplier', () => {
  it('reads old:new as "each `old` shares become `new`" (PART 6)', () => {
    // Forward splits — stored with newRatio > oldRatio.
    expect(ratioMultiplier(1, 2)).toBe(2); // 2-for-1:  100 -> 200
    expect(ratioMultiplier(2, 3)).toBeCloseTo(1.5, 10); // 3-for-2:  100 -> 150

    // Reverse splits — stored with newRatio < oldRatio. Same function, no
    // separate code path; a reverse split is just a multiplier below 1.
    expect(ratioMultiplier(2, 1)).toBe(0.5); // 1-for-2:  100 -> 50
    expect(ratioMultiplier(3, 2)).toBeCloseTo(0.6666666667, 9); // 2-for-3
    expect(ratioMultiplier(10, 1)).toBeCloseTo(0.1, 10); // 1-for-10:  10 -> 1
  });

  it('rejects a non-positive leg rather than clamping it (PART 6)', () => {
    expect(() => ratioMultiplier(0, 2)).toThrow(/greater than zero/);
    expect(() => ratioMultiplier(1, 0)).toThrow(/greater than zero/);
    expect(() => ratioMultiplier(-1, 2)).toThrow(/greater than zero/);
    expect(() => ratioMultiplier(NaN, 2)).toThrow(/finite/);
  });
});

describe('applyRatio — PART 45 acceptance tests', () => {
  // TEST 1 — the spec's primary example, and the APH case from PART 39.
  it('Test 1: 100 shares @ $100, 2:1 split -> 200 @ $50, cost unchanged', () => {
    const r = applyRatio({
      quantityBefore: 100,
      averageCostBefore: 100,
      oldRatio: 1,
      newRatio: 2,
    });

    expect(r.quantityAfter).toBe(200);
    expect(r.averageCostAfter).toBe(50);
    expect(r.totalCostBefore).toBe(10000);
    expect(r.totalCostAfter).toBe(10000);
    expect(r.cashInLieu).toBe(0);
  });

  /**
   * TEST 2 — and the one place the specification contradicts itself, so it is
   * pinned here deliberately rather than left to a reader's assumption.
   *
   * PART 6 defines the STORAGE convention: "3:2 means old_ratio = 3,
   * new_ratio = 2", i.e. every 3 shares become 2 — a multiplier of 2/3, which
   * takes 100 shares DOWN to 66.67.
   *
   * PART 45's Test 2 expects "100 shares, 3:2 split -> 150 shares", which is
   * the market's spoken convention for a "3-for-2 split": 3 new shares issued
   * for every 2 held, a multiplier of 3/2.
   *
   * Both cannot be true of one stored pair. This engine resolves it in favour
   * of PART 6, because the storage convention is what the validator, the
   * processors and the database all key off — and a real 3-for-2 split is then
   * stored oldRatio=2, newRatio=3. The ingest layer is where a provider's
   * "3:2" label gets turned into the right pair (see normalizeRatio in the
   * provider interface), which is the only place that judgement belongs.
   *
   * Both readings are asserted below so the distinction can never silently
   * invert again.
   */
  it('Test 2 (PART 6 storage reading): oldRatio=3,newRatio=2 -> 100 becomes 66.67', () => {
    const r = applyRatio({
      quantityBefore: 100,
      averageCostBefore: 90,
      oldRatio: 3,
      newRatio: 2,
    });

    expect(r.quantityAfter).toBeCloseTo(66.6666666667, 8);
    expect(r.averageCostAfter).toBeCloseTo(135, 6); // 90 * 3/2
    expect(r.totalCostAfter).toBeCloseTo(9000, 6);
  });

  it('Test 2 (PART 45 intent): a 3-FOR-2 split stored as 2:3 -> 150 @ 2/3 cost', () => {
    const r = applyRatio({
      quantityBefore: 100,
      averageCostBefore: 90,
      oldRatio: 2,
      newRatio: 3,
    });

    expect(r.quantityAfter).toBe(150);
    expect(r.averageCostAfter).toBeCloseTo(60, 10); // 90 * 2/3
    expect(r.totalCostAfter).toBeCloseTo(9000, 8);
  });

  // TEST 3 — reverse split via the same code path.
  it('Test 3: 100 shares, 1:2 reverse -> 50 shares at double the cost', () => {
    const r = applyRatio({
      quantityBefore: 100,
      averageCostBefore: 100,
      oldRatio: 2,
      newRatio: 1,
    });

    expect(r.quantityAfter).toBe(50);
    expect(r.averageCostAfter).toBe(200);
    expect(r.totalCostAfter).toBe(10000);
  });

  // TEST 4 — an odd lot that stays whole.
  it('Test 4: 15 shares, 2:1 split -> 30 shares, no fraction', () => {
    const r = applyRatio({
      quantityBefore: 15,
      averageCostBefore: 20,
      oldRatio: 1,
      newRatio: 2,
    });

    expect(r.quantityAfter).toBe(30);
    expect(r.fractionalShares).toBe(0);
    expect(r.totalCostAfter).toBe(300);
  });

  // TEST 5 — an odd lot that does NOT.
  it('Test 5: 15 shares, 1:2 reverse -> 7.5 when fractions are retained', () => {
    const r = applyRatio({
      quantityBefore: 15,
      averageCostBefore: 20,
      oldRatio: 2,
      newRatio: 1,
      policy: 'RETAIN',
    });

    expect(r.quantityAfter).toBe(7.5);
    expect(r.averageCostAfter).toBe(40);
    expect(r.totalCostAfter).toBe(300);
    // Reported even though it was kept — PART 11's audit requirement.
    expect(r.fractionalShares).toBe(0.5);
  });

  // The PART 10 worked example, which uses a different lot size to Test 3.
  it('PART 10: 10 shares @ $10, 10:1 reverse -> 1 share @ $100', () => {
    const r = applyRatio({
      quantityBefore: 10,
      averageCostBefore: 10,
      oldRatio: 10,
      newRatio: 1,
    });

    expect(r.quantityAfter).toBe(1);
    expect(r.averageCostAfter).toBe(100);
    expect(r.totalCostAfter).toBe(100);
  });
});

describe('applyRatio — the economic invariant', () => {
  /**
   * The property that PART 2, 27 and 52 all reduce to. Checked across a spread
   * of ratios and lot sizes rather than at one point, because a formula that
   * holds at 2:1 and breaks at 7:3 is exactly the failure a single example
   * misses.
   */
  const ratios: Array<[number, number]> = [
    [1, 2],
    [1, 3],
    [2, 3],
    [3, 2],
    [2, 1],
    [10, 1],
    [7, 3],
    [1, 1],
    [20, 7],
  ];
  const lots = [1, 15, 100, 1240, 33333];

  /**
   * Tolerance is RELATIVE, not absolute, and that distinction matters here.
   *
   * `averageCostAfter` is deliberately rounded to 10 decimal places before it
   * is stored — a per-share cost of 91.6133333333333331 is noise, and the
   * column should hold a clean figure. On a 33,333-share lot that 1e-11
   * per-share rounding multiplies back up to ~1e-6 of total cost, so an
   * absolute-epsilon assertion would fail for a reason that is arithmetically
   * correct and financially meaningless (a fraction of a cent on $4.6m).
   *
   * A relative bound of 1e-9 is far tighter than any currency needs while
   * remaining honest about what float64 can carry across a round trip.
   */
  const expectRelativelyEqual = (actual: number, expected: number) => {
    const scale = Math.max(1, Math.abs(expected));
    expect(Math.abs(actual - expected) / scale).toBeLessThan(1e-9);
  };

  it.each(ratios)('preserves total cost across a %i:%i ratio', (oldR, newR) => {
    for (const qty of lots) {
      const r = applyRatio({
        quantityBefore: qty,
        averageCostBefore: 137.42,
        oldRatio: oldR,
        newRatio: newR,
        policy: 'RETAIN',
      });

      // The invariant, stated directly.
      expectRelativelyEqual(r.quantityAfter * r.averageCostAfter, qty * 137.42);
      expectRelativelyEqual(r.totalCostAfter, r.totalCostBefore);
    }
  });

  it('never produces a negative or -0 quantity', () => {
    const r = applyRatio({
      quantityBefore: 0,
      averageCostBefore: 100,
      oldRatio: 1,
      newRatio: 2,
    });
    expect(r.quantityAfter).toBe(0);
    expect(Object.is(r.quantityAfter, -0)).toBe(false);
  });

  it('leaves a zero position alone (a closed lot is not affected by a split)', () => {
    const r = applyRatio({
      quantityBefore: 0,
      averageCostBefore: 0,
      oldRatio: 1,
      newRatio: 2,
    });
    expect(r.quantityAfter).toBe(0);
    expect(r.totalCostAfter).toBe(0);
  });

  it('is free of binary floating-point residue on a 1:3 split', () => {
    const r = applyRatio({
      quantityBefore: 100,
      averageCostBefore: 30,
      oldRatio: 1,
      newRatio: 3,
    });
    // 100/3 * 3 in raw IEEE-754 is 299.99999999999994.
    expect(r.quantityAfter).toBe(300);
    expect(r.averageCostAfter).toBe(10);
  });
});

describe('applyRatio — fractional share policy (PART 11)', () => {
  it('CASH_IN_LIEU rounds down and pays the fraction at market price', () => {
    const r = applyRatio({
      quantityBefore: 15,
      averageCostBefore: 20,
      oldRatio: 2,
      newRatio: 1,
      policy: 'CASH_IN_LIEU',
      marketPrice: 44,
    });

    expect(r.quantityAfter).toBe(7);
    expect(r.fractionalShares).toBe(0.5);
    expect(r.cashInLieu).toBe(22); // 0.5 x 44
    // Basis leaves with the shares: 300 x (0.5/7.5) = 20 removed.
    expect(r.totalCostAfter).toBeCloseTo(280, 8);
    expect(r.averageCostAfter).toBeCloseTo(40, 8);
  });

  it('CASH_IN_LIEU falls back to average cost when no market price is known', () => {
    const r = applyRatio({
      quantityBefore: 15,
      averageCostBefore: 20,
      oldRatio: 2,
      newRatio: 1,
      policy: 'CASH_IN_LIEU',
    });
    // Post-action average cost is 40; the half share settles at 20.
    expect(r.cashInLieu).toBe(20);
  });

  it('ROUND_DOWN drops the fraction with no cash, but still reports it', () => {
    const r = applyRatio({
      quantityBefore: 15,
      averageCostBefore: 20,
      oldRatio: 2,
      newRatio: 1,
      policy: 'ROUND_DOWN',
    });

    expect(r.quantityAfter).toBe(7);
    expect(r.cashInLieu).toBe(0);
    expect(r.fractionalShares).toBe(0.5); // never rounded silently
  });

  it('leaves a whole result untouched under every policy', () => {
    for (const policy of ['RETAIN', 'CASH_IN_LIEU', 'ROUND_DOWN'] as const) {
      const r = applyRatio({
        quantityBefore: 100,
        averageCostBefore: 100,
        oldRatio: 1,
        newRatio: 2,
        policy,
        marketPrice: 80,
      });
      expect(r.quantityAfter).toBe(200);
      expect(r.cashInLieu).toBe(0);
      expect(r.fractionalShares).toBe(0);
    }
  });
});

describe('bonusShares (PART 12)', () => {
  it('1:1 bonus on 100 shares issues 100 additional shares', () => {
    expect(bonusShares(100, 1, 1)).toBe(100);
  });

  it('1:2 bonus (one new for every two held) issues 50 on 100', () => {
    expect(bonusShares(100, 1, 2)).toBe(50);
  });

  it('3:5 bonus issues 60 on 100', () => {
    expect(bonusShares(100, 3, 5)).toBe(60);
  });
});

describe('rightsEntitlement (PART 16)', () => {
  it('1 right per 10 shares gives 10 rights on 100 shares', () => {
    expect(rightsEntitlement(100, 1, 10)).toEqual({ rights: 10, fractional: 0 });
  });

  it('reports the dropped fraction rather than hiding it', () => {
    expect(rightsEntitlement(105, 1, 10)).toEqual({ rights: 10, fractional: 0.5 });
  });
});

describe('spinOffShares (PART 17)', () => {
  it('1-for-5 (ratio 0.2) on 100 parent shares distributes 20', () => {
    expect(spinOffShares(100, 0.2)).toBe(20);
  });

  it('rejects a non-positive distribution ratio', () => {
    expect(() => spinOffShares(100, 0)).toThrow(/greater than 0|> 0/);
  });
});

describe('formatRatioLabel', () => {
  it('speaks a stored 1:2 as the "2:1" the desk says out loud', () => {
    expect(formatRatioLabel(1, 2)).toBe('2:1');
  });

  it('speaks a stored 3:2 as "2:3" — storage is old:new, display is new:old', () => {
    expect(formatRatioLabel(3, 2)).toBe('2:3');
  });

  it('renders a reverse split as 1:10', () => {
    expect(formatRatioLabel(10, 1)).toBe('1:10');
  });
});

describe('normalize', () => {
  it('strips IEEE-754 residue', () => {
    expect(normalize(199.99999999999997)).toBe(200);
    expect(normalize(0.1 + 0.2)).toBe(0.3);
  });

  it('turns -0 into 0', () => {
    expect(Object.is(normalize(-0), 0)).toBe(true);
  });

  it('leaves a genuine fractional quantity intact', () => {
    expect(normalize(7.5)).toBe(7.5);
    expect(normalize(0.00012345)).toBe(0.00012345);
  });
});
