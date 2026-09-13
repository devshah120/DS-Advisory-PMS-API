import { TemplateCommentaryProvider } from './template-commentary.provider';
import { CommentaryInput } from '../review-pack.types';

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

describe('TemplateCommentaryProvider', () => {
  const provider = new TemplateCommentaryProvider();

  // Test 3: outperformance language.
  it('says "outperforming" when the portfolio beats the benchmark by more than the in-line threshold', async () => {
    const out = await provider.generateCommentary(baseInput({ performanceDifference: 0.022 }));
    expect(out.portfolio_commentary).toMatch(/outperforming/i);
    expect(out.portfolio_commentary).not.toMatch(/\balpha\b/i);
  });

  // Test 4: underperformance language.
  it('says "underperforming" when the portfolio trails the benchmark by more than the in-line threshold', async () => {
    const out = await provider.generateCommentary(
      baseInput({ portfolioReturn: 0.041, benchmarkReturn: 0.06, performanceDifference: -0.019 }),
    );
    expect(out.portfolio_commentary).toMatch(/underperforming/i);
  });

  it('says "broadly in line with" when the difference is within ±0.25 percentage points', async () => {
    const out = await provider.generateCommentary(
      baseInput({ portfolioReturn: 0.062, benchmarkReturn: 0.061, performanceDifference: 0.001 }),
    );
    expect(out.portfolio_commentary).toMatch(/broadly in line with/i);
  });

  // Test 5: no performance data → no fabricated return.
  it('never fabricates a return when portfolioReturn is null', async () => {
    const out = await provider.generateCommentary(baseInput({ portfolioReturn: null, benchmarkReturn: null, performanceDifference: null }));
    expect(out.portfolio_commentary).toMatch(/could not be reliably measured/i);
    expect(out.portfolio_commentary).not.toMatch(/0\.0%|0%/);
  });

  // Test 8 (portfolio-only branch): macro unavailable and no cache → says so, no fabricated macro data.
  it('states market commentary was unavailable rather than inventing macro data', async () => {
    const out = await provider.generateCommentary(baseInput({ macroData: [], macroEvents: [] }));
    expect(out.market_macro_commentary).toMatch(/unavailable/i);
  });

  // Test 12: deployable cash phrased as allocation, never a deposit/withdrawal.
  it('describes cash as an allocation measure, never as a client deposit', async () => {
    const out = await provider.generateCommentary(baseInput({ cashWeight: 0.2 }));
    expect(out.positioning_commentary).toMatch(/deployable cash/i);
    expect(out.positioning_commentary).not.toMatch(/invested|deposit|withdrew/i);
  });

  it('mentions contributors and detractors when present', async () => {
    const out = await provider.generateCommentary(
      baseInput({
        topContributors: [{ symbol: 'RELIANCE', company: 'Reliance Industries', portfolioContributionPct: 0.012, weight: 0.08 }],
        topDetractors: [{ symbol: 'XYZ', company: 'XYZ Ltd', portfolioContributionPct: -0.006, weight: 0.03 }],
      }),
    );
    expect(out.portfolio_commentary).toContain('Reliance Industries');
    expect(out.portfolio_commentary).toMatch(/offset/i);
    expect(out.portfolio_commentary).toContain('XYZ Ltd');
  });
});
