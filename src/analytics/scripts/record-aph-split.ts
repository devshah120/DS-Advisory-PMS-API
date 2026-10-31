/**
 * Records APH's 2-for-1 split (ex-date 3-Sep-2026) in the ledger, where every
 * valuation can see it.
 *
 * WHAT WENT WRONG
 *
 * The split never reached the Corporate Action Engine. Between 18 and 27 Sept
 * it was applied by hand instead, by editing each US client's 1-July bulk-import
 * APH BUY to the post-split share count (Om Patel: 58.1561 -> 116.3122, same
 * $5,015 cost). The Holdings screen rebuilt from those rows and looked right.
 *
 * Every valuation did not. A house-baseline client's 1-July BUYs are import
 * artifacts: the replay drops them and takes the position from the 30-June
 * baseline (58.1561, seeded 5-Aug, before the split). With no SPLIT row, the
 * replay carried the pre-split count forever and priced it at the post-split
 * quote, so APH read as -55% on seven US books. Nirav Patel's position was
 * re-entered as a second BUY (53.67, dated 30-Jun 18:30Z) beside the original
 * import row rather than edited, with the same effect.
 *
 * WHAT THIS WRITES
 *
 *   1. Each edited 1-July import row goes back to its baseline quantity (the
 *      quantity it was imported with); amount is unchanged, price re-derived.
 *   2. A re-entered duplicate created after the ex-date inside the import window
 *      (Nirav's) is deleted.
 *   3. One SPLIT row per holder on the ex-date, delta = shares held on the eve
 *      of the split, amount 0 — the shape StockSplitProcessor writes.
 *   4. A PROCESSED CorporateAction with per-client ledger rows and an audit
 *      entry, so the engine knows the event is done and never applies it again.
 *
 * Holding rows are NOT written. They already show the post-split count, and a
 * lot rebuild over the repaired ledger (BUY + SPLIT) reproduces it — the
 * dry run prints that check per client.
 *
 * Every touched row is written to a JSON backup before anything changes.
 *
 * USAGE
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/record-aph-split.ts           # dry run
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/record-aph-split.ts --apply
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { isBulkImportClient, isImportArtifact } from '../calculators/flows';
import { fingerprintOf } from '../../corporate-actions/corporate-action.dedupe';

const prisma = new PrismaClient();

const SYMBOL = 'APH';
const EX_DATE = new Date('2026-09-03T00:00:00.000Z');
// Stored old:new — each 1 old share becomes 2 (see ratio.ts).
const OLD_RATIO = 1;
const NEW_RATIO = 2;
const MULTIPLIER = NEW_RATIO / OLD_RATIO;
const EPSILON = 1e-6;

type Plan = {
  clientId: string;
  clientName: string;
  baselineQty: number;
  preSplitQty: number;
  restore: Array<{ id: string; from: number; to: number; amount: number }>;
  remove: Array<{ id: string; quantity: number; amount: number; date: Date }>;
  holding: { quantity: number; averageCost: number; currentPrice: number } | null;
  rebuiltQty: number;
  rebuiltCost: number;
};

async function planFor(client: { id: string; name: string }): Promise<Plan | null> {
  const baseline = await prisma.portfolioBaseline.findUnique({
    where: { clientId: client.id },
    include: { holdings: { where: { ticker: SYMBOL } } },
  });
  const baselineQty = baseline?.holdings[0]?.quantity ?? 0;

  const ledger = await prisma.transaction.findMany({
    where: { clientId: client.id, ticker: SYMBOL },
    orderBy: { date: 'asc' },
  });
  if (!ledger.length && baselineQty === 0) return null;

  if (ledger.some((t) => t.type === 'SPLIT')) {
    throw new Error(`${client.name} already has an ${SYMBOL} SPLIT row — refusing to write a second.`);
  }

  const first = await prisma.transaction.findFirst({
    where: { clientId: client.id },
    orderBy: { date: 'asc' },
    select: { date: true },
  });
  const bulk = isBulkImportClient({
    baselineDate: baseline?.baselineDate,
    firstTransactionDate: first?.date ?? null,
  });

  const importRows = ledger.filter((t) => isImportArtifact(t, bulk));
  // A row inside the import window that was CREATED after the ex-date is a
  // re-entry of the post-split position, not the imported one.
  const reentered = importRows.filter((t) => t.createdAt >= EX_DATE);
  const original = importRows.filter((t) => t.createdAt < EX_DATE);

  if (original.length > 1) {
    throw new Error(`${client.name}: ${original.length} original ${SYMBOL} import rows — resolve by hand.`);
  }

  const restore = original
    .filter((t) => Math.abs((t.quantity ?? 0) - baselineQty) > EPSILON)
    .map((t) => ({ id: t.id, from: t.quantity ?? 0, to: baselineQty, amount: Math.abs(t.amount) }));

  // Shares held on the eve of the split: the baseline plus every REAL trade
  // before the ex-date — the same rows the replay applies.
  const preSplitQty = ledger
    .filter((t) => !isImportArtifact(t, bulk) && t.date > (baseline?.baselineDate ?? new Date(0)) && t.date < EX_DATE)
    .reduce((q, t) => q + (t.type === 'BUY' ? t.quantity ?? 0 : t.type === 'SELL' ? -(t.quantity ?? 0) : 0), baselineQty);

  // What a lot rebuild (HoldingsService.recomputeFromLedger) will produce
  // from the repaired ledger, for the check against today's Holding.
  const repaired = ledger
    .filter((t) => !reentered.some((r) => r.id === t.id))
    .map((t) => {
      const r = restore.find((x) => x.id === t.id);
      return r ? { ...t, quantity: r.to } : t;
    });
  let rebuiltQty = 0;
  let rebuiltCost = 0;
  let splitDone = false;
  for (const t of repaired) {
    if (!splitDone && t.date >= EX_DATE) {
      rebuiltQty *= MULTIPLIER;
      splitDone = true;
    }
    if (t.type === 'BUY') {
      rebuiltQty += t.quantity ?? 0;
      rebuiltCost += Math.abs(t.amount);
    } else if (t.type === 'SELL') {
      const avg = rebuiltQty > 0 ? rebuiltCost / rebuiltQty : 0;
      rebuiltQty -= t.quantity ?? 0;
      rebuiltCost -= avg * (t.quantity ?? 0);
    }
  }
  if (!splitDone) rebuiltQty *= MULTIPLIER;

  const holding = await prisma.holding.findFirst({
    where: { clientId: client.id, ticker: SYMBOL },
    select: { quantity: true, averageCost: true, currentPrice: true },
  });

  return {
    clientId: client.id,
    clientName: client.name,
    baselineQty,
    preSplitQty,
    restore,
    remove: reentered.map((t) => ({ id: t.id, quantity: t.quantity ?? 0, amount: t.amount, date: t.date })),
    holding,
    rebuiltQty,
    rebuiltCost,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');

  const clients = await prisma.client.findMany({ where: { market: 'US' }, select: { id: true, name: true } });
  const plans = (await Promise.all(clients.map(planFor))).filter((p): p is Plan => p !== null && p.preSplitQty > EPSILON);

  console.log(`${SYMBOL} ${NEW_RATIO}-for-${OLD_RATIO} split on ${EX_DATE.toISOString().slice(0, 10)} — ${plans.length} holders\n`);
  for (const p of plans) {
    const check =
      p.holding && Math.abs(p.holding.quantity - p.rebuiltQty) > EPSILON
        ? `MISMATCH: holding shows ${p.holding.quantity}, a lot rebuild would give ${p.rebuiltQty.toFixed(6)}`
        : 'holding matches a lot rebuild';
    console.log(`${p.clientName}`);
    console.log(`  split delta +${p.preSplitQty} (${p.preSplitQty} -> ${p.preSplitQty * MULTIPLIER})`);
    for (const r of p.restore) console.log(`  restore import row ${r.id}: qty ${r.from} -> ${r.to} (amount ${r.amount})`);
    for (const r of p.remove) console.log(`  delete re-entered row ${r.id}: BUY ${r.quantity} for ${r.amount} dated ${r.date.toISOString()}`);
    console.log(`  ${check}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  // Backup first: every row this run will change or delete, as it is now.
  const touchedIds = plans.flatMap((p) => [...p.restore.map((r) => r.id), ...p.remove.map((r) => r.id)]);
  const backup = {
    takenAt: new Date().toISOString(),
    purpose: `${SYMBOL} split repair — rows as they were before src/analytics/scripts/record-aph-split.ts --apply`,
    transactions: await prisma.transaction.findMany({ where: { id: { in: touchedIds } } }),
  };
  const backupPath = path.join(__dirname, '..', '..', '..', `aph-split-backup-${backup.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const normalized = {
    symbol: SYMBOL,
    actionType: 'STOCK_SPLIT' as const,
    recordDate: null as Date | null,
    effectiveDate: EX_DATE,
    oldRatio: OLD_RATIO,
    newRatio: NEW_RATIO,
  };
  const fingerprint = fingerprintOf(normalized);
  if (await prisma.corporateAction.findUnique({ where: { fingerprint } })) {
    throw new Error(`A CorporateAction with this fingerprint already exists (${fingerprint}) — refusing to re-run.`);
  }

  const now = new Date();
  const action = await prisma.corporateAction.create({
    data: {
      symbol: SYMBOL,
      company: 'Amphenol Corporation',
      market: 'US',
      actionType: 'STOCK_SPLIT',
      exDate: EX_DATE,
      effectiveDate: EX_DATE,
      processingDate: now,
      oldRatio: OLD_RATIO,
      newRatio: NEW_RATIO,
      source: 'manual',
      sourceReference: `${SYMBOL}:${EX_DATE.toISOString().slice(0, 10)}`,
      status: 'PROCESSED',
      confidenceScore: 100,
      fingerprint,
      approvedAt: now,
      createdBy: 'src/analytics/scripts/record-aph-split.ts',
      approvedBy: 'src/analytics/scripts/record-aph-split.ts',
      notes:
        'Recorded after the fact. Ex-date read from Yahoo (raw/adjusted close ratio steps from 2 to 1 on ' +
        '2026-09-03). Holdings had already been moved to the post-split count by editing the 1-July import ' +
        'rows; this restores those rows and writes the SPLIT rows the replay needs. Holdings untouched.',
    },
  });
  const runReference = `CA:${action.id}:${now.getTime()}`;

  for (const p of plans) {
    for (const r of p.restore) {
      await prisma.transaction.update({
        where: { id: r.id },
        data: {
          quantity: r.to,
          price: r.amount / r.to,
          description: `Bulk import — buy ${r.to} ${SYMBOL}`,
        },
      });
    }
    if (p.remove.length) {
      await prisma.transaction.deleteMany({ where: { id: { in: p.remove.map((r) => r.id) } } });
    }

    const after = p.preSplitQty * MULTIPLIER;
    const split = await prisma.transaction.create({
      data: {
        clientId: p.clientId,
        ticker: SYMBOL,
        type: 'SPLIT',
        quantity: p.preSplitQty,
        price: null,
        amount: 0,
        date: EX_DATE,
        description: `${NEW_RATIO}-for-${OLD_RATIO} stock split — ${p.preSplitQty} → ${after} shares`,
        reference: runReference,
      },
    });

    const avgAfter = p.holding?.averageCost ?? 0;
    const price = p.holding?.currentPrice ?? 0;
    await prisma.corporateActionLedger.create({
      data: {
        corporateActionId: action.id,
        clientId: p.clientId,
        symbol: SYMBOL,
        quantityBefore: p.preSplitQty,
        quantityAfter: after,
        averageCostBefore: avgAfter * MULTIPLIER,
        averageCostAfter: avgAfter,
        marketValueBefore: p.preSplitQty * price,
        marketValueAfter: after * price,
        currency: 'USD',
        transactionIds: [split.id],
        status: 'APPLIED',
        processedAt: now,
      },
    });
    console.log(`  ${p.clientName}: SPLIT +${p.preSplitQty} written`);
  }

  await prisma.corporateActionAuditLog.create({
    data: {
      corporateActionId: action.id,
      action: 'PROCESSED',
      actorLabel: 'src/analytics/scripts/record-aph-split.ts',
      afterValue: {
        holders: plans.length,
        sharesBefore: plans.reduce((s, p) => s + p.preSplitQty, 0),
        sharesAfter: plans.reduce((s, p) => s + p.preSplitQty * MULTIPLIER, 0),
        backup: path.basename(backupPath),
      },
      source: 'manual',
      reason: 'Split applied by hand to the 1-July import rows; recorded in the ledger so valuations see it.',
    },
  });

  // Cached valuations need no purge: every row written here is newer than any
  // snapshot (created or updated after it), which is exactly what
  // PortfolioHistoryService.isStale replays on — and deleting them would also
  // drop their isQuarterEnd flags.
  console.log(`\nDone. CorporateAction ${action.id}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
