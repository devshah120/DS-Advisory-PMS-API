import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Actor, assertCanAccessClient, clientWhere } from '../../common/ownership-scope';
import { normalizeSymbol } from '../../common/market-scope';
import { HoldingsService } from '../holdings.service';
import { istDay } from '../ledger-replay';
import { BulkImportRowResult, BulkImportSummary } from '../dto/bulk-import-result.dto';
import { CommitContractNoteDto } from '../dto/commit-contract-note.dto';
import { PdfPasswordError, extractPositionedText } from './pdf-text';
import {
  ParsedContractNote,
  ParsedTrade,
  UnrecognisedStatementError,
  parseContractNote,
} from './contract-note.parser';
import { IsinResolverService } from './isin-resolver.service';

export interface ContractNotePreview extends Omit<ParsedContractNote, 'trades'> {
  trades: (ParsedTrade & { symbol: string | null })[];
  /** Set only when exactly one of the caller's Indian clients claims the code. */
  suggestedClientId: string | null;
}

/**
 * Turns a broker's contract note into ledger trades, in two steps.
 *
 * `preview` reads the PDF and resolves every ISIN to a symbol but writes
 * nothing; the user reviews the rows and picks the client. `commit` then books
 * the reviewed rows through HoldingsService.recordTrade — the same path as Add
 * Position and the Excel import — so a contract-note trade is indistinguishable
 * from one typed in by hand, apart from its reference.
 */
@Injectable()
export class ContractNoteService {
  constructor(
    private prisma: PrismaService,
    private holdings: HoldingsService,
    private isins: IsinResolverService,
  ) {}

  async preview(
    file: Buffer,
    fileName: string,
    password: string | undefined,
    actor: Actor,
  ): Promise<ContractNotePreview> {
    let note: ParsedContractNote;
    try {
      note = parseContractNote(await extractPositionedText(file, password), fileName);
    } catch (error) {
      if (error instanceof PdfPasswordError || error instanceof UnrecognisedStatementError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(`Could not read the PDF: ${(error as Error).message}`);
    }

    if (note.trades.length === 0 && note.errors.length === 0) {
      throw new BadRequestException('No trades were found in this contract note');
    }

    const symbols = await this.isins.resolve(note.trades.map((t) => t.isin));

    // The letterhead naming the client is an image, so the broker client code
    // in the file name is all there is to match on. It is only a suggestion —
    // the user confirms the client before anything is written.
    let suggestedClientId: string | null = null;
    if (note.clientCode) {
      const candidates = await this.prisma.client.findMany({
        where: { ...clientWhere(actor), market: 'INDIA' },
        select: { id: true, accountNumber: true },
      });
      const matches = candidates.filter(
        (c) => c.accountNumber.trim().toUpperCase() === note.clientCode,
      );
      if (matches.length === 1) suggestedClientId = matches[0].id;
    }

    return {
      ...note,
      trades: note.trades.map((t) => ({ ...t, symbol: symbols.get(t.isin) ?? null })),
      suggestedClientId,
    };
  }

  async commit(dto: CommitContractNoteDto, actor: Actor): Promise<BulkImportSummary> {
    const client = await this.prisma.client.findUnique({
      where: { id: dto.clientId },
      select: { id: true, ownerId: true, market: true },
    });
    assertCanAccessClient(actor, client);
    if (client!.market !== 'INDIA') {
      throw new BadRequestException(
        'Contract notes are Indian broker statements — choose a client in the India book',
      );
    }

    // Booked in trade order, so a buy and a later sell of the same stock in one
    // statement land in the order they happened. The reference carries the
    // trade time, which breaks ties within a day.
    const trades = [...dto.trades].sort(
      (a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference),
    );

    const imported = new Set(
      (
        await this.prisma.transaction.findMany({
          where: { clientId: client!.id, reference: { in: trades.map((t) => t.reference) } },
          select: { reference: true },
        })
      ).map((t) => t.reference),
    );

    // Trades already typed in by hand carry no reference, so they are matched
    // on what they do share with the statement: day, side, symbol and size.
    // The window is padded a day each side to take in IST-midnight rows.
    const days = trades.map((t) => Date.parse(`${t.date.slice(0, 10)}T00:00:00Z`));
    const manual = (
      await this.prisma.transaction.findMany({
        where: {
          clientId: client!.id,
          type: { in: ['BUY', 'SELL'] },
          date: {
            gte: new Date(Math.min(...days) - 86_400_000),
            lt: new Date(Math.max(...days) + 2 * 86_400_000),
          },
        },
        select: { ticker: true, type: true, quantity: true, date: true, reference: true },
      })
    ).filter((t) => !t.reference);

    const results: BulkImportRowResult[] = [];
    for (const t of trades) {
      const ticker = normalizeSymbol(t.symbol.trim().toUpperCase(), 'INDIA');
      const day = t.date.slice(0, 10);

      if (imported.has(t.reference)) {
        results.push({
          row: t.line,
          ticker,
          status: 'skipped',
          error: 'Already imported from this contract note',
        });
        continue;
      }

      const twin = manual.findIndex(
        (m) =>
          m.type === t.side &&
          m.ticker?.toUpperCase() === ticker &&
          Math.abs((m.quantity ?? 0) - t.quantity) < 1e-9 &&
          istDay(m.date) === day,
      );
      if (twin >= 0) {
        // Consumed, so a statement with two identical fills against one manual
        // entry still books the second.
        manual.splice(twin, 1);
        results.push({
          row: t.line,
          ticker,
          status: 'skipped',
          error: 'Already on the ledger — entered manually',
        });
        continue;
      }

      const charges = dto.includeCharges ? t.charges : 0;
      try {
        await this.holdings.recordTrade(
          {
            clientId: client!.id,
            market: 'INDIA',
            symbol: ticker,
            side: t.side,
            quantity: t.quantity,
            // Charges are a cost on both sides: they add to what a buy cost
            // and come out of what a sell realised.
            amount: t.side === 'BUY' ? t.total + charges : t.total - charges,
            date: new Date(`${day}T00:00:00.000Z`),
            reference: t.reference,
          },
          actor,
        );
        imported.add(t.reference);
        results.push({ row: t.line, ticker, status: 'imported' });
      } catch (error) {
        results.push({ row: t.line, ticker, status: 'failed', error: (error as Error).message });
      }
    }

    const count = (s: BulkImportRowResult['status']) => results.filter((r) => r.status === s).length;
    return {
      total: results.length,
      imported: count('imported'),
      failed: count('failed'),
      skipped: count('skipped'),
      results: results.sort((a, b) => a.row - b.row),
    };
  }
}
