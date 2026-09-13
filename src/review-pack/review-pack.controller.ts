import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Actor } from '../common/ownership-scope';
import { ReviewPackService } from './review-pack.service';
import { ReviewPackPdfService } from './review-pack-pdf.service';
import { ReviewSubjectKind } from './review-pack.types';

type AuthedRequest = { user: Actor };

interface GenerateBody {
  subjectType: ReviewSubjectKind;
  subjectId: string;
  periodCode: string;
  regenerate?: boolean;
}

interface EditBody {
  portfolioCommentary?: string;
  macroCommentary?: string;
  positioningCommentary?: string;
}

/**
 * Routes for the Automated Client Review Pack — spec §66-67. Every route
 * requires auth; ownership is enforced INSIDE ReviewPackService/ReviewPackAnalysisService
 * via the shared common/ownership-scope.ts helpers, the same 404-not-403 rule
 * every other client/family-scoped route in this codebase follows.
 */
@Controller('review-packs')
@UseGuards(JwtAuthGuard)
export class ReviewPackController {
  constructor(
    private reviewPack: ReviewPackService,
    private pdf: ReviewPackPdfService,
  ) {}

  @Post('generate')
  async generate(@Body() body: GenerateBody, @Req() req: AuthedRequest) {
    return this.reviewPack.generate(
      body.subjectType,
      body.subjectId,
      body.periodCode,
      req.user,
      body.regenerate ?? false,
    );
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reviewPack.get(id, req.user);
  }

  @Patch(':id/commentary')
  async editCommentary(@Param('id') id: string, @Body() body: EditBody, @Req() req: AuthedRequest) {
    return this.reviewPack.editCommentary(id, req.user, body);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reviewPack.approve(id, req.user);
  }

  @Post(':id/regenerate')
  async regenerate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.reviewPack.regenerate(id, req.user);
  }

  @Get(':id/pdf')
  async downloadPdf(@Param('id') id: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const pack = await this.reviewPack.get(id, req.user);
    const buffer = await this.pdf.build(pack);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="review-pack-${pack.id}.pdf"`);
    res.send(buffer);
  }
}
