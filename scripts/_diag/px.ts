import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { HistoricalPriceService } from '../../src/historical-price/historical-price.service';
import { SnapshotService } from '../../src/analytics/services/snapshot.service';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  const prisma = app.get(PrismaService);
  const prices = app.get(HistoricalPriceService);
  const snaps = app.get(SnapshotService);
  const c = await prisma.client.findFirst({ where:{name:'Ketan Gohil'}, include:{holdings:true} });
  const asOf = new Date();
  const snap = await snaps.forClient(c!.id);
  const closes = await prices.closesOn(c!.holdings.map(h=>h.ticker), asOf);
  console.log('ticker      qty        histClose   snapPrice   histMV       snapMV      diff');
  let hm=0, sm=0;
  for (const h of c!.holdings) {
    const pos = snap.positions.find(p=>p.ticker===h.ticker);
    const hc = closes.get(h.ticker);
    const sp = pos?.price;
    const hmv = h.quantity * (hc ?? 0);
    const smv = pos?.marketValue ?? 0;
    hm+=hmv; sm+=smv;
    const d = smv-hmv;
    console.log(`${h.ticker.padEnd(10)} ${h.quantity.toFixed(3).padStart(9)} ${(hc??0).toFixed(2).padStart(10)} ${(sp??0).toFixed(2).padStart(11)} ${hmv.toFixed(2).padStart(11)} ${smv.toFixed(2).padStart(11)} ${Math.abs(d)>0.01?d.toFixed(2):''}`);
  }
  console.log(`TOTAL hist=${hm.toFixed(2)} snap=${sm.toFixed(2)} diff=${(sm-hm).toFixed(2)}`);
  // latest bar dates
  const bars = await prisma.priceBar.groupBy({ by:['symbol'], _max:{date:true}, where:{symbol:{in:c!.holdings.map(h=>h.ticker)}} });
  console.log('\nlatest bar per symbol:');
  for (const b of bars) console.log(`  ${b.symbol.padEnd(8)} ${b._max.date?.toISOString().slice(0,10)}`);
  await app.close();
})().catch(e=>{console.error(e);process.exit(1);});
