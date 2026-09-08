/**
 * The arithmetic of a ratio-based corporate action, as pure functions.
 *
 * Everything here is deliberately free of Prisma, Nest and dates so that the
 * one calculation the whole engine turns on can be proven in a unit test
 * without a database. If a split ever adjusts a client's book wrongly, the bug
 * is either here or in the plumbing that calls it — and this half is provable.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 * A ratio action changes how many pieces a position is cut into. It does not
 * change what the position is WORTH and it does not change what it COST:
 *
 *     quantityAfter x averageCostAfter  ===  quantityBefore x averageCostBefore
 *
 * That identity is PART 2, PART 27 and PART 52 of the spec restated as one
 * line, and `applyRatio` is written so it holds by construction rather than by
 * two independent formulas that happen to agree. Average cost is derived by
 * dividing the UNCHANGED total cost by the new quantity — not by multiplying
 * the old average cost by the inverse ratio. Algebraically identical; only the
 * first is immune to the two drifting apart under floating point.
 *
 * ── Direction ───────────────────────────────────────────────────────────────
 *
 * There is no separate reverse-split formula. '1:2' (multiplier 2) doubles the
 * count; '10:1' (multiplier 0.1) tenths it. A reverse split is a forward split
 * with a multiplier below 1, and giving it its own code path would be two
 * chances to get one calculation wrong.
 */

/** How a fractional remainder is disposed of. Mirrors AppSetting.caFractionalSharePolicy. */
export type FractionalSharePolicy = 'RETAIN' | 'CASH_IN_LIEU' | 'ROUND_DOWN';

export interface RatioInput {
  quantityBefore: number;
  averageCostBefore: number;
  /** Left side of 'old:new'. Must be > 0 (PART 6). */
  oldRatio: number;
  /** Right side of 'old:new'. Must be > 0 (PART 6). */
  newRatio: number;
  policy?: FractionalSharePolicy;
  /**
   * Price used to value a fractional remainder under CASH_IN_LIEU. Falls back
   * to average cost when absent, which is the conservative choice: it books no
   * gain on a fraction whose market price we could not establish.
   */
  marketPrice?: number;
}

export interface RatioResult {
  quantityAfter: number;
  averageCostAfter: number;
  /** Unchanged by definition — returned so callers can assert on it. */
  totalCostBefore: number;
  totalCostAfter: number;
  /**
   * The fraction that arose before the policy was applied. Non-zero even when
   * the policy RETAINs it (in which case it stayed on the position) — this is
   * the field that makes PART 11's "never round silently" auditable.
   */
  fractionalShares: number;
  /** Cash paid for the fraction. Zero unless the policy is CASH_IN_LIEU. */
  cashInLieu: number;
}

/** Floating-point noise floor. Below this a quantity or fraction is zero. */
const EPSILON = 1e-9;

/**
 * Rounds to 10 decimal places to stop IEEE-754 residue from turning an exact
 * result into 199.99999999999997.
 *
 * Ten places is chosen against the domain, not arbitrarily: brokers quote
 * fractional shares to at most 8 decimals, so 10 preserves every real quantity
 * while discarding everything below the last meaningful digit. Applied to
 * quantities and per-share costs, never to a running total that later gets
 * multiplied — rounding an input is how a rounding rule becomes a rounding
 * ERROR.
 */
export function normalize(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Number(value.toFixed(10));
  // -0 is a valid double but reads as a bug in a quantity column.
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * The share multiplier for a ratio. `oldRatio:newRatio` means each `oldRatio`
 * shares become `newRatio` shares, so the factor is newRatio/oldRatio:
 *
 *   1:2  -> 2.0    (2-for-1 forward split: 100 -> 200)
 *   3:2  -> 1.5    (3-for-2 split:          100 -> 150)
 *   2:1  -> 0.5    (2-to-1 REVERSE:         100 -> 50)
 *   10:1 -> 0.1    (10-to-1 reverse:         10 -> 1)
 */
export function ratioMultiplier(oldRatio: number, newRatio: number): number {
  assertUsableRatio(oldRatio, newRatio);
  return newRatio / oldRatio;
}

/**
 * Throws unless both legs are finite and strictly positive (PART 6).
 *
 * A zero or negative leg is not a recoverable input to clamp — a 0:1 split has
 * no meaning, and silently treating it as 1:1 would leave a wrong position
 * looking successfully processed. It fails loudly instead.
 */
export function assertUsableRatio(oldRatio: number, newRatio: number): void {
  if (!Number.isFinite(oldRatio) || !Number.isFinite(newRatio)) {
    throw new Error(`Ratio must be finite; received ${oldRatio}:${newRatio}`);
  }
  if (oldRatio <= 0 || newRatio <= 0) {
    throw new Error(
      `Ratio legs must both be greater than zero; received ${oldRatio}:${newRatio}`,
    );
  }
}

/**
 * Applies a ratio to one position.
 *
 * Total cost is computed once, up front, and then never touched — the new
 * average cost is that same figure divided by the new quantity. This is what
 * makes the economic-preservation invariant structural rather than incidental.
 *
 * Under CASH_IN_LIEU the fraction leaves the position, so the cost basis it
 * represented leaves with it: total cost is reduced pro-rata rather than being
 * spread over the remaining whole shares. Keeping the full basis on fewer
 * shares would quietly inflate their average cost and understate the gain on a
 * later sale.
 */
export function applyRatio(input: RatioInput): RatioResult {
  const { quantityBefore, averageCostBefore, oldRatio, newRatio } = input;
  const policy: FractionalSharePolicy = input.policy ?? 'RETAIN';

  assertUsableRatio(oldRatio, newRatio);

  const totalCostBefore = normalize(quantityBefore * averageCostBefore);

  // A closed or empty position is untouched by a ratio action. Returning early
  // avoids a 0/0 average cost below.
  if (Math.abs(quantityBefore) < EPSILON) {
    return {
      quantityAfter: 0,
      averageCostAfter: averageCostBefore,
      totalCostBefore,
      totalCostAfter: totalCostBefore,
      fractionalShares: 0,
      cashInLieu: 0,
    };
  }

  const multiplier = newRatio / oldRatio;
  const rawQuantity = normalize(quantityBefore * multiplier);

  // The fraction is what a whole-share-only broker could not issue. Computed
  // against the RAW result, before any policy is applied.
  const wholeQuantity = Math.floor(rawQuantity + EPSILON);
  const fractionalShares = normalize(rawQuantity - wholeQuantity);

  let quantityAfter = rawQuantity;
  let totalCostAfter = totalCostBefore;
  let cashInLieu = 0;

  if (fractionalShares > EPSILON && policy !== 'RETAIN') {
    quantityAfter = wholeQuantity;

    // Cost carried by the fraction, at the post-action average cost. Derived
    // from the ratio of the fraction to the raw quantity so it needs no
    // separate per-share figure and cannot disagree with one.
    const costOfFraction = normalize(totalCostBefore * (fractionalShares / rawQuantity));
    totalCostAfter = normalize(totalCostBefore - costOfFraction);

    if (policy === 'CASH_IN_LIEU') {
      // Market price where we have one, average cost otherwise — see RatioInput.
      const perShare =
        input.marketPrice !== undefined && Number.isFinite(input.marketPrice)
          ? input.marketPrice
          : rawQuantity > 0
            ? totalCostBefore / rawQuantity
            : 0;
      cashInLieu = normalize(fractionalShares * perShare);
    }
    // ROUND_DOWN: basis is removed with the shares, but no cash is paid. The
    // fraction is still reported on the ledger row.
  }

  const averageCostAfter =
    Math.abs(quantityAfter) < EPSILON ? 0 : normalize(totalCostAfter / quantityAfter);

  return {
    quantityAfter: normalize(quantityAfter),
    averageCostAfter,
    totalCostBefore,
    totalCostAfter: normalize(totalCostAfter),
    fractionalShares,
    cashInLieu,
  };
}

/**
 * Additional shares a BONUS or STOCK_DIVIDEND issue produces (PART 12).
 *
 * A bonus is quoted as "N new for every M held" — 1:1 means one extra share
 * per share held, taking 100 to 200. Note this differs from a SPLIT ratio,
 * where 1:2 also takes 100 to 200 but is read as "each 1 becomes 2". Same
 * outcome, different convention, and conflating them is the single easiest way
 * to double a client's position by mistake — which is why bonus arithmetic
 * lives in its own function rather than reusing applyRatio.
 */
export function bonusShares(
  quantityBefore: number,
  bonusNew: number,
  bonusFor: number,
): number {
  assertUsableRatio(bonusFor, bonusNew);
  return normalize(quantityBefore * (bonusNew / bonusFor));
}

/**
 * Rights ENTITLEMENT — how many rights a holder accrues (PART 16).
 *
 * "1 right for every 10 shares" is rightsNew=1, rightsFor=10. Entitlements are
 * whole by market convention; the fraction is reported so the desk can see
 * what was dropped rather than discovering it as a discrepancy later.
 */
export function rightsEntitlement(
  quantityBefore: number,
  rightsNew: number,
  rightsFor: number,
): { rights: number; fractional: number } {
  assertUsableRatio(rightsFor, rightsNew);
  const raw = normalize(quantityBefore * (rightsNew / rightsFor));
  const whole = Math.floor(raw + EPSILON);
  return { rights: whole, fractional: normalize(raw - whole) };
}

/**
 * Shares of the NEW security a spin-off distributes (PART 17).
 *
 * "1 new share for every 5 parent shares" is distributionRatio 1/5 = 0.2, so
 * 100 parent shares yield 20. Callers pass the ratio already divided because
 * feeds quote spin-offs both ways ("0.2 shares per share" and "1 for 5") and
 * normalising at the parse boundary keeps one convention inside the engine.
 */
export function spinOffShares(parentQuantity: number, distributionRatio: number): number {
  if (!Number.isFinite(distributionRatio) || distributionRatio <= 0) {
    throw new Error(`Spin-off distribution ratio must be > 0; received ${distributionRatio}`);
  }
  return normalize(parentQuantity * distributionRatio);
}

/**
 * Formats a ratio the way the desk says it out loud: '2:1' for a 2-for-1
 * split. Note the INVERSION against storage — a 2-for-1 is stored 1:2
 * (each 1 share becomes 2) but is universally spoken and printed as "2:1".
 *
 * Getting this backwards on screen is a support call, not a data bug, so the
 * conversion is confined to this one function and the UI never does it itself.
 */
export function formatRatioLabel(oldRatio: number, newRatio: number): string {
  if (!Number.isFinite(oldRatio) || !Number.isFinite(newRatio)) return '—';
  return `${trimNumber(newRatio)}:${trimNumber(oldRatio)}`;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(normalize(n));
}
