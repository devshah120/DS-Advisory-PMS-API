/**
 * READ-ONLY audit of every HEI-variant symbol across the database.
 * Writes nothing. Run before any cleanup so the blast radius is known.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Match HEI, HEI-A, HEI.A, HEI_A, hei.a ... anything in the HEI family.
const HEI_FAMILY = /^HEI[-._ ]?A?$/i;

async function main() {
  const clients = await prisma.client.findMany({
    select: { id: true, name: true },
  });
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const report: Record<string, any[]> = {};

  // --- ticker-keyed models -------------------------------------------------
  const tickerModels = [
    ['Holding', prisma.holding],
    ['Transaction', prisma.transaction],
    ['Research', prisma.research],
    ['Watchlist', prisma.watchlist],
    ['HoldingSnapshot', prisma.holdingSnapshot],
    ['EventSnapshot', prisma.eventSnapshot],
    ['BaselineHolding', prisma.baselineHolding],
  ] as const;

  for (const [name, model] of tickerModels) {
    const rows = await (model as any).findMany({
      where: { ticker: { startsWith: 'HEI', mode: 'insensitive' } },
    });
    const hits = rows.filter((r: any) => r.ticker && HEI_FAMILY.test(r.ticker));
    report[name] = hits;
  }

  // --- symbol-keyed models -------------------------------------------------
  const symbolModels = [
    ['PriceBar', prisma.priceBar],
    ['InstrumentProfile', prisma.instrumentProfile],
    ['FundamentalSnapshot', prisma.fundamentalSnapshot],
    ['FundamentalScore', prisma.fundamentalScore],
  ] as const;

  for (const [name, model] of symbolModels) {
    try {
      const rows = await (model as any).findMany({
        where: { symbol: { startsWith: 'HEI', mode: 'insensitive' } },
      });
      const hits = rows.filter(
        (r: any) => r.symbol && HEI_FAMILY.test(r.symbol),
      );
      report[name] = hits;
    } catch (e: any) {
      report[name] = [{ ERROR: e.message?.slice(0, 200) }];
    }
  }

  // --- print ---------------------------------------------------------------
  for (const [model, rows] of Object.entries(report)) {
    if (!rows.length) {
      console.log(`\n${model}: none`);
      continue;
    }
    const bySymbol: Record<string, number> = {};
    for (const r of rows) {
      const k = r.ticker ?? r.symbol ?? '??';
      bySymbol[k] = (bySymbol[k] || 0) + 1;
    }
    console.log(`\n${model}: ${rows.length} row(s) ->`, bySymbol);

    if (model === 'Holding' || model === 'BaselineHolding') {
      for (const r of rows) {
        console.log(
          `   [${r.ticker}] client=${clientName.get(r.clientId) ?? r.clientId}` +
            ` qty=${r.quantity} avgCost=${r.averageCost ?? '-'}` +
            ` mktVal=${r.marketValue ?? '-'} company="${r.company ?? '-'}" id=${r.id}`,
        );
      }
    }
    if (model === 'Transaction') {
      for (const r of rows) {
        console.log(
          `   [${r.ticker}] client=${clientName.get(r.clientId) ?? r.clientId}` +
            ` ${r.type} qty=${r.quantity} px=${r.price} amt=${r.amount}` +
            ` date=${r.date?.toISOString?.().slice(0, 10)} id=${r.id}`,
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
