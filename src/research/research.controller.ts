import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResearchService } from './research.service';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';

@Controller('research')
@UseGuards(JwtAuthGuard)
export class ResearchController {
  constructor(private researchService: ResearchService) {}

  @Post()
  create(@Body() createResearchDto: CreateResearchDto) {
    return this.researchService.create(createResearchDto);
  }

  @Get()
  findAll(@Query('page') page = 1, @Query('limit') limit = 10) {
    const skip = (page - 1) * limit;
    return this.researchService.findAll(skip, limit);
  }

  @Get('ticker/:ticker')
  findByTicker(@Param('ticker') ticker: string) {
    return this.researchService.findByTicker(ticker);
  }

  @Get('client/:clientId')
  findByClient(@Param('clientId') clientId: string) {
    return this.researchService.findByClient(clientId);
  }

  @Get('overdue')
  getOverdueReviews() {
    return this.researchService.getOverdueReviews();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.researchService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateResearchDto: UpdateResearchDto
  ) {
    return this.researchService.update(id, updateResearchDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.researchService.remove(id);
  }
}
