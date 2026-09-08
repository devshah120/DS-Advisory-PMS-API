/**
 * HTTP surface for the Corporate Action Engine.
 *
 * ── The access model, stated once here ──────────────────────────────────────
 *
 * READS are ownership-scoped: a manager sees affected-client counts and ledger
 * rows for their own book only (see CorporateActionService.decorate). Who
 * holds what is private between managers, exactly as everywhere else in this
 * codebase.
 *
 * WRITES are firm-wide in effect but not restricted to a Super Admin. A
 * corporate action is a fact about a security — if Amphenol split 2-for-1,
 * every holder is affected and no manager gets to opt their book out. What the
 * approve/reject step gates is DATA QUALITY (did the ratio parse right, is the
 * source real), not permission. Any authenticated staff user may therefore
 * clear that gate; VIEWER (client-portal) logins may not, since they are not
 * staff at all.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CorporateActionStatus, CorporateActionType, Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/auth/roles.guard';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';
import { PrismaService } from '../common/prisma/prisma.service';
import { CorporateActionAuditService } from './audit.service';
import { CorporateActionScheduler } from './corporate-action.scheduler';
import { CorporateActionService } from './corporate-action.service';
import { CreateCorporateActionDto } from './dto/create-corporate-action.dto';
import {
  RejectCorporateActionDto,
  UpdateCorporateActionSettingsDto,
} from './dto/review-corporate-action.dto';
import { ProcessorRegistry } from './processors/processor.registry';

type AuthedRequest = {
  user: Actor;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

/** Staff roles. A VIEWER is a client login and has no business here at all. */
const STAFF = [Role.SUPER_ADMIN, Role.ADMIN, Role.PORTFOLIO_MANAGER, Role.RESEARCH_ANALYST];

@Controller('corporate-actions')
@UseGuards(JwtAuthGuard)
export class CorporateActionsController {
  constructor(
    private service: CorporateActionService,
    private scheduler: CorporateActionScheduler,
    private audit: CorporateActionAuditService,
    private registry: ProcessorRegistry,
    private prisma: PrismaService,
  ) {}

  /** The Review Center grid (PART 8). */
  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('actionType') actionType?: string,
    @Query('market') market?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list(req.user, {
      status: asEnum(status, CorporateActionStatus),
      actionType: asEnum(actionType, CorporateActionType),
      market: market ? parseMarket(market) : undefined,
      symbol,
      from: asDate(from),
      to: asDate(to),
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Counts by status — the Review Center's tab badges.
   *
   * A separate endpoint rather than being derived from the list, because the
   * list is paginated and counting a page is not counting the queue.
   */
  @Get('summary')
  async summary() {
    const grouped = await this.prisma.corporateAction.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      grouped.map((g) => [g.status, g._count._all]),
    ) as Record<CorporateActionStatus, number>;

    return {
      counts,
      pendingReview:
        (counts.PENDING_APPROVAL ?? 0) + (counts.DETECTED ?? 0) + (counts.PENDING_VALIDATION ?? 0),
      failed: counts.FAILED ?? 0,
      processed: counts.PROCESSED ?? 0,
      supportedTypes: this.registry.supportedTypes(),
    };
  }

  /** Engine settings (PART 44). */
  @Get('settings')
  settings() {
    return this.service.settings();
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  async updateSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateCorporateActionSettingsDto,
  ) {
    const data: Record<string, unknown> = {};
    if (dto.autoProcessEnabled !== undefined) data.caAutoProcessEnabled = dto.autoProcessEnabled;
    if (dto.minimumConfidenceScore !== undefined)
      data.caMinimumConfidenceScore = dto.minimumConfidenceScore;
    if (dto.fractionalSharePolicy !== undefined)
      data.caFractionalSharePolicy = dto.fractionalSharePolicy;
    if (dto.cashInLieuPolicy !== undefined) data.caCashInLieuPolicy = dto.cashInLieuPolicy;
    if (dto.notificationEnabled !== undefined)
      data.caNotificationEnabled = dto.notificationEnabled;
    if (dto.processingHourUtc !== undefined) data.caProcessingHourUtc = dto.processingHourUtc;

    await this.prisma.appSetting.upsert({
      where: { id: 'app' },
      // The singleton may not exist on a fresh install; create it with these
      // values rather than failing the first settings save.
      create: { id: 'app', ...data, updatedById: req.user.id },
      update: { ...data, updatedById: req.user.id },
    });

    /**
     * Auto-processing is the setting that can silently alter client books, so
     * flipping it is audited on its own. `corporateActionId` is a sentinel
     * rather than a real id: the entry belongs to the engine, not to an action.
     */
    if (dto.autoProcessEnabled !== undefined || dto.minimumConfidenceScore !== undefined) {
      await this.audit.record({
        corporateActionId: 'settings',
        action: 'SETTINGS_CHANGED',
        actor: req.user,
        after: {
          autoProcessEnabled: dto.autoProcessEnabled,
          minimumConfidenceScore: dto.minimumConfidenceScore,
        },
        request: requestContext(req),
      });
    }

    return this.service.settings();
  }

  /** Recent activity across every action — the audit feed. */
  @Get('audit')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  auditFeed(@Query('limit') limit?: string) {
    return this.audit.recent(limit ? Number(limit) : 100);
  }

  /** One action with its ledger and audit trail. */
  @Get(':id')
  detail(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.detail(id, req.user);
  }

  /** PART 39/40 — what processing would do, computed without writing. */
  @Get(':id/preview')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  preview(@Param('id') id: string) {
    return this.service.preview(id);
  }

  @Get(':id/audit')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  auditFor(@Param('id') id: string) {
    return this.audit.history(id);
  }

  /** Manual entry — the path for IR announcements and exchange filings. */
  @Post()
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  async create(@Req() req: AuthedRequest, @Body() dto: CreateCorporateActionDto) {
    const { action, created, merged } = await this.service.ingest(
      {
        symbol: dto.symbol,
        company: dto.company ?? null,
        actionType: dto.actionType,
        effectiveDate: new Date(dto.effectiveDate),
        announcementDate: asDate(dto.announcementDate),
        declarationDate: asDate(dto.declarationDate),
        recordDate: asDate(dto.recordDate),
        exDate: asDate(dto.exDate),
        paymentDate: asDate(dto.paymentDate),
        oldRatio: dto.oldRatio ?? null,
        newRatio: dto.newRatio ?? null,
        cashAmount: dto.cashAmount ?? null,
        currency: dto.currency ?? null,
        newSymbol: dto.newSymbol ?? null,
        newCompany: dto.newCompany ?? null,
        details: dto.details ?? null,
        source: dto.source,
        tier: dto.tier,
        sourceUrl: dto.sourceUrl ?? null,
        sourceReference: dto.sourceReference ?? null,
      },
      req.user,
    );

    // Validate immediately so the operator sees any problem with what they
    // just typed, rather than discovering it at approval time.
    const validation = await this.service.validate(action.id, req.user);

    return { action: await this.service.detail(action.id, req.user), created, merged, validation };
  }

  @Post(':id/validate')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  validate(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.validate(id, req.user);
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  approve(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.approve(id, req.user, requestContext(req));
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  reject(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: RejectCorporateActionDto,
  ) {
    return this.service.reject(id, dto.reason, req.user, requestContext(req));
  }

  /**
   * Applies the action to every affected client, atomically (PART 35/36).
   *
   * Firm-wide by design — see the note at the top of this file.
   */
  @Post(':id/process')
  @UseGuards(RolesGuard)
  @Roles(...STAFF)
  process(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.service.process(id, req.user, requestContext(req));
  }

  /** Manual trigger for the provider sweep (PART 34). */
  @Post('sync')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.PORTFOLIO_MANAGER)
  sync() {
    return this.scheduler.sweep();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Coerces a query-string value to an enum member, or undefined.
 *
 * Deliberately lenient, matching parseMarket's reasoning: an unrecognised
 * `?status=` drops the filter rather than 400-ing, because a stray value is a
 * UI bug and blanking the review queue is a worse response to it than showing
 * everything.
 */
function asEnum<T extends Record<string, string>>(
  value: string | undefined,
  enumeration: T,
): T[keyof T] | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  return Object.values(enumeration).includes(upper) ? (upper as T[keyof T]) : undefined;
}

function asDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** IP and user-agent for the audit trail, where the proxy passed them through. */
function requestContext(req: AuthedRequest) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? req.ip);
  const agent = req.headers['user-agent'];

  return {
    ipAddress: typeof ip === 'string' ? ip.split(',')[0].trim() : null,
    userAgent: Array.isArray(agent) ? agent[0] : (agent ?? null),
  };
}
