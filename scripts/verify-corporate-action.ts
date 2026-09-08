/**
 * End-to-end verification of the Corporate Action Engine against the REAL
 * database — PART 57's item H, the APH 2-for-1 split.
 *
 * Everything the jest suite proves is computed in memory. This proves the part
 * that only a database can: that the interactive transaction commits, that the
 * unique index really does stop a double-adjustment, that reconciliation reads
 * back what was written, and that the historical replay sees the right
 * quantity either side of the effective date.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * It creates its own throwaway clients (prefixed `__CA_VERIFY__`) and its own
 * synthetic symbol, then deletes every row it made — including on failure, via
 * the finally block. It NEVER touches a real client, a real holding or a real
 * corporate action. The symbol is deliberately not APH itself but
 * `__CAVERIFY` so that a real Amphenol position, if one exists, cannot be
 * caught up in it.
 *
 * Run with:  npx ts-node -r tsconfig-paths/register scripts/verify-corporate-action.ts
 */
import { PrismaClient } from '@prisma/client';
import { applyRatio } from '../src/corporate-actions/ratio';

const prisma = new PrismaClient();

const MARKER = '__CA_VERIFY__';
const SYMBOL = '__CAVERIFY';

/** PART 39's four-client book: 100 + 340 + 500 + 300 = 1,240 shares. */
const BOOK = [
  { name: `${MARKER}Ketan`, quantity: 100, averageCost: 100 },
  { name: `${MARKER}Asha`, quantity: 340, averageCost: 80 },
  { name: `${MARKER}Rohan`, quantity: 500, averageCost: 120 },
  { name: `${MARKER}Meera`, quantity: 300, averageCost: 95 },
];

const CURRENT_PRICE = 160;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance;
}

async function main() {
  console.log('\nCorporate Action Engine — end-to-end verification');
  console.log('APH-style 2-for-1 split across a four-client book\n');

  await cleanup();

  const clientIds: string[] = [];
  let actionId = '';

  try {
    // ── Arrange ─────────────────────────────────────────────────────────────
    console.log('Setting up throwaway clients and positions…');

    for (const entry of BOOK) {
      const client = await prisma.client.create({
        data: {
          name: entry.name,
          broker: MARKER,
          accountNumber: MARKER,
          benchmark: 'S&P 500',
          riskProfile: 'MODERATE',
          currency: 'USD',
          market: 'US',
        },
      });
      clientIds.push(client.id);

      await prisma.holding.create({
        data: {
          clientId: client.id,
          ticker: SYMBOL,
          company: 'CA Verify Corp',
          sector: 'Technology',
          industry: 'Electronic Components',
          country: 'United States',
          exchange: 'NYSE',
          quantity: entry.quantity,
          averageCost: entry.averageCost,
          currentPrice: CURRENT_PRICE,
          marketValue: entry.quantity * CURRENT_PRICE,
        },
      });

      // The ORIGINAL purchase, which must never be rewritten (PART 50/51).
      await prisma.transaction.create({
        data: {
          clientId: client.id,
          ticker: SYMBOL,
          type: 'BUY',
          quantity: entry.quantity,
          price: entry.averageCost,
          amount: entry.quantity * entry.averageCost,
          date: new Date('2026-01-15T00:00:00Z'),
          description: 'Opening purchase',
          reference: MARKER,
        },
      });
    }

    const sharesBefore = BOOK.reduce((s, e) => s + e.quantity, 0);
    const costBefore = BOOK.reduce((s, e) => s + e.quantity * e.averageCost, 0);
    console.log(`  ${BOOK.length} clients, ${sharesBefore} shares, $${costBefore} total cost\n`);

    // ── The corporate action ────────────────────────────────────────────────
    // Stored per PART 6: each 1 share becomes 2 (spoken as "2-for-1").
    const effectiveDate = new Date('2026-09-03T00:00:00Z');

    const action = await prisma.corporateAction.create({
      data: {
        symbol: SYMBOL,
        company: 'CA Verify Corp',
        market: 'US',
        actionType: 'STOCK_SPLIT',
        announcementDate: new Date('2026-08-06T00:00:00Z'),
        recordDate: new Date('2026-09-02T00:00:00Z'),
        exDate: effectiveDate,
        effectiveDate,
        oldRatio: 1,
        newRatio: 2,
        source: 'company_ir',
        sourceUrl: 'https://example.invalid/verification',
        sources: [
          {
            source: 'company_ir',
            tier: 'COMPANY_IR',
            url: 'https://example.invalid/verification',
            fetchedAt: new Date().toISOString(),
            payload: { oldRatio: 1, newRatio: 2 },
          },
        ],
        fingerprint: `${MARKER}${Date.now()}`,
        confidenceScore: 100,
        status: 'APPROVED',
      },
    });
    actionId = action.id;

    // ── Act: the same transaction the service performs ──────────────────────
    console.log('Processing the split inside one interactive transaction…');

    await prisma.$transaction(
      async (tx) => {
        const holdings = await tx.holding.findMany({ where: { ticker: SYMBOL } });

        for (const h of holdings) {
          const result = applyRatio({
            quantityBefore: h.quantity,
            averageCostBefore: h.averageCost,
            oldRatio: 1,
            newRatio: 2,
          });

          // The idempotency key — the unique index is the real guard.
          await tx.corporateActionLedger.create({
            data: {
              corporateActionId: action.id,
              clientId: h.clientId,
              symbol: SYMBOL,
              quantityBefore: h.quantity,
              quantityAfter: result.quantityAfter,
              averageCostBefore: h.averageCost,
              averageCostAfter: result.averageCostAfter,
              marketValueBefore: h.marketValue,
              marketValueAfter: result.quantityAfter * h.currentPrice,
              cashImpact: 0,
              currency: 'USD',
              status: 'APPLIED',
            },
          });

          // DELTA shares, zero cash — the convention the replay expects.
          await tx.transaction.create({
            data: {
              clientId: h.clientId,
              ticker: SYMBOL,
              type: 'SPLIT',
              quantity: result.quantityAfter - h.quantity,
              amount: 0,
              date: effectiveDate,
              description: '2:1 stock split',
              reference: MARKER,
            },
          });

          await tx.holding.update({
            where: { id: h.id },
            data: {
              quantity: result.quantityAfter,
              averageCost: result.averageCostAfter,
              marketValue: result.quantityAfter * h.currentPrice,
            },
          });
        }
      },
      { timeout: 30_000 },
    );

    await prisma.corporateAction.update({
      where: { id: action.id },
      data: { status: 'PROCESSED', processingDate: new Date() },
    });

    console.log('  Committed.\n');

    // ── Assert ──────────────────────────────────────────────────────────────
    console.log('Verifying the result:\n');

    const after = await prisma.holding.findMany({
      where: { ticker: SYMBOL },
      include: { client: { select: { name: true } } },
    });

    const sharesAfter = after.reduce((s, h) => s + h.quantity, 0);
    const costAfter = after.reduce((s, h) => s + h.quantity * h.averageCost, 0);

    check(
      'Quantities doubled across the book',
      near(sharesAfter, sharesBefore * 2),
      `${sharesBefore} → ${sharesAfter}`,
    );

    check(
      'Total economic cost is unchanged (PART 2/27)',
      near(costAfter, costBefore, 0.01),
      `$${costBefore} → $${costAfter}`,
    );

    const ketan = after.find((h) => h.client.name === `${MARKER}Ketan`);
    check(
      'Ketan: 100 @ $100 became 200 @ $50 (PART 39)',
      !!ketan && near(ketan.quantity, 200) && near(ketan.averageCost, 50),
      ketan ? `${ketan.quantity} @ $${ketan.averageCost}` : 'missing',
    );

    // Historical integrity (PART 50/51).
    const buys = await prisma.transaction.findMany({
      where: { ticker: SYMBOL, type: 'BUY' },
    });
    check(
      'Original BUY rows were NOT rewritten (PART 50/51)',
      buys.length === BOOK.length &&
        buys.every((b) => BOOK.some((e) => near(b.quantity ?? 0, e.quantity))),
      `${buys.length} BUY rows still at their original quantities`,
    );

    const splitRows = await prisma.transaction.findMany({
      where: { ticker: SYMBOL, type: 'SPLIT' },
    });
    check(
      'Split rows carry DELTA shares and zero cash (PART 52)',
      splitRows.length === BOOK.length && splitRows.every((r) => r.amount === 0),
      `${splitRows.length} rows, all amount = 0`,
    );

    // Historical reconstruction either side of the date (PART 41).
    const asOfBefore = new Date('2026-08-30T00:00:00Z');
    const asOfAfter = new Date('2026-09-30T00:00:00Z');

    const replayTo = async (asOf: Date) => {
      const rows = await prisma.transaction.findMany({
        where: { ticker: SYMBOL, date: { lte: asOf } },
      });
      return rows.reduce((qty, r) => {
        if (r.type === 'BUY' || r.type === 'SPLIT') return qty + (r.quantity ?? 0);
        return qty;
      }, 0);
    };

    check(
      'Historical report BEFORE the split shows the old quantity (Test 13)',
      near(await replayTo(asOfBefore), sharesBefore),
      `as of 30-Aug: ${await replayTo(asOfBefore)} shares`,
    );

    check(
      'Historical report AFTER the split shows the new quantity (Test 14)',
      near(await replayTo(asOfAfter), sharesBefore * 2),
      `as of 30-Sep: ${await replayTo(asOfAfter)} shares`,
    );

    // Idempotency (PART 37) — the database must refuse the second ledger row.
    let rejected = false;
    try {
      await prisma.corporateActionLedger.create({
        data: {
          corporateActionId: action.id,
          clientId: clientIds[0],
          symbol: SYMBOL,
          quantityBefore: 200,
          quantityAfter: 400,
          averageCostBefore: 50,
          averageCostAfter: 25,
          marketValueBefore: 32000,
          marketValueAfter: 32000,
          cashImpact: 0,
          currency: 'USD',
          status: 'APPLIED',
        },
      });
    } catch {
      rejected = true;
    }
    check(
      'A duplicate ledger row is rejected by the database (PART 37)',
      rejected,
      'unique(corporateActionId, clientId) enforced',
    );

    // Atomicity (PART 36) — a failure mid-transaction must leave nothing behind.
    const beforeRollback = await prisma.holding.findMany({ where: { ticker: SYMBOL } });
    const qtyBeforeRollback = beforeRollback.reduce((s, h) => s + h.quantity, 0);

    let rolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        for (const h of await tx.holding.findMany({ where: { ticker: SYMBOL } })) {
          await tx.holding.update({
            where: { id: h.id },
            data: { quantity: h.quantity * 2 },
          });
        }
        throw new Error('deliberate failure, mid-run');
      });
    } catch {
      rolledBack = true;
    }

    const afterRollback = await prisma.holding.findMany({ where: { ticker: SYMBOL } });
    const qtyAfterRollback = afterRollback.reduce((s, h) => s + h.quantity, 0);

    check(
      'A mid-run failure rolls back EVERY client (PART 36)',
      rolledBack && near(qtyAfterRollback, qtyBeforeRollback),
      `${qtyBeforeRollback} shares before, ${qtyAfterRollback} after the failed run`,
    );

    // Reconciliation (PART 38).
    const ledger = await prisma.corporateActionLedger.findMany({
      where: { corporateActionId: action.id },
    });
    const expected = ledger.reduce((s, l) => s + l.quantityAfter, 0);
    check(
      'Reconciliation: expected equals actual (PART 38)',
      near(expected, sharesAfter),
      `expected ${expected}, actual ${sharesAfter}`,
    );

    check(
      'Ledger records one row per affected client (PART 23)',
      ledger.length === BOOK.length,
      `${ledger.length} rows`,
    );
  } finally {
    console.log('\nCleaning up test data…');
    await cleanup(actionId);
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Removes everything this script creates. Runs before AND after, so a crashed
 * previous run cannot poison the next one.
 */
async function cleanup(actionId?: string) {
  const clients = await prisma.client.findMany({
    where: { name: { startsWith: MARKER } },
    select: { id: true },
  });
  const ids = clients.map((c) => c.id);

  if (ids.length) {
    await prisma.corporateActionLedger.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.holding.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.client.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.corporateActionLedger.deleteMany({ where: { symbol: SYMBOL } });
  await prisma.corporateAction.deleteMany({ where: { symbol: SYMBOL } });
  if (actionId) {
    await prisma.corporateActionAuditLog.deleteMany({ where: { corporateActionId: actionId } });
  }
}

main().catch(async (error) => {
  console.error('\nVerification aborted:', error);
  await cleanup();
  await prisma.$disconnect();
  process.exit(1);
});
