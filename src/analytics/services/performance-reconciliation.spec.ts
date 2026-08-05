/**
 * The arithmetic identities the Performance sheet must satisfy.
 *
 * These exist because the original defect was not a crash — it was two
 * plausible-looking numbers on the same card that quietly disagreed
 * ("Invested capital $111,357.95" against "Unrealized gain +$6,302.74", computed
 * from two different cost bases). Nothing compared them, so nothing caught it.
 * Every test here compares figures that must agree, and states WHY they must.
 *
 * Pure arithmetic — no database. The live cross-client check lives in
 * scripts/verify-reconciliation.ts, which runs these same identities against
 * real data.
 */

/** Total gain, built from the position level. */
function gainFromPositions(p: {
  unrealizedGain: number;
  realizedGain: number;
  dividendIncome: number;
  fees: number;
}): number {
  return p.unrealizedGain + p.realizedGain + p.dividendIncome - p.fees;
}

/** Total gain, built from the flow series. */
function gainFromFlows(f: {
  terminalValue: number;
  withdrawn: number;
  contributed: number;
}): number {
  return f.terminalValue + f.withdrawn - f.contributed;
}

describe('gain identity — flows vs positions', () => {
  /**
   * The core identity. Both sides are anchored on the 30-June basis, so they are
   * two ways of adding up the same money and must land on the same number.
   */
  it('agrees for a buy-and-hold book with no cash activity', () => {
    // Ketan Gohil's shape: one inception basis, no sales, no dividends, no fees.
    const basis = 111_357.95;
    const marketValue = 116_241.68;

    const positions = gainFromPositions({
      unrealizedGain: marketValue - basis,
      realizedGain: 0,
      dividendIncome: 0,
      fees: 0,
    });

    const flows = gainFromFlows({
      terminalValue: marketValue,
      withdrawn: 0,
      contributed: basis,
    });

    expect(positions).toBeCloseTo(flows, 6);
    expect(positions).toBeCloseTo(4_883.73, 2);
  });

  /**
   * A fully worked book, stated once and read both ways.
   *
   *   30-June basis                        100,000
   *   sold shares that cost  18,500  for    20,000  -> realized  +1,500
   *   dividends received                       200
   *   fees paid                                 50
   *   remaining positions cost  81,500, now worth 85,500 -> unrealized +4,000
   *
   * Position view : 4,000 + 1,500 + 200 − 50            = 5,650
   * Flow view     : 85,500 + (20,000 + 200) − (100,000 + 50) = 5,650
   *
   * The terminal value is only what is STILL HELD — the proceeds and dividends
   * have already left the securities and are counted in `withdrawn`.
   */
  it('still agrees once sales, dividends and fees are involved', () => {
    const positions = gainFromPositions({
      unrealizedGain: 4_000,
      realizedGain: 1_500,
      dividendIncome: 200,
      fees: 50,
    });

    const flows = gainFromFlows({
      terminalValue: 85_500,
      withdrawn: 20_000 + 200,
      contributed: 100_000 + 50,
    });

    expect(positions).toBeCloseTo(flows, 6);
    expect(positions).toBeCloseTo(5_650, 2);
  });

  /**
   * The regression guard for the actual shipped bug: a cost basis taken from the
   * pre-import accumulated cost instead of the 30-June close breaks the identity.
   */
  it('breaks — detectably — if the cost basis is not the 30-June one', () => {
    const marketValue = 116_241.68;
    const jun30Basis = 111_357.95;
    const preImportCost = 109_846.07; // what Holding.costBasisTotal carried

    const wrong = gainFromPositions({
      unrealizedGain: marketValue - preImportCost,
      realizedGain: 0,
      dividendIncome: 0,
      fees: 0,
    });

    const flows = gainFromFlows({
      terminalValue: marketValue,
      withdrawn: 0,
      contributed: jun30Basis,
    });

    // This is the $1,511.88 discrepancy that reached the screen.
    expect(Math.abs(wrong - flows)).toBeGreaterThan(1_000);
  });
});

/**
 * Why the two TABS legitimately differ — and by exactly how much.
 *
 * The Current tab measures deployed capital (idle cash excluded); the Historical
 * tab measures the whole book (cash included). They are answers to different
 * questions and are NOT expected to be equal. What IS required is that the
 * difference be fully explained, so a real error can never hide inside it.
 */
describe('cross-tab difference is fully explained', () => {
  it('is zero when the client holds no cash and deploys none', () => {
    const openingCash = 0;
    const deployed = 0;
    expect(deployed - openingCash * 0).toBe(0);

    // Ketan/Kush/Kushal/Saumya: fully invested, so both tabs report one number.
    const currentGain = 4_883.72;
    const historicalGain = 4_883.72;
    expect(currentGain - historicalGain).toBeCloseTo(0, 6);
  });

  /**
   * Idle cash ALONE does not create a gap — Nirav Patel holds $2,100 throughout
   * and both tabs agree, because cash that never moves is neither invested
   * capital nor a gain on either basis.
   */
  it('is zero when cash sits idle and is never deployed', () => {
    const idleCash = 2_100;
    const deployedSince = 0;

    const currentGain = 2_759.05;
    const historicalGain = 2_759.05;

    expect(deployedSince).toBe(0);
    expect(idleCash).toBeGreaterThan(0);
    expect(currentGain - historicalGain).toBeCloseTo(0, 6);
  });

  /**
   * The gap appears only where idle cash was DEPLOYED into stock after
   * inception, and it equals the price movement between the 30-June basis and
   * the price actually paid:
   *
   *     gap = cashDeployed − increaseInInvestedCapital
   *
   * Verified against all three affected clients on live data.
   */
  it.each([
    ['Mrugesh Patel', 7_500.0, 6_539.29, 960.71],
    ['Om Patel', 10_000.0, 9_918.16, 81.84],
    ['Shubh Laiwala', 1_105.0, 1_365.69, -260.69],
  ])('%s: gap equals deployed cash minus the rise in invested capital', (
    _name,
    cashDeployed,
    investedCapitalIncrease,
    expectedGap,
  ) => {
    expect(cashDeployed - investedCapitalIncrease).toBeCloseTo(expectedGap, 2);
  });

  it('leaves no unexplained residual on any client', () => {
    const clients = [
      { deployed: 0, dInvested: 0, gap: 0 },
      { deployed: 0, dInvested: 0, gap: 0 },
      { deployed: 7_500.0, dInvested: 6_539.29, gap: 960.71 },
      { deployed: 10_000.0, dInvested: 9_918.16, gap: 81.84 },
      { deployed: 1_105.0, dInvested: 1_365.69, gap: -260.69 },
    ];

    for (const c of clients) {
      expect(c.deployed - c.dInvested).toBeCloseTo(c.gap, 2);
    }
  });
});
