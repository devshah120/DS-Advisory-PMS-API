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
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { CreateDividendDto } from './dto/create-dividend.dto';
import { BulkDeleteTransactionsDto } from './dto/bulk-delete-transactions.dto';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private transactionsService: TransactionsService) {}

  @Post()
  create(
    @Body() createTransactionDto: CreateTransactionDto,
    @Req() req: AuthedRequest
  ) {
    return this.transactionsService.create(createTransactionDto, req.user);
  }

  /** Record an external inflow/outflow for a cash-flow-basis client. */
  @Post('cash-flow')
  createCashFlow(@Body() dto: CreateCashFlowDto, @Req() req: AuthedRequest) {
    return this.transactionsService.createCashFlow(dto, req.user);
  }

  /** Record a dividend received. Raises the client's return under both methods. */
  @Post('dividend')
  createDividend(@Body() dto: CreateDividendDto, @Req() req: AuthedRequest) {
    return this.transactionsService.createDividend(dto, req.user);
  }

  /**
   * Delete a selection of transactions.
   *
   * POST rather than `@Delete()` with a body: DELETE bodies are not carried
   * reliably by every proxy and HTTP client in the path, and the ids would not
   * fit a query string at this cap. Declared above `@Get(':id')` so 'bulk-delete'
   * is never captured as an id.
   */
  @Post('bulk-delete')
  removeMany(
    @Body() dto: BulkDeleteTransactionsDto,
    @Req() req: AuthedRequest
  ) {
    return this.transactionsService.removeMany(dto.ids, req.user);
  }

  @Get()
  findAll(
    @Req() req: AuthedRequest,
    @Query('page') page = 1,
    @Query('limit') limit = 100
  ) {
    const skip = (Number(page) - 1) * Number(limit);
    return this.transactionsService.findAll(req.user, skip, Number(limit));
  }

  @Get('client/:clientId')
  findByClient(
    @Param('clientId') clientId: string,
    @Req() req: AuthedRequest,
    @Query('page') page = 1,
    @Query('limit') limit = 10
  ) {
    const skip = (page - 1) * limit;
    return this.transactionsService.findByClient(clientId, req.user, skip, limit);
  }

  @Get('client/:clientId/recent')
  getRecentTransactions(
    @Param('clientId') clientId: string,
    @Req() req: AuthedRequest,
    @Query('days') days = 30
  ) {
    return this.transactionsService.getRecentTransactions(clientId, req.user, days);
  }

  /**
   * The lot history behind one position. Declared above `@Get(':id')` for the
   * same reason 'bulk-delete' is — a literal segment must be matched before the
   * catch-all id param claims it.
   */
  @Get('client/:clientId/lots/:ticker')
  findLots(
    @Param('clientId') clientId: string,
    @Param('ticker') ticker: string,
    @Req() req: AuthedRequest
  ) {
    return this.transactionsService.findLots(clientId, ticker, req.user);
  }

  @Get('client/:clientId/cashflow')
  getCashFlow(@Param('clientId') clientId: string, @Req() req: AuthedRequest) {
    return this.transactionsService.getClientCashFlow(clientId, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.transactionsService.findOne(id, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.transactionsService.remove(id, req.user);
  }
}
