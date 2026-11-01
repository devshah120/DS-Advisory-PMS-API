import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const BACKUP = process.argv.find((a) => a.startsWith('--backup='))!.slice(9);
(async () => {
  const c = await prisma.client.findFirstOrThrow({ where: { name: 'Prashant Salecha HUF' } });
  const syms = ['AXISBANK.NS', 'ICICIBANK.NS', 'KNACK.NS', 'REMUS-SM.NS'];
  const holdings = await prisma.holding.findMany({ where: { clientId: c.id, ticker: { in: syms } } });
  const ledger = await prisma.transaction.findMany({ where: { clientId: c.id, ticker: { in: syms } }, orderBy: { date: 'asc' } });
  // The second upload of the 2-Sep blotter: created between 07:21:54 and 07:21:55 UTC today.
  const dupes = ledger.filter((t) => t.createdAt >= new Date('2026-11-01T07:21:54Z') && t.createdAt < new Date('2026-11-01T07:21:55Z'));
  if (dupes.length !== 4) throw new Error(`expected 4 duplicates, found ${dupes.length}`);
  writeFileSync(BACKUP, JSON.stringify({ clientId: c.id, holdings, ledger }, null, 2));
  console.log('backup ->', BACKUP);
  const dupeIds = new Set(dupes.map((d) => d.id));
  for (const h of holdings) {
    let q = 0, cost = 0;
    for (const t of ledger) if (t.ticker === h.ticker && !dupeIds.has(t.id) && t.type === 'BUY') { q += t.quantity!; cost += t.amount; }
    const avg = cost / q;
    console.log(h.ticker, 'stored', h.quantity, h.averageCost.toFixed(2), '-> rebuilt', q, avg.toFixed(2), 'invested', cost.toFixed(2));
    if (APPLY) {
      const mv = q * h.currentPrice;
      await prisma.holding.update({ where: { id: h.id }, data: { quantity: q, averageCost: avg, realizedPnL: 0, marketValue: mv, unrealizedPnL: mv - cost } });
    }
  }
  if (ledger.some((t) => t.type !== 'BUY')) throw new Error('non-BUY row present; aborting before delete');
  if (APPLY) console.log('deleted', (await prisma.transaction.deleteMany({ where: { id: { in: [...dupeIds] } } })).count, 'duplicate ledger rows');
  await prisma.$disconnect();
})();
