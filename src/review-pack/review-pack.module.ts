import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { ConfigModule } from '../config/config.module';
import { PortfolioReconstructionModule } from '../portfolio-reconstruction/portfolio-reconstruction.module';
import { ReviewPackController } from './review-pack.controller';
import { ReviewPackService } from './review-pack.service';
import { ReviewPackAnalysisService } from './review-pack-analysis.service';
import { ReviewPackPdfService } from './review-pack-pdf.service';
import { CommentaryProviderFactory } from './ai/commentary-provider.factory';
import { GeminiCommentaryProvider } from './ai/gemini-commentary.provider';
import { TemplateCommentaryProvider } from './ai/template-commentary.provider';

/**
 * The Automated Client Review Pack engine — spec §108's architecture:
 * PortfolioReconstructionModule's verified engines feed
 * ReviewPackAnalysisService, which feeds the AI provider (or its template
 * fallback), gated by the fact validator, and persisted as a ReviewPack.
 *
 * Depends only on PrismaModule/ConfigModule/PortfolioReconstructionModule;
 * nothing existing depends on this module, matching how CorporateActionsModule
 * was integrated — a new feature that reads verified state rather than one
 * the rest of the app needs to know about.
 */
@Module({
  imports: [PrismaModule, ConfigModule, PortfolioReconstructionModule],
  controllers: [ReviewPackController],
  providers: [
    ReviewPackService,
    ReviewPackAnalysisService,
    ReviewPackPdfService,
    CommentaryProviderFactory,
    GeminiCommentaryProvider,
    TemplateCommentaryProvider,
  ],
})
export class ReviewPackModule {}
