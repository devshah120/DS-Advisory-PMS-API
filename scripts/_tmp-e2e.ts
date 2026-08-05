import { PrismaClient } from '@prisma/client';
import { YahooEventsService } from '../src/market/yahoo-events.service';
import { EventSnapshotRepository } from '../src/events/event-snapshot.repository';
import { PortfolioEventsService } from '../src/events/portfolio-events.service';

(async () => {
  const prisma = new PrismaClient();
  const prismaSvc = prisma as any; // PrismaService is PrismaClient + lifecycle hooks
  const repo = new EventSnapshotRepository(prismaSvc);
  const svc = new PortfolioEventsService(prismaSvc, new YahooEventsService(), repo);

  const before = await prisma.eventSnapshot.count();
  console.log('snapshot rows before:', before);

  const result = await svc.refresh();
  console.log('refresh() ->', result);

  const after = await prisma.eventSnapshot.count();
  console.log('snapshot rows after:', after);

  const sources = await prisma.eventSnapshot.findMany({ select: { source: true } });
  console.log('sources:', [...new Set(sources.map((s) => s.source))]);

  const read = await svc.forAllHoldings();
  console.log('\nforAllHoldings() ->', read.length, 'events');
  for (const e of read.slice(0, 8)) {
    console.log(`  ${e.date}  ${e.ticker.padEnd(6)} ${e.label.padEnd(20)} held by ${e.clientCount}  ${e.company}`);
  }
  console.log('  rows with clientCount 0:', read.filter((e) => e.clientCount === 0).length);
  console.log('  rows with company === ticker (unresolved):', read.filter((e) => e.company === e.ticker).length);

  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
