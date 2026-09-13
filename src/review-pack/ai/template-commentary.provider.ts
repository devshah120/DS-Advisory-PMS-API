import { Injectable } from '@nestjs/common';
import { AICommentaryProvider } from './ai-commentary-provider.interface';
import { AICommentaryOutput, CommentaryInput } from '../review-pack.types';

/** ±0.25 percentage points — spec §44's "broadly in line with" threshold. */
const IN_LINE_THRESHOLD_PCT = 0.25;

function pct(n: number | null, decimals = 1): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

/**
 * The deterministic, AI-free commentary generator — spec §35/§95. Must
 * produce a usable, client-ready report on its own, because a Gemini outage
 * or a missing API key must never fail report generation (spec §74).
 *
 * Every sentence here is built directly from CommentaryInput fields with
 * fixed templates — there is nothing to fact-check because nothing is
 * invented; it is arithmetic and string concatenation over already-verified
 * numbers.
 */
@Injectable()
export class TemplateCommentaryProvider implements AICommentaryProvider {
  readonly name = 'template';
  readonly model: string | null = null;

  async generateCommentary(input: CommentaryInput): Promise<AICommentaryOutput> {
    return {
      portfolio_commentary: this.portfolioParagraph(input),
      market_macro_commentary: this.macroParagraph(input),
      positioning_commentary: this.positioningParagraph(input),
      headline: this.headline(input),
      key_points: this.keyPoints(input),
    };
  }

  async generateTitle(input: CommentaryInput): Promise<string> {
    return this.headline(input);
  }

  async regenerateCommentary(input: CommentaryInput): Promise<AICommentaryOutput> {
    return this.generateCommentary(input);
  }

  private headline(input: CommentaryInput): string {
    return `${input.subjectName} — Portfolio Review, ${input.periodStart} to ${input.periodEnd}`;
  }

  private benchmarkClause(input: CommentaryInput): string {
    const { portfolioReturn: r, benchmarkReturn: b, performanceDifference: d, benchmarkName } = input;

    if (r === null) {
      return 'Portfolio performance could not be reliably measured for the period because sufficient historical data was unavailable.';
    }

    if (b === null || d === null || !benchmarkName) {
      return `The portfolio returned ${pct(r)} during the period.`;
    }

    const diffPts = Math.abs(d) * 100;
    if (diffPts <= IN_LINE_THRESHOLD_PCT) {
      return `The portfolio returned ${pct(r)} during the period, performing broadly in line with ${benchmarkName} at ${pct(b)}.`;
    }

    return d > 0
      ? `The portfolio returned ${pct(r)} during the period, outperforming ${benchmarkName} by ${diffPts.toFixed(1)} percentage points.`
      : `The portfolio returned ${pct(r)} during the period, underperforming ${benchmarkName} by ${diffPts.toFixed(1)} percentage points.`;
  }

  private portfolioParagraph(input: CommentaryInput): string {
    const sentences: string[] = [this.benchmarkClause(input)];

    if (input.topContributors.length > 0) {
      const names = input.topContributors.map((c) => c.company).join(', ');
      sentences.push(`Performance was supported by contributions from ${names}.`);
    }
    if (input.topDetractors.length > 0) {
      const names = input.topDetractors.map((c) => c.company).join(' and ');
      sentences.push(
        input.topContributors.length > 0
          ? `These gains were partly offset by weakness in ${names}.`
          : `Performance was affected by weakness in ${names}.`,
      );
    }

    if (input.numberOfSectors > 0) {
      const leaders = input.sectorAllocation.slice(0, 2).map((s) => s.sector);
      sentences.push(
        leaders.length > 0
          ? `The portfolio remained diversified across ${input.numberOfSectors} sectors, with ${leaders.join(' and ')} representing the largest exposures.`
          : `The portfolio remained diversified across ${input.numberOfSectors} sectors.`,
      );
    }

    const changes: string[] = [];
    if (input.newPositions.length > 0) changes.push(`new exposure to ${input.newPositions.join(', ')}`);
    if (input.exitedPositions.length > 0) changes.push(`the exit of ${input.exitedPositions.join(', ')}`);
    if (input.majorAdditions.length > 0) changes.push(`increased exposure to ${input.majorAdditions.join(', ')}`);
    if (input.majorReductions.length > 0) changes.push(`reduced exposure to ${input.majorReductions.join(', ')}`);
    if (changes.length > 0) {
      sentences.push(`During the period, the portfolio saw ${changes.join('; ')}.`);
    }

    if (input.dividendsMaterial) {
      sentences.push('Dividend income during the period provided an additional source of portfolio return.');
    }

    for (const ca of input.corporateActions.slice(0, 2)) {
      sentences.push(`${ca.company} completed a ${ca.actionType.toLowerCase().replace(/_/g, ' ')} during the period.`);
    }

    return sentences.join(' ');
  }

  private macroParagraph(input: CommentaryInput): string {
    if (input.macroData.length === 0 && input.macroEvents.length === 0) {
      return 'Market commentary was unavailable for this reporting period.';
    }

    const isIndia = input.marketRegion === 'INDIA';
    const benchmarkName = input.benchmarkName ?? (isIndia ? 'the Nifty 50' : 'the S&P 500');
    const region = isIndia ? 'Indian equities' : 'US equities';

    const sentences: string[] = [];
    const benchmarkPoint = input.macroData.find((m) => m.indicator.includes('50_RETURN') || m.indicator === 'SP500_RETURN');
    if (benchmarkPoint) {
      sentences.push(`${region} moved ${pct(benchmarkPoint.value / 100)} during the period, as measured by ${benchmarkName}.`);
    }

    for (const event of input.macroEvents.slice(0, 3)) {
      sentences.push(event.summary);
    }

    if (sentences.length === 0) {
      return 'Market commentary was unavailable for this reporting period.';
    }

    return sentences.join(' ');
  }

  private positioningParagraph(input: CommentaryInput): string {
    const sentences: string[] = [];

    sentences.push(
      `At period-end, deployable cash represented approximately ${pct(input.cashWeight)} of portfolio value, providing flexibility for future deployment.`,
    );

    if (input.numberOfSectors > 0) {
      const leaders = input.sectorAllocation.slice(0, 2).map((s) => s.sector);
      sentences.push(
        leaders.length > 0
          ? `The portfolio remained focused on ${input.numberOfSectors} sectors, with the largest exposures in ${leaders.join(' and ')}.`
          : `The portfolio remained focused across ${input.numberOfSectors} sectors.`,
      );
    }

    if (input.concentration.top5WeightPct > 0) {
      sentences.push(
        `The five largest positions accounted for approximately ${pct(input.concentration.top5WeightPct)} of assets.`,
      );
    }

    if (input.majorAdditions.length > 0 || input.majorReductions.length > 0) {
      sentences.push('Positioning was selectively adjusted during the period among existing holdings.');
    }

    return sentences.join(' ');
  }

  private keyPoints(input: CommentaryInput): string[] {
    const points: string[] = [];

    points.push(
      input.portfolioReturn === null
        ? 'Performance could not be reliably measured this period.'
        : `Portfolio return: ${pct(input.portfolioReturn)}${
            input.benchmarkReturn !== null ? ` vs. ${pct(input.benchmarkReturn)} for ${input.benchmarkName}` : ''
          }.`,
    );

    if (input.topContributors.length > 0) {
      points.push(`Top contributor: ${input.topContributors[0].company}.`);
    }
    if (input.topDetractors.length > 0) {
      points.push(`Top detractor: ${input.topDetractors[0].company}.`);
    }
    points.push(`Cash weight: ${pct(input.cashWeight)}.`);

    return points.slice(0, 5);
  }
}
