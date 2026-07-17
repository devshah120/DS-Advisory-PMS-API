import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface ClientFeeRow {
  clientId: string;
  clientName: string;
  feeRatePercent: number;
  portfolioValue: number;
  quarterLabel: string;
  quarterStart: string;
  quarterEnd: string;
  daysBilled: number;
  daysInQuarter: number;
  /** True once the quarter has actually closed; false means portfolioValue is today's live value, not a locked quarter-end figure. */
  isEstimate: boolean;
  feeAmount: number;
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  /**
   * One row per active client for the CURRENT calendar quarter, prorated
   * from the later of (quarter start, client inception) to today.
   *
   * There is no historical portfolio-value time series in this system (see
   * PortfolioValuation in schema.prisma — defined but never populated), so a
   * closed prior quarter's fee can't be reconstructed. Only the in-progress
   * quarter can be shown, using today's live portfolio value as a running
   * estimate of the eventual quarter-end figure.
   */
  async currentQuarterFees(): Promise<ClientFeeRow[]> {
    const clients = await this.prisma.client.findMany({
      include: { holdings: true },
    });

    const today = new Date();
    const { start, end, label } = currentQuarter(today);
    const daysInQuarter = diffDays(start, end) + 1;

    return clients.map((client) => {
      const portfolioValue = client.holdings.reduce((sum, h) => sum + h.marketValue, 0);

      const billingStart = client.inceptionDate > start ? client.inceptionDate : start;
      const daysBilled = Math.max(0, diffDays(billingStart, today) + 1);
      const proration = Math.min(daysBilled, daysInQuarter) / daysInQuarter;

      const feeAmount = portfolioValue * (client.feeRatePercent / 100 / 4) * proration;

      return {
        clientId: client.id,
        clientName: client.name,
        feeRatePercent: client.feeRatePercent,
        portfolioValue,
        quarterLabel: label,
        quarterStart: toIsoDate(start),
        quarterEnd: toIsoDate(end),
        daysBilled: Math.min(daysBilled, daysInQuarter),
        daysInQuarter,
        isEstimate: true, // the quarter hasn't closed yet — always true today
        feeAmount,
      };
    });
  }
}

function currentQuarter(today: Date): { start: Date; end: Date; label: string } {
  const y = today.getUTCFullYear();
  const q = Math.floor(today.getUTCMonth() / 3); // 0-3
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 0)); // day 0 of next month = last day of this quarter
  return { start, end, label: `Q${q + 1} ${y}` };
}

function diffDays(from: Date, to: Date): number {
  const MS_PER_DAY = 86400000;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
