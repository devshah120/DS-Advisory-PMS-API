import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { INCEPTION_DATE } from '../analytics/calculators/flows';
import {
  FeeSegment,
  computeProratedFee,
} from '../analytics/calculators/fee-proration';
import { Market, currencyForMarket } from '../common/market-scope';
import { Actor, assertOwns, clientWhere, ownedWhere } from '../common/ownership-scope';

export interface ClientFeeRow {
  clientId: string;
  clientName: string;
  feeRatePercent: number;
  /**
   * The capital the fee was charged against: opening book plus net capital
   * deployed during the quarter. Not quarter-end NAV — see computeFee.
   */
  portfolioValue: number;
  /** Portfolio value at the quarter's start. Null on pre-proration frozen rows. */
  openingValue: number | null;
  /**
   * Why the fee is the number it is, one entry per billed component. Empty on
   * frozen rows predating segmented proration — those carry only a total.
   */
  segments: FeeSegment[];
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
      // Holdings are no longer loaded: the live-value sum they fed was the old
      // single-NAV basis. The prorated fee reads the quarter's opening value
      // and its BUY/SELL ledger instead, so pulling every holding of every
      // client on a firm-wide fee run is pure waste.
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
        { isClosed, asOf: today },
      );

      if (isClosed) {
        await this.freeze(computed);
      }
      rows.push(computed);
    }

    return rows;
  }

  /**
   * Builds one client's fee for one quarter, prorated over deployed capital.
   *
   * THE BASIS. The opening book bills for the whole quarter; capital deployed
   * mid-quarter bills only for the days it was actually at work. A BUY on the
   * 11th of September in a 92-day quarter is charged 20 days, not 92 — which
   * the previous basis (quarter-end NAV x rate/4) could not express, because a
   * single closing number carries no information about WHEN the money arrived.
   * The arithmetic lives in fee-proration.ts; this method's job is to assemble
   * its three inputs.
   *
   * THE OPENING VALUE is the portfolio at quarter start, read from that day's
   * snapshot or replayed from the baseline. Note this is the day BEFORE the
   * quarter opens: a trade on day one must count as a flow, not be silently
   * folded into the opening book and billed for the full quarter.
   *
   * THE FLOWS are BUY and SELL rows — the TRANSACTIONAL method, the same
   * ledger the client's XIRR is measured on. The client is billed on capital
   * at work, consistent with how the manager's own return is computed. Cash
   * handed over but not yet deployed is not billed until it is put to work.
   *
   * For an OPEN quarter there is no quarter-end to bill to, so segments run to
   * today and the row is flagged an estimate.
   */
  private async computeFee(
    client: { id: string; name: string; feeRatePercent: number; inceptionDate: Date; currency: string },
    quarter: { code: string; label: string; start: Date; end: Date },
    ctx: { isClosed: boolean; asOf: Date },
  ): Promise<ClientFeeRow> {
    const billingEnd = ctx.isClosed ? quarter.end : utcDay(ctx.asOf);

    // The day before the quarter opens — see the note above on why day-one
    // trades must remain visible as flows.
    const openingAsOf = new Date(quarter.start.getTime() - MS_PER_DAY);
    const opening = await this.valueAsOf(client.id, openingAsOf);

    const ledger = await this.prisma.transaction.findMany({
      where: {
        clientId: client.id,
        date: { gte: quarter.start, lte: endOfDay(billingEnd) },
        type: { in: ['BUY', 'SELL'] },
      },
      select: { type: true, amount: true, date: true },
    });

    const prorated = computeProratedFee({
      openingValue: opening.value,
      ledger,
      feeRatePercent: client.feeRatePercent,
      quarterStart: quarter.start,
      quarterEnd: quarter.end,
      inceptionDate: client.inceptionDate,
      billingEnd,
    });

    return {
      clientId: client.id,
      clientName: client.name,
      feeRatePercent: client.feeRatePercent,
      portfolioValue: prorated.billableValue,
      openingValue: prorated.openingValue,
      segments: prorated.segments,
      quarter: quarter.code,
      quarterLabel: quarter.label,
      quarterStart: toIsoDate(quarter.start),
      quarterEnd: toIsoDate(quarter.end),
      daysBilled: prorated.daysBilled,
      daysInQuarter: prorated.daysInQuarter,
      isEstimate: !ctx.isClosed,
      feeAmount: prorated.feeAmount,
      valuationSource: opening.source,
      currency: client.currency,
    };
  }

  /**
   * Portfolio value on a given date, preferring the stored snapshot and
   * falling back to a replay. Returns 0 (source 'unavailable') rather than
   * throwing when the client has no baseline to replay from — one unbillable
   * client must not fail the whole firm's fee run.
   *
   * Generalised from a quarter-END helper when proration arrived: the fee now
   * needs the quarter's OPENING value as well, and two copies of the
   * snapshot-then-replay fallback would eventually disagree about which
   * sources are acceptable.
   */
  private async valueAsOf(
    clientId: string,
    date: Date,
  ): Promise<{ value: number; source: string }> {
    const snapshot = await this.history.getSnapshot(clientId, date);
    if (snapshot) {
      return { value: snapshot.totalValue, source: 'snapshot' };
    }

    try {
      const replayed = await this.history.getPortfolioAsOf(clientId, date);
      return { value: replayed.portfolioValue, source: 'reconstruction' };
    } catch (error) {
      this.logger.warn(
        `No portfolio value for client=${clientId} at ${toIsoDate(date)}: ` +
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
          openingValue: row.openingValue,
          // Frozen, not recomputed on read: the ledger behind a closed quarter
          // can still be corrected afterwards, and an issued invoice must
          // always explain the amount that was actually billed.
          //
          // Cast because Prisma's InputJsonValue does not accept an interface
          // array — FeeSegment has no index signature. The shape is plain data
          // (strings and numbers), so the round-trip through Json is lossless.
          segments: row.segments as unknown as Prisma.InputJsonValue,
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
     * fee = Σ(amount × rate/4 × days/daysInQuarter) summed over every SEGMENT,
     * so recovering an annual rate means dividing by the day-weighted base, not
     * by the raw value — otherwise a household that deployed capital late in
     * the quarter would report a rate far below its true one, because the fee
     * was prorated but the divisor was not.
     *
     * Each member's segments carry their own day-counts, so the base is summed
     * segment by segment. A row frozen before proration shipped has no
     * segments; it falls back to its single portfolioValue × daysBilled, which
     * is exactly the basis it was billed on. Null when there is no billed base.
     */
    const proratedBase = lines.reduce((s, r) => {
      if (r.segments.length > 0) {
        return (
          s +
          r.segments.reduce(
            (inner, seg) => inner + seg.amount * (seg.days / r.daysInQuarter),
            0,
          )
        );
      }
      return s + r.portfolioValue * (r.daysBilled / r.daysInQuarter);
    }, 0);
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

/**
 * The last instant of a day, for an inclusive `lte` date bound.
 *
 * Ledger rows carry a real timestamp, not a midnight-normalised date. Bounding
 * a query at `utcDay(end)` would drop every trade made during the final day —
 * on an open quarter that is TODAY's trades, the ones most likely to be
 * queried about.
 */
function endOfDay(d: Date): Date {
  return new Date(utcDay(d).getTime() + MS_PER_DAY - 1);
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
    openingValue: number | null;
    segments: unknown;
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
    openingValue: row.openingValue,
    /**
     * Rows frozen before segmented proration shipped carry no breakdown. An
     * empty list is the honest answer — the fee was billed on the old
     * single-NAV basis and there are no segments to show. Callers render the
     * total alone rather than inventing a breakdown that was never billed.
     */
    segments: Array.isArray(row.segments) ? (row.segments as FeeSegment[]) : [],
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
