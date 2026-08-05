import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PortfolioHistoryService } from '../../src/portfolio-reconstruction/portfolio-history.service';
import { PerformanceBaselineService } from '../../src/portfolio-reconstruction/performance-baseline.service';
import { PerformanceService } from '../../src/analytics/services/performance.service';
import { resolvePeriod } from '../../src/portfolio-reconstruction/periods';
import { PrismaService } from '../../src/common/prisma/prisma.service';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const hist = app.get(PortfolioHistoryService);
  const pbs = app.get(PerformanceBaselineService);
  const perf = app.get(PerformanceService);
  const prisma = app.get(PrismaService);

  for (const name of ['Om Patel','Ketan Gohil']) {
    const c = await prisma.client.findFirst({ where:{name} });
    if(!c) continue;
    console.log(`\n======== ${name} ========`);

    const r = await pbs.periodReturn(c.id, resolvePeriod('INCEPTION'));
    console.log(`HISTORICAL  open=${r.openingValue.toFixed(2)} close=${r.closingValue.toFixed(2)} gain=${(r.closingValue-r.openingValue).toFixed(2)} ret=${(r.returnPct!*100).toFixed(2)}%`);

    const ao = await hist.getPortfolioAsOf(c.id, new Date());
    console.log(`  asOf: pv=${ao.portfolioValue.toFixed(2)} hold=${ao.holdingsValue.toFixed(2)} cash=${ao.cash.toFixed(2)} totalCost=${ao.totalCost.toFixed(2)} unreal=${ao.unrealizedGain.toFixed(2)} real=${ao.realizedGain.toFixed(2)}`);

    const cur:any = await perf.forClient(c.id);
    const d = cur.data;
    if (d.status==='ok') {
      console.log(`CURRENT     invested=${d.investedCapital.toFixed(2)} unrealValue=${d.unrealizedValue.toFixed(2)} cash=${d.cashBalance.toFixed(2)} pv=${d.portfolioValue.toFixed(2)}`);
      console.log(`  totalGain=${d.totalGain.toFixed(2)} unrealGain=${d.unrealizedGain.toFixed(2)} realGain=${d.realizedGain.toFixed(2)} absRet=${(d.absoluteReturn*100).toFixed(2)}% contrib=${d.totalContributed.toFixed(2)} withdrawn=${d.totalWithdrawn.toFixed(2)}`);
    }
  }
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
