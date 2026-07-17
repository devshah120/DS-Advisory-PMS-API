import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { CreateDividendDto } from './dto/create-dividend.dto';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private transactionsService: TransactionsService) {}

  @Post()
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(createTransactionDto);
  }

  /** Record an external inflow/outflow for a cash-flow-basis client. */
  @Post('cash-flow')
  createCashFlow(@Body() dto: CreateCashFlowDto) {
    return this.transactionsService.createCashFlow(dto);
  }

  /** Record a dividend received. Raises the client's return under both methods. */
  @Post('dividend')
  createDividend(@Body() dto: CreateDividendDto) {
    return this.transactionsService.createDividend(dto);
  }

  @Get()
  findAll(@Query('page') page = 1, @Query('limit') limit = 100) {
    const skip = (Number(page) - 1) * Number(limit);
    return this.transactionsService.findAll(skip, Number(limit));
  }

  @Get('client/:clientId')
  findByClient(
    @Param('clientId') clientId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 10
  ) {
    const skip = (page - 1) * limit;
    return this.transactionsService.findByClient(clientId, skip, limit);
  }

  @Get('client/:clientId/recent')
  getRecentTransactions(
    @Param('clientId') clientId: string,
    @Query('days') days = 30
  ) {
    return this.transactionsService.getRecentTransactions(clientId, days);
  }

  @Get('client/:clientId/cashflow')
  getCashFlow(@Param('clientId') clientId: string) {
    return this.transactionsService.getClientCashFlow(clientId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.transactionsService.findOne(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.transactionsService.remove(id);
  }
}
