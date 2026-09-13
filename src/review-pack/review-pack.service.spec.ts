import { ReviewPackService } from './review-pack.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { ReviewPackAnalysisService } from './review-pack-analysis.service';
import { CommentaryProviderFactory } from './ai/commentary-provider.factory';
import { TemplateCommentaryProvider } from './ai/template-commentary.provider';
import { Actor } from '../common/ownership-scope';
import { CommentaryInput, PortfolioAnalysis } from './review-pack.types';

const SUPER_ADMIN: Actor = { id: 'u_super', role: 'SUPER_ADMIN' };

function baseAnalysis(overrides: Partial<PortfolioAnalysis> = {}): PortfolioAnalysis {
  return {
    subjectType: 'client',
    subjectId: 'c1',
    subjectName: 'Test Client',
    market: 'INDIA',
    currency: 'INR',
    periodCode: 'Q2-FY27',
    periodLabel: 'Q2 FY27',
    periodStart: new Date('2026-07-01'),
    periodEnd: new Date('2026-09-30'),
    openPeriod: false,
    portfolioValueStart: 1000000,
    portfolioValueEnd: 1084000,
    portfolioReturnPct: 0.084,
    benchmarkName: 'Nifty 50',
    benchmarkReturnPct: 0.062,
    differencePct: 0.022,
    investmentGainLoss: 84000,
    cashWeight: 0.157,
    cashValue: 157000,
    topHoldings: [],
    topContributors: [],
    topDetractors: [],
    sectorAllocation: [],
    topSectors: [],
    largestSectorIncrease: null,
    largestSectorDecrease: null,
    newPositions: [],
    exitedPositions: [],
    majorAdditions: [],
    majorReductions: [],
    concentration: { numberOfHoldings: 5, numberOfSectors: 3, top1WeightPct: 0.2, top5WeightPct: 0.6, top10WeightPct: 0.8 },
    dividends: null,
    corporateActions: [],
    dataQuality: 'HIGH',
    warnings: [],
    ...overrides,
  };
}

function build(opts: { primaryProviderName?: string; primaryThrows?: boolean; primaryOutput?: any }) {
  const prisma = {
    reviewPack: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'rp1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'rp1', ...data })),
    },
    reviewPackVersion: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    client: {
      findUnique: jest.fn().mockResolvedValue({ id: 'c1', ownerId: null, market: 'INDIA' }),
    },
    family: {
      findUnique: jest.fn(),
    },
  } as unknown as PrismaService;

  const analysisResult = baseAnalysis();
  const commentaryInput: CommentaryInput = {
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
    numberOfHoldings: 5,
    numberOfSectors: 3,
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
    concentration: { numberOfHoldings: 5, numberOfSectors: 3, top1WeightPct: 0.2, top5WeightPct: 0.6, top10WeightPct: 0.8 },
    macroData: [],
    macroEvents: [],
    dataQuality: 'HIGH',
    warnings: [],
  };
  const analysis = {
    analyse: jest.fn().mockResolvedValue(analysisResult),
    buildCommentaryInput: jest.fn().mockReturnValue(commentaryInput),
  } as unknown as ReviewPackAnalysisService;

  const template = new TemplateCommentaryProvider();

  const primary = {
    name: opts.primaryProviderName ?? 'gemini',
    model: 'gemini-2.0-flash',
    generateCommentary: jest.fn(async () => {
      if (opts.primaryThrows) throw new Error('Gemini unavailable');
      return opts.primaryOutput;
    }),
    generateTitle: jest.fn(),
    regenerateCommentary: jest.fn(),
  };

  const providers = {
    getPrimary: jest.fn().mockReturnValue(primary),
    getFallback: jest.fn().mockReturnValue(template),
  } as unknown as CommentaryProviderFactory;

  return { service: new ReviewPackService(prisma, analysis, providers), prisma, primary, template };
}

describe('ReviewPackService', () => {
  // Test 6: Gemini unavailable/throws → template fallback still produces a savable pack.
  it('falls back to the template provider when the primary AI call throws', async () => {
    const { service, prisma } = build({ primaryThrows: true });

    const pack = await service.generate('client', 'c1', 'Q2-FY27', SUPER_ADMIN);

    expect(pack).toBeDefined();
    expect((prisma.reviewPack.create as jest.Mock)).toHaveBeenCalled();
    const createCall = (prisma.reviewPack.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.aiProvider).toBe('template');
    expect(createCall.data.status).toBe('GENERATED');
  });

  // Test 9 (integration angle): a fact-check failure also falls back to template.
  it('falls back to the template provider when the AI output fails fact validation', async () => {
    const { service, prisma } = build({
      primaryThrows: false,
      primaryOutput: {
        portfolio_commentary: 'The portfolio surged an incredible 999.9% this quarter.',
        market_macro_commentary: 'Market commentary was unavailable for this reporting period.',
        positioning_commentary: 'Deployable cash stood at approximately 15.7% of portfolio value.',
        headline: 'Test',
        key_points: [],
      },
    });

    await service.generate('client', 'c1', 'Q2-FY27', SUPER_ADMIN);

    const createCall = (prisma.reviewPack.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.aiProvider).toBe('template');
  });

  it('uses the primary provider when it succeeds and passes fact validation', async () => {
    const { service, prisma } = build({
      primaryThrows: false,
      primaryOutput: {
        portfolio_commentary: 'The portfolio returned 8.4% during the quarter.',
        market_macro_commentary: 'Market commentary was unavailable for this reporting period.',
        positioning_commentary: 'Deployable cash stood at approximately 15.7% of portfolio value.',
        headline: 'Test',
        key_points: [],
      },
    });

    await service.generate('client', 'c1', 'Q2-FY27', SUPER_ADMIN);

    const createCall = (prisma.reviewPack.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.aiProvider).toBe('gemini');
  });

  it('reuses an existing GENERATED pack for the same subject+period without regenerating', async () => {
    const { service, prisma, primary } = build({ primaryThrows: false, primaryOutput: {} });
    (prisma.reviewPack.findUnique as jest.Mock).mockResolvedValue({
      id: 'rp1',
      status: 'GENERATED',
      subjectType: 'CLIENT',
      subjectId: 'c1',
      periodCode: 'Q2-FY27',
    });

    const pack = await service.generate('client', 'c1', 'Q2-FY27', SUPER_ADMIN, false);

    expect(pack.id).toBe('rp1');
    expect(primary.generateCommentary).not.toHaveBeenCalled();
  });

  it('regenerates (bypassing the cache) when regenerate=true', async () => {
    const { service, prisma, primary } = build({
      primaryThrows: false,
      primaryOutput: {
        portfolio_commentary: 'The portfolio returned 8.4% during the quarter.',
        market_macro_commentary: 'Market commentary was unavailable for this reporting period.',
        positioning_commentary: 'Deployable cash stood at approximately 15.7% of portfolio value.',
        headline: 'Test',
        key_points: [],
      },
    });
    (prisma.reviewPack.findUnique as jest.Mock).mockResolvedValue({
      id: 'rp1',
      status: 'GENERATED',
      subjectType: 'CLIENT',
      subjectId: 'c1',
      periodCode: 'Q2-FY27',
    });

    await service.generate('client', 'c1', 'Q2-FY27', SUPER_ADMIN, true);

    expect(primary.generateCommentary).toHaveBeenCalled();
    expect(prisma.reviewPack.update).toHaveBeenCalled();
  });
});
