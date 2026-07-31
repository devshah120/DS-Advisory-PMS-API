/**
 * Reconciles positions against the trade ledger.
 *
 * Background: until the ledger write moved inside HoldingsService.create(),
 * only the bulk importer wrote Transaction rows. Positions added through the
 * Add Position screen moved the book without ever touching the blotter, so
 * they are invisible to the Transactions screen and to XIRR — which reads its
 * cash flows straight out of the ledger.
 *
 * This script finds where the two disagree and, for the one case it can settle
 * safely, writes the missing ledger row.
 *
 * WHAT IT WILL AND WILL NOT TOUCH
 *
 * Holdings fall into three groups, and only the first is mechanically safe:
 *
 *   1. ORPHAN — a position with no BUY/SELL at all. The whole position is
 *      unexplained, so a single opening BUY for exactly its quantity and cost
 *      basis reproduces it. This is the only class the script writes.
 *
 *   2. SHORTFALL — a position larger than its ledger. Something is missing,
 *      but "how many trades, on what dates, at what prices" is not recoverable
 *      from the position alone: one 84-share buy and two 42-share buys leave
 *      an identical holding but a different XIRR. Reported, never guessed at.
 *
 *   3. EXCESS — a position *smaller* than its ledger, i.e. the blotter records
 *      trades the book never applied. Fixing this means changing the position,
 *      not adding a row, and the ledger is the better record of the two. Also
 *      reported only.
 *
 * The dates matter as much as the amounts. An orphan's opening trade is dated
 * with --date (default 2026-06-30, the rebasing date the XIRR already uses),
 * because a flow booked on the wrong day reprices the whole return.
 *
 * USAGE
 *   npx ts-node -T scripts/reconcile-ledger.ts              # dry run (default)
 *   npx ts-node -T scripts/reconcile-ledger.ts --apply      # write orphan rows
 *   npx ts-node -T scripts/reconcile-ledger.ts --apply --date=2026-06-30
 *   npx ts-node -T scripts/reconcile-ledger.ts --client="Om Patel"
 *
 * Dry run is the default precisely because --apply is not reversible; read the
 * report first.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/** Quantities are floats; compare with a tolerance rather than for equality. */
const EPSILON = 1e-6;

const DEFAULT_TRADE_DATE = '2026-06-30';

type Args = { apply: boolean; date: string; client?: string };

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');
  const dateArg = argv.find((a) => a.startsWith('--date='))?.slice('--date='.length);
  const clientArg = argv.find((a) => a.startsWith('--client='))?.slice('--client='.length);

  const date = dateArg ?? DEFAULT_TRADE_DATE;
  if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error(`--date must be yyyy-mm-dd, got "${date}"`);
  }
  return { apply, date, client: clientArg };
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const qty = (n: number) => Number(n.toFixed(6)).toString();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const scoped = args.client
    ? clients.filter((c) => c.name.toLowerCase() === args.client!.toLowerCase())
    : clients;

  if (args.client && scoped.length === 0) {
    throw new Error(`No client named "${args.client}"`);
  }
  const scopedIds = new Set(scoped.map((c) => c.id));

  const holdings = (await prisma.holding.findMany()).filter((h) => scopedIds.has(h.clientId));
  const trades = (
    await prisma.transaction.findMany({ where: { type: { in: ['BUY', 'SELL'] } } })
  ).filter((t) => scopedIds.has(t.clientId));

  // Net ledger quantity per position, so each holding is compared against the
  // trades that claim to explain it.
  const netByKey = new Map<string, { net: number; rows: number }>();
  for (const t of trades) {
    if (!t.ticker) continue;
    const key = `${t.clientId}|${t.ticker}`;
    const signed = (t.type === 'BUY' ? 1 : -1) * (t.quantity ?? 0);
    const prev = netByKey.get(key) ?? { net: 0, rows: 0 };
    netByKey.set(key, { net: prev.net + signed, rows: prev.rows + 1 });
  }

  const orphans: typeof holdings = [];
  const shortfalls: { h: (typeof holdings)[number]; net: number; rows: number }[] = [];
  const excesses: { h: (typeof holdings)[number]; net: number; rows: number }[] = [];

  for (const h of holdings) {
    const { net, rows } = netByKey.get(`${h.clientId}|${h.ticker}`) ?? { net: 0, rows: 0 };
    const diff = h.quantity - net;
    if (Math.abs(diff) < EPSILON) continue;
    if (rows === 0) orphans.push(h);
    else if (diff > 0) shortfalls.push({ h, net, rows });
    else excesses.push({ h, net, rows });
  }

  const reconciled = holdings.length - orphans.length - shortfalls.length - excesses.length;

  console.log('\n=== Ledger reconciliation ===');
  console.log(`Mode           : ${args.apply ? 'APPLY (writes rows)' : 'dry run'}`);
  console.log(`Scope          : ${args.client ?? 'all clients'} (${scoped.length})`);
  console.log(`Opening date   : ${args.date}`);
  console.log(`Positions       : ${holdings.length}  |  already reconciled: ${reconciled}`);

  // ---- 1. Orphans: safe to write -----------------------------------------
  console.log(`\n--- Orphan positions (no ledger rows) : ${orphans.length} ---`);
  if (orphans.length) {
    console.log('An opening BUY reproduces each of these exactly.\n');
    for (const h of orphans) {
      const amount = h.quantity * h.averageCost;
      console.log(
        `  ${h.ticker.padEnd(8)} ${(clientName.get(h.clientId) ?? '?').padEnd(16)} ` +
          `qty=${qty(h.quantity).padEnd(12)} @ ${money(h.averageCost).padStart(11)} = ${money(amount)}`,
      );
    }
    const total = orphans.reduce((s, h) => s + h.quantity * h.averageCost, 0);
    console.log(`\n  Total capital to be booked: ${money(total)}`);
  }

  // ---- 2 & 3. Reported only ----------------------------------------------
  console.log(`\n--- Shortfall (position > ledger) : ${shortfalls.length} ---`);
  if (shortfalls.length) {
    console.log('Trades are missing, but their number/dates/prices cannot be inferred.');
    console.log('Re-import the original blotter rows for these, or add them by hand.\n');
    for (const { h, net, rows } of shortfalls) {
      console.log(
        `  ${h.ticker.padEnd(8)} ${(clientName.get(h.clientId) ?? '?').padEnd(16)} ` +
          `position=${qty(h.quantity).padEnd(12)} ledger=${qty(net).padEnd(12)} ` +
          `missing=${qty(h.quantity - net).padEnd(12)} (${rows} row${rows === 1 ? '' : 's'})`,
      );
    }
  }

  console.log(`\n--- Excess (ledger > position) : ${excesses.length} ---`);
  if (excesses.length) {
    console.log('The blotter records trades the position never applied — the ledger is');
    console.log('likely correct and the POSITION is understated. Verify before changing.\n');
    for (const { h, net, rows } of excesses) {
      console.log(
        `  ${h.ticker.padEnd(8)} ${(clientName.get(h.clientId) ?? '?').padEnd(16)} ` +
          `position=${qty(h.quantity).padEnd(12)} ledger=${qty(net).padEnd(12)} ` +
          `excess=${qty(net - h.quantity).padEnd(12)} (${rows} row${rows === 1 ? '' : 's'})`,
      );
    }
  }

  if (!args.apply) {
    console.log(
      `\nDry run — nothing written. Re-run with --apply to book the ${orphans.length} orphan row(s).\n`,
    );
    return;
  }

  if (orphans.length === 0) {
    console.log('\nNothing to write.\n');
    return;
  }

  // ---- Apply --------------------------------------------------------------
  const date = new Date(`${args.date}T00:00:00Z`);
  let written = 0;
  const failures: { ticker: string; reason: string }[] = [];

  for (const h of orphans) {
    // Re-check immediately before writing: a concurrent import may have filled
    // this position's ledger since the scan, and a second opening row would
    // double the position's apparent cost basis.
    const existing = await prisma.transaction.count({
      where: { clientId: h.clientId, ticker: h.ticker, type: { in: ['BUY', 'SELL'] } },
    });
    if (existing > 0) {
      failures.push({ ticker: h.ticker, reason: 'ledger rows appeared during the run — skipped' });
      continue;
    }

    try {
      await prisma.transaction.create({
        data: {
          clientId: h.clientId,
          ticker: h.ticker,
          type: 'BUY',
          quantity: h.quantity,
          price: h.averageCost,
          amount: h.quantity * h.averageCost,
          date,
          description: `Opening position ${qty(h.quantity)} ${h.ticker}`,
          reference: 'reconcile-ledger',
        },
      });
      written++;
    } catch (error) {
      const reason =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? `${error.code} ${error.message.split('\n').pop()}`
          : (error as Error).message;
      failures.push({ ticker: h.ticker, reason });
    }
  }

  console.log(`\nWrote ${written} opening trade row(s).`);
  if (failures.length) {
    console.log(`${failures.length} could not be written:`);
    failures.forEach((f) => console.log(`  ${f.ticker}: ${f.reason}`));
  }
  console.log(
    `\nRows carry reference="reconcile-ledger", so they can be found (or undone) later:\n` +
      `  db.transactions.deleteMany({ reference: "reconcile-ledger" })\n`,
  );
}

main()
  .catch((e) => {
    console.error(`\nreconcile-ledger failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
