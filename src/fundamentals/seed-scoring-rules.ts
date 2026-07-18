/**
 * Seeds ScoringRule with the GARP (Growth At Reasonable Price) strategy.
 * This is data, not logic — ScoringEngine never special-cases "GARP"
 * anywhere in code. Adding "Value", "Quality", "Dividend", "Small Cap", "AI"
 * later means writing another array shaped exactly like this one and
 * inserting it; ScoringEngine, FundamentalService, and the controller do not
 * change.
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/fundamentals/seed-scoring-rules.ts
 *
 * Each metric's rows must tile the full number line with no gaps or overlaps
 * (min inclusive, max exclusive) — see the ScoringRule model doc in
 * schema.prisma. -999/999 stand in for -Infinity/+Infinity since these are
 * finite DB columns.
 */
import { PrismaClient } from '@prisma/client';

const NEG_INF = -999999;
const POS_INF = 999999;

interface Band {
  min: number;
  max: number;
  score: number;
}

function bands(metricName: string, weight: number, strategy: string, rows: Band[]) {
  return rows.map((r) => ({
    metricName,
    minimumValue: r.min,
    maximumValue: r.max,
    score: r.score,
    weight,
    strategy,
  }));
}

const GARP = 'GARP';

export const GARP_SCORING_RULES = [
  // ── Growth — 35 total (10 + 10 + 7.5 + 7.5) ──────────────────────────────
  ...bands('Revenue YoY', 10, GARP, [
    { min: 30, max: POS_INF, score: 100 },
    { min: 20, max: 30, score: 90 },
    { min: 15, max: 20, score: 80 },
    { min: 10, max: 15, score: 70 },
    { min: 5, max: 10, score: 50 },
    { min: 0, max: 5, score: 25 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('Profit YoY', 10, GARP, [
    { min: 30, max: POS_INF, score: 100 },
    { min: 20, max: 30, score: 90 },
    { min: 15, max: 20, score: 80 },
    { min: 10, max: 15, score: 70 },
    { min: 5, max: 10, score: 50 },
    { min: 0, max: 5, score: 25 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('Revenue CAGR 3Y', 7.5, GARP, [
    { min: 25, max: POS_INF, score: 100 },
    { min: 18, max: 25, score: 90 },
    { min: 12, max: 18, score: 80 },
    { min: 8, max: 12, score: 70 },
    { min: 4, max: 8, score: 50 },
    { min: 0, max: 4, score: 25 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('Profit CAGR 3Y', 7.5, GARP, [
    { min: 25, max: POS_INF, score: 100 },
    { min: 18, max: 25, score: 90 },
    { min: 12, max: 18, score: 80 },
    { min: 8, max: 12, score: 70 },
    { min: 4, max: 8, score: 50 },
    { min: 0, max: 4, score: 25 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),

  // ── Profitability — 25 total (10 + 7 + 4 + 4) ────────────────────────────
  ...bands('ROE', 10, GARP, [
    { min: 30, max: POS_INF, score: 100 },
    { min: 20, max: 30, score: 90 },
    { min: 15, max: 20, score: 75 },
    { min: 10, max: 15, score: 55 },
    { min: 5, max: 10, score: 35 },
    { min: 0, max: 5, score: 15 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('ROIC', 7, GARP, [
    { min: 25, max: POS_INF, score: 100 },
    { min: 15, max: 25, score: 90 },
    { min: 10, max: 15, score: 75 },
    { min: 6, max: 10, score: 55 },
    { min: 3, max: 6, score: 35 },
    { min: 0, max: 3, score: 15 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('Operating Margin', 4, GARP, [
    { min: 30, max: POS_INF, score: 100 },
    { min: 20, max: 30, score: 85 },
    { min: 12, max: 20, score: 70 },
    { min: 6, max: 12, score: 50 },
    { min: 0, max: 6, score: 30 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),
  ...bands('Net Margin', 4, GARP, [
    { min: 20, max: POS_INF, score: 100 },
    { min: 12, max: 20, score: 85 },
    { min: 7, max: 12, score: 70 },
    { min: 3, max: 7, score: 50 },
    { min: 0, max: 3, score: 30 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),

  // ── Financial Strength — 15 total (6 + 4 + 3 + 2) ────────────────────────
  // Lower Debt/Equity is better, so the band scoring runs in reverse (low value -> high score).
  ...bands('Debt / Equity', 6, GARP, [
    { min: NEG_INF, max: 0.25, score: 100 },
    { min: 0.25, max: 0.5, score: 85 },
    { min: 0.5, max: 1, score: 65 },
    { min: 1, max: 1.5, score: 45 },
    { min: 1.5, max: 2.5, score: 25 },
    { min: 2.5, max: POS_INF, score: 0 },
  ]),
  ...bands('Interest Coverage', 4, GARP, [
    { min: 15, max: POS_INF, score: 100 },
    { min: 8, max: 15, score: 85 },
    { min: 4, max: 8, score: 65 },
    { min: 2, max: 4, score: 40 },
    { min: 1, max: 2, score: 15 },
    { min: NEG_INF, max: 1, score: 0 },
  ]),
  ...bands('Current Ratio', 3, GARP, [
    { min: 2, max: POS_INF, score: 100 },
    { min: 1.5, max: 2, score: 85 },
    { min: 1.2, max: 1.5, score: 70 },
    { min: 1, max: 1.2, score: 50 },
    { min: 0.8, max: 1, score: 25 },
    { min: NEG_INF, max: 0.8, score: 0 },
  ]),
  // FCF is scale-dependent (billions for a mega-cap, thousands for a micro-cap),
  // so this band only distinguishes "generating cash" from "burning cash" —
  // sign, not magnitude, is what a single unscaled threshold can honestly score.
  ...bands('Free Cash Flow', 2, GARP, [
    { min: 0, max: POS_INF, score: 100 },
    { min: NEG_INF, max: 0, score: 0 },
  ]),

  // ── Valuation — 15 total (6 + 4 + 3 + 2) ─────────────────────────────────
  // "vs Industry" metrics are scored on premium/discount PERCENT: negative
  // (trading below industry) scores well, large positive (expensive vs.
  // peers) scores poorly — the GARP "reasonable price" half of the philosophy.
  ...bands('PE vs Industry', 6, GARP, [
    { min: NEG_INF, max: -20, score: 100 },
    { min: -20, max: -5, score: 85 },
    { min: -5, max: 10, score: 65 },
    { min: 10, max: 30, score: 40 },
    { min: 30, max: 60, score: 20 },
    { min: 60, max: POS_INF, score: 0 },
  ]),
  // PEG < 1 is the textbook "growth not yet priced in" GARP signal.
  ...bands('PEG Ratio', 4, GARP, [
    { min: NEG_INF, max: 0, score: 30 }, // negative PEG (shrinking earnings or loss) isn't free money — flagged, not rewarded
    { min: 0, max: 1, score: 100 },
    { min: 1, max: 1.5, score: 75 },
    { min: 1.5, max: 2, score: 50 },
    { min: 2, max: 3, score: 25 },
    { min: 3, max: POS_INF, score: 0 },
  ]),
  ...bands('EV / EBITDA vs Industry', 3, GARP, [
    { min: NEG_INF, max: -20, score: 100 },
    { min: -20, max: -5, score: 85 },
    { min: -5, max: 10, score: 65 },
    { min: 10, max: 30, score: 40 },
    { min: 30, max: 60, score: 20 },
    { min: 60, max: POS_INF, score: 0 },
  ]),
  ...bands('Price / Sales vs Industry', 2, GARP, [
    { min: NEG_INF, max: -20, score: 100 },
    { min: -20, max: -5, score: 85 },
    { min: -5, max: 10, score: 65 },
    { min: 10, max: 30, score: 40 },
    { min: 30, max: 60, score: 20 },
    { min: 60, max: POS_INF, score: 0 },
  ]),

  // ── Momentum — 10 total (4 + 4 + 2) ──────────────────────────────────────
  ...bands('Revenue QoQ', 4, GARP, [
    { min: 10, max: POS_INF, score: 100 },
    { min: 5, max: 10, score: 85 },
    { min: 2, max: 5, score: 65 },
    { min: 0, max: 2, score: 45 },
    { min: -3, max: 0, score: 20 },
    { min: NEG_INF, max: -3, score: 0 },
  ]),
  ...bands('Profit QoQ', 4, GARP, [
    { min: 10, max: POS_INF, score: 100 },
    { min: 5, max: 10, score: 85 },
    { min: 2, max: 5, score: 65 },
    { min: 0, max: 2, score: 45 },
    { min: -3, max: 0, score: 20 },
    { min: NEG_INF, max: -3, score: 0 },
  ]),
  ...bands('Last Four Earnings Beat %', 2, GARP, [
    { min: 10, max: POS_INF, score: 100 },
    { min: 3, max: 10, score: 80 },
    { min: 0, max: 3, score: 60 },
    { min: -3, max: 0, score: 35 },
    { min: NEG_INF, max: -3, score: 10 },
  ]),
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.scoringRule.count({ where: { strategy: GARP } });
    if (existing > 0) {
      await prisma.scoringRule.deleteMany({ where: { strategy: GARP } });
      console.log(`Cleared ${existing} existing GARP rows before reseeding.`);
    }
    await prisma.scoringRule.createMany({ data: GARP_SCORING_RULES });
    console.log(`Seeded ${GARP_SCORING_RULES.length} GARP scoring rules.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
