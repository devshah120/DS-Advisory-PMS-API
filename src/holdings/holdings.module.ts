import { Module } from '@nestjs/common';
import { HoldingsService } from './holdings.service';
import { HoldingsController } from './holdings.controller';
import { PrismaModule } from '../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HoldingsController],
  providers: [HoldingsService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
