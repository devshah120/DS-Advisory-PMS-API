import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HoldingsService } from './holdings.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import { parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

// A generous ceiling: a bulk position file is small, but this stops an
// oversized upload from being buffered into memory.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Minimal shape of a Multer memory-storage file. Declared locally so the
// project doesn't need @types/multer just for this one endpoint.
interface UploadedExcel {
  buffer: Buffer;
  originalname: string;
  size: number;
}

@Controller('holdings')
@UseGuards(JwtAuthGuard)
export class HoldingsController {
  constructor(private holdingsService: HoldingsService) {}

  @Post()
  create(@Body() createHoldingDto: CreateHoldingDto, @Req() req: AuthedRequest) {
    return this.holdingsService.create(createHoldingDto, req.user);
  }

  /**
   * Streams the sample import workbook. Kept above `@Get(':id')` so the literal
   * path isn't captured as an `id`.
   */
  @Get('import/template')
  downloadTemplate(@Res() res: Response) {
    const buffer = this.holdingsService.buildImportTemplate();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="transactions-import-sample.xlsx"',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES } }),
  )
  importHoldings(@Req() req: AuthedRequest, @UploadedFile() file?: UploadedExcel) {
    if (!file) throw new BadRequestException('No file uploaded (expected field "file")');
    // The actor scopes the name→client index the parser resolves rows against,
    // so a blotter naming someone else's client fails that row rather than
    // writing into their book.
    return this.holdingsService.bulkImport(file.buffer, req.user);
  }

  @Get()
  findAll(@Req() req: AuthedRequest, @Query('market') market?: string) {
    // Market is unscoped when absent (both books); ownership never is.
    return this.holdingsService.findAll(
      market ? parseMarket(market) : undefined,
      req.user
    );
  }

  @Get('client/:clientId')
  findByClient(@Param('clientId') clientId: string, @Req() req: AuthedRequest) {
    return this.holdingsService.findByClient(clientId, req.user);
  }

  @Get('ticker/:ticker')
  getByTicker(@Param('ticker') ticker: string, @Req() req: AuthedRequest) {
    return this.holdingsService.getByTicker(ticker, req.user);
  }

  @Get('client/:clientId/sectors')
  getSectorExposure(
    @Param('clientId') clientId: string,
    @Req() req: AuthedRequest
  ) {
    return this.holdingsService.getSectorExposure(clientId, req.user);
  }

  @Get('client/:clientId/as-of-date/:date')
  async getPortfolioAsOfDate(
    @Param('clientId') clientId: string,
    @Param('date') dateStr: string,
    @Req() req: AuthedRequest,
  ) {
    const asOfDate = new Date(dateStr);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO format (YYYY-MM-DD)');
    }
    return this.holdingsService.getPortfolioAsOfDate(clientId, asOfDate, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.holdingsService.findOne(id, req.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateHoldingDto: UpdateHoldingDto,
    @Req() req: AuthedRequest
  ) {
    return this.holdingsService.update(id, updateHoldingDto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.holdingsService.remove(id, req.user);
  }
}
