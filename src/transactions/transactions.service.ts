import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { CreateDividendDto } from './dto/create-dividend.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
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

  /**
   * The dated lot history behind ONE position — every buy and sell of a single
   * ticker in a single mandate, oldest first.
   *
   * Read off the ledger rather than the Holding row because the holding stores
   * only running aggregates (quantity, averageCost): it knows the position is
   * 39.89 shares at $162.95 average, but not that it was assembled from two
   * fills. That breakdown only exists here.
   *
   * Ordered ASCENDING, unlike the blotter views above — this is read as the
   * story of how a position was built, and a cost basis reads forwards.
   * Unpaginated: a single name in a single account is a handful of rows, and
   * partial lot history would misstate the cost basis it is used to explain.
   *
   * `relatedClientWhere` means an unowned clientId returns an empty list, so
   * this leaks nothing about another manager's book.
   */
  async findLots(clientId: string, ticker: string, actor: Actor) {
    const rows = await this.prisma.transaction.findMany({
      where: {
        clientId,
        // Ownership merged into the same query, exactly as findByClient does:
        // an unowned clientId then returns an empty list rather than another
        // manager's fills, with no separate existence check to keep in step.
        ...relatedClientWhere(actor),
        // Tickers are upper-cased on every write path (the importer and the
        // Add Position form both normalise), so match on the same casing
        // rather than trusting whatever the querystring carried.
        ticker: ticker.toUpperCase(),
        // Only the trades that MOVE the position. A dividend or a fee against
        // the same ticker is real, but it buys no shares — including it would
        // put rows in a cost-basis table that contribute no cost and no basis.
        type: { in: ['BUY', 'SELL'] },
      },
      orderBy: { date: 'asc' },
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
   * Correct an existing ledger row.
   *
   * Two things make this different from an ordinary PATCH:
   *
   * 1. Ownership is proved by the UPDATE ITSELF, not by a read beforehand.
   *    `updateMany` takes the same relation filter `remove` uses, so a row in
   *    another manager's book matches nothing and reports count 0 — the same
   *    indistinguishable 404. A findFirst-then-update would leave a window
   *    between the two, and would need the check kept in step by hand.
   *
   * 2. Only the keys actually sent are written. An absent key must not be
   *    confused with a cleared one: `{ ticker: undefined }` would tell Prisma
   *    to leave the ticker alone, which is right, but spreading the whole DTO
   *    would also push `undefined` over fields the form never showed. So the
   *    patch is assembled key by key, and an explicit `null` on a nullable
   *    field is preserved as a genuine "clear this".
   *
   * Nothing recalculates here, deliberately. Holdings and every return figure
   * are derived by replaying this ledger (see HoldingsService's reconstruction
   * and analytics/calculators/flows.ts), so the corrected row is picked up on
   * the next read — exactly as it is after a delete. Writing a Holding patch
   * from this method would put a second, divergent source of truth next to the
   * replay.
   */
  async update(id: string, dto: UpdateTransactionDto, actor: Actor) {
    const data: Prisma.TransactionUncheckedUpdateManyInput = {};

    if (dto.type !== undefined) data.type = dto.type;
    if (dto.amount !== undefined) data.amount = dto.amount;
    if (dto.date !== undefined) data.date = new Date(dto.date);
    // The nullable columns: `null` clears, a value sets, absent leaves alone.
    if (dto.ticker !== undefined) data.ticker = dto.ticker;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.reference !== undefined) data.reference = dto.reference;

    // An empty patch would otherwise bump `updatedAt` and report success for a
    // save that changed nothing, so it is answered from the read instead.
    if (Object.keys(data).length === 0) {
      const current = await this.findOne(id, actor);
      if (!current) throw new NotFoundException('Transaction not found');
      return current;
    }

    const { count } = await this.prisma.transaction.updateMany({
      where: { id, ...relatedClientWhere(actor) },
      data,
    });
    if (count === 0) throw new NotFoundException('Transaction not found');

    // Re-read rather than trusting the patch: `updateMany` returns a count, not
    // the row, and the caller needs the whole corrected record to patch its
    // table with.
    const updated = await this.prisma.transaction.findUnique({ where: { id } });
    if (!updated) throw new NotFoundException('Transaction not found');
    return serialize(updated);
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

  /**
   * Deletes many rows in one statement, keeping only those the caller owns.
   *
   * Deliberately NOT all-or-nothing: the relation filter silently drops ids that
   * are absent or in another manager's book, and the caller is told how many
   * actually went. Rejecting the whole batch on one stale id would mean a row
   * deleted in another tab makes the rest of the selection undeletable.
   *
   * `deleted` is therefore the count the UI must trust when reconciling its
   * state — not `ids.length`.
   */
  async removeMany(ids: string[], actor: Actor) {
    // Duplicate ids in the payload would inflate nothing (deleteMany counts
    // rows, not ids), but they do bloat the IN list for no gain.
    const unique = [...new Set(ids)];

    const { count } = await this.prisma.transaction.deleteMany({
      where: { id: { in: unique }, ...relatedClientWhere(actor) },
    });

    if (count === 0) throw new NotFoundException('No matching transactions found');

    return { success: true, requested: unique.length, deleted: count };
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
