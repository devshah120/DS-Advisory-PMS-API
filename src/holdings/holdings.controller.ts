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
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HoldingsService } from './holdings.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';

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
  create(@Body() createHoldingDto: CreateHoldingDto) {
    return this.holdingsService.create(createHoldingDto);
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
  importHoldings(@UploadedFile() file?: UploadedExcel) {
    if (!file) throw new BadRequestException('No file uploaded (expected field "file")');
    return this.holdingsService.bulkImport(file.buffer);
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
