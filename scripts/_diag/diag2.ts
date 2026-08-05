import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const BASE = new Date('2026-06-30T00:00:00.000Z');
(async () => {
  const clients = await p.client.findMany({ orderBy:{name:'asc'} });
  for (const c of clients) {
    const b = await p.portfolioBaseline.findUnique({ where:{clientId:c.id} });
    if (!b) { console.log(`${c.name}: no baseline`); continue; }
    const ledger = await p.transaction.findMany({ where:{clientId:c.id, date:{gt:b.baselineDate}}, orderBy:{date:'asc'} });
    let cash = b.openingCash;
    const byType: Record<string, {n:number, amt:number}> = {};
    for (const t of ledger) {
      const k = t.type;
      byType[k] = byType[k] || {n:0, amt:0};
      byType[k].n++; byType[k].amt += Math.abs(t.amount);
      switch(t.type){
        case 'BUY': case 'FEES': case 'CASH_WITHDRAWAL': cash -= Math.abs(t.amount); break;
        case 'SELL': case 'DIVIDEND': case 'CASH_DEPOSIT': cash += Math.abs(t.amount); break;
      }
    }
    console.log(`${c.name}: openCash=${b.openingCash.toFixed(2)} -> replayedCash(today)=${cash.toFixed(2)} | liveCash=${c.cashBalance.toFixed(2)} | types=${JSON.stringify(byType)}`);
    // also on the baseline date itself
    const atBase = await p.transaction.findMany({ where:{clientId:c.id, date:{gt:b.baselineDate, lte:BASE}} });
    console.log(`   tx in (baseline, 6/30] = ${atBase.length}`);
  }
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
