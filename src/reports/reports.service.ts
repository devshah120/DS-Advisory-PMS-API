import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { INCEPTION_DATE } from '../analytics/calculators/flows';
import { Market, currencyForMarket } from '../common/market-scope';
import { Actor, assertOwns, clientWhere, ownedWhere } from '../common/ownership-scope';

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
  /**
   * The client's own reporting currency, so a fee row renders in the unit it
   * was billed in rather than in whatever the viewer's selector happens to say.
   */
  currency: string;
}

/** One member account, unbillable for this quarter, and why. */
export interface UnbilledMember {
  clientId: string;
  clientName: string;
  reason: string;
}

/**
 * A household's fee invoice for one quarter: the member fee rows verbatim,
 * plus the totals a bill needs.
 */
export interface FamilyFeeInvoice {
  familyId: string;
  familyName: string;
  market: string;
  /** The single unit every figure below is in — a family lives in one book. */
  currency: string;

  quarter: string;
  quarterLabel: string;
  quarterStart: string;
  quarterEnd: string;
  /** True while the quarter is open: every line is an estimate, not a bill. */
  isEstimate: boolean;

  /**
   * The billable member accounts, each row IDENTICAL to the one that client's
   * own fee statement carries — see the service doc on why these are reused
   * rather than recomputed.
   */
  lines: ClientFeeRow[];

  /**
   * Members that could not be billed this quarter, with the reason.
   *
   * Listed rather than silently dropped: a household invoice that quietly
   * omits an account looks like a complete bill for the family and is not one,
   * and the client is the party least able to detect the omission.
   */
  unbilled: UnbilledMember[];

  totals: {
    memberCount: number;
    billedCount: number;
    /** Σ of the member portfolio values the fee was charged on. */
    portfolioValue: number;
    /** THE invoice total — Σ of the member fee amounts, nothing re-derived. */
    feeAmount: number;
    /**
     * The household's effective annual rate: feeAmount back-solved against the
     * value and the days actually billed.
     *
     * Reported rather than assumed because members can sit on different rates
     * and different proration, so no single member's rate describes the
     * household. Null when nothing was billable to divide by.
     */
    effectiveAnnualRatePercent: number | null;
  };
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
  async feesForQuarter(
    quarter?: string,
    market?: Market,
    actor?: Actor,
  ): Promise<ClientFeeRow[]> {
    const today = new Date();
    const code = quarter ?? currentQuarterCode(today);
    const { start, end, label } = parseQuarterCode(code);

    const isClosed = utcDay(today) > end;

    // Scoped to one book. The fee table sums a Total column across its rows,
    // and an unscoped read put USD and INR mandates in the same table under one
    // total — a figure in no currency at all. Optional so an unscoped
    // firm-wide read still works.
    const clients = await this.prisma.client.findMany({
      where: {
        status: 'ACTIVE',
        ...(market ? { market } : {}),
        // Ownership scoping happens HERE and nowhere else in this service: the
        // fee rows, the totals and clientFee() below are all derived from this
        // one list, so narrowing it narrows every fee surface at once.
        ...(actor ? clientWhere(actor) : {}),
      },
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
        rows.push(fromStoredRow(frozen, client.name, client.currency));
        continue;
      }

      // A client whose mandate began after the quarter ended was never
      // billable for it — omit rather than emit a zero, which reads as
      // "we billed them nothing" instead of "they weren't a client yet".
      if (utcDay(client.inceptionDate) > end) continue;

      const computed = await this.computeFee(
        {
          id: client.id,
          name: client.name,
          feeRatePercent: client.feeRatePercent,
          inceptionDate: client.inceptionDate,
          currency: client.currency,
        },
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
    client: { id: string; name: string; feeRatePercent: number; inceptionDate: Date; currency: string },
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
      currency: client.currency,
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
  async clientFee(
    clientId: string,
    quarter?: string,
    actor?: Actor,
  ): Promise<ClientFeeRow> {
    // Derived from the scoped list above, so a mandate the caller does not own
    // simply is not among the rows and falls into the NotFound below — the same
    // answer an unbilled client gets.
    const rows = await this.feesForQuarter(quarter, undefined, actor);
    const row = rows.find((r) => r.clientId === clientId);
    if (!row) {
      throw new NotFoundException(
        `No fee schedule for client ${clientId} in ${quarter ?? 'the current quarter'} — ` +
          `the client may be inactive, or its mandate may have begun after that quarter ended.`,
      );
    }
    return row;
  }

  /**
   * One household's invoice for one quarter.
   *
   * The governing decision: this REUSES the per-client rows `feesForQuarter`
   * already produced, and sums them. It does not recompute a fee from a
   * combined portfolio value, and it does not apply a blended household rate.
   *
   * That matters because both documents go to the same people. A family
   * invoice and the member's own fee statement are read side by side, and if
   * the household bill were derived independently the two could differ by
   * rounding — or, once members sit on different rates or different proration,
   * by real money. Summing the exact rows the individual statements are built
   * from makes disagreement structurally impossible rather than merely
   * unlikely.
   *
   * It also means every guarantee `feesForQuarter` already provides carries
   * over unchanged: a closed quarter is served from its frozen
   * ClientFeeSchedule rows, so re-invoicing a household months later reports
   * what was actually billed rather than what today's rates would produce.
   */
  async familyInvoice(
    familyId: string,
    quarter: string | undefined,
    actor: Actor,
  ): Promise<FamilyFeeInvoice> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: {
        clients: {
          select: { id: true, name: true, status: true, inceptionDate: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    // Same 404-for-absent-and-for-someone-else's rule the other family routes
    // use: an invoice discloses the household's member roster and their values.
    assertOwns(actor, family, 'Family');
    if (!family) throw new NotFoundException(`Family ${familyId} not found`);

    const code = quarter ?? currentQuarterCode(new Date());
    const { start, end, label } = parseQuarterCode(code);
    const isEstimate = utcDay(new Date()) <= end;

    /**
     * Scoped to the family's OWN book rather than to the caller's current
     * market selector.
     *
     * A family lives in exactly one book (schema.prisma: Family.market), and
     * its invoice must be denominated in that book's currency no matter which
     * market the viewer happens to be looking at. Passing the viewer's
     * selection here would let an INR household be invoiced while the UI sat
     * on the US book, and the total would be a number in no currency at all.
     */
    const allRows = await this.feesForQuarter(code, family.market as Market, actor);
    const byClient = new Map(allRows.map((r) => [r.clientId, r]));

    const lines: ClientFeeRow[] = [];
    const unbilled: UnbilledMember[] = [];

    for (const member of family.clients) {
      const row = byClient.get(member.id);
      if (row) {
        lines.push(row);
        continue;
      }

      /**
       * Absent from the fee run means one of two things, and the invoice says
       * which. Both are legitimate; neither may be silently dropped, because a
       * household bill missing an account still looks like a complete bill.
       */
      const reason =
        member.status !== 'ACTIVE'
          ? `Mandate is ${member.status.toLowerCase()} — not billed this quarter`
          : utcDay(member.inceptionDate) > end
            ? `Mandate began ${toIsoDate(utcDay(member.inceptionDate))}, after this quarter ended`
            : 'Not billable for this quarter';

      unbilled.push({ clientId: member.id, clientName: member.name, reason });
    }

    // Invoice lines read alphabetically, matching the fee table they are
    // reconciled against. `feesForQuarter` already orders by name, but the
    // family's member list drives the loop above, so sorting here keeps the
    // order stable regardless of how the roster comes back.
    lines.sort((a, b) => a.clientName.localeCompare(b.clientName));
    unbilled.sort((a, b) => a.clientName.localeCompare(b.clientName));

    const portfolioValue = lines.reduce((s, r) => s + r.portfolioValue, 0);
    const feeAmount = lines.reduce((s, r) => s + r.feeAmount, 0);

    /**
     * The household's effective annual rate, back-solved from what was actually
     * billed rather than averaged from the members' headline rates.
     *
     * fee = Σ(value × rate/4 × daysBilled/daysInQuarter), so recovering an
     * annual rate means dividing by the value-weighted proration, not by the
     * raw value — otherwise a household whose accounts were billed for half
     * the quarter would report half its true rate. Null when there is no
     * billed base to divide by.
     */
    const proratedBase = lines.reduce(
      (s, r) => s + r.portfolioValue * (r.daysBilled / r.daysInQuarter),
      0,
    );
    const effectiveAnnualRatePercent =
      proratedBase > 0 ? (feeAmount / proratedBase) * 4 * 100 : null;

    return {
      familyId: family.id,
      familyName: family.name,
      market: family.market,
      currency: currencyForMarket(family.market as Market),
      quarter: code,
      quarterLabel: label,
      quarterStart: toIsoDate(start),
      quarterEnd: toIsoDate(end),
      isEstimate,
      lines,
      unbilled,
      totals: {
        memberCount: family.clients.length,
        billedCount: lines.length,
        portfolioValue,
        feeAmount,
        effectiveAnnualRatePercent,
      },
    };
  }

  /**
   * The households the fee page can invoice, for its selector.
   *
   * Scoped by ownership and by book, and each carries the member count so the
   * dropdown can read "Salecha Family · 4 accounts" without a second call.
   */
  async invoiceableFamilies(
    actor: Actor,
    market?: Market,
  ): Promise<Array<{ id: string; name: string; memberCount: number }>> {
    const families = await this.prisma.family.findMany({
      where: {
        ...(market ? { market } : {}),
        ...ownedWhere(actor),
      },
      include: { clients: { select: { id: true } } },
      orderBy: { name: 'asc' },
    });

    return families.map((f) => ({
      id: f.id,
      name: f.name,
      memberCount: f.clients.length,
    }));
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
  currency: string,
): ClientFeeRow {
  return {
    clientId: row.clientId,
    clientName,
    currency,
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
