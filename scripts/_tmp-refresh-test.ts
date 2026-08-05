import { PrismaClient } from '@prisma/client';
import { YahooEventsService } from '../src/market/yahoo-events.service';

(async () => {
  const prisma = new PrismaClient();
  const holdings = await prisma.holding.findMany({ select: { ticker: true } });
  const tickers = [...new Set(holdings.map((h) => h.ticker))];

  const svc = new YahooEventsService();
  const started = Date.now();
  const events = await svc.forTickers(tickers);
  console.log(`fetched ${events.length} events for ${tickers.length} tickers in ${Date.now() - started}ms\n`);

  for (const e of events) {
    console.log(`${e.date}  ${e.ticker.padEnd(6)} ${e.code}  ${e.label.padEnd(24)} ${e.status}`);
  }

  const byType = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\nby type:', byType);
  console.log('distinct tickers with events:', new Set(events.map((e) => e.ticker)).size);
  const today = new Date().toISOString().slice(0, 10);
  console.log('any past-dated leaked through:', events.filter((e) => e.date < today).length);

  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
