import { validateCommentary } from './fact-validator';
import { AICommentaryOutput, CommentaryInput } from './review-pack.types';

function baseInput(overrides: Partial<CommentaryInput> = {}): CommentaryInput {
  return {
    subjectType: 'client',
    subjectName: 'Test Client',
    marketRegion: 'INDIA',
    currency: 'INR',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    portfolioValueStart: 1000000,
    portfolioValueEnd: 1084000,
    portfolioReturn: 0.084,
    benchmarkName: 'Nifty 50',
    benchmarkReturn: 0.062,
    performanceDifference: 0.022,
    numberOfHoldings: 12,
    numberOfSectors: 6,
    cashWeight: 0.157,
    topHoldings: [],
    topContributors: [],
    topDetractors: [],
    sectorAllocation: [],
    sectorChanges: [],
    newPositions: [],
    exitedPositions: [],
    majorAdditions: [],
    majorReductions: [],
    dividendsMaterial: false,
    corporateActions: [],
    concentration: { numberOfHoldings: 12, numberOfSectors: 6, top1WeightPct: 0.12, top5WeightPct: 0.45, top10WeightPct: 0.7 },
    macroData: [],
    macroEvents: [],
    dataQuality: 'HIGH',
    warnings: [],
    ...overrides,
  };
}

function output(overrides: Partial<AICommentaryOutput> = {}): AICommentaryOutput {
  return {
    portfolio_commentary: 'The portfolio returned 8.4% during the quarter, outperforming the Nifty 50 by 2.2 percentage points.',
    market_macro_commentary: 'Market commentary was unavailable for this reporting period.',
    positioning_commentary: 'Deployable cash stood at approximately 15.7% of portfolio value.',
    headline: 'Test Client — Q2 FY27 Review',
    key_points: [],
    ...overrides,
  };
}

describe('validateCommentary', () => {
  it('passes when every number in the prose traces back to the input, within rounding tolerance', () => {
    const input = baseInput();
    const result = validateCommentary(output(), input);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('passes a rounded figure (8.42% actual vs "8.4%" in prose)', () => {
    const input = baseInput({ portfolioReturn: 0.0842 });
    const result = validateCommentary(output(), input);
    expect(result.ok).toBe(true);
  });

  // Test 9: AI returns a number not present in CommentaryInput → flagged.
  it('flags a number the AI invented that does not appear anywhere in the input', () => {
    const input = baseInput();
    const badOutput = output({
      portfolio_commentary: 'The portfolio returned 8.4% during the quarter, driven by a remarkable 47.3% surge in one holding.',
    });
    const result = validateCommentary(badOutput, input);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toContain('47.3');
  });

  it('does not flag incidental small integers already covered by holdings/sector counts', () => {
    const input = baseInput({ numberOfSectors: 6 });
    const result = validateCommentary(
      output({ portfolio_commentary: 'The portfolio remained diversified across 6 sectors.' }),
      input,
    );
    expect(result.ok).toBe(true);
  });
});
