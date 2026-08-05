import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const CUT = new Date('2026-07-01T23:59:59.999Z');
(async()=>{
  for (const n of ['Mrugesh Patel','Om Patel','Shubh Laiwala']) {
    const c = await p.client.findFirst({where:{name:n}});
    const b = await p.portfolioBaseline.findUnique({where:{clientId:c!.id}});
    const tx = await p.transaction.findMany({where:{clientId:c!.id, date:{gt:CUT}}, orderBy:{date:'asc'}});
    let buys=0, sells=0, dep=0, wdr=0;
    for(const t of tx){
      if(t.type==='BUY') buys+=Math.abs(t.amount);
      if(t.type==='SELL') sells+=Math.abs(t.amount);
      if(t.type==='CASH_DEPOSIT') dep+=Math.abs(t.amount);
      if(t.type==='CASH_WITHDRAWAL') wdr+=Math.abs(t.amount);
    }
    console.log(`${n}: openCash=${b!.openingCash.toFixed(2)} liveCash=${c!.cashBalance.toFixed(2)} | postCutover buys=${buys.toFixed(2)} sells=${sells.toFixed(2)} deposits=${dep.toFixed(2)} withdrawals=${wdr.toFixed(2)}`);
    console.log(`   cashDeployed(openCash-liveCash)=${(b!.openingCash-c!.cashBalance).toFixed(2)}`);
  }
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
