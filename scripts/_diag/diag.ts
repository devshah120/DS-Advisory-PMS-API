import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const clients = await p.client.findMany({ select: { id:true, name:true, cashBalance:true, accountingMethod:true }, orderBy:{name:'asc'} });
  console.log('clients:', clients.length);
  for (const c of clients) {
    const b = await p.portfolioBaseline.findUnique({ where:{clientId:c.id}, include:{holdings:true} });
    const txCount = await p.transaction.count({ where:{clientId:c.id} });
    const txBefore = await p.transaction.count({ where:{clientId:c.id, date:{ lt: new Date('2026-06-30T00:00:00Z') } } });
    const txAfter = await p.transaction.count({ where:{clientId:c.id, date:{ gt: new Date('2026-06-30T00:00:00Z') } } });
    console.log(`${c.name} | cash=${c.cashBalance.toFixed(2)} | tx=${txCount} (before=${txBefore}, after=${txAfter}) | baseline=${b? `${b.baselineDate.toISOString().slice(0,10)} openCash=${b.openingCash.toFixed(2)} openVal=${b.openingPortfolioValue.toFixed(2)} hld=${b.holdings.length}` : 'NONE'}`);
  }
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
