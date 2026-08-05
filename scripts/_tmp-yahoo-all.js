const { PrismaClient } = require('@prisma/client');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getSession() {
  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const cookie = seed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  return { cookie, crumb: (await res.text()).trim() };
}

(async () => {
  const p = new PrismaClient();
  const rows = await p.holding.findMany({ select: { ticker: true } });
  const tickers = [...new Set(rows.map((r) => r.ticker))].sort();
  await p.$disconnect();

  const s = await getSession();
  const today = new Date().toISOString().slice(0, 10);
  let counts = { earnings: 0, div: 0, split: 0, empty: 0, fail: 0 };

  for (const t of tickers) {
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}` +
      `?modules=calendarEvents,defaultKeyStatistics&crumb=${encodeURIComponent(s.crumb)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
    if (!r.ok) { counts.fail++; console.log(t.padEnd(6), 'HTTP', r.status); continue; }
    const j = await r.json().catch(() => null);
    const res0 = j?.quoteSummary?.result?.[0];
    const ce = res0?.calendarEvents;
    const ed = ce?.earnings?.earningsDate?.[0]?.fmt;
    const est = ce?.earnings?.isEarningsDateEstimate;
    const ex = ce?.exDividendDate?.fmt;
    const pay = ce?.dividendDate?.fmt;
    const sd = res0?.defaultKeyStatistics?.lastSplitDate?.fmt;
    if (ed) counts.earnings++;
    if (ex && ex >= today) counts.div++;
    if (sd && sd >= today) counts.split++;
    if (!ed && !ex && !sd) counts.empty++;
    console.log(
      t.padEnd(6),
      'earn=' + (ed || '-') + (est === true ? '(est)' : est === false ? '(conf)' : ''),
      'ex=' + (ex || '-') + (ex && ex < today ? '(past)' : ''),
      'pay=' + (pay || '-'),
      'split=' + (sd || '-'),
    );
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log('\nSUMMARY', JSON.stringify(counts), 'of', tickers.length, 'tickers; today =', today);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
