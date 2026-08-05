import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { INCEPTION_DATE } from '../analytics/calculators/flows';

export interface ClientFeeRow {
  clientId: string;
  clientName: string;
  feeRatePercent: number;
  portfolioValue: number;
  /** Canonical quarter code, e.g. "Q3-CY26". Matches periods.ts's vocabulary. */
  quarter: string;
  quarterLabel: string;
  quarterStart: string;
  quarterEnd: string;
  daysBilled: number;
  daysInQuarter: number;
  /**
   * True when this row was computed live for a quarter that has not closed —
   * portfolioValue is today's moving value, not a locked quarter-end figure.
   * False means it was read from a frozen ClientFeeSchedule row: the amount
   * that was actually billed.
   */
  isEstimate: boolean;
  feeAmount: number;
  /** 'snapshot' | 'reconstruction' | 'live' — where portfolioValue came from. */
  valuationSource: string;
}

/** One entry in the quarter dropdown. */
export interface FeeQuarterOption {
  code: string;
  label: string;
  /** False while the quarter is still in progress — the UI marks it an estimate. */
  closed: boolean;
}

const QUARTER_CODE = /^Q([1-4])-CY(\d{2})$/;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
  ) {}

  /**
   * The quarter dropdown's vocabulary: every quarter from the one containing
   * inception through the one containing today, newest first.
   *
   * Generated from the calendar rather than from what happens to be stored, so
   * a quarter that closed while the scheduler was down still appears and can
   * still be exported (it resolves through the reconstruction fallback below).
   */
  availableQuarters(asOf: Date = new Date()): FeeQuarterOption[] {
    const quarters: FeeQuarterOption[] = [];

    const startYear = INCEPTION_DATE.getUTCFullYear();
    const startQ = Math.floor(INCEPTION_DATE.getUTCMonth() / 3) + 1;
    const endYear = asOf.getUTCFullYear();
    const endQ = Math.floor(asOf.getUTCMonth() / 3) + 1;

    for (let y = startYear; y <= endYear; y++) {
      const first = y === startYear ? startQ : 1;
      const last = y === endYear ? endQ : 4;
      for (let q = first; q <= last; q++) {
        const cy = String(y).slice(-2);
        const { end } = quarterRange(q, y);
        quarters.push({
          code: `Q${q}-CY${cy}`,
          label: `Q${q} CY${cy}`,
          closed: utcDay(asOf) > end,
        });
      }
    }

    // Newest first — the quarter someone wants is almost always a recent one.
    return quarters.reverse();
  }

  /**
   * Fee rows for one quarter. `quarter` omitted means the current one.
   *
   * Three cases, in priority order:
   *   1. A frozen ClientFeeSchedule row exists  → return it verbatim. This is
   *      the whole point of storing: a closed quarter re-read months later
   *      must report what was billed, not what today's rate would produce.
   *   2. The quarter has closed but was never frozen (scheduler was down, or
   *      the quarter predates this feature) → compute it from the quarter-end
   *      snapshot and freeze it now, so the first read locks it in.
   *   3. The quarter is still open → compute live and store nothing.
   */
  async feesForQuarter(quarter?: string): Promise<ClientFeeRow[]> {
    const today = new Date();
    const code = quarter ?? currentQuarterCode(today);
    const { start, end, label } = parseQuarterCode(code);

    const isClosed = utcDay(today) > end;

    const clients = await this.prisma.client.findMany({
      where: { status: 'ACTIVE' },
      include: { holdings: true },
      orderBy: { name: 'asc' },
    });

    const stored = await this.prisma.clientFeeSchedule.findMany({
      where: { quarter: code },
    });
    const storedByClient = new Map(stored.map((row) => [row.clientId, row]));

    const rows: ClientFeeRow[] = [];

    for (const client of clients) {
      const frozen = storedByClient.get(client.id);
      if (frozen) {
        rows.push(fromStoredRow(frozen, client.name));
        continue;
      }

      // A client whose mandate began after the quarter ended was never
      // billable for it — omit rather than emit a zero, which reads as
      // "we billed them nothing" instead of "they weren't a client yet".
      if (utcDay(client.inceptionDate) > end) continue;

      const computed = await this.computeFee(
        { id: client.id, name: client.name, feeRatePercent: client.feeRatePercent, inceptionDate: client.inceptionDate },
        { code, label, start, end },
        { isClosed, liveValue: client.holdings.reduce((sum, h) => sum + h.marketValue, 0), asOf: today },
      );

      if (isClosed) {
        await this.freeze(computed);
      }
      rows.push(computed);
    }

    return rows;
  }

  /**
   * Builds one client's fee for one quarter.
   *
   * For a CLOSED quarter the value is the quarter-end NAV, per the billing
   * basis stated on the Client model. It is read from the quarter-end
   * PortfolioValuation snapshot; if the scheduler never wrote one for that
   * date, PortfolioHistoryService.getPortfolioAsOf replays it from the
   * baseline instead, so a missed snapshot degrades the audit trail
   * (valuationSource says so) but never blocks the export.
   *
   * For an OPEN quarter there is no quarter-end value to read, so today's live
   * holdings total stands in as a running estimate.
   */
  private async computeFee(
    client: { id: string; name: string; feeRatePercent: number; inceptionDate: Date },
    quarter: { code: string; label: string; start: Date; end: Date },
    ctx: { isClosed: boolean; liveValue: number; asOf: Date },
  ): Promise<ClientFeeRow> {
    let portfolioValue = ctx.liveValue;
    let valuationSource = 'live';

    if (ctx.isClosed) {
      const resolved = await this.quarterEndValue(client.id, quarter.end);
      portfolioValue = resolved.value;
      valuationSource = resolved.source;
    }

    const daysInQuarter = diffDays(quarter.start, quarter.end) + 1;

    // Bill from the later of (quarter start, inception): a mandate that began
    // mid-quarter owes only the days it actually existed for. A closed quarter
    // runs to quarter end; an open one runs to today.
    const billingStart =
      utcDay(client.inceptionDate) > quarter.start ? utcDay(client.inceptionDate) : quarter.start;
    const billingEnd = ctx.isClosed ? quarter.end : utcDay(ctx.asOf);

    const daysBilled = Math.min(Math.max(0, diffDays(billingStart, billingEnd) + 1), daysInQuarter);
    const proration = daysBilled / daysInQuarter;

    return {
      clientId: client.id,
      clientName: client.name,
      feeRatePercent: client.feeRatePercent,
      portfolioValue,
      quarter: quarter.code,
      quarterLabel: quarter.label,
      quarterStart: toIsoDate(quarter.start),
      quarterEnd: toIsoDate(quarter.end),
      daysBilled,
      daysInQuarter,
      isEstimate: !ctx.isClosed,
      feeAmount: portfolioValue * (client.feeRatePercent / 100 / 4) * proration,
      valuationSource,
    };
  }

  /**
   * The quarter-end NAV, preferring the stored snapshot and falling back to a
   * replay. Returns 0 (source 'unavailable') rather than throwing when the
   * client has no baseline to replay from — one unbillable client must not
   * fail the whole firm's fee run.
   */
  private async quarterEndValue(
    clientId: string,
    quarterEnd: Date,
  ): Promise<{ value: number; source: string }> {
    const snapshot = await this.history.getSnapshot(clientId, quarterEnd);
    if (snapshot) {
      return { value: snapshot.totalValue, source: 'snapshot' };
    }

    try {
      const replayed = await this.history.getPortfolioAsOf(clientId, quarterEnd);
      return { value: replayed.portfolioValue, source: 'reconstruction' };
    } catch (error) {
      this.logger.warn(
        `No quarter-end value for client=${clientId} at ${toIsoDate(quarterEnd)}: ` +
          `${(error as Error).message}`,
      );
      return { value: 0, source: 'unavailable' };
    }
  }

  /**
   * Freeze one computed row. Idempotent by the [clientId, quarter] unique
   * index: `create`-on-conflict-ignore rather than `upsert`, because a fee row
   * that already exists must NEVER be overwritten — that is the invariant the
   * whole model exists to protect.
   */
  private async freeze(row: ClientFeeRow): Promise<void> {
    if (row.valuationSource === 'unavailable') return; // don't freeze a value we couldn't establish

    try {
      await this.prisma.clientFeeSchedule.create({
        data: {
          clientId: row.clientId,
          quarter: row.quarter,
          quarterLabel: row.quarterLabel,
          quarterStart: new Date(`${row.quarterStart}T00:00:00.000Z`),
          quarterEnd: new Date(`${row.quarterEnd}T00:00:00.000Z`),
          feeRatePercent: row.feeRatePercent,
          portfolioValue: row.portfolioValue,
          daysBilled: row.daysBilled,
          daysInQuarter: row.daysInQuarter,
          feeAmount: row.feeAmount,
          valuationSource: row.valuationSource,
        },
      });
      this.logger.log(
        `Fee frozen: client=${row.clientId} quarter=${row.quarter} ` +
          `amount=${row.feeAmount.toFixed(2)} source=${row.valuationSource}`,
      );
    } catch (error) {
      // A concurrent request that froze the same row first is the expected
      // race here, not a failure — the row exists either way.
      this.logger.debug(
        `Fee row for client=${row.clientId} quarter=${row.quarter} already frozen: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * Freeze every active client's fee for the quarter that just closed. Called
   * by the quarter-end scheduler after snapshots are written, so the
   * quarter-end NAV each fee reads is already in place.
   */
  async closeQuarter(asOf: Date = new Date()): Promise<void> {
    const code = quarterCodeFor(asOf);
    this.logger.log(`Closing fee quarter ${code}`);
    await this.feesForQuarter(code);
  }

  /** Back-compat with the original single-purpose endpoint. */
  async currentQuarterFees(): Promise<ClientFeeRow[]> {
    return this.feesForQuarter();
  }

  /** One client, one quarter — what the per-client export downloads. */
  async clientFee(clientId: string, quarter?: string): Promise<ClientFeeRow> {
    const rows = await this.feesForQuarter(quarter);
    const row = rows.find((r) => r.clientId === clientId);
    if (!row) {
      throw new NotFoundException(
        `No fee schedule for client ${clientId} in ${quarter ?? 'the current quarter'} — ` +
          `the client may be inactive, or its mandate may have begun after that quarter ended.`,
      );
    }
    return row;
  }
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Quarter q (1-4) of a year → [start, end] in UTC, end = last day of the quarter. */
function quarterRange(q: number, year: number): { start: Date; end: Date } {
  const startMonth = (q - 1) * 3;
  return {
    start: new Date(Date.UTC(year, startMonth, 1)),
    // Day 0 of the month AFTER the quarter is the quarter's last day.
    end: new Date(Date.UTC(year, startMonth + 3, 0)),
  };
}

function quarterCodeFor(d: Date): string {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q}-CY${String(d.getUTCFullYear()).slice(-2)}`;
}

function currentQuarterCode(today: Date): string {
  return quarterCodeFor(today);
}

function parseQuarterCode(code: string): { start: Date; end: Date; label: string } {
  const match = QUARTER_CODE.exec(code);
  if (!match) {
    throw new BadRequestException(
      `Unknown quarter "${code}". Expected a code like Q3-CY26.`,
    );
  }
  const q = Number(match[1]);
  const year = 2000 + Number(match[2]);
  const { start, end } = quarterRange(q, year);
  return { start, end, label: `Q${q} CY${match[2]}` };
}

function fromStoredRow(
  row: {
    clientId: string;
    feeRatePercent: number;
    portfolioValue: number;
    quarter: string;
    quarterLabel: string;
    quarterStart: Date;
    quarterEnd: Date;
    daysBilled: number;
    daysInQuarter: number;
    feeAmount: number;
    valuationSource: string;
  },
  clientName: string,
): ClientFeeRow {
  return {
    clientId: row.clientId,
    clientName,
    feeRatePercent: row.feeRatePercent,
    portfolioValue: row.portfolioValue,
    quarter: row.quarter,
    quarterLabel: row.quarterLabel,
    quarterStart: toIsoDate(row.quarterStart),
    quarterEnd: toIsoDate(row.quarterEnd),
    daysBilled: row.daysBilled,
    daysInQuarter: row.daysInQuarter,
    isEstimate: false, // a stored row is by definition a closed, billed quarter
    feeAmount: row.feeAmount,
    valuationSource: row.valuationSource,
  };
}

function diffDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
