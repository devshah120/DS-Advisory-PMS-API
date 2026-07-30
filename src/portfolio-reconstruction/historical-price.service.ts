import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarketService } from '../market/market.service';

/**
 * The single place that resolves "closing price of TICKER on or before DATE".
 *
 * Both PortfolioReconstructionService and PortfolioHistoryService need this,
 * and both need it to behave identically — a reconstruction for 30-Sept and
 * a snapshot written on 30-Sept must price every position the same way, or
 * "the user should not know whether a snapshot or a reconstruction served
 * this" (PART 7) stops being true.
 *
 * PriceBar is the durable store (same table performance.service.ts reads for
 * benchmark closes). A miss falls back to backfilling PriceBar from Yahoo via
 * MarketService, matching the existing pattern in
 * analytics/scripts/backfill-benchmark-bars.ts, rather than duplicating a
 * second fetch-and-cache path.
 */
@Injectable()
export class HistoricalPriceService {
  private readonly logger = new Logger(HistoricalPriceService.name);

  constructor(
    private prisma: PrismaService,
    private market: MarketService,
  ) {}

  /** Closing price for `ticker` on or before `date`. Null if truly no history exists. */
  async closeOn(ticker: string, date: Date): Promise<number | null> {
    const bar = await this.prisma.priceBar.findFirst({
      where: { symbol: ticker, date: { lte: date } },
      orderBy: { date: 'desc' },
    });
    if (bar) return bar.adjClose;

    await this.backfill(ticker, date);

    const retried = await this.prisma.priceBar.findFirst({
      where: { symbol: ticker, date: { lte: date } },
      orderBy: { date: 'desc' },
    });
    return retried?.adjClose ?? null;
  }

  /** Batched convenience wrapper — one query per ticker, run concurrently. */
  async closesOn(tickers: string[], date: Date): Promise<Map<string, number>> {
    const unique = [...new Set(tickers)];
    const out = new Map<string, number>();

    await Promise.all(
      unique.map(async (ticker) => {
        const close = await this.closeOn(ticker, date);
        if (close !== null) out.set(ticker, close);
      }),
    );

    return out;
  }

  private async backfill(ticker: string, date: Date): Promise<void> {
    try {
      const fromDate = new Date(date.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
      const bars = await this.market.history(ticker, fromDate);
      if (bars.length === 0) return;

      // Mongo's Prisma connector has no `skipDuplicates` on createMany, so this
      // upserts one bar at a time keyed on [symbol, date] — the same pattern
      // backfill-benchmark-bars.ts and workbook-import.service.ts already use.
      for (const b of bars) {
        const barDate = new Date(`${b.date}T00:00:00.000Z`);
        await this.prisma.priceBar.upsert({
          where: { symbol_date: { symbol: ticker, date: barDate } },
          create: { symbol: ticker, date: barDate, close: b.close, adjClose: b.close, source: 'yahoo' },
          update: { close: b.close, adjClose: b.close, source: 'yahoo' },
        });
      }
    } catch (error) {
      this.logger.warn(`Historical backfill failed for ${ticker}: ${(error as Error).message}`);
    }
  }
}
