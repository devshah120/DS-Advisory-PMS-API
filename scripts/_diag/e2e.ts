import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PortfolioHistoryService } from '../../src/portfolio-reconstruction/portfolio-history.service';
import { PerformanceBaselineService } from '../../src/portfolio-reconstruction/performance-baseline.service';
import { resolvePeriod } from '../../src/portfolio-reconstruction/periods';
import { PrismaService } from '../../src/common/prisma/prisma.service';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const hist = app.get(PortfolioHistoryService);
  const perf = app.get(PerformanceBaselineService);
  const prisma = app.get(PrismaService);
  const clients = await prisma.client.findMany({ orderBy:{name:'asc'} });

  for (const c of clients) {
    const ao = await hist.getPortfolioAsOf(c.id, new Date());
    const sectorSum = ao.sectorAllocation.slices.reduce((s,x)=>s+x.weight,0);
    const flag = ao.cash < 0 ? ' <== NEGATIVE' : '';
    console.log(`${c.name.padEnd(15)} cash=${ao.cash.toFixed(2).padStart(10)} shortfall=${ao.cashShortfall.toFixed(2)} pv=${ao.portfolioValue.toFixed(2).padStart(11)} sectorWeightSum=${(sectorSum*100).toFixed(1)}% src=${ao.source}${flag}`);
  }

  console.log('\nReturns for Saumya Patel:');
  const s = clients.find(c=>c.name==='Saumya Patel')!;
  for (const code of ['INCEPTION','QTD','Q3-CY26','MTD']) {
    const r = await perf.periodReturn(s.id, resolvePeriod(code));
    console.log(`  ${code.padEnd(10)} ${r.from.toISOString().slice(0,10)}->${r.to.toISOString().slice(0,10)} open=${r.openingValue.toFixed(2).padStart(10)} close=${r.closingValue.toFixed(2).padStart(10)} ret=${r.returnPct!==null?(r.returnPct*100).toFixed(2)+'%':'n/a'} bm=${r.benchmark?.interim!=null?(r.benchmark.interim*100).toFixed(2)+'%':'n/a'}`);
  }
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
