import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BaselineService } from './baseline.service';
import { BaselineAdminService } from './baseline-admin.service';
import { CreateBaselineDto } from './dto/create-baseline.dto';
import { AmendBaselineDto } from './dto/amend-baseline.dto';
import { AdminOnlyGuard } from './admin-only.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor, assertCanAccessClient } from '../common/ownership-scope';

@Controller('clients/:clientId/baseline')
@UseGuards(JwtAuthGuard)
export class BaselineController {
  constructor(
    private baselineService: BaselineService,
    private baselineAdminService: BaselineAdminService,
    private prisma: PrismaService,
  ) {}

  /**
   * Every route here is mounted under `clients/:clientId`, so each gates on
   * ownership first — a baseline is the client's opening position and is as
   * disclosive as their holdings.
   *
   * The admin-only routes below carry this in ADDITION to AdminOnlyGuard: that
   * guard checks the ROLE (may you amend a baseline at all) while this checks
   * the ROW (is this mandate yours). A legacy ADMIN is firm-wide so it passes
   * both; the two are not redundant.
   */
  private async assertAccess(clientId: string, actor: Actor) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, ownerId: true },
    });
    assertCanAccessClient(actor, client);
  }

  @Post()
  async create(
    @Param('clientId') clientId: string,
    @Body() dto: CreateBaselineDto,
    @Req() req: any,
  ) {
    await this.assertAccess(clientId, req.user);
    return this.baselineService.create(clientId, dto, req?.user?.id);
  }

  @Get()
  async get(@Param('clientId') clientId: string, @Req() req: any) {
    await this.assertAccess(clientId, req.user);
    return this.baselineService.get(clientId);
  }

  @Patch()
  @UseGuards(AdminOnlyGuard)
  async amend(
    @Param('clientId') clientId: string,
    @Body() dto: AmendBaselineDto,
    @Req() req: any,
  ) {
    await this.assertAccess(clientId, req.user);
    return this.baselineAdminService.amend(clientId, dto, req?.user?.email ?? req?.user?.id);
  }

  /**
   * Deletes and rebuilds this client's baseline (and any snapshots computed
   * from it) via the current auto-seed logic — the fix for a baseline that
   * was seeded before a bug in that logic (or its price lookups) was
   * corrected. See BaselineAdminService.reseedFromHoldings.
   */
  @Post('re-seed')
  @UseGuards(AdminOnlyGuard)
  async reseed(
    @Param('clientId') clientId: string,
    @Body('reason') reason: string,
    @Req() req: any,
  ) {
    await this.assertAccess(clientId, req.user);
    return this.baselineAdminService.reseedFromHoldings(
      clientId,
      reason || 'Re-seeded after an auto-seed calculation fix',
      req?.user?.email ?? req?.user?.id,
    );
  }
}
