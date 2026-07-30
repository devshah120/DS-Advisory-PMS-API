import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { HistoricalPriceService } from '../historical-price/historical-price.service';
import { JUN30_REBASE_DATE } from '../analytics/calculators/flows';
import { CreateBaselineDto } from './dto/create-baseline.dto';

export interface AutoSeedSummary {
  created: string[];
  skipped: string[];
  failed: Array<{ clientId: string; reason: string }>;
}

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
  private readonly logger = new Logger(BaselineService.name);

  constructor(
    private prisma: PrismaService,
    private prices: HistoricalPriceService,
  ) {}

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

  /**
   * Builds a baseline for `clientId` from data already in Atlas, instead of
   * requiring hand-typed holdings: current `Holding` rows, valued at their
   * `baselineDate` close (falls back to the holding's own `averageCost` when
   * no price bar exists for that date — the identical fallback order
   * `rebaseLedgerToJun30` already uses in analytics/calculators/flows.ts, so
   * the Current tab's rebase and this baseline agree on the same position's
   * opening value).
   *
   * Idempotent: if the client already has a baseline, it is returned
   * unchanged rather than re-created — safe to call from a "seed all
   * clients" sweep without double-creating or needing a pre-check per call.
   */
  async autoSeed(clientId: string, baselineDate: Date = JUN30_REBASE_DATE) {
    const existing = await this.findOrNull(clientId);
    if (existing) return existing;

    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { holdings: true },
    });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);

    const open = client.holdings.filter((h) => h.quantity !== 0);

    const holdings = await Promise.all(
      open.map(async (h) => {
        const close = await this.prices.closeOn(h.ticker, baselineDate);
        const price = close ?? h.averageCost;
        return {
          ticker: h.ticker,
          quantity: h.quantity,
          averageCost: price,
          currency: client.currency,
          sector: h.sector,
          industry: h.industry,
        };
      }),
    );

    const openingPortfolioValue =
      holdings.reduce((sum, h) => sum + h.quantity * h.averageCost, 0) + client.cashBalance;

    const dto: CreateBaselineDto = {
      baselineDate: baselineDate.toISOString().slice(0, 10),
      openingPortfolioValue,
      openingCash: client.cashBalance,
      remarks: `Auto-seeded from Holdings + PriceBar on ${baselineDate.toISOString().slice(0, 10)}`,
      holdings,
    };

    return this.create(clientId, dto);
  }

  async autoSeedAllClients(baselineDate: Date = JUN30_REBASE_DATE): Promise<AutoSeedSummary> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
    });

    const summary: AutoSeedSummary = { created: [], skipped: [], failed: [] };

    for (const client of clients) {
      try {
        const alreadyExisted = await this.findOrNull(client.id);
        await this.autoSeed(client.id, baselineDate);
        (alreadyExisted ? summary.skipped : summary.created).push(client.name);
      } catch (error) {
        // One client's failure (e.g. no holdings, no client record) must not
        // block the rest — matches the same tolerance pattern used by
        // SnapshotScheduler.runForAllClients.
        this.logger.warn(`Auto-seed failed for ${client.name} (${client.id}): ${(error as Error).message}`);
        summary.failed.push({ clientId: client.id, reason: (error as Error).message });
      }
    }

    return summary;
  }
}
