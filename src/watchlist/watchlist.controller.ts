import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WatchlistService } from './watchlist.service';
import { ClientPortfolioWatchlistService } from './client-portfolio-watchlist.service';
import { CreateWatchlistDto, BulkAddWatchlistDto, RenameWatchlistFolderDto } from './dto/create-watchlist.dto';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('watchlist')
@UseGuards(JwtAuthGuard)
export class WatchlistController {
  constructor(
    private watchlistService: WatchlistService,
    private clientPortfolio: ClientPortfolioWatchlistService,
  ) {}

  @Post()
  create(
    @Body() createWatchlistDto: CreateWatchlistDto,
    @Req() req: AuthedRequest
  ) {
    return this.watchlistService.create(createWatchlistDto, req.user);
  }

  @Post('bulk')
  bulkAdd(@Body() dto: BulkAddWatchlistDto, @Req() req: AuthedRequest) {
    return this.watchlistService.bulkAdd(
      dto.tickers,
      req.user,
      dto.slot,
      dto.market ? parseMarket(dto.market) : undefined,
    );
  }

  @Get()
  findAll(
    @Req() req: AuthedRequest,
    @Query('slot') slot?: string,
    @Query('market') market?: string
  ) {
    // Market unscoped when absent (both books); ownership always applied.
    return this.watchlistService.findAll(
      req.user,
      slot,
      market ? parseMarket(market) : undefined
    );
  }

  @Get('folders')
  folders(@Req() req: AuthedRequest, @Query('market') market?: string) {
    return this.watchlistService.folders(parseMarket(market), req.user);
  }

  @Post('folders/:slot')
  renameFolder(
    @Param('slot') slot: string,
    @Body() dto: RenameWatchlistFolderDto,
    @Req() req: AuthedRequest
  ) {
    return this.watchlistService.renameFolder(
      slot,
      dto.name,
      parseMarket(dto.market),
      req.user
    );
  }

  @Get('benchmarks')
  benchmarkReturns(@Query('market') market?: string) {
    return this.watchlistService.benchmarkReturns(parseMarket(market));
  }

  /**
   * The watchlist generated from a client's book: every position they hold,
   * with MTD/QTD/YTD for their own holding and the book's indices over the same
   * windows. Declared above `:id` so the id routes cannot capture it.
   */
  @Get('client/:clientId')
  clientPortfolioWatchlist(@Param('clientId') clientId: string, @Req() req: AuthedRequest) {
    return this.clientPortfolio.forClient(clientId, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.watchlistService.findOne(id, req.user);
  }

  @Get(':id/returns')
  returns(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.watchlistService.findOne(id, req.user).then((item) => {
      if (!item) return null;
      return this.watchlistService.returnsFor(item.ticker);
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.watchlistService.remove(id, req.user);
  }
}
