import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async()=>{
  for (const [n,tks] of [['Mrugesh Patel',['BMY']],['Om Patel',['IAU','SLV']],['Shubh Laiwala',['CRWV']]] as [string,string[]][]) {
    const c = await p.client.findFirst({where:{name:n}, include:{holdings:true}});
    const b = await p.portfolioBaseline.findUnique({where:{clientId:c!.id}, include:{holdings:true}});
    console.log(`\n=== ${n} ===`);
    for (const t of tks) {
      const bh = b!.holdings.find(h=>h.ticker===t);
      const ch = c!.holdings.find(h=>h.ticker===t);
      const tx = await p.transaction.findMany({where:{clientId:c!.id, ticker:t}, orderBy:{date:'asc'}});
      console.log(`  ${t}: baselineQty=${bh?.quantity} currentHoldingQty=${ch?.quantity}`);
      for (const x of tx) console.log(`     TX ${x.date.toISOString().slice(0,10)} ${x.type} qty=${x.quantity} amt=${x.amount}`);
    }
  }
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
