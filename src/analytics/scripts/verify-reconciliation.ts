/**
 * Cross-tab reconciliation, run against LIVE data.
 *
 * The unit tests in performance-reconciliation.spec.ts prove the arithmetic; this
 * proves the arithmetic is what the running system actually produces, for every
 * client. Run it after any change to pricing, cost basis, baselines or flows.
 *
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/verify-reconciliation.ts
 *
 * Exits non-zero if any client fails, so it can gate a deploy.
 *
 * The four checks, and why each exists:
 *
 *   1. PORTFOLIO VALUE — both tabs must value the same book at the same instant
 *      identically. They once differed by $683 because one priced from PriceBar
 *      (yesterday's close) and the other from the live quote.
 *
 *   2. GAIN IDENTITY — totalGain from the flow series must equal the sum of the
 *      position-level gains. This broke when unrealizedGain used the pre-import
 *      cost basis while investedCapital used the 30-June one.
 *
 *   3. OPENING VALUE — the Historical tab's opening value must be the baseline's
 *      stored opening value. Catches a baseline that drifted from what the
 *      reconstruction replays onto.
 *
 *   4. EXPLAINED GAP — the two tabs legitimately differ when idle cash is
 *      deployed into stock after inception (Current excludes idle cash;
 *      Historical includes it). That difference must equal exactly
 *      `cashDeployed − increaseInInvestedCapital` — the price movement between
 *      the 30-June basis and the price actually paid. Anything else is an error
 *      hiding inside a difference that looks legitimate.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { PerformanceBaselineService } from '../../portfolio-reconstruction/performance-baseline.service';
import { PerformanceService } from '../services/performance.service';
import { resolvePeriod } from '../../portfolio-reconstruction/periods';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Cents, not dollars — anything larger is a real disagreement, not float noise. */
const TOLERANCE = 0.01;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const perf = app.get(PerformanceService);
  const baseline = app.get(PerformanceBaselineService);
  const prisma = app.get(PrismaService);

  const clients = await prisma.client.findMany({ orderBy: { name: 'asc' } });
  const failures: string[] = [];

  for (const client of clients) {
    const current: any = await perf.forClient(client.id);
    const d = current.data;

    if (d.status !== 'ok') {
      console.log(`SKIP  ${client.name} — ${d.reason}`);
      continue;
    }

    const historical = await baseline.periodReturn(client.id, resolvePeriod('INCEPTION'));
    const row = await prisma.portfolioBaseline.findUnique({ where: { clientId: client.id } });
    if (!row) {
      console.log(`SKIP  ${client.name} — no baseline`);
      continue;
    }

    const baselineHoldings = row.openingPortfolioValue - row.openingCash;
    const cashDeployed = row.openingCash - d.cashBalance;
    const investedIncrease = d.investedCapital - baselineHoldings;

    const historicalGain = historical.closingValue - historical.openingValue;
    const gap = d.totalGain - historicalGain;

    const checks = {
      portfolioValue: Math.abs(d.portfolioValue - historical.closingValue) < TOLERANCE,
      gainIdentity: d.reconciliation.balanced,
      openingValue: Math.abs(historical.openingValue - row.openingPortfolioValue) < TOLERANCE,
      explainedGap: Math.abs(gap - (cashDeployed - investedIncrease)) < TOLERANCE,
    };

    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    if (failed.length > 0) failures.push(`${client.name}: ${failed.join(', ')}`);

    console.log(
      `${failed.length === 0 ? 'PASS' : 'FAIL'}  ${client.name.padEnd(15)} ` +
        `pv=${d.portfolioValue.toFixed(2).padStart(11)} ` +
        `gain(current)=${d.totalGain.toFixed(2).padStart(10)} ` +
        `gain(historical)=${historicalGain.toFixed(2).padStart(10)} ` +
        `gap=${gap.toFixed(2).padStart(9)} ` +
        `explained=${(cashDeployed - investedIncrease).toFixed(2).padStart(9)}`,
    );

    if (failed.length > 0) {
      console.log(`      failed: ${failed.join(', ')}`);
    }
  }

  await app.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} client(s) failed reconciliation:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log('\nAll clients reconcile — every cross-tab difference is fully explained.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
