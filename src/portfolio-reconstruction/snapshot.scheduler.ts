import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from './portfolio-history.service';

/** UTC midnight for `d` — snapshots key on the trading DAY, matching PriceBar/PortfolioValuation. */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Quarter-end calendar dates (31 Mar / 30 Jun / 30 Sep / 31 Dec), walked back
 * to the nearest weekday. A real trading-holiday calendar is out of scope —
 * this is a documented simplification, not a full market-calendar engine.
 */
function isLastTradingDayOfQuarter(date: Date): boolean {
  const y = date.getUTCFullYear();
  const quarterEndDates = [
    new Date(Date.UTC(y, 2, 31)),
    new Date(Date.UTC(y, 5, 30)),
    new Date(Date.UTC(y, 8, 30)),
    new Date(Date.UTC(y, 11, 31)),
  ];

  for (const qEnd of quarterEndDates) {
    const tradingDay = new Date(qEnd);
    // Walk back over Sat(6)/Sun(0).
    while (tradingDay.getUTCDay() === 0 || tradingDay.getUTCDay() === 6) {
      tradingDay.setUTCDate(tradingDay.getUTCDate() - 1);
    }
    if (utcDay(tradingDay).getTime() === utcDay(date).getTime()) return true;
  }
  return false;
}

/**
 * Triggers PortfolioHistoryService.writeSnapshot for every active client:
 * once daily after market close, and again (flagged isQuarterEnd) on the
 * last trading day of each calendar quarter.
 *
 * This class does no computation of its own — it only decides WHEN to call
 * writeSnapshot and for WHOM, matching the "scheduler triggers, doesn't
 * compute" split from the architecture note (PART 10). No Excel/PDF
 * generation is triggered from here: this pass stores historical data only,
 * export is a separate, later concern.
 */
@Injectable()
export class SnapshotScheduler {
  private readonly logger = new Logger(SnapshotScheduler.name);

  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
  ) {}

  /** Weekdays, after US market close (21:30 UTC ≈ 4:30pm ET plus buffer). */
  @Cron('0 30 21 * * 1-5')
  async dailySnapshot(): Promise<void> {
    await this.runForAllClients(new Date(), { isQuarterEnd: false });
  }

  /** Runs daily; only acts on the last trading day of a quarter. */
  @Cron('0 0 22 * * *')
  async quarterEndCheck(): Promise<void> {
    const today = new Date();
    if (!isLastTradingDayOfQuarter(today)) return;
    await this.runForAllClients(today, { isQuarterEnd: true });
  }

  private async runForAllClients(date: Date, opts: { isQuarterEnd: boolean }): Promise<void> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
    });

    this.logger.log(
      `Snapshot run starting: date=${utcDay(date).toISOString().slice(0, 10)} ` +
        `clients=${clients.length} quarterEnd=${opts.isQuarterEnd}`,
    );

    for (const client of clients) {
      try {
        await this.history.writeSnapshot(client.id, date, opts);
      } catch (error) {
        // One client's failure (e.g. no baseline yet) must not block the rest.
        this.logger.warn(
          `Snapshot failed for client ${client.name} (${client.id}): ${(error as Error).message}`,
        );
      }
    }
  }
}
