import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ALL_METRICS, MetricName, PILLAR_METRICS, Pillar } from './scoring-metrics';

// Matches seed-scoring-rules.ts's NEG_INF/POS_INF (-999999/999999) — the finite
// stand-ins for -Infinity/+Infinity used because ScoringRule's bounds are
// finite DB columns. A raw-dollar metric (Free Cash Flow, Enterprise Value)
// can exceed 999999 for a real company, so `value < maximumValue` would wrongly
// reject it on the very band meant to catch "everything above X" — comparing
// against THIS constant, not the literal column value, is what makes a band
// whose bound IS the sentinel open-ended regardless of the metric's scale.
const INFINITY_SENTINEL = 999999;

export interface MetricInput {
  metric: MetricName;
  /** Null when the underlying data point wasn't available — see `computeMetric`. */
  value: number | null;
}

export interface MetricScore {
  pillar: Pillar;
  metric: MetricName;
  value: number | null;
  /** The matched ScoringRule's [minimumValue, maximumValue), or null when no value/no rule matched. */
  matchedRange: { min: number; max: number } | null;
  /** 0-100, as authored on the matched rule. Null when unscored. */
  score: number | null;
  /** Points out of 100 for the metric's pillar, as authored on the matched rule. */
  weight: number;
  /** score/100 * weight — what this metric actually contributed to the pillar total. */
  contribution: number;
}

export interface PillarScore {
  pillar: Pillar;
  /** Sum of contributions, out of the sum of weights actually available (see below). */
  score: number;
  metrics: MetricScore[];
}

export interface FundamentalScoreResult {
  overallScore: number;
  pillars: Record<Pillar, PillarScore>;
  breakdown: MetricScore[];
}

/**
 * Reads ScoringRule from the database and nothing else. There is no
 * switch/if-chain anywhere in this class mapping a metric or a strategy to a
 * score — every band, every weight, and every strategy is a row this engine
 * looks up. A brand-new strategy ("Value", "Quality", "Dividend", "Small
 * Cap", "AI", ...) or a re-tuned band is a set of INSERT/UPDATE statements
 * against ScoringRule; this file does not change.
 *
 * Rule matching: for a given (strategy, metricName, value), the matched rule
 * is the one row where minimumValue <= value < maximumValue. Seed data must
 * tile each metric's number line with no gaps/overlaps (see schema.prisma's
 * ScoringRule doc) for this to always resolve to exactly one row; if two rows
 * match, the first one Prisma returns wins — a data-authoring bug, not
 * something this engine silently repairs.
 */
@Injectable()
export class ScoringEngine {
  constructor(private prisma: PrismaService) {}

  /**
   * Scores one company's metric inputs against one strategy. `weightOverride`
   * lets a caller substitute the sum of pillar weights actually available
   * (see FundamentalService) instead of assuming every metric has data.
   */
  async score(strategy: string, inputs: MetricInput[]): Promise<FundamentalScoreResult> {
    const rules = await this.prisma.scoringRule.findMany({ where: { strategy } });
    const rulesByMetric = new Map<string, typeof rules>();
    for (const rule of rules) {
      const list = rulesByMetric.get(rule.metricName) ?? [];
      list.push(rule);
      rulesByMetric.set(rule.metricName, list);
    }

    const byMetric = new Map(inputs.map((i) => [i.metric, i.value]));
    const breakdown: MetricScore[] = ALL_METRICS.map((metric) =>
      this.scoreOne(metric, byMetric.get(metric) ?? null, rulesByMetric.get(metric) ?? []),
    );

    const pillars = {} as Record<Pillar, PillarScore>;
    for (const pillar of Object.keys(PILLAR_METRICS) as Pillar[]) {
      const pillarMetrics = breakdown.filter((m) => m.pillar === pillar);
      pillars[pillar] = { pillar, score: weightedAverage(pillarMetrics), metrics: pillarMetrics };
    }

    const overallScore = weightedAverage(breakdown);

    return { overallScore, pillars, breakdown };
  }

  private scoreOne(metric: MetricName, value: number | null, rules: { minimumValue: number; maximumValue: number; score: number; weight: number }[]): MetricScore {
    const pillar = pillarOf(metric);
    const weight = rules[0]?.weight ?? 0;

    if (value == null || rules.length === 0) {
      return { pillar, metric, value, matchedRange: null, score: null, weight, contribution: 0 };
    }

    // Seed data stands in for -Infinity/+Infinity with a large finite sentinel
    // (see seed-scoring-rules.ts), because these are finite DB columns. Some
    // metrics (Free Cash Flow, Enterprise Value, ...) are raw dollar amounts
    // that routinely exceed that sentinel, so a literal `value < maximumValue`
    // comparison would reject a real value as out of range on the very band
    // meant to catch "everything above X". Any band whose max/min IS the
    // sentinel is therefore treated as open-ended on that side.
    const matched = rules.find(
      (r) =>
        (r.minimumValue <= -INFINITY_SENTINEL || value >= r.minimumValue) &&
        (r.maximumValue >= INFINITY_SENTINEL || value < r.maximumValue),
    );
    if (!matched) {
      return { pillar, metric, value, matchedRange: null, score: null, weight, contribution: 0 };
    }

    return {
      pillar,
      metric,
      value,
      matchedRange: { min: matched.minimumValue, max: matched.maximumValue },
      score: matched.score,
      weight: matched.weight,
      contribution: (matched.score / 100) * matched.weight,
    };
  }
}

/**
 * Sum of contributions over the sum of weights for metrics that actually
 * scored, rescaled to a 0-100 pillar/overall figure. A metric with no data
 * (score: null) contributes neither points nor weight to the denominator —
 * it is excluded from the average rather than silently counted as a zero,
 * which would punish a company for a data gap rather than for performance.
 */
function weightedAverage(metrics: MetricScore[]): number {
  const scored = metrics.filter((m) => m.score != null);
  const totalWeight = scored.reduce((s, m) => s + m.weight, 0);
  if (totalWeight === 0) return 0;
  const totalContribution = scored.reduce((s, m) => s + m.contribution, 0);
  return (totalContribution / totalWeight) * 100;
}

function pillarOf(metric: MetricName): Pillar {
  for (const [pillar, metrics] of Object.entries(PILLAR_METRICS)) {
    if ((metrics as readonly string[]).includes(metric)) return pillar as Pillar;
  }
  throw new Error(`Metric "${metric}" is not assigned to any pillar`);
}
