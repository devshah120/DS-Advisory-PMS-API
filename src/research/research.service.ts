import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import {
  Actor,
  assertCanAccessClient,
  clientWhere,
  isFirmWide,
} from '../common/ownership-scope';

@Injectable()
export class ResearchService {
  constructor(private prisma: PrismaService) {}

  /**
   * Research rows come in two kinds, and only one of them is private.
   *
   * A row WITH a clientId is a note about a specific mandate — it inherits that
   * client's owner and must be scoped like any other client-linked record. A row
   * WITHOUT one is house research on a ticker: a thesis on RELIANCE that belongs
   * to the firm's shared library, not to whoever happened to type it. Those stay
   * visible to all staff, which is what the desk expects from a research note
   * and what `clientId String?` in the schema already implies.
   *
   * So the filter is "house research OR my clients' research" rather than a
   * plain owner match — an owner match would hide the shared library from
   * everyone.
   */
  private visibilityWhere(actor: Actor) {
    if (isFirmWide(actor)) return {};
    return {
      OR: [{ clientId: null }, { client: clientWhere(actor) }],
    };
  }

  /** Proves the caller owns the mandate a client-linked note names. */
  private async assertOwnsClient(clientId: string | null | undefined, actor: Actor) {
    if (!clientId) return; // house research — no mandate to check
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, ownerId: true },
    });
    assertCanAccessClient(actor, client);
  }

  async create(createResearchDto: CreateResearchDto, actor: Actor) {
    await this.assertOwnsClient(createResearchDto.clientId, actor);
    return this.prisma.research.create({
      data: createResearchDto,
    });
  }

  findAll(actor: Actor, skip = 0, take = 10) {
    return this.prisma.research.findMany({
      where: this.visibilityWhere(actor),
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
    });
  }

  findByTicker(ticker: string, actor: Actor) {
    return this.prisma.research.findMany({
      where: { ticker, ...this.visibilityWhere(actor) },
    });
  }

  findByClient(clientId: string, actor: Actor) {
    return this.prisma.research.findMany({
      where: { clientId, ...this.visibilityWhere(actor) },
    });
  }

  findOne(id: string, actor: Actor) {
    return this.prisma.research.findFirst({
      where: { id, ...this.visibilityWhere(actor) },
    });
  }

  async update(id: string, updateResearchDto: UpdateResearchDto, actor: Actor) {
    // Read through the visibility filter first, so a note that is not visible
    // cannot be edited — and reassigning a note onto another manager's client
    // is blocked by checking the incoming clientId too.
    const existing = await this.findOne(id, actor);
    if (!existing) throw new NotFoundException('Research note not found');
    await this.assertOwnsClient(updateResearchDto.clientId, actor);

    return this.prisma.research.update({
      where: { id },
      data: updateResearchDto,
    });
  }

  async remove(id: string, actor: Actor) {
    const existing = await this.findOne(id, actor);
    if (!existing) throw new NotFoundException('Research note not found');

    return this.prisma.research.delete({
      where: { id },
    });
  }

  async getOverdueReviews(actor: Actor) {
    return this.prisma.research.findMany({
      where: {
        reviewDate: { lt: new Date() },
        ...this.visibilityWhere(actor),
      },
    });
  }
}
