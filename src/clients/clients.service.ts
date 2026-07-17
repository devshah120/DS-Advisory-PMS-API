import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

// Prisma persists SCREAMING_CASE enums; the HTTP contract uses lowercase.
const toDb = <T extends string>(v: T | undefined) =>
  v === undefined ? undefined : (v.toUpperCase() as any);

const toApi = (v: string | null | undefined) =>
  v == null ? v : (v.toLowerCase() as any);

function serialize<T extends { riskProfile: string; status: string; accountingMethod?: string }>(
  client: T
) {
  return {
    ...client,
    riskProfile: toApi(client.riskProfile),
    status: toApi(client.status),
    // CASH_FLOW -> cash_flow. toApi already lowercases; the underscore survives.
    accountingMethod: toApi(client.accountingMethod),
  };
}

@Injectable()
export class ClientsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateClientDto) {
    const existing = await this.prisma.client.findFirst({
      where: {
        broker: dto.broker,
        accountNumber: dto.accountNumber,
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        `Account ${dto.accountNumber} already exists for broker ${dto.broker}`
      );
    }

    try {
      const client = await this.prisma.client.create({
        data: {
          ...dto,
          riskProfile: toDb(dto.riskProfile),
          status: toDb(dto.status),
          accountingMethod: toDb(dto.accountingMethod),
          inceptionDate: new Date(dto.inceptionDate),
        },
      });
      return serialize(client);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('A client with these details already exists');
      }
      throw err;
    }
  }

  async findAll(skip = 0, take = 10) {
    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          holdings: true,
          transactions: true,
        },
      }),
      this.prisma.client.count(),
    ]);

    return {
      data: clients.map(serialize),
      total,
      page: Math.floor(skip / take) + 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        holdings: true,
        transactions: true,
        research: true,
      },
    });

    if (!client) throw new NotFoundException(`Client ${id} not found`);
    return serialize(client);
  }

  async update(id: string, dto: UpdateClientDto) {
    await this.findOne(id);

    const client = await this.prisma.client.update({
      where: { id },
      data: {
        ...dto,
        riskProfile: toDb(dto.riskProfile),
        status: toDb(dto.status),
        accountingMethod: toDb(dto.accountingMethod),
        inceptionDate: dto.inceptionDate ? new Date(dto.inceptionDate) : undefined,
      },
    });
    return serialize(client);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.client.delete({ where: { id } });
    return { success: true, id };
  }

  async count() {
    return this.prisma.client.count();
  }

  async getClientMetrics(id: string) {
    const client = await this.findOne(id);

    const totalValue = client.holdings.reduce(
      (sum: number, h: any) => sum + h.marketValue,
      0
    );
    const totalCost = client.holdings.reduce(
      (sum: number, h: any) => sum + h.averageCost * h.quantity,
      0
    );

    return {
      ...client,
      totalInvested: totalCost,
      unrealizedGain: totalValue - totalCost,
      gainPercent: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    };
  }
}
