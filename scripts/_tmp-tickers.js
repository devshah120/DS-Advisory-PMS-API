const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const h = await p.holding.findMany({ select: { ticker: true, company: true } });
  const set = new Map();
  for (const x of h) set.set(x.ticker, x.company);
  console.log('distinct tickers:', set.size, '| holding rows:', h.length);
  for (const [t, c] of [...set].sort()) console.log(t, '|', c);
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
