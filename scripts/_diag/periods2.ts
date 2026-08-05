import { resolvePeriod, availablePeriods } from '../../src/portfolio-reconstruction/periods';
const asOf = new Date('2026-08-05T00:00:00.000Z');
console.log('Dropdown:');
for (const o of availablePeriods(asOf)) console.log(`  ${o.code.padEnd(12)} ${o.label}`);
console.log('\nResolution:');
for (const c of ['INCEPTION','QTD','MTD','YTD','Q3-CY26']) {
  const r = resolvePeriod(c, { asOf });
  console.log(`  ${c.padEnd(11)} ${r.from.toISOString().slice(0,10)} -> ${r.to.toISOString().slice(0,10)}  anchored=${r.clampedToInception} open=${r.openPeriod}`);
}
console.log('\nFuture calendar (asOf 2027-02-10):');
const a2 = new Date('2027-02-10T00:00:00.000Z');
for (const o of availablePeriods(a2)) console.log(`  ${o.code.padEnd(12)} ${o.label}`);
for (const c of ['Q4-CY26','Q1-CY27','QTD']) {
  const r = resolvePeriod(c, { asOf: a2 });
  console.log(`  ${c.padEnd(11)} ${r.from.toISOString().slice(0,10)} -> ${r.to.toISOString().slice(0,10)} anchored=${r.clampedToInception} open=${r.openPeriod}`);
}
