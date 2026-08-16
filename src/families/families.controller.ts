import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FamiliesService } from './families.service';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('families')
@UseGuards(JwtAuthGuard)
export class FamiliesController {
  constructor(private familiesService: FamiliesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateFamilyDto, @Req() req: AuthedRequest) {
    return this.familiesService.create(dto, req.user);
  }

  @Get()
  findAll(@Req() req: AuthedRequest, @Query('market') market?: string) {
    // Market unscoped when absent (both books); ownership always applied.
    return this.familiesService.findAll(
      market ? parseMarket(market) : undefined,
      req.user
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.familiesService.findOne(id, req.user);
  }

  /**
   * The integrated household portfolio — merged positions, blended cost, and
   * the combined sector allocation.
   */
  @Get(':id/aggregate')
  aggregate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.familiesService.aggregate(id, req.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFamilyDto,
    @Req() req: AuthedRequest
  ) {
    return this.familiesService.update(id, dto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.familiesService.remove(id, req.user);
  }
}
