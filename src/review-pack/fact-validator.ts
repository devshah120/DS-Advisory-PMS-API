import { AICommentaryOutput, CommentaryInput } from './review-pack.types';

/**
 * Checks every numeric claim an AI made against the numbers actually present
 * in CommentaryInput. This is the guard the spec's most important rule
 * depends on (§80/§109): "THE FACT VALIDATOR ENSURES THE AI DOES NOT INVENT
 * NUMBERS." A number the AI states that cannot be traced back to input, within
 * rounding tolerance, fails validation — the caller must then fall back to the
 * deterministic template rather than save unverified prose.
 *
 * Deliberately conservative: this is a whitelist check (every number in the
 * prose must appear in the allowed set), not a full NLP fact-check. That is
 * the right trade for a compliance guard — a false "flagged" just means we
 * fall back to the template, which is always safe; a false "passed" would let
 * a fabricated figure reach a client.
 */

const ROUNDING_TOLERANCE_PCT = 0.05; // absolute percentage points

/** Every percentage/number CommentaryInput actually contains, as tokens like "8.4". */
function allowedNumbers(input: CommentaryInput): number[] {
  const nums: number[] = [];
  const pushPct = (v: number | null | undefined) => {
    if (v === null || v === undefined) return;
    nums.push(Math.abs(v) * 100);
  };

  pushPct(input.portfolioReturn);
  pushPct(input.benchmarkReturn);
  pushPct(input.performanceDifference);
  pushPct(input.cashWeight);
  nums.push(input.numberOfHoldings, input.numberOfSectors);
  pushPct(input.concentration.top1WeightPct);
  pushPct(input.concentration.top5WeightPct);
  pushPct(input.concentration.top10WeightPct);

  for (const c of [...input.topContributors, ...input.topDetractors]) {
    pushPct(c.portfolioContributionPct);
    pushPct(c.weight);
  }
  for (const s of input.sectorAllocation) pushPct(s.weight);
  for (const s of input.sectorChanges) pushPct(s.changePct);
  for (const m of input.macroData) nums.push(Math.abs(m.value));

  return nums;
}

/**
 * Extracts bare numeric tokens (with optional % sign) from free text.
 *
 * Numbers embedded in a benchmark's own NAME (Nifty 50, S&P 500, Nifty 500,
 * NASDAQ 100) are stripped first — those digits identify an index, they are
 * not a claim about a figure, and the fact validator must not treat "50" in
 * "the Nifty 50" as an invented statistic just because 50 does not appear
 * anywhere in CommentaryInput's numbers.
 */
function numbersIn(text: string, benchmarkName: string | null): number[] {
  const withoutBenchmarkName = benchmarkName ? text.split(benchmarkName).join(' ') : text;
  const matches = withoutBenchmarkName.match(/-?\d+(\.\d+)?%?/g) ?? [];
  return matches.map((m) => Number(m.replace('%', ''))).filter((n) => !Number.isNaN(n));
}

export interface FactCheckResult {
  ok: boolean;
  issues: string[];
}

export function validateCommentary(output: AICommentaryOutput, input: CommentaryInput): FactCheckResult {
  const allowed = allowedNumbers(input);
  const issues: string[] = [];

  const prose = [output.portfolio_commentary, output.market_macro_commentary, output.positioning_commentary].join(
    '\n',
  );

  for (const claimed of numbersIn(prose, input.benchmarkName)) {
    // Small integers (position/sector counts, years) and zero are common
    // incidental numbers (e.g. "six sectors") already covered by
    // numberOfHoldings/numberOfSectors above; anything else must be within
    // tolerance of a real figure.
    const matches = allowed.some((a) => Math.abs(a - claimed) <= ROUNDING_TOLERANCE_PCT || a === claimed);
    if (!matches) {
      issues.push(`Commentary references "${claimed}", which does not match any figure in the verified input.`);
    }
  }

  return { ok: issues.length === 0, issues };
}
