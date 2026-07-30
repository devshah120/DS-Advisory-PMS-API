import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateBaselineDto } from './dto/create-baseline.dto';

/**
 * The Legacy Portfolio Baseline: the immutable opening position imported for
 * a client before Atlas started recording transactions.
 *
 * Deliberately has no `update()`. A baseline is a one-time import — every
 * downstream calculation (PortfolioReconstructionService, the performance
 * baseline, every historical snapshot) treats it as ground truth for its
 * date, so a normal-path edit would silently rewrite history for anything
 * already computed from it. The only way to change one after creation is
 * BaselineAdminService, which is a distinct, ADMIN-gated code path that
 * appends to the audit trail rather than overwriting it.
 */
@Injectable()
export class BaselineService {
  constructor(private prisma: PrismaService) {}

  async create(clientId: string, dto: CreateBaselineDto, createdBy?: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const existing = await this.prisma.portfolioBaseline.findUnique({ where: { clientId } });
    if (existing) {
      throw new ConflictException(
        `Client ${clientId} already has a baseline (set ${existing.createdAt.toISOString()}). ` +
          `A baseline is immutable once created — use the admin amendment path to correct it.`,
      );
    }

    return this.prisma.portfolioBaseline.create({
      data: {
        clientId,
        baselineDate: new Date(dto.baselineDate),
        openingPortfolioValue: dto.openingPortfolioValue,
        openingCash: dto.openingCash,
        remarks: dto.remarks,
        createdBy,
        lockedAt: new Date(),
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

  async get(clientId: string) {
    const baseline = await this.prisma.portfolioBaseline.findUnique({
      where: { clientId },
      include: { holdings: true },
    });
    if (!baseline) throw new NotFoundException(`Client ${clientId} has no baseline`);
    return baseline;
  }

  async findOrNull(clientId: string) {
    return this.prisma.portfolioBaseline.findUnique({
      where: { clientId },
      include: { holdings: true },
    });
  }
}
