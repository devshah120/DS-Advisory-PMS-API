import { PrismaClient } from '@prisma/client';
import { isImportArtifact } from '../../src/analytics/calculators/flows';
const p = new PrismaClient();
(async () => {
  const clients = await p.client.findMany({ orderBy:{name:'asc'} });
  let bad = 0;
  for (const c of clients) {
    const b = await p.portfolioBaseline.findUnique({ where:{clientId:c.id} });
    if(!b) continue;
    const ledger = await p.transaction.findMany({ where:{clientId:c.id, date:{gt:b.baselineDate}}, orderBy:{date:'asc'} });
    let cash = b.openingCash;
    let skipped = 0;
    for (const t of ledger) {
      if (isImportArtifact(t)) { skipped++; continue; }
      switch(t.type){
        case 'BUY': case 'FEES': case 'CASH_WITHDRAWAL': cash -= Math.abs(t.amount); break;
        case 'SELL': case 'DIVIDEND': case 'CASH_DEPOSIT': cash += Math.abs(t.amount); break;
      }
    }
    const ok = Math.abs(cash - c.cashBalance) < 0.01;
    if(!ok) bad++;
    console.log(`${ok?'OK ':'!! '} ${c.name.padEnd(15)} replayedCash=${cash.toFixed(2).padStart(11)} liveCash=${c.cashBalance.toFixed(2).padStart(10)} importBuysSkipped=${skipped}`);
  }
  console.log(bad===0 ? '\nAll clients reconcile to live cash. No negative balances.' : `\n${bad} client(s) do not reconcile.`);
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
