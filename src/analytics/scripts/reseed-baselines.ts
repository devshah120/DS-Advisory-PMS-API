/**
 * Re-seed every client's Legacy Portfolio Baseline onto the corrected
 * opening-cash rule.
 *
 * Baselines created before the import-artifact fix ran their `openingCash`
 * through a `backOutOpeningCash` that treated the bulk-imported 2026-07-01 BUY
 * rows as real post-baseline purchases. It therefore credited the full cost of
 * the book back into the opening balance (Mrugesh: $17,450 against a real
 * $9,950; Om: $14,000 against $10,093). Those stored figures are wrong under the
 * new rule and, because a baseline is deliberately immutable, they cannot be
 * corrected by a normal write.
 *
 * This script deletes and re-creates them so `openingCash` is recomputed by the
 * fixed code path. It is safe to re-run: the result is a pure function of the
 * current Holdings, PriceBar and Transaction rows.
 *
 * The stored PortfolioValuation snapshots are dropped too — they cached the
 * negative reconstructed cash and would otherwise keep serving it through
 * PortfolioHistoryService's snapshot-first read. They regenerate on demand.
 *
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/reseed-baselines.ts
 */
import { PrismaClient } from '@prisma/client';
import { INCEPTION_DATE, isImportArtifact } from '../calculators/flows';

const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.client.findMany({
    include: { holdings: true },
    orderBy: { name: 'asc' },
  });

  console.log(`Re-seeding baselines for ${clients.length} clients at ${INCEPTION_DATE.toISOString().slice(0, 10)}\n`);

  for (const client of clients) {
    const ledgerAll = await prisma.transaction.findMany({
      where: { clientId: client.id, date: { gt: INCEPTION_DATE } },
      orderBy: { date: 'asc' },
    });

    /**
     * Roll today's holdings back to the baseline date — see the long comment in
     * BaselineService.autoSeed. Copying current quantities forward asserts the
     * client held post-baseline purchases on 30-June, and reconstruction then
     * replays those same BUYs on top, doubling the position.
     */
    const sharesAddedSince = new Map<string, number>();
    for (const t of ledgerAll) {
      if (!t.ticker || !t.quantity) continue;
      if (isImportArtifact(t)) continue;

      const delta =
        t.type === 'BUY' || t.type === 'SPLIT' || t.type === 'BONUS'
          ? t.quantity
          : t.type === 'SELL'
            ? -t.quantity
            : 0;

      if (delta !== 0) {
        sharesAddedSince.set(t.ticker, (sharesAddedSince.get(t.ticker) ?? 0) + delta);
      }
    }

    const open = client.holdings
      .map((h) => ({ ...h, quantity: h.quantity - (sharesAddedSince.get(h.ticker) ?? 0) }))
      .filter((h) => h.quantity > 1e-9);

    // Same fallback order as BaselineService.autoSeed and rebaseLedgerToJun30:
    // the 30-June close, else the holding's own average cost.
    const holdings = await Promise.all(
      open.map(async (h) => {
        const bar = await prisma.priceBar.findFirst({
          where: { symbol: h.ticker, date: { lte: INCEPTION_DATE } },
          orderBy: { date: 'desc' },
          select: { adjClose: true },
        });
        return {
          ticker: h.ticker,
          quantity: h.quantity,
          averageCost: bar?.adjClose ?? h.averageCost,
          currency: client.currency,
          sector: h.sector,
          industry: h.industry,
        };
      }),
    );

    // Mirrors the fixed BaselineService.backOutOpeningCash: real post-baseline
    // cash movements only, import artifacts excluded.
    let netCashSinceBaseline = 0;
    for (const t of ledgerAll) {
      if (isImportArtifact(t)) continue;
      switch (t.type) {
        case 'BUY':
        case 'FEES':
        case 'CASH_WITHDRAWAL':
          netCashSinceBaseline -= Math.abs(t.amount);
          break;
        case 'SELL':
        case 'DIVIDEND':
        case 'CASH_DEPOSIT':
          netCashSinceBaseline += Math.abs(t.amount);
          break;
        default:
          break;
      }
    }

    const openingCash = client.cashBalance - netCashSinceBaseline;
    const holdingsValue = holdings.reduce((s, h) => s + h.quantity * h.averageCost, 0);
    const openingPortfolioValue = holdingsValue + openingCash;

    const existing = await prisma.portfolioBaseline.findUnique({ where: { clientId: client.id } });
    if (existing) {
      await prisma.baselineHolding.deleteMany({ where: { baselineId: existing.id } });
      await prisma.portfolioBaseline.delete({ where: { id: existing.id } });
    }

    await prisma.portfolioBaseline.create({
      data: {
        clientId: client.id,
        baselineDate: INCEPTION_DATE,
        openingPortfolioValue,
        openingCash,
        remarks: `Re-seeded on the corrected opening-cash rule (import BUYs treated as part of the ${INCEPTION_DATE.toISOString().slice(0, 10)} opening position).`,
        lockedAt: new Date(),
        holdings: { create: holdings },
      },
    });

    // Drop cached valuations built from the old (negative-cash) replay.
    const stale = await prisma.portfolioValuation.findMany({
      where: { clientId: client.id },
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.holdingSnapshot.deleteMany({
        where: { snapshotId: { in: stale.map((s) => s.id) } },
      });
      await prisma.portfolioValuation.deleteMany({ where: { clientId: client.id } });
    }

    console.log(
      `${client.name.padEnd(16)} openingValue=${openingPortfolioValue.toFixed(2).padStart(12)} ` +
        `openingCash=${openingCash.toFixed(2).padStart(10)} (live ${client.cashBalance.toFixed(2)}) ` +
        `holdings=${holdings.length} staleSnapshotsDropped=${stale.length}`,
    );
  }

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
