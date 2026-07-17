import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HoldingsService } from './holdings.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';

@Controller('holdings')
@UseGuards(JwtAuthGuard)
export class HoldingsController {
  constructor(private holdingsService: HoldingsService) {}

  @Post()
  create(@Body() createHoldingDto: CreateHoldingDto) {
    return this.holdingsService.create(createHoldingDto);
  }

  @Get()
  findAll() {
    return this.holdingsService.findAll();
  }

  @Get('client/:clientId')
  findByClient(@Param('clientId') clientId: string) {
    return this.holdingsService.findByClient(clientId);
  }

  @Get('ticker/:ticker')
  getByTicker(@Param('ticker') ticker: string) {
    return this.holdingsService.getByTicker(ticker);
  }

  @Get('client/:clientId/sectors')
  getSectorExposure(@Param('clientId') clientId: string) {
    return this.holdingsService.getSectorExposure(clientId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.holdingsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateHoldingDto: UpdateHoldingDto
  ) {
    return this.holdingsService.update(id, updateHoldingDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.holdingsService.remove(id);
  }
}
