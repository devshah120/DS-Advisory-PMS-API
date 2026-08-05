import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportsService } from './reports.service';

/** UTC midnight for `d` — quarter boundaries are day-granular, matching periods.ts. */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Is `date` the first day of a calendar quarter? */
function isFirstDayOfQuarter(date: Date): boolean {
  const d = utcDay(date);
  return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
}

/**
 * Freezes the just-ended quarter's fees into ClientFeeSchedule.
 *
 * Deliberately runs on the FIRST day of the new quarter rather than alongside
 * SnapshotScheduler's last-trading-day run. Two reasons:
 *
 *  1. A fee is charged on the quarter-end NAV, and that snapshot is written by
 *     SnapshotScheduler at 22:00 UTC on the last trading day. Reading it from a
 *     job on the same day is a race; reading it the next quarter is not.
 *  2. The last TRADING day is not the last CALENDAR day — Q3 can close on 30
 *     Sep while the last trading day was the 28th. Proration counts calendar
 *     days, so the quarter is only truly over once the calendar says so.
 *
 * This lives in ReportsModule rather than in SnapshotScheduler because Reports
 * already depends on PortfolioReconstruction; putting it the other way round
 * would make the two modules circular.
 */
@Injectable()
export class FeeCloseScheduler {
  private readonly logger = new Logger(FeeCloseScheduler.name);

  constructor(private reports: ReportsService) {}

  /** Runs daily at 02:00 UTC; only acts on the first day of a quarter. */
  @Cron('0 0 2 * * *')
  async quarterCloseCheck(): Promise<void> {
    const today = new Date();
    if (!isFirstDayOfQuarter(today)) return;

    // One day back lands in the quarter that just ended.
    const justClosed = new Date(today.getTime() - 86_400_000);

    try {
      await this.reports.closeQuarter(justClosed);
    } catch (error) {
      this.logger.error(`Fee close failed: ${(error as Error).message}`);
    }
  }
}
