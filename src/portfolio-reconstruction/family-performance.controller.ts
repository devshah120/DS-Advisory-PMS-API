import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FamilyPerformanceService } from './family-performance.service';
import { availablePeriods, resolvePeriod } from './periods';
import { Market, parseMarket } from '../common/market-scope';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor, assertOwns } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

/**
 * Household-level performance: the same period vocabulary and the same
 * money-weighted engine as a single mandate, applied to a family as one
 * account.
 *
 * Mounted under `families/:familyId` rather than beside the client routes
 * because the subject IS the family — its calendar comes from the family's
 * market and its access check is the family's, not any one member's.
 */
@Controller('families/:familyId/performance')
@UseGuards(JwtAuthGuard)
export class FamilyPerformanceController {
  constructor(
    private familyPerformance: FamilyPerformanceService,
    private prisma: PrismaService,
  ) {}

  /**
   * The reporting calendar for a household, taken from the FAMILY record.
   *
   * A family lives in exactly one book (schema.prisma: Family.market), so the
   * household calendar is unambiguous in a way a per-member lookup would not
   * be — and getting it wrong would report an Indian household's Q2 on the
   * calendar quarter, mislabelling a statutory FY figure. An explicit param is
   * still honoured as an override, matching the client route's behaviour.
   */
  private async marketFor(familyId: string, actor: Actor, override?: string): Promise<Market> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: { id: true, ownerId: true, market: true },
    });
    assertOwns(actor, family, 'Family');
    if (override) return parseMarket(override);
    return parseMarket(family!.market);
  }

  /**
   * The household's own start date: the EARLIEST `inceptionDate` among its
   * members, since the family is measured as one account and that account's
   * money-weighted flows (see FamilyPerformanceService) cannot predate its
   * first member's own start. A family with no members yet has no floor of
   * its own — `undefined` leaves `effectiveInception` at the house date, which
   * is moot anyway because `emptyHousehold` short-circuits before any window
   * math runs.
   */
  private async householdInceptionFor(familyId: string): Promise<Date | undefined> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: { clients: { select: { inceptionDate: true } } },
    });
    const dates = family?.clients.map((c) => c.inceptionDate) ?? [];
    if (dates.length === 0) return undefined;
    return new Date(Math.min(...dates.map((d) => d.getTime())));
  }

  /**
   * The periods a household can be measured over — the same list a member
   * would offer, generated from the FAMILY'S market calendar so the dropdown
   * cannot drift from what `resolvePeriod` will accept.
   */
  @Get('periods')
  async periods(
    @Param('familyId') familyId: string,
    @Req() req: AuthedRequest,
    @Query('market') market?: string,
  ) {
    const [resolvedMarket, householdInception] = await Promise.all([
      this.marketFor(familyId, req.user, market),
      this.householdInceptionFor(familyId),
    ]);
    return availablePeriods(new Date(), resolvedMarket, householdInception);
  }

  /**
   * ?period=INCEPTION|MTD|QTD|FYTD|Q2-FY27|… or ?from=&to= for a custom range.
   *
   * Returns the household's money-weighted return over the window, its
   * benchmark and alpha on the same flows, and the per-member breakdown
   * underneath it.
   */
  @Get('return')
  async periodReturn(
    @Param('familyId') familyId: string,
    @Req() req: AuthedRequest,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('market') market?: string,
  ) {
    const [resolvedMarket, householdInception] = await Promise.all([
      this.marketFor(familyId, req.user, market),
      this.householdInceptionFor(familyId),
    ]);

    const to_ = to ? this.parseDate(to) : undefined;
    const from_ = from ? this.parseDate(from) : undefined;

    // An explicit ?from= with no ?period= is the custom-range call.
    const code = period ?? (from_ ? 'CUSTOM' : 'INCEPTION');

    const resolved = resolvePeriod(code, {
      from: from_,
      to: to_,
      market: resolvedMarket,
      clientInception: householdInception,
    });
    return this.familyPerformance.periodReturn(familyId, resolved, req.user);
  }

  private parseDate(raw: string): Date {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid date "${raw}" — expected YYYY-MM-DD`);
    }
    return parsed;
  }
}
