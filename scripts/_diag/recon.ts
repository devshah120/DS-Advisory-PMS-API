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
  const clients = await prisma.client.findMany({ orderBy:{name:'asc'} });
  let fails = 0;

  for (const c of clients) {
    const cur:any = await perf.forClient(c.id);
    const d = cur.data;
    if (d.status!=='ok') { console.log(`${c.name}: ${d.reason}`); continue; }
    const r = await pbs.periodReturn(c.id, resolvePeriod('INCEPTION'));
    const histGain = r.closingValue - r.openingValue;

    const recon = d.reconciliation;
    const pvMatch = Math.abs(d.portfolioValue - r.closingValue) < 0.01;
    const gainMatch = Math.abs(d.totalGain - histGain) < 0.01;
    const ok = recon.balanced && pvMatch && gainMatch;
    if(!ok) fails++;

    console.log(`\n${ok?'PASS':'FAIL'}  ${c.name}`);
    console.log(`   CURRENT   pv=${d.portfolioValue.toFixed(2).padStart(11)} invested=${d.investedCapital.toFixed(2).padStart(11)} totalGain=${d.totalGain.toFixed(2).padStart(10)} unreal=${d.unrealizedGain.toFixed(2).padStart(10)} abs=${(d.absoluteReturn*100).toFixed(2)}%`);
    console.log(`   HISTORIC  pv=${r.closingValue.toFixed(2).padStart(11)} opening =${r.openingValue.toFixed(2).padStart(11)} gain     =${histGain.toFixed(2).padStart(10)}                    ret=${(r.returnPct!*100).toFixed(2)}%`);
    console.log(`   identity  flows=${recon.totalGainFromFlows.toFixed(2)} positions=${recon.totalGainFromPositions.toFixed(2)} residual=${recon.residual.toFixed(4)} balanced=${recon.balanced}`);
    if(!pvMatch) console.log(`   !! portfolio value mismatch: ${(d.portfolioValue-r.closingValue).toFixed(2)}`);
    if(!gainMatch) console.log(`   !! gain mismatch: ${(d.totalGain-histGain).toFixed(2)}`);
  }
  console.log(fails===0 ? '\n=== ALL CLIENTS RECONCILE ===' : `\n=== ${fails} CLIENT(S) FAILED ===`);
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
