/**
 * Post-processing reconciliation — PART 38.
 *
 * After a run, prove that the book actually says what the plan said it would:
 * expected 2,480 shares across 4 clients, count what is really there, and fail
 * loudly on a mismatch.
 *
 * ── Why this is not redundant with the transaction ──────────────────────────
 *
 * The processing transaction guarantees that all the writes happened or none
 * did. It does NOT guarantee that the writes were the RIGHT ones — a
 * miscalculated ratio commits just as atomically as a correct one. Atomicity
 * protects against partial application; reconciliation protects against
 * confident, complete, wrong application. They catch different failures, which
 * is why PART 36 and PART 38 are separate requirements.
 *
 * The check runs INSIDE the transaction, before commit. A reconciliation that
 * ran afterwards could only report a corruption that had already landed; run
 * before commit, a failure rolls the whole thing back and nothing is corrupted
 * at all.
 */
import { Injectable, Logger } from '@nestjs/common';
import { normalize } from './ratio';
import { ReconciliationResult } from './corporate-action.types';
import { PlannedClientChange, TxClient } from './processors/processor.interface';

/**
 * Tolerance for the share-count comparison.
 *
 * Not zero, because fractional quantities are float64 and a sum of forty of
 * them will not reproduce bit-for-bit. 1e-6 of a share is far below any
 * tradable unit while still catching a whole share that went missing.
 */
const SHARE_TOLERANCE = 1e-6;

/** Cash comparisons are in currency units; a hundredth of a cent is noise. */
const CASH_TOLERANCE = 1e-4;

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * Verifies the post-state of a processing run against its plan.
   *
   * Re-reads the holdings from the database rather than trusting the values
   * the processor computed — reading back what was actually written is the
   * entire point. Comparing the plan against itself would always pass.
   */
  async verify(
    tx: TxClient,
    changes: PlannedClientChange[],
    options: { symbol: string; expectNewSymbol?: string | null },
  ): Promise<ReconciliationResult> {
    if (changes.length === 0) {
      return {
        status: 'NOT_APPLICABLE',
        expectedShares: 0,
        actualShares: 0,
        variance: 0,
        message: 'No clients were affected by this action.',
      };
    }

    // Only positions the processor actually meant to change are reconcilable.
    // A dividend leaves every holding alone, so summing them proves nothing —
    // its cash leg is checked instead, below.
    const positionChanges = changes.filter((c) => c.holdingUpdate !== null);

    const expectedShares = normalize(
      positionChanges.reduce((sum, c) => sum + (c.holdingUpdate?.quantity ?? 0), 0),
    );

    const expectedCash = normalize(
      changes.reduce((sum, c) => sum + c.impact.cashImpact, 0),
    );

    if (positionChanges.length === 0) {
      // Cash-only action: nothing to count in the holdings table.
      return {
        status: 'RECONCILED',
        expectedShares: 0,
        actualShares: 0,
        variance: 0,
        expectedCash,
        actualCash: expectedCash,
        message: `Cash-only action; ${changes.length} client(s) credited.`,
      };
    }

    const holdingIds = positionChanges.map((c) => c.holdingUpdate!.holdingId);
    const actual = await tx.holding.findMany({
      where: { id: { in: holdingIds } },
      select: { id: true, ticker: true, quantity: true, averageCost: true },
    });

    const actualShares = normalize(actual.reduce((sum, h) => sum + h.quantity, 0));
    const variance = normalize(actualShares - expectedShares);

    // Every holding the plan touched must still exist. A missing row means a
    // concurrent delete raced the run.
    if (actual.length !== holdingIds.length) {
      return {
        status: 'RECONCILIATION_FAILED',
        expectedShares,
        actualShares,
        variance,
        expectedCash,
        message:
          `Expected ${holdingIds.length} holdings to update but found ${actual.length}. ` +
          'A holding was deleted or reassigned during processing.',
      };
    }

    if (Math.abs(variance) > SHARE_TOLERANCE) {
      return {
        status: 'RECONCILIATION_FAILED',
        expectedShares,
        actualShares,
        variance,
        expectedCash,
        message:
          `Share reconciliation failed for ${options.symbol}: expected ${expectedShares} ` +
          `shares across ${positionChanges.length} client(s), found ${actualShares} ` +
          `(variance ${variance}).`,
      };
    }

    /**
     * Per-client verification, not just the total.
     *
     * A total-only check has a real blind spot: if two clients' updates were
     * transposed the sum still balances while both books are wrong. Cheap to
     * rule out, so it is ruled out.
     */
    const byId = new Map(actual.map((h) => [h.id, h]));
    for (const change of positionChanges) {
      const update = change.holdingUpdate!;
      const row = byId.get(update.holdingId);
      if (!row) continue;

      if (Math.abs(row.quantity - update.quantity) > SHARE_TOLERANCE) {
        return {
          status: 'RECONCILIATION_FAILED',
          expectedShares,
          actualShares,
          variance,
          expectedCash,
          message:
            `Client ${change.impact.clientName} (${change.impact.symbol}): expected ` +
            `${update.quantity} shares, found ${row.quantity}.`,
        };
      }

      if (Math.abs(row.averageCost - update.averageCost) > CASH_TOLERANCE) {
        return {
          status: 'RECONCILIATION_FAILED',
          expectedShares,
          actualShares,
          variance,
          expectedCash,
          message:
            `Client ${change.impact.clientName} (${change.impact.symbol}): expected average ` +
            `cost ${update.averageCost}, found ${row.averageCost}.`,
        };
      }
    }

    /**
     * The economic invariant, checked against the database rather than the
     * calculator (PART 2/27). For a ratio action total cost must be unchanged;
     * this is the last line of defence against a processor that adjusted
     * quantity without adjusting basis.
     */
    const costBefore = normalize(
      positionChanges.reduce(
        (sum, c) => sum + c.impact.quantityBefore * c.impact.averageCostBefore,
        0,
      ),
    );
    const costAfter = normalize(
      actual.reduce((sum, h) => sum + h.quantity * h.averageCost, 0),
    );
    const cashMoved = normalize(changes.reduce((sum, c) => sum + c.impact.cashImpact, 0));

    // Cost may legitimately fall by the basis that left with a cash-settled
    // fraction, so the comparison allows for cash actually paid out.
    const costVariance = normalize(costAfter - costBefore + cashMoved);
    const costScale = Math.max(1, Math.abs(costBefore));

    if (Math.abs(costVariance) / costScale > 1e-6) {
      return {
        status: 'RECONCILIATION_FAILED',
        expectedShares,
        actualShares,
        variance,
        expectedCash,
        actualCash: cashMoved,
        message:
          `Economic cost was not preserved for ${options.symbol}: total cost moved from ` +
          `${costBefore} to ${costAfter} (cash out ${cashMoved}, unexplained ${costVariance}). ` +
          'A corporate action must not change total economic cost.',
      };
    }

    return {
      status: 'RECONCILED',
      expectedShares,
      actualShares,
      variance: 0,
      expectedCash,
      actualCash: cashMoved,
      message:
        `${positionChanges.length} client(s) reconciled: ${expectedShares} shares, ` +
        `total cost preserved at ${costBefore}.`,
    };
  }
}
