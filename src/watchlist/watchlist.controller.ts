import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WatchlistService } from './watchlist.service';
import { CreateWatchlistDto, BulkAddWatchlistDto, RenameWatchlistFolderDto } from './dto/create-watchlist.dto';
import { parseMarket } from '../common/market-scope';

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
    return this.watchlistService.bulkAdd(
      dto.tickers,
      dto.slot,
      dto.market ? parseMarket(dto.market) : undefined,
    );
  }

  @Get()
  findAll(@Query('slot') slot?: string, @Query('market') market?: string) {
    // Unscoped when absent, so a firm-wide read still returns both books.
    return this.watchlistService.findAll(slot, market ? parseMarket(market) : undefined);
  }

  @Get('folders')
  folders(@Query('market') market?: string) {
    return this.watchlistService.folders(parseMarket(market));
  }

  @Post('folders/:slot')
  renameFolder(@Param('slot') slot: string, @Body() dto: RenameWatchlistFolderDto) {
    return this.watchlistService.renameFolder(slot, dto.name, parseMarket(dto.market));
  }

  @Get('benchmarks')
  benchmarkReturns(@Query('market') market?: string) {
    return this.watchlistService.benchmarkReturns(parseMarket(market));
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
