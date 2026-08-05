const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getSession() {
  const seed = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const cookie = seed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie },
  });
  const crumb = (await res.text()).trim();
  return { cookie, crumb };
}

(async () => {
  const s = await getSession();
  console.log('crumb:', JSON.stringify(s.crumb).slice(0, 40), '| cookie len:', s.cookie.length);

  for (const sym of ['AAPL', 'HEI-A', 'IAU', 'JPM']) {
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}` +
      `?modules=calendarEvents,defaultKeyStatistics,summaryDetail&crumb=${encodeURIComponent(s.crumb)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: s.cookie } });
    const j = await r.json().catch(() => null);
    const res0 = j?.quoteSummary?.result?.[0];
    console.log('\n===', sym, 'status', r.status);
    console.log('calendarEvents:', JSON.stringify(res0?.calendarEvents)?.slice(0, 600));
    console.log('exDivDate:', JSON.stringify(res0?.summaryDetail?.exDividendDate));
    console.log('lastSplit:', JSON.stringify(res0?.defaultKeyStatistics?.lastSplitDate), JSON.stringify(res0?.defaultKeyStatistics?.lastSplitFactor));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
