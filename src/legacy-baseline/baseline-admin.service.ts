import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AmendBaselineDto } from './dto/amend-baseline.dto';

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
  constructor(private prisma: PrismaService) {}

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
}
