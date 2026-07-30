import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BaselineService } from './baseline.service';
import { BaselineAdminService } from './baseline-admin.service';
import { CreateBaselineDto } from './dto/create-baseline.dto';
import { AmendBaselineDto } from './dto/amend-baseline.dto';
import { AdminOnlyGuard } from './admin-only.guard';

@Controller('clients/:clientId/baseline')
@UseGuards(JwtAuthGuard)
export class BaselineController {
  constructor(
    private baselineService: BaselineService,
    private baselineAdminService: BaselineAdminService,
  ) {}

  @Post()
  create(@Param('clientId') clientId: string, @Body() dto: CreateBaselineDto, @Req() req: any) {
    return this.baselineService.create(clientId, dto, req?.user?.id);
  }

  @Get()
  get(@Param('clientId') clientId: string) {
    return this.baselineService.get(clientId);
  }

  @Patch()
  @UseGuards(AdminOnlyGuard)
  amend(@Param('clientId') clientId: string, @Body() dto: AmendBaselineDto, @Req() req: any) {
    return this.baselineAdminService.amend(clientId, dto, req?.user?.email ?? req?.user?.id);
  }
}
