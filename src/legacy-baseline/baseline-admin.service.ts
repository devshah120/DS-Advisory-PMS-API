import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AmendBaselineDto } from './dto/amend-baseline.dto';
import { BaselineService } from './baseline.service';

/**
 * The one and only path that can change a baseline after BaselineService has
 * locked it. Gated to ADMIN at the controller (see BaselineAdminGuard) —
 * this service itself does not re-check the role, the same way other
 * services in this codebase trust their controller's guard.
 *
 * Every amendment is recorded, never silent: `reason` is appended to
 * `remarks` with a timestamp rather than replacing it, so the baseline's
 * history of corrections is readable from the row itself. Holdings are
 * replaced wholesale (delete + recreate) rather than diffed, matching the
 * "never a partially-corrected baseline visible to a reader" contract on the
 * BaselineHolding model.
 */
@Injectable()
export class BaselineAdminService {
  constructor(
    private prisma: PrismaService,
    private baselineService: BaselineService,
  ) {}

  async amend(clientId: string, dto: AmendBaselineDto, amendedBy?: string) {
    const baseline = await this.prisma.portfolioBaseline.findUnique({ where: { clientId } });
    if (!baseline) throw new NotFoundException(`Client ${clientId} has no baseline to amend`);

    const stamp = new Date().toISOString();
    const who = amendedBy ?? 'unknown admin';
    const auditLine = `[amended ${stamp} by ${who}] ${dto.reason}`;
    const remarks = baseline.remarks ? `${baseline.remarks}\n${auditLine}` : auditLine;

    await this.prisma.baselineHolding.deleteMany({ where: { baselineId: baseline.id } });

    return this.prisma.portfolioBaseline.update({
      where: { clientId },
      data: {
        openingPortfolioValue: dto.openingPortfolioValue,
        openingCash: dto.openingCash,
        remarks,
        holdings: {
          create: dto.holdings.map((h) => ({
            ticker: h.ticker.trim().toUpperCase(),
            quantity: h.quantity,
            averageCost: h.averageCost,
            currency: h.currency,
            sector: h.sector,
            industry: h.industry,
          })),
        },
      },
      include: { holdings: true },
    });
  }

  /**
   * Deletes a client's existing baseline and rebuilds it from scratch via
   * BaselineService.autoSeed — for correcting a baseline that was seeded
   * before a bug in the auto-seed math (or the price lookup it depends on)
   * was fixed, without requiring an admin to hand-type the right numbers via
   * `amend`. Also clears any PortfolioValuation/HoldingSnapshot rows for the
   * client: they were computed FROM the bad baseline (via
   * PortfolioReconstructionService), so they are just as wrong and must not
   * survive as stale cached "truth" that the fixed baseline can no longer
   * explain — PortfolioHistoryService.getPortfolioAsOf would otherwise keep
   * serving the old, wrong snapshot instead of ever reconstructing again.
   */
  async reseedFromHoldings(clientId: string, reason: string, amendedBy?: string) {
    const existing = await this.prisma.portfolioBaseline.findUnique({ where: { clientId } });

    // HoldingSnapshot has no direct clientId column (it hangs off
    // PortfolioValuation), and a nested-relation filter on deleteMany is not
    // reliably supported by Prisma's MongoDB connector for writes — so this
    // resolves the parent ids first rather than filtering through the
    // relation in one call.
    const valuations = await this.prisma.portfolioValuation.findMany({
      where: { clientId },
      select: { id: true },
    });
    const valuationIds = valuations.map((v) => v.id);

    if (valuationIds.length > 0) {
      await this.prisma.holdingSnapshot.deleteMany({ where: { snapshotId: { in: valuationIds } } });
    }
    await this.prisma.portfolioValuation.deleteMany({ where: { clientId } });

    if (existing) {
      await this.prisma.baselineHolding.deleteMany({ where: { baselineId: existing.id } });
      await this.prisma.portfolioBaseline.delete({ where: { clientId } });
    }

    await this.baselineService.autoSeed(clientId);

    const stamp = new Date().toISOString();
    const who = amendedBy ?? 'unknown admin';

    return this.prisma.portfolioBaseline.update({
      where: { clientId },
      data: {
        remarks: `[re-seeded ${stamp} by ${who}] ${reason}`,
      },
      include: { holdings: true },
    });
  }
}
