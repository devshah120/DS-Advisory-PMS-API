import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { CreateDividendDto } from './dto/create-dividend.dto';
import {
  Actor,
  assertCanAccessClient,
  relatedClientWhere,
} from '../common/ownership-scope';

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

  /**
   * Every write path takes `clientId` straight from the payload, so each one
   * must prove the caller owns that client first — otherwise a manager could
   * post trades into another manager's book by id alone, which corrupts data
   * rather than merely reading it.
   */
  private async assertOwnsClient(clientId: string, actor: Actor) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, ownerId: true },
    });
    assertCanAccessClient(actor, client);
  }

  async create(createTransactionDto: CreateTransactionDto, actor: Actor) {
    await this.assertOwnsClient(createTransactionDto.clientId, actor);
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
  async createDividend(dto: CreateDividendDto, actor: Actor) {
    await this.assertOwnsClient(dto.clientId, actor);
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
  async createCashFlow(dto: CreateCashFlowDto, actor: Actor) {
    await this.assertOwnsClient(dto.clientId, actor);
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

  /**
   * The caller's clients' activity — what the Transactions page lists.
   *
   * Transactions carry no owner of their own; they inherit it from the client
   * they belong to, so the filter is a relation hop (`client: { ownerId }`)
   * rather than a column match. Same for every read below.
   */
  async findAll(actor: Actor, skip = 0, take = 100) {
    const rows = await this.prisma.transaction.findMany({
      where: relatedClientWhere(actor),
      skip,
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map(serialize);
  }

  async findByClient(clientId: string, actor: Actor, skip = 0, take = 10) {
    // Merging the ownership filter into the same query means an unowned
    // clientId simply returns an empty page — no separate existence check, and
    // no way to tell "no transactions" from "not your client".
    const rows = await this.prisma.transaction.findMany({
      where: { clientId, ...relatedClientWhere(actor) },
      skip,
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map(serialize);
  }

  async findOne(id: string, actor: Actor) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, ...relatedClientWhere(actor) },
    });
    return tx ? serialize(tx) : null;
  }

  /**
   * Deletes only if the row belongs to one of the caller's clients.
   *
   * `deleteMany` rather than `delete` because it accepts a relation filter,
   * which `delete` (unique-key only) does not — and a zero count is then the
   * signal that the row was absent OR someone else's, which is the same
   * indistinguishable 404 the rest of the codebase gives.
   */
  async remove(id: string, actor: Actor) {
    const { count } = await this.prisma.transaction.deleteMany({
      where: { id, ...relatedClientWhere(actor) },
    });
    if (count === 0) throw new NotFoundException('Transaction not found');
    return { success: true, id };
  }

  async getClientCashFlow(clientId: string, actor: Actor) {
    return this.prisma.transaction.findMany({
      where: {
        clientId,
        ...relatedClientWhere(actor),
        type: { in: ['CASH_DEPOSIT', 'CASH_WITHDRAWAL'] },
      },
      orderBy: { date: 'asc' },
    });
  }

  async getRecentTransactions(clientId: string, actor: Actor, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.prisma.transaction.findMany({
      where: {
        clientId,
        ...relatedClientWhere(actor),
        date: { gte: since },
      },
      orderBy: { date: 'desc' },
      take: 10,
    });
  }
}
