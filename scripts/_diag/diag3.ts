import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const c = await p.client.findFirst({ where:{ name:'Saumya Patel' }, include:{holdings:true} });
  if(!c) return;
  const b = await p.portfolioBaseline.findUnique({ where:{clientId:c.id}, include:{holdings:true} });
  console.log('baselineDate', b!.baselineDate.toISOString());
  console.log('baseline holdings sample:', b!.holdings.slice(0,3).map(h=>`${h.ticker} q=${h.quantity} avg=${h.averageCost}`));
  const tx = await p.transaction.findMany({ where:{clientId:c.id}, orderBy:{date:'asc'} });
  console.log('tx dates:', [...new Set(tx.map(t=>t.date.toISOString().slice(0,10)))]);
  console.log('BUY rows after baseline sample:', tx.filter(t=>t.type==='BUY').slice(0,4).map(t=>`${t.date.toISOString().slice(0,10)} ${t.ticker} q=${t.quantity} amt=${t.amount}`));
  console.log('current holdings sample:', c.holdings.slice(0,3).map(h=>`${h.ticker} q=${h.quantity} avg=${h.averageCost}`));
  await p.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
