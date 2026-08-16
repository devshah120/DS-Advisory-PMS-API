import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResearchService } from './research.service';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('research')
@UseGuards(JwtAuthGuard)
export class ResearchController {
  constructor(private researchService: ResearchService) {}

  @Post()
  create(
    @Body() createResearchDto: CreateResearchDto,
    @Req() req: AuthedRequest
  ) {
    return this.researchService.create(createResearchDto, req.user);
  }

  @Get()
  findAll(
    @Req() req: AuthedRequest,
    @Query('page') page = 1,
    @Query('limit') limit = 10
  ) {
    const skip = (page - 1) * limit;
    return this.researchService.findAll(req.user, skip, limit);
  }

  @Get('ticker/:ticker')
  findByTicker(@Param('ticker') ticker: string, @Req() req: AuthedRequest) {
    return this.researchService.findByTicker(ticker, req.user);
  }

  @Get('client/:clientId')
  findByClient(@Param('clientId') clientId: string, @Req() req: AuthedRequest) {
    return this.researchService.findByClient(clientId, req.user);
  }

  @Get('overdue')
  getOverdueReviews(@Req() req: AuthedRequest) {
    return this.researchService.getOverdueReviews(req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.researchService.findOne(id, req.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateResearchDto: UpdateResearchDto,
    @Req() req: AuthedRequest
  ) {
    return this.researchService.update(id, updateResearchDto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.researchService.remove(id, req.user);
  }
}
