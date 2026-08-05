import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PortfolioHistoryService } from '../../src/portfolio-reconstruction/portfolio-history.service';
import { SnapshotService } from '../../src/analytics/services/snapshot.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const hist = app.get(PortfolioHistoryService); const snaps = app.get(SnapshotService);
  const prisma = app.get(PrismaService);
  for (const n of ['Mrugesh Patel','Om Patel','Shubh Laiwala']) {
    const c = await prisma.client.findFirst({where:{name:n}});
    const ao = await hist.getPortfolioAsOf(c!.id, new Date());
    const snap = await snaps.forClient(c!.id);
    const H = new Map(ao.positions.map(p=>[p.ticker,p]));
    const S = new Map(snap.positions.map(p=>[p.ticker,p]));
    const all = [...new Set([...H.keys(),...S.keys()])].sort();
    console.log(`\n=== ${n} === histPos=${ao.positions.length} snapPos=${snap.positions.length}`);
    for (const t of all) {
      const h=H.get(t), s=S.get(t);
      const hq=h?.quantity??0, sq=s?.quantity??0;
      const hv=h?.marketValue??0, sv=s?.marketValue??0;
      if (Math.abs(hq-sq)>0.0001 || Math.abs(hv-sv)>0.5) {
        console.log(`  ${t.padEnd(8)} histQty=${hq.toFixed(4).padStart(11)} snapQty=${sq.toFixed(4).padStart(11)} | histMV=${hv.toFixed(2).padStart(10)} snapMV=${sv.toFixed(2).padStart(10)} | dMV=${(sv-hv).toFixed(2)}`);
      }
    }
  }
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
