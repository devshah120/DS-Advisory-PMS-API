import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { CreateDividendDto } from './dto/create-dividend.dto';

/**
 * Prisma stores SCREAMING_CASE enums; the HTTP contract is lowercase — the same
 * convention ClientsService.serialize() already follows.
 *
 * Without this the API hands back "CASH_DEPOSIT" while the frontend's
 * TransactionType union is 'cash_deposit', so every type comparison silently
 * fails: the tab filters match nothing and the badges render the raw enum.
 */
const serialize = <T extends { type: string }>(tx: T) => ({
  ...tx,
  type: tx.type.toLowerCase(),
});

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async create(createTransactionDto: CreateTransactionDto) {
    const tx = await this.prisma.transaction.create({
      data: {
        ...createTransactionDto,
        date: new Date(createTransactionDto.date),
      },
    });
    return serialize(tx);
  }

  /**
   * Record a dividend received.
   *
   * Cash that arrived and is attributable to a holding. It raises the client's
   * return under BOTH methods — see calculators/flows.ts, where DIVIDEND is a
   * positive flow for the transactional method, and where a cash-flow client's
   * dividend is left to accrue inside the NAV rather than being counted as a
   * client withdrawal (it is the portfolio earning, not the client taking money
   * out).
   */
  async createDividend(dto: CreateDividendDto) {
    const tx = await this.prisma.transaction.create({
      data: {
        clientId: dto.clientId,
        ticker: dto.ticker,
        type: 'DIVIDEND',
        amount: Math.abs(dto.amount),
        quantity: dto.quantity,
        date: new Date(dto.date),
        description: dto.description,
        reference: dto.reference,
      },
    });
    return serialize(tx);
  }

  /**
   * Record an external cash flow for a cash-flow-basis client.
   *
   * This is a Transaction row like any other — a separate collection would mean
   * two ledgers to keep in step, and the XIRR engine would have to union them.
   * The direction is stored as the TYPE and the amount is always kept positive,
   * so `buildFlows` can derive the sign from the type rather than trusting
   * whatever sign the operator happened to type in.
   */
  async createCashFlow(dto: CreateCashFlowDto) {
    const tx = await this.prisma.transaction.create({
      data: {
        clientId: dto.clientId,
        type: dto.direction === 'in' ? 'CASH_DEPOSIT' : 'CASH_WITHDRAWAL',
        amount: Math.abs(dto.amount),
        date: new Date(dto.date),
        description: dto.description,
        reference: dto.reference,
      },
    });
    return serialize(tx);
  }

  /** Every client's activity — what the Transactions page lists. */
  async findAll(skip = 0, take = 100) {
    const rows = await this.prisma.transaction.findMany({
      skip,
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map(serialize);
  }

  async findByClient(clientId: string, skip = 0, take = 10) {
    const rows = await this.prisma.transaction.findMany({
      where: { clientId },
      skip,
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map(serialize);
  }

  async findOne(id: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
    });
    return tx ? serialize(tx) : null;
  }

  remove(id: string) {
    return this.prisma.transaction.delete({
      where: { id },
    });
  }

  async getClientCashFlow(clientId: string) {
    return this.prisma.transaction.findMany({
      where: {
        clientId,
        type: { in: ['CASH_DEPOSIT', 'CASH_WITHDRAWAL'] },
      },
      orderBy: { date: 'asc' },
    });
  }

  async getRecentTransactions(clientId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.transaction.findMany({
      where: {
        clientId,
        date: { gte: since },
      },
      orderBy: { date: 'desc' },
      take: 10,
    });
  }
}
