import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { CreateHoldingDto } from './dto/create-holding.dto';
import { UpdateHoldingDto } from './dto/update-holding.dto';
import { BulkImportRowResult, BulkImportSummary } from './dto/bulk-import-result.dto';

/**
 * Columns the bulk-import parser reads, in the order they appear in the sample
 * template. The header text is what a user sees; the value is the row key.
 * Keeping this list as the single source of truth means the generated template
 * and the parser can never drift apart.
 */
const IMPORT_COLUMNS: { header: string; key: string; required: boolean }[] = [
  { header: 'clientId', key: 'clientId', required: true },
  { header: 'ticker', key: 'ticker', required: true },
  { header: 'quantity', key: 'quantity', required: true },
  { header: 'averageCost', key: 'averageCost', required: true },
  { header: 'currentPrice', key: 'currentPrice', required: false },
  { header: 'company', key: 'company', required: false },
  { header: 'sector', key: 'sector', required: false },
  { header: 'industry', key: 'industry', required: false },
  { header: 'country', key: 'country', required: false },
  { header: 'exchange', key: 'exchange', required: false },
  { header: 'theme', key: 'theme', required: false },
  { header: 'targetWeight', key: 'targetWeight', required: false },
  { header: 'notes', key: 'notes', required: false },
];

/** Reads a spreadsheet cell as a finite number, or null if it isn't one. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
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

  remove(id: string) {
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
   * Builds the sample `.xlsx` a user downloads before a bulk import. The sheet
   * carries the exact header row the parser expects plus one illustrative row,
   * so the file a user gets back is guaranteed to round-trip through
   * `bulkImport`. Returned as a Buffer for the controller to stream.
   */
  buildImportTemplate(): Buffer {
    const headers = IMPORT_COLUMNS.map((c) => c.header);
    const example: Record<string, string | number> = {
      clientId: 'REPLACE_WITH_CLIENT_ID',
      ticker: 'AAPL',
      quantity: 100,
      averageCost: 150,
      currentPrice: 175,
      company: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      country: 'United States',
      exchange: 'NASDAQ',
      theme: '',
      targetWeight: 5,
      notes: 'Optional free-text note',
    };

    const sheet = XLSX.utils.json_to_sheet([example], { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Holdings');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  /**
   * Parses an uploaded `.xlsx`/`.csv` of positions and applies each row through
   * the same `create()` path a single Add Position uses — so a repeated ticker
   * for a client folds into the existing lot at weighted-average cost, and a
   * negative quantity draws the position down, exactly like the manual flow.
   *
   * One bad row never fails the whole file: every row is reported back with its
   * spreadsheet line number and either an 'imported' or 'failed' status, so the
   * UI can show the user precisely what did and didn't land.
   *
   * Classification (company/sector/industry/…) is taken from the file when
   * present, and otherwise resolved from the ticker via the market lookup, so a
   * minimal file of just clientId/ticker/quantity/averageCost still produces
   * fully-classified holdings.
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

    const results: BulkImportRowResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      // +2: row 1 is the header, and spreadsheet rows are 1-based.
      const rowNumber = i + 2;
      const raw = rows[i];
      const ticker = toText(raw.ticker) ?? null;

      try {
        const dto = await this.rowToDto(raw);
        await this.create(dto);
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

  /** Validates and enriches a single spreadsheet row into a CreateHoldingDto. */
  private async rowToDto(raw: Record<string, unknown>): Promise<CreateHoldingDto> {
    const clientId = toText(raw.clientId);
    const ticker = toText(raw.ticker)?.toUpperCase();
    const quantity = toNumber(raw.quantity);
    const averageCost = toNumber(raw.averageCost);

    if (!clientId) throw new Error('clientId is required');
    if (!ticker) throw new Error('ticker is required');
    if (quantity === null) throw new Error('quantity is required and must be a number');
    if (averageCost === null) throw new Error('averageCost is required and must be a number');

    // Classification and a live-ish price come from the file if given, otherwise
    // from the market lookup. The lookup failing is non-fatal — we fall back to
    // averageCost for price and let create() default the blank classification.
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

    const currentPrice =
      toNumber(raw.currentPrice) ?? looked.currentPrice ?? averageCost;

    return {
      clientId,
      ticker,
      quantity,
      averageCost,
      currentPrice,
      company: toText(raw.company) ?? looked.company ?? ticker,
      sector: toText(raw.sector) ?? looked.sector,
      industry: toText(raw.industry) ?? looked.industry,
      country: toText(raw.country) ?? looked.country,
      exchange: toText(raw.exchange) ?? looked.exchange,
      theme: toText(raw.theme) ?? looked.theme,
      targetWeight: toNumber(raw.targetWeight) ?? undefined,
      notes: toText(raw.notes),
    };
  }
}
