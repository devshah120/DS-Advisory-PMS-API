import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import { BulkImportRowResult, BulkImportSummary } from './dto/bulk-import-result.dto';

/**
 * The bulk-import sheet, in the order the columns appear in the sample workbook.
 *
 * This is deliberately the trade blotter a manager already keeps — what was
 * done, when, for whom, in what size — and nothing else. Every other field a
 * holding needs (company, sector, industry, country, exchange, theme, live
 * price) is resolved from the ticker at import time, exactly as the Add
 * Position screen auto-fills them from the same market lookup.
 *
 * Keeping this list as the single source of truth means the generated sample
 * and the parser can never drift apart.
 */
const IMPORT_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'Action', key: 'action', width: 10 },
  { header: 'Date', key: 'date', width: 14 },
  { header: 'Client Name', key: 'clientName', width: 22 },
  { header: 'Symbol', key: 'symbol', width: 12 },
  { header: 'Quantity', key: 'quantity', width: 12 },
  { header: 'Amount Invested', key: 'amountInvested', width: 18 },
];

/**
 * Accepted spellings for each column, normalised to lowercase alphanumerics.
 * A manager's own blotter says "Scrip" or "Trade Date" as readily as "Symbol"
 * or "Date", and rejecting the file over a synonym would be needless friction.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  action: ['action', 'type', 'side', 'transactiontype', 'buysell'],
  date: ['date', 'transactiondate', 'tradedate', 'dateoftransaction'],
  clientName: ['clientname', 'client', 'name', 'clientaccount', 'account'],
  symbol: ['symbol', 'ticker', 'scrip', 'stock', 'security'],
  quantity: ['quantity', 'qty', 'shares', 'units'],
  amountInvested: [
    'amountinvested',
    'amount',
    'investedamount',
    'value',
    'consideration',
    'netamount',
    'totalamount',
  ],
};

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Maps a raw sheet row onto our canonical keys via COLUMN_ALIASES, so the rest
 * of the parser never has to care what the user titled their columns.
 */
function canonicalise(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawHeader, value] of Object.entries(raw)) {
    const norm = normaliseHeader(rawHeader);
    const key = Object.keys(COLUMN_ALIASES).find((k) =>
      COLUMN_ALIASES[k].includes(norm),
    );
    // First match wins: a sheet with both "Amount" and "Amount Invested"
    // shouldn't have the blank one overwrite the populated one.
    if (key && out[key] === undefined) out[key] = value;
  }
  return out;
}

/** Reads a spreadsheet cell as a finite number, or null if it isn't one. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  // Currency symbols, thousands separators and a trailing minus or bracketed
  // negative are all things a real blotter contains.
  const cleaned = String(value)
    .replace(/[,\s$₹€£]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .trim();
  const n = typeof value === 'number' ? value : Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/**
 * Reads the Action column as a trade direction.
 *
 * Only buys and sells are positions; anything else in a blotter (dividends,
 * cash movements) belongs on the Transactions screen, so it is rejected here
 * rather than being silently coerced into a trade.
 */
function toSide(value: unknown): 'BUY' | 'SELL' {
  const s = toText(value)?.toUpperCase();
  if (!s) throw new Error('Action is required (Buy or Sell)');
  if (['BUY', 'B', 'PURCHASE', 'BOUGHT'].includes(s)) return 'BUY';
  if (['SELL', 'S', 'SALE', 'SOLD'].includes(s)) return 'SELL';
  throw new Error(`Action must be Buy or Sell, got "${s}"`);
}

/**
 * Reads the Date column into a Date.
 *
 * Excel hands back a serial number for a real date cell and a string for a
 * text-formatted one. The string case is read day-first (20-07-2026 is the
 * 20th of July), because that is how the sample is written and how the
 * managers using it write dates; month-first parsing would silently mis-date
 * every trade before the 13th of a month.
 */
function toDate(value: unknown): Date {
  if (value === null || value === undefined || value === '') {
    throw new Error('Date is required');
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Date is not a valid date');
    return value;
  }

  // Excel serial: days since 1899-12-30, read as UTC midnight.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) throw new Error(`Could not read "${value}" as a date`);
    return d;
  }

  const s = String(value).trim();

  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    // Rejects 31-02-2026 rather than letting JS roll it into March.
    if (d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd) {
      throw new Error(`"${s}" is not a real calendar date`);
    }
    return d;
  }

  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const [, yyyy, mm, dd] = ymd;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    if (d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd) {
      throw new Error(`"${s}" is not a real calendar date`);
    }
    return d;
  }

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not read "${s}" as a date — use DD-MM-YYYY`);
  }
  return parsed;
}

/** Derived position figures. Cost basis is always averageCost * quantity. */
function derive(quantity: number, averageCost: number, currentPrice: number) {
  const marketValue = quantity * currentPrice;
  const costBasis = quantity * averageCost;
  return { marketValue, unrealizedPnL: marketValue - costBasis };
}

@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  /**
   * Overlays each holding's stored `currentPrice`/`marketValue`/`unrealizedPnL`
   * with a live quote. The DB row stays untouched (it's the cost-basis ledger,
   * not a price cache) — this only affects what a read returns. One ticker
   * lookup per distinct symbol, shared across every client holding it, and a
   * failed quote just falls back to the last stored price rather than failing
   * the whole list.
   */
  private async withLivePrices<T extends { ticker: string; quantity: number; averageCost: number; currentPrice: number }>(
    holdings: T[],
  ): Promise<T[]> {
    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    const quotes = new Map<string, number>();

    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const { currentPrice } = await this.market.lookup(ticker);
          if (typeof currentPrice === 'number') quotes.set(ticker, currentPrice);
        } catch (error) {
          this.logger.warn(`Live price lookup failed for ${ticker}: ${(error as Error).message}`);
        }
      }),
    );

    return holdings.map((h) => {
      const livePrice = quotes.get(h.ticker);
      if (livePrice == null) return h;
      return {
        ...h,
        currentPrice: livePrice,
        ...derive(h.quantity, h.averageCost, livePrice),
      };
    });
  }

  /**
   * Records a buy or a sell against a client's position in a ticker.
   *
   * A negative quantity is a sell. Buys fold into the existing lot at the
   * weighted-average cost across both the old and new amounts invested; sells
   * only draw the position down, leaving averageCost untouched, so realised
   * gains never distort the basis of the remaining shares.
   */
  async create(createHoldingDto: CreateHoldingDto) {
    const { clientId, marketValue: _ignored, ...data } = createHoldingDto;
    const { ticker, quantity, averageCost, currentPrice } = data;

    if (quantity === 0) {
      throw new BadRequestException('Quantity must be non-zero');
    }

    const existing = await this.prisma.holding.findUnique({
      where: { clientId_ticker: { clientId, ticker } },
    });

    const classified = {
      ...data,
      // Yahoo leaves these blank for ETFs and indices, but the schema (and the
      // sector-exposure grouping) expect a value.
      sector: data.sector?.trim() || 'Unclassified',
      industry: data.industry?.trim() || 'Unclassified',
      country: data.country?.trim() || 'Unknown',
      exchange: data.exchange?.trim() || 'Unknown',
    };

    if (!existing) {
      if (quantity < 0) {
        throw new BadRequestException(`No open position in ${ticker} to sell`);
      }
      return this.prisma.holding.create({
        data: {
          ...classified,
          ...derive(quantity, averageCost, currentPrice),
          client: { connect: { id: clientId } },
        },
      });
    }

    const newQuantity = existing.quantity + quantity;
    if (newQuantity < 0) {
      throw new BadRequestException(
        `Cannot sell ${Math.abs(quantity)} shares of ${ticker}; only ${existing.quantity} held`,
      );
    }

    let newAverageCost = existing.averageCost;
    let realizedPnL = existing.realizedPnL;

    if (quantity > 0) {
      // Weighted average across the existing and incoming amounts invested.
      const totalInvested = existing.averageCost * existing.quantity + averageCost * quantity;
      newAverageCost = totalInvested / newQuantity;
    } else {
      // Sold shares realise (sale price - basis) and leave averageCost alone.
      realizedPnL += (currentPrice - existing.averageCost) * Math.abs(quantity);
    }

    // Closing the position out entirely resets the basis rather than leaving a stale one.
    if (newQuantity === 0) newAverageCost = 0;

    return this.prisma.holding.update({
      where: { id: existing.id },
      data: {
        ...classified,
        quantity: newQuantity,
        averageCost: newAverageCost,
        currentPrice,
        realizedPnL,
        ...derive(newQuantity, newAverageCost, currentPrice),
      },
    });
  }

  async findAll() {
    const holdings = await this.prisma.holding.findMany({
      include: {
        client: true,
      },
    });
    return this.withLivePrices(holdings);
  }

  async findByClient(clientId: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { clientId },
    });
    return this.withLivePrices(holdings);
  }

  findOne(id: string) {
    return this.prisma.holding.findUnique({
      where: { id },
    });
  }

  /** Recomputes marketValue and unrealizedPnL whenever an input to them changes. */
  async update(id: string, updateHoldingDto: UpdateHoldingDto) {
    const existing = await this.prisma.holding.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException(`No holding with id ${id}`);

    const { marketValue: _ignored, ...data } = updateHoldingDto as UpdateHoldingDto & {
      marketValue?: number;
    };

    const quantity = data.quantity ?? existing.quantity;
    const averageCost = data.averageCost ?? existing.averageCost;
    const currentPrice = data.currentPrice ?? existing.currentPrice;

    return this.prisma.holding.update({
      where: { id },
      data: { ...data, ...derive(quantity, averageCost, currentPrice) },
    });
  }

  /**
   * Deletes a position. Transactions recorded against the ticker are left
   * alone — they are the record of what actually happened, and the schema
   * hangs both off the client rather than off each other.
   */
  async remove(id: string) {
    const existing = await this.prisma.holding.findUnique({ where: { id } });
    // Two people deleting the same row shouldn't surface a raw Prisma error.
    if (!existing) throw new BadRequestException(`No holding with id ${id}`);

    return this.prisma.holding.delete({
      where: { id },
    });
  }

  async getByTicker(ticker: string) {
    const holdings = await this.prisma.holding.findMany({
      where: { ticker },
      include: {
        client: true,
      },
    });
    return this.withLivePrices(holdings);
  }

  async getSectorExposure(clientId: string) {
    const stored = await this.prisma.holding.findMany({
      where: { clientId },
    });
    const holdings = await this.withLivePrices(stored);

    const sectors = holdings.reduce((acc: Record<string, { value: number; holdings: number }>, h: any) => {
      if (!acc[h.sector]) {
        acc[h.sector] = { value: 0, holdings: 0 };
      }
      acc[h.sector].value += h.marketValue;
      acc[h.sector].holdings += 1;
      return acc;
    }, {} as Record<string, { value: number; holdings: number }>);

    return sectors;
  }

  /**
   * Builds the sample `.xlsx` a user downloads before a bulk import.
   *
   * The sheet carries the exact header row the parser expects plus two
   * illustrative trades, so the file a user gets back is guaranteed to
   * round-trip through `bulkImport`. Dates are written as text rather than as
   * Excel date cells so the file reads the same way it looks (DD-MM-YYYY)
   * regardless of the opener's locale.
   *
   * A second sheet documents what each column means and, more importantly,
   * what the importer fills in on the user's behalf. Returned as a Buffer for
   * the controller to stream.
   */
  buildImportTemplate(): Buffer {
    const headers = IMPORT_COLUMNS.map((c) => c.header);
    const examples = [
      {
        Action: 'Buy',
        Date: '20-07-2026',
        'Client Name': 'Mrugesh Patel',
        Symbol: 'HWM',
        Quantity: 28.38,
        'Amount Invested': 2352.47,
      },
      {
        Action: 'Buy',
        Date: '20-07-2026',
        'Client Name': 'Mrugesh Patel',
        Symbol: 'WDC',
        Quantity: 15.7,
        'Amount Invested': 923.24,
      },
    ];

    const sheet = XLSX.utils.json_to_sheet(examples, { header: headers });
    sheet['!cols'] = IMPORT_COLUMNS.map((c) => ({ wch: c.width }));

    const notes = [
      ['Column', 'Required', 'What to enter'],
      ['Action', 'Yes', 'Buy or Sell'],
      ['Date', 'Yes', 'Date the trade happened, DD-MM-YYYY (e.g. 20-07-2026)'],
      ['Client Name', 'Yes', 'Must match a client already on the Clients page, exactly'],
      ['Symbol', 'Yes', 'Ticker as listed, e.g. HWM, WDC, AAPL'],
      ['Quantity', 'Yes', 'Number of shares. Always positive — a Sell is set by the Action column'],
      ['Amount Invested', 'Yes', 'Total consideration for the trade. Sells: the proceeds received'],
      [],
      ['Filled in for you', '', 'Resolved from the Symbol — do not add these columns'],
      ['Company', '', 'Company name'],
      ['Sector / Industry', '', 'Classification'],
      ['Country / Exchange', '', 'Listing details'],
      ['Theme', '', 'Where the instrument maps to one'],
      ['Average Cost', '', 'Amount Invested ÷ Quantity'],
      ['Current Price', '', 'Live market price'],
      [],
      ['Notes', '', ''],
      ['', '', 'Repeat buys in the same symbol fold into the existing position at weighted-average cost.'],
      ['', '', 'Each row also records a dated Buy/Sell transaction, so performance and XIRR pick it up.'],
      ['', '', 'A bad row never stops the file — every row is reported back with its result.'],
    ];
    const notesSheet = XLSX.utils.aoa_to_sheet(notes);
    notesSheet['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 78 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Transactions');
    XLSX.utils.book_append_sheet(wb, notesSheet, 'Instructions');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  /**
   * Parses an uploaded trade blotter (`.xlsx`/`.csv`) and applies each row the
   * way the manual flow does, from six business columns: what was done, when,
   * for whom, in what symbol and size, for how much money.
   *
   * Everything else is filled in on the user's behalf — the client is resolved
   * by name, and company/sector/industry/country/exchange/theme plus the live
   * price all come from the same market lookup the Add Position screen uses.
   * Average cost is derived as Amount Invested ÷ Quantity, mirroring the
   * read-only Avg. Cost field on that form.
   *
   * Each row does two things, in this order:
   *   1. Updates the position through `create()` — so a repeat buy folds into
   *      the existing lot at weighted-average cost and a sell draws it down.
   *   2. Records a dated BUY/SELL Transaction, so the trade reaches the
   *      performance and XIRR engines, which read the ledger by date.
   *
   * If the ledger write fails the position update is rolled back, so the two
   * can never disagree about what was imported.
   *
   * One bad row never fails the whole file: every row is reported back with its
   * spreadsheet line number and either an 'imported' or 'failed' status, so the
   * UI can show the user precisely what did and didn't land.
   */
  async bulkImport(fileBuffer: Buffer): Promise<BulkImportSummary> {
    let rows: Record<string, unknown>[];
    try {
      const wb = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('The workbook has no sheets');
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], {
        defval: null,
      });
    } catch (error) {
      throw new BadRequestException(
        `Could not read the uploaded file: ${(error as Error).message}`,
      );
    }

    if (rows.length === 0) {
      throw new BadRequestException('The file has no data rows below the header');
    }

    // Resolved once for the whole file rather than per row: a blotter is mostly
    // the same few names repeated, and this is the only DB read the row loop
    // would otherwise make before doing any work.
    const clientsByName = await this.clientNameIndex();

    const results: BulkImportRowResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      // +2: row 1 is the header, and spreadsheet rows are 1-based.
      const rowNumber = i + 2;
      const raw = canonicalise(rows[i]);
      const ticker = toText(raw.symbol)?.toUpperCase() ?? null;

      try {
        await this.importRow(raw, clientsByName);
        results.push({ row: rowNumber, ticker, status: 'imported' });
      } catch (error) {
        results.push({
          row: rowNumber,
          ticker,
          status: 'failed',
          error: (error as Error).message,
        });
      }
    }

    const imported = results.filter((r) => r.status === 'imported').length;
    return {
      total: results.length,
      imported,
      failed: results.length - imported,
      results,
    };
  }

  /**
   * Client ids keyed by lowercased name. A name owned by more than one client
   * maps to null, which the row loop reports as an ambiguity rather than
   * guessing which account a trade belongs to.
   */
  private async clientNameIndex(): Promise<Map<string, string | null>> {
    const clients = await this.prisma.client.findMany({
      select: { id: true, name: true },
    });

    const index = new Map<string, string | null>();
    for (const c of clients) {
      const key = c.name.trim().toLowerCase();
      index.set(key, index.has(key) ? null : c.id);
    }
    return index;
  }

  /**
   * Validates one blotter row, applies it to the position, and records the
   * matching dated transaction. Throws with a message aimed at the person who
   * wrote the spreadsheet — it is shown against their row in the UI.
   */
  private async importRow(
    raw: Record<string, unknown>,
    clientsByName: Map<string, string | null>,
  ): Promise<void> {
    const side = toSide(raw.action);
    const date = toDate(raw.date);
    const clientName = toText(raw.clientName);
    const ticker = toText(raw.symbol)?.toUpperCase();
    const quantity = toNumber(raw.quantity);
    const amountInvested = toNumber(raw.amountInvested);

    if (!clientName) throw new Error('Client Name is required');
    if (!ticker) throw new Error('Symbol is required');
    if (quantity === null) throw new Error('Quantity is required and must be a number');
    if (quantity <= 0) {
      throw new Error('Quantity must be greater than zero — use the Action column for a sell');
    }
    if (amountInvested === null) {
      throw new Error('Amount Invested is required and must be a number');
    }
    if (amountInvested <= 0) throw new Error('Amount Invested must be greater than zero');

    const clientId = clientsByName.get(clientName.toLowerCase());
    if (clientId === undefined) {
      throw new Error(`No client named "${clientName}"`);
    }
    if (clientId === null) {
      throw new Error(`More than one client is named "${clientName}"`);
    }

    // The price the trade actually happened at. For a sell this is what
    // realises the P&L in create(), which is why the file's proceeds are used
    // rather than today's quote — a back-dated sale did not happen at today's
    // price.
    const tradePrice = amountInvested / quantity;

    // Classification comes from the ticker, as it does on the Add Position
    // screen. A failed lookup is non-fatal: the trade is still real, so we
    // fall back to the trade price and let create() default the blanks.
    let looked: Partial<{
      company: string;
      sector: string;
      industry: string;
      country: string;
      exchange: string;
      theme: string;
      currentPrice: number;
    }> = {};
    try {
      looked = await this.market.lookup(ticker);
    } catch (error) {
      this.logger.warn(`Import lookup failed for ${ticker}: ${(error as Error).message}`);
    }

    const dto: CreateHoldingDto = {
      clientId,
      ticker,
      // create() reads a negative quantity as a sell.
      quantity: side === 'SELL' ? -quantity : quantity,
      averageCost: tradePrice,
      // A sell realises against the price it was sold at; a buy marks to market.
      currentPrice: side === 'SELL' ? tradePrice : looked.currentPrice ?? tradePrice,
      company: looked.company ?? ticker,
      sector: looked.sector,
      industry: looked.industry,
      country: looked.country,
      exchange: looked.exchange,
      theme: looked.theme,
    };

    const before = await this.prisma.holding.findUnique({
      where: { clientId_ticker: { clientId, ticker } },
    });

    const holding = await this.create(dto);

    // The position and the ledger have to agree. Prisma's Mongo connector has
    // no transaction to lean on here, so an unwritable ledger row undoes the
    // position change by hand rather than leaving the two out of step.
    try {
      await this.prisma.transaction.create({
        data: {
          clientId,
          ticker,
          type: side,
          quantity,
          price: tradePrice,
          amount: amountInvested,
          date,
          description: `Bulk import — ${side === 'SELL' ? 'sell' : 'buy'} ${quantity} ${ticker}`,
        },
      });
    } catch (error) {
      if (before) {
        await this.prisma.holding.update({ where: { id: before.id }, data: before });
      } else {
        await this.prisma.holding.delete({ where: { id: holding.id } });
      }
      throw new Error(
        `Position not imported — could not record the transaction: ${(error as Error).message}`,
      );
    }
  }
}
