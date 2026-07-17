import { Module } from '@nestjs/common';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ResearchController],
  providers: [ResearchService],
  exports: [ResearchService],
})
export class ResearchModule {}
