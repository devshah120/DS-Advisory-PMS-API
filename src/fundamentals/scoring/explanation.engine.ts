import { Injectable } from '@nestjs/common';
import { FundamentalSnapshot } from '@prisma/client';
import { MetricScore } from './scoring-engine';
import { IndustryComparisonResult } from './industry-comparison.engine';

export interface Explanation {
  strengths: string[];
  weaknesses: string[];
}

// Only a metric scoring at/above this band is worth calling out as a strength;
// only at/below this is worth flagging as a weakness. The 40-point gap between
// them is deliberate — an unremarkable, middling metric (40-79) says nothing
// interesting about the company and is correctly left out of both lists.
const STRENGTH_THRESHOLD = 80;
const WEAKNESS_THRESHOLD = 40;

// A valuation premium/discount only reads as noteworthy past this magnitude;
// single-digit deviations from a peer average are within normal noise.
const NOTABLE_PREMIUM_PERCENT = 15;

/**
 * Turns a scored breakdown into the plain-English strengths/weaknesses list
 * the UI renders under a company's Atlas Fundamental Score. Entirely
 * derived from the SAME MetricScore/IndustryComparisonResult objects the
 * score itself was built from — there is no separate narrative logic that
 * could disagree with the number next to it, and no strategy-specific
 * wording to maintain: swap the strategy and the same thresholds produce a
 * different explanation because the underlying scores differ, not because
 * this class special-cases the strategy name.
 */
@Injectable()
export class ExplanationEngine {
  explain(
    snapshot: FundamentalSnapshot,
    breakdown: MetricScore[],
    industryComparison: IndustryComparisonResult | null,
  ): Explanation {
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // "X vs Industry" metrics are narrated exclusively by the industry-comparison
    // block below (better phrasing, and it has the premium/discount % the raw
    // score band doesn't) — skipped here so the same fact isn't stated twice.
    const vsIndustryMetrics = new Set(['PE vs Industry', 'EV / EBITDA vs Industry', 'Price / Sales vs Industry']);

    for (const m of breakdown) {
      if (m.score == null || m.value == null || vsIndustryMetrics.has(m.metric)) continue;
      const line = this.describe(m.metric, m.value);
      if (m.score >= STRENGTH_THRESHOLD) strengths.push(line);
      else if (m.score <= WEAKNESS_THRESHOLD) weaknesses.push(line);
    }

    if (snapshot.debtToEquity != null && snapshot.debtToEquity <= 0.05) {
      strengths.push('Effectively debt-free');
    }

    if (industryComparison) {
      for (const m of industryComparison.metrics) {
        if (m.premiumDiscountPercent == null) continue;
        if (m.metric !== 'PE' && m.metric !== 'EV / EBITDA' && m.metric !== 'Price / Sales') continue;
        if (m.premiumDiscountPercent >= NOTABLE_PREMIUM_PERCENT) {
          weaknesses.push(`Trading ${round(m.premiumDiscountPercent)}% above industry ${m.metric}`);
        } else if (m.premiumDiscountPercent <= -NOTABLE_PREMIUM_PERCENT) {
          strengths.push(`Trading ${round(Math.abs(m.premiumDiscountPercent))}% below industry ${m.metric}`);
        }
      }
    }

    const revQoq = breakdown.find((m) => m.metric === 'Revenue QoQ');
    const revYoy = breakdown.find((m) => m.metric === 'Revenue YoY');
    if (revQoq?.value != null && revYoy?.value != null && revQoq.value < revYoy.value - 5) {
      weaknesses.push('Revenue growth decelerating quarter over quarter');
    }

    const beat = breakdown.find((m) => m.metric === 'Last Four Earnings Beat %');
    if (beat?.value != null && beat.value < 0) {
      weaknesses.push('Missed earnings estimates over the last four quarters');
    }

    return { strengths, weaknesses };
  }

  private describe(metric: string, value: number): string {
    switch (metric) {
      case 'Revenue CAGR 3Y':
        return `Revenue CAGR ${round(value)}%`;
      case 'Profit CAGR 3Y':
        return `Profit CAGR ${round(value)}%`;
      case 'Revenue YoY':
        return `Revenue growth ${round(value)}% YoY`;
      case 'Profit YoY':
        return `Profit growth ${round(value)}% YoY`;
      case 'ROIC':
        return `ROIC ${round(value)}%`;
      case 'ROE':
        return `ROE ${round(value)}%`;
      case 'Operating Margin':
        return `Operating margin ${round(value)}%`;
      case 'Net Margin':
        return `Net margin ${round(value)}%`;
      case 'Debt / Equity':
        return `Debt/Equity ${value.toFixed(2)}x`;
      case 'Interest Coverage':
        return `Interest coverage ${round(value)}x`;
      case 'Current Ratio':
        return `Current ratio ${value.toFixed(2)}x`;
      case 'Free Cash Flow':
        return `Free cash flow ${formatMoney(value)}`;
      case 'PEG Ratio':
        return `PEG ratio ${value.toFixed(2)}`;
      case 'Revenue QoQ':
        return `Revenue growth ${round(value)}% QoQ`;
      case 'Profit QoQ':
        return `Profit growth ${round(value)}% QoQ`;
      case 'Last Four Earnings Beat %':
        return value >= 0 ? `Beat estimates by ${round(value)}% on average` : `Missed estimates by ${round(Math.abs(value))}% on average`;
      default:
        return `${metric} ${round(value)}`;
    }
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
