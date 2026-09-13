import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ReviewPackAnalysisService } from './review-pack-analysis.service';
import { CommentaryProviderFactory } from './ai/commentary-provider.factory';
import { PROMPT_VERSION } from './ai/gemini-commentary.provider';
import { validateCommentary } from './fact-validator';
import { resolvePeriod } from '../portfolio-reconstruction/periods';
import { Market, parseMarket } from '../common/market-scope';
import { Actor, assertCanAccessClient, assertOwns } from '../common/ownership-scope';
import { AICommentaryOutput, ReviewSubjectKind } from './review-pack.types';
import { ReviewSubjectType as PrismaSubjectType, CommentaryStatus, ReviewPack } from '@prisma/client';

const toPrismaSubjectType = (kind: ReviewSubjectKind): PrismaSubjectType =>
  kind === 'family' ? PrismaSubjectType.FAMILY : PrismaSubjectType.CLIENT;

/**
 * Orchestrates the Review Pack workflow — spec §66. Every step delegates to a
 * verified engine or a well-scoped helper; this class's own job is sequencing
 * and persistence, never calculation:
 *
 *   1. Resolve subject + market + period (periods.ts, the subject's own record).
 *   2. Analyse the portfolio (ReviewPackAnalysisService — real numbers only).
 *   3. Build the compact CommentaryInput.
 *   4. Ask the configured AI provider; validate its numeric claims; fall back
 *      to the deterministic template on any failure (missing key, API error,
 *      malformed JSON, or a failed fact-check) so generation never fails.
 *   5. Upsert the ReviewPack row (the [subjectType, subjectId, periodCode]
 *      cache key means a second "Generate" click reuses the row unless the
 *      caller passes regenerate: true) and append a ReviewPackVersion.
 */
@Injectable()
export class ReviewPackService {
  private readonly logger = new Logger(ReviewPackService.name);

  constructor(
    private prisma: PrismaService,
    private analysis: ReviewPackAnalysisService,
    private providers: CommentaryProviderFactory,
  ) {}

  async generate(
    subjectType: ReviewSubjectKind,
    subjectId: string,
    periodCode: string,
    actor: Actor,
    regenerate = false,
  ): Promise<ReviewPack> {
    const market = await this.marketFor(subjectType, subjectId, actor);
    const resolved = resolvePeriod(periodCode, { market });

    const existing = await this.prisma.reviewPack.findUnique({
      where: {
        subjectType_subjectId_periodCode: {
          subjectType: toPrismaSubjectType(subjectType),
          subjectId,
          periodCode: resolved.period,
        },
      },
    });

    // Cache hit: same subject + period, no explicit regenerate — spec §76-77.
    if (existing && !regenerate && existing.status !== 'FAILED') {
      return existing;
    }

    const portfolioAnalysis = await this.analysis.analyse(subjectType, subjectId, resolved, actor);
    const commentaryInput = this.analysis.buildCommentaryInput(portfolioAnalysis);

    const { output, providerUsed, modelUsed } = await this.generateWithFallback(commentaryInput);

    const ownerId = await this.ownerIdFor(subjectType, subjectId);

    const data = {
      subjectType: toPrismaSubjectType(subjectType),
      subjectId,
      market,
      periodCode: resolved.period,
      periodStart: resolved.from,
      periodEnd: resolved.to,
      benchmarkCode: portfolioAnalysis.benchmarkName ?? undefined,
      portfolioValue: portfolioAnalysis.portfolioValueEnd,
      portfolioReturn: portfolioAnalysis.portfolioReturnPct ?? undefined,
      benchmarkReturn: portfolioAnalysis.benchmarkReturnPct ?? undefined,
      difference: portfolioAnalysis.differencePct ?? undefined,
      headline: output.headline,
      portfolioCommentary: output.portfolio_commentary,
      macroCommentary: output.market_macro_commentary,
      positioningCommentary: output.positioning_commentary,
      keyPoints: output.key_points,
      dataQuality: portfolioAnalysis.dataQuality,
      warnings: portfolioAnalysis.warnings,
      status: CommentaryStatus.GENERATED,
      aiProvider: providerUsed,
      aiModel: modelUsed,
      promptVersion: PROMPT_VERSION,
      generatedAt: new Date(),
      generatedBy: actor.id,
      ownerId: ownerId ?? undefined,
    };

    const pack = existing
      ? await this.prisma.reviewPack.update({ where: { id: existing.id }, data })
      : await this.prisma.reviewPack.create({ data });

    await this.appendVersion(pack.id, output, providerUsed, modelUsed);

    return pack;
  }

  async get(id: string, actor: Actor): Promise<ReviewPack> {
    const pack = await this.prisma.reviewPack.findUnique({ where: { id } });
    this.assertAccess(actor, pack);
    if (!pack) throw new NotFoundException('Review pack not found');
    return pack;
  }

  async editCommentary(
    id: string,
    actor: Actor,
    edits: { portfolioCommentary?: string; macroCommentary?: string; positioningCommentary?: string },
  ): Promise<ReviewPack> {
    const pack = await this.get(id, actor);

    const updated = await this.prisma.reviewPack.update({
      where: { id },
      data: {
        portfolioCommentary: edits.portfolioCommentary ?? pack.portfolioCommentary,
        macroCommentary: edits.macroCommentary ?? pack.macroCommentary,
        positioningCommentary: edits.positioningCommentary ?? pack.positioningCommentary,
        status: CommentaryStatus.EDITED,
      },
    });

    await this.appendVersion(
      id,
      {
        portfolio_commentary: updated.portfolioCommentary ?? '',
        market_macro_commentary: updated.macroCommentary ?? '',
        positioning_commentary: updated.positioningCommentary ?? '',
        headline: updated.headline ?? '',
        key_points: updated.keyPoints,
      },
      'user',
      null,
      actor.id,
    );

    return updated;
  }

  async approve(id: string, actor: Actor): Promise<ReviewPack> {
    await this.get(id, actor); // ownership check
    return this.prisma.reviewPack.update({
      where: { id },
      data: { status: CommentaryStatus.APPROVED, approvedAt: new Date(), approvedBy: actor.id },
    });
  }

  async regenerate(id: string, actor: Actor): Promise<ReviewPack> {
    const pack = await this.get(id, actor);
    return this.generate(
      pack.subjectType === PrismaSubjectType.FAMILY ? 'family' : 'client',
      pack.subjectId,
      pack.periodCode,
      actor,
      true,
    );
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async generateWithFallback(
    input: ReturnType<ReviewPackAnalysisService['buildCommentaryInput']>,
  ): Promise<{ output: AICommentaryOutput; providerUsed: string; modelUsed: string | null }> {
    const primary = this.providers.getPrimary();

    if (primary.name !== 'template') {
      try {
        const output = await primary.generateCommentary(input);
        const check = validateCommentary(output, input);
        if (check.ok) {
          return { output, providerUsed: primary.name, modelUsed: primary.model };
        }
        this.logger.warn(`Fact validation failed for ${primary.name}: ${check.issues.join('; ')}`);
      } catch (error) {
        this.logger.warn(`${primary.name} commentary generation failed: ${(error as Error).message}`);
      }
    }

    const fallback = this.providers.getFallback();
    const output = await fallback.generateCommentary(input);
    return { output, providerUsed: fallback.name, modelUsed: fallback.model };
  }

  private async appendVersion(
    reviewPackId: string,
    output: AICommentaryOutput,
    provider: string,
    model: string | null,
    generatedBy?: string,
  ): Promise<void> {
    const last = await this.prisma.reviewPackVersion.findFirst({
      where: { reviewPackId },
      orderBy: { versionNumber: 'desc' },
    });

    await this.prisma.reviewPackVersion.create({
      data: {
        reviewPackId,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        portfolioCommentary: output.portfolio_commentary,
        macroCommentary: output.market_macro_commentary,
        positioningCommentary: output.positioning_commentary,
        headline: output.headline,
        keyPoints: output.key_points,
        generatedBy: generatedBy ?? provider,
        provider,
        model: model ?? undefined,
      },
    });
  }

  private async marketFor(subjectType: ReviewSubjectKind, subjectId: string, actor: Actor): Promise<Market> {
    if (subjectType === 'family') {
      const family = await this.prisma.family.findUnique({
        where: { id: subjectId },
        select: { id: true, ownerId: true, market: true },
      });
      assertOwns(actor, family, 'Family');
      if (!family) throw new NotFoundException('Family not found');
      return parseMarket(family.market);
    }

    const client = await this.prisma.client.findUnique({
      where: { id: subjectId },
      select: { id: true, ownerId: true, market: true },
    });
    assertCanAccessClient(actor, client, 'Client');
    if (!client) throw new NotFoundException('Client not found');
    return parseMarket(client.market);
  }

  private async ownerIdFor(subjectType: ReviewSubjectKind, subjectId: string): Promise<string | null> {
    if (subjectType === 'family') {
      const family = await this.prisma.family.findUnique({ where: { id: subjectId }, select: { ownerId: true } });
      return family?.ownerId ?? null;
    }
    const client = await this.prisma.client.findUnique({ where: { id: subjectId }, select: { ownerId: true } });
    return client?.ownerId ?? null;
  }

  private assertAccess(actor: Actor, pack: ReviewPack | null): void {
    if (!pack) throw new NotFoundException('Review pack not found');
    // A review pack's ownership mirrors its subject's — see ownerId's comment
    // in schema.prisma. Firm-wide actors pass through assertOwns as usual.
    assertOwns(actor, pack, 'Review pack');
  }
}
