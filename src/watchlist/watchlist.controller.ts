import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WatchlistService } from './watchlist.service';
import { CreateWatchlistDto, BulkAddWatchlistDto, RenameWatchlistFolderDto } from './dto/create-watchlist.dto';

@Controller('watchlist')
@UseGuards(JwtAuthGuard)
export class WatchlistController {
  constructor(private watchlistService: WatchlistService) {}

  @Post()
  create(@Body() createWatchlistDto: CreateWatchlistDto) {
    return this.watchlistService.create(createWatchlistDto);
  }

  @Post('bulk')
  bulkAdd(@Body() dto: BulkAddWatchlistDto) {
    return this.watchlistService.bulkAdd(dto.tickers, dto.slot);
  }

  @Get()
  findAll(@Query('slot') slot?: string) {
    return this.watchlistService.findAll(slot);
  }

  @Get('folders')
  folders() {
    return this.watchlistService.folders();
  }

  @Post('folders/:slot')
  renameFolder(@Param('slot') slot: string, @Body() dto: RenameWatchlistFolderDto) {
    return this.watchlistService.renameFolder(slot, dto.name);
  }

  @Get('benchmarks')
  benchmarkReturns() {
    return this.watchlistService.benchmarkReturns();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.watchlistService.findOne(id);
  }

  @Get(':id/returns')
  returns(@Param('id') id: string) {
    return this.watchlistService.findOne(id).then((item) => {
      if (!item) return null;
      return this.watchlistService.returnsFor(item.ticker);
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.watchlistService.remove(id);
  }
}
