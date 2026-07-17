import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';

@Injectable()
export class ResearchService {
  constructor(private prisma: PrismaService) {}

  create(createResearchDto: CreateResearchDto) {
    return this.prisma.research.create({
      data: createResearchDto,
    });
  }

  findAll(skip = 0, take = 10) {
    return this.prisma.research.findMany({
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
    });
  }

  findByTicker(ticker: string) {
    return this.prisma.research.findMany({
      where: { ticker },
    });
  }

  findByClient(clientId: string) {
    return this.prisma.research.findMany({
      where: { clientId },
    });
  }

  findOne(id: string) {
    return this.prisma.research.findUnique({
      where: { id },
    });
  }

  update(id: string, updateResearchDto: UpdateResearchDto) {
    return this.prisma.research.update({
      where: { id },
      data: updateResearchDto,
    });
  }

  remove(id: string) {
    return this.prisma.research.delete({
      where: { id },
    });
  }

  async getOverdueReviews() {
    return this.prisma.research.findMany({
      where: {
        reviewDate: { lt: new Date() },
      },
    });
  }
}
