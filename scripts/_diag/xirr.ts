import { PrismaClient } from '@prisma/client';
import { rebaseLedgerToJun30, buildFlows, JUN30_REBASE_DATE } from '../../src/analytics/calculators/flows';
import { xirr } from '../../src/analytics/calculators/xirr';
const p = new PrismaClient();
(async () => {
  const clients = await p.client.findMany({ include:{holdings:true}, orderBy:{name:'asc'} });
  const asOf = new Date();
  for (const c of clients) {
    const open = c.holdings.filter(h=>h.quantity!==0);
    const bars = await p.priceBar.findMany({ where:{ symbol:{in:open.map(h=>h.ticker)}, date: JUN30_REBASE_DATE }, select:{symbol:true,adjClose:true} });
    const closeOf = new Map(bars.map(b=>[b.symbol,b.adjClose]));
    const ledger = await p.transaction.findMany({ where:{clientId:c.id, date:{lte:asOf}}, orderBy:{date:'asc'} });
    const rebased = rebaseLedgerToJun30(open.map(h=>({ticker:h.ticker,quantity:h.quantity,averageCost:h.averageCost})), ledger, closeOf);
    // terminal = current holdings market value
    let mv = 0;
    for (const h of open) {
      const bar = await p.priceBar.findFirst({ where:{symbol:h.ticker}, orderBy:{date:'desc'}, select:{adjClose:true} });
      mv += h.quantity * (bar?.adjClose ?? h.averageCost);
    }
    const built = buildFlows(rebased as any, 'TRANSACTIONAL', mv, asOf, {includeDividends:true, includeFees:true});
    if (built.status!=='ok') { console.log(`${c.name}: ${built.reason}`); continue; }
    const first = built.flows[0];
    const r = xirr(built.flows);
    const days = (asOf.getTime()-first.date.getTime())/86400000;
    const interim = r.status==='ok' ? (1+r.rate)**(days/365)-1 : null;
    console.log(`${c.name.padEnd(15)} inceptionFlow=${first.date.toISOString().slice(0,10)} base=${(-first.amount).toFixed(2).padStart(11)} terminal=${mv.toFixed(2).padStart(11)} xirr=${r.status==='ok'?(r.rate*100).toFixed(2)+'%':'n/a'} interim=${interim!==null?(interim*100).toFixed(2)+'%':'n/a'}`);
  }
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
