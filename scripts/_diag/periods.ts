import { resolvePeriod, availablePeriods } from '../../src/portfolio-reconstruction/periods';
const asOf = new Date('2026-08-05T00:00:00.000Z');
console.log('Dropdown options:');
for (const o of availablePeriods(asOf)) console.log(`  ${o.code.padEnd(12)} ${o.label}`);
console.log('\nResolution (asOf 2026-08-05):');
for (const c of ['INCEPTION','QTD','MTD','YTD','Q3-CY26','Q2-CY26','Q4-CY26']) {
  try {
    const r = resolvePeriod(c, { asOf });
    console.log(`  ${c.padEnd(11)} ${r.from.toISOString().slice(0,10)} -> ${r.to.toISOString().slice(0,10)}  clamped=${r.clampedToInception} open=${r.openPeriod}  "${r.label}"`);
  } catch(e:any) { console.log(`  ${c.padEnd(11)} ERROR: ${e.message}`); }
}
try { resolvePeriod('Q1-CY26',{asOf}); } catch(e:any){ console.log(`  Q1-CY26     -> rejected/clamped: ${e.message.slice(0,80)}`); }
const q1 = resolvePeriod('Q1-CY26',{asOf});
console.log(`  Q1-CY26     ${q1.from.toISOString().slice(0,10)} -> ${q1.to.toISOString().slice(0,10)} clamped=${q1.clampedToInception}`);
