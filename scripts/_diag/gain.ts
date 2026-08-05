import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { SnapshotService } from '../../src/analytics/services/snapshot.service';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const prisma = app.get(PrismaService);
  const snaps = app.get(SnapshotService);
  const c = await prisma.client.findFirst({ where:{name:'Ketan Gohil'} });
  const snap = await snaps.forClient(c!.id);
  console.log('ticker    qty        price    costBasis(perShare)  mktValue     costTotal   unrealPnl');
  let mv=0, ct=0, up=0;
  for (const p of snap.positions) {
    mv+=p.marketValue; ct+=p.costBasisTotal; up+=p.unrealizedPnl;
    console.log(`${p.ticker.padEnd(8)} ${p.quantity.toFixed(3).padStart(9)} ${p.price.toFixed(2).padStart(8)} ${p.costBasis.toFixed(2).padStart(18)} ${p.marketValue.toFixed(2).padStart(11)} ${p.costBasisTotal.toFixed(2).padStart(11)} ${p.unrealizedPnl.toFixed(2).padStart(10)}`);
  }
  console.log(`TOTALS  mv=${mv.toFixed(2)} costTotal=${ct.toFixed(2)} unrealPnl=${up.toFixed(2)}`);
  console.log(`\nmv - costTotal = ${(mv-ct).toFixed(2)}   <-- should equal unrealPnl`);
  const base = await prisma.portfolioBaseline.findUnique({ where:{clientId:c!.id} });
  console.log(`baseline openingValue = ${base!.openingPortfolioValue.toFixed(2)} (this is the TRUE invested capital / cost basis since inception)`);
  console.log(`mv - baselineOpening  = ${(mv-base!.openingPortfolioValue).toFixed(2)}  <-- the TRUE gain since 30 June`);
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
