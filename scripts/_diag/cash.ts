import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PortfolioHistoryService } from '../../src/portfolio-reconstruction/portfolio-history.service';
import { PerformanceService } from '../../src/analytics/services/performance.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const hist = app.get(PortfolioHistoryService); const perf = app.get(PerformanceService);
  const prisma = app.get(PrismaService);
  for (const n of ['Mrugesh Patel','Om Patel','Shubh Laiwala']) {
    const c = await prisma.client.findFirst({where:{name:n}});
    const cur:any = await perf.forClient(c!.id); const d = cur.data;
    const ao = await hist.getPortfolioAsOf(c!.id, new Date());
    const b = await prisma.portfolioBaseline.findUnique({where:{clientId:c!.id}});
    console.log(`${n}`);
    console.log(`  CURRENT  holdings=${d.holdingsValue.toFixed(2)} cash=${d.cashBalance.toFixed(2)} pv=${d.portfolioValue.toFixed(2)} invested=${d.investedCapital.toFixed(2)}`);
    console.log(`  HISTORIC holdings=${ao.holdingsValue.toFixed(2)} cash=${ao.cash.toFixed(2)} pv=${ao.portfolioValue.toFixed(2)}`);
    console.log(`  BASELINE openVal=${b!.openingPortfolioValue.toFixed(2)} openCash=${b!.openingCash.toFixed(2)} -> holdingsOnly=${(b!.openingPortfolioValue-b!.openingCash).toFixed(2)}`);
    console.log(`  deltas: holdings=${(d.holdingsValue-ao.holdingsValue).toFixed(2)} pv=${(d.portfolioValue-ao.portfolioValue).toFixed(2)} cash=${(d.cashBalance-ao.cash).toFixed(2)}\n`);
  }
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
