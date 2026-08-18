import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor, assertCanAccessClient } from '../common/ownership-scope';
import { Market, currencyForMarket, fiscalYearOf } from '../common/market-scope';
import { LotLedgerRow, replayLots, RealizedGainRow, OpenLot } from '../analytics/calculators/tax-lots';
import {
  CapitalGainsSummary,
  capitalGainsByYear,
  capitalGainsForFiscalYear,
  fiscalYearsCovered,
} from '../analytics/calculators/capital-gains';

/**
 * The capital-gains statement — the report a client hands to their CA.
 *
 * Thin by design: every judgement about WHAT a gain is lives in the pure
 * calculators (analytics/calculators/tax-lots.ts and capital-gains.ts). This
 * service only fetches the ledger, decides which market's statute applies, and
 * shapes the result for HTTP. That split is what lets the tax rules be tested
 * without a database, the same way the rest of the analytics layer works.
 *
 * The figures here are FIFO, not average cost — see the header of tax-lots.ts
 * for why that is not a preference but a filing requirement in both books.
 */

export interface UnmatchedSale {
  ticker: string;
  quantity: number;
  date: Date;
  proceeds: number;
}

export interface CapitalGainsReport {
  clientId: string;
  clientName: string;
  market: Market;
  currency: string;
  /** Newest first. Empty when the client has never sold anything. */
  availableYears: number[];
  /** The year this payload is FOR; null when there is nothing to report. */
  fiscalYear: number | null;
  summary: CapitalGainsSummary | null;
  /** Every year's totals, for the trend strip above the table. */
  allYears: CapitalGainsSummary[];
  /**
   * Sales the ledger could not match to a purchase.
   *
   * Surfaced on the report rather than logged away: these are the positions
   * whose cost basis we cannot defend, and a statement that quietly omitted
   * them would understate the client's proceeds. The UI must show this.
   */
  unmatchedSales: UnmatchedSale[];
  /**
   * True when any reported lot rests on a bulk-import acquisition date rather
   * than a real one. See `IMPORT_ARTIFACT_CUTOFF`.
   */
  hasSyntheticAcquisitionDates: boolean;
  openLots: OpenLot[];
}

/**
 * Acquisition dates on or before this are bulk-import artifacts, not real
 * trade dates.
 *
 * The legacy book was imported with every pre-existing position written as a
 * fresh BUY stamped 2026-07-01, though those shares had been held for years
 * (the same condition flows.ts documents as IMPORT_CUTOVER_DATE). FIFO reads
 * the acquisition date to decide short versus long term, so those lots will
 * classify as SHORT — taxing a genuinely long-held position at the higher rate.
 *
 * That error runs AGAINST the client, so it cannot be left implicit. The report
 * carries a flag and the UI must warn on it; the fix is real purchase dates
 * from contract notes, which is a data problem no calculation can solve.
 */
const IMPORT_ARTIFACT_CUTOFF = new Date('2026-07-01T23:59:59.999Z');

@Injectable()
export class CapitalGainsService {
  private readonly logger = new Logger(CapitalGainsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Replays one client's whole ledger through FIFO lots.
   *
   * Always the WHOLE ledger, never just the requested year: FIFO is
   * path-dependent, so which lot a March-2026 sale consumes depends on every
   * purchase before it. Filtering the ledger to one fiscal year first would
   * match sales against the wrong lots — or against no lot at all — and produce
   * a different, wrong basis. The year filter is applied to the RESULT.
   */
  private async replayClient(clientId: string, actor: Actor) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, ownerId: true, market: true, currency: true },
    });
    assertCanAccessClient(actor, client);
    if (!client) throw new NotFoundException('Client not found');

    const rows = await this.prisma.transaction.findMany({
      where: { clientId },
      orderBy: { date: 'asc' },
      select: { type: true, ticker: true, quantity: true, price: true, amount: true, date: true },
    });

    const market = client.market as Market;

    const ledger: LotLedgerRow[] = rows.map((r) => ({
      type: r.type,
      ticker: r.ticker,
      quantity: r.quantity,
      price: r.price,
      amount: r.amount,
      date: r.date,
    }));

    // fmv31Jan2018 is not supplied: no 31-Jan-2018 price source is wired up yet,
    // and guessing one would substitute a wrong cost under s.112A — understating
    // the client's basis and overstating their tax. Grandfathering therefore
    // stays off until real FMV data exists, which is the safe direction.
    const result = replayLots(ledger, { market });

    return { client, market, ...result };
  }

  /**
   * One client's capital-gains statement.
   *
   * `fiscalYear` omitted means the most recent year with activity, so the page
   * opens on something rather than on an empty state.
   */
  async forClient(
    clientId: string,
    actor: Actor,
    fiscalYear?: number,
  ): Promise<CapitalGainsReport> {
    const { client, market, gains, openLots, unmatchedSales } = await this.replayClient(
      clientId,
      actor,
    );

    const availableYears = fiscalYearsCovered(gains, market);
    const year = fiscalYear ?? availableYears[0] ?? null;

    const summary = year !== null ? capitalGainsForFiscalYear(gains, year, market) : null;

    return {
      clientId: client.id,
      clientName: client.name,
      market,
      // The mandate's own currency, falling back to the book's — an Indian
      // statement must render in rupees with Indian digit grouping.
      currency: client.currency || currencyForMarket(market),
      availableYears,
      fiscalYear: year,
      summary,
      allYears: capitalGainsByYear(gains, market),
      unmatchedSales,
      hasSyntheticAcquisitionDates: this.flagSyntheticDates(gains, openLots, clientId),
      openLots,
    };
  }

  /**
   * Does this report rest on imported acquisition dates?
   *
   * Checked against the REPORTED lots (both realized and still open), not the
   * raw ledger, so the warning appears only when it actually affects a number
   * on the page.
   */
  private flagSyntheticDates(
    gains: RealizedGainRow[],
    openLots: OpenLot[],
    clientId: string,
  ): boolean {
    const synthetic =
      gains.some((g) => g.acquiredOn <= IMPORT_ARTIFACT_CUTOFF) ||
      openLots.some((l) => l.acquiredOn <= IMPORT_ARTIFACT_CUTOFF);

    if (synthetic) {
      this.logger.warn(
        `Capital-gains report for client=${clientId} includes lots dated on or before the ` +
          `bulk-import cutover; short/long-term classification is unreliable until real ` +
          `acquisition dates are loaded.`,
      );
    }

    return synthetic;
  }

  /**
   * The fiscal-year dropdown's options for one client, newest first.
   *
   * Served from the backend for the same reason the fee quarters are: the list
   * cannot then drift from what the report endpoint will actually accept.
   */
  async availableYears(clientId: string, actor: Actor): Promise<number[]> {
    const { market, gains } = await this.replayClient(clientId, actor);
    return fiscalYearsCovered(gains, market);
  }

  /**
   * Realized gain for one client over one fiscal year — the scalar the
   * Performance sheet shows.
   *
   * Exposed so the KPI layer reads FIFO from the same replay the statement
   * uses, rather than recomputing gain its own way. Two realized-gain figures
   * in one product is exactly the drift this codebase keeps warning about.
   */
  async realizedGainForYear(
    clientId: string,
    actor: Actor,
    fiscalYear?: number,
  ): Promise<number> {
    const { market, gains } = await this.replayClient(clientId, actor);
    const year = fiscalYear ?? fiscalYearOf(new Date(), market);
    return capitalGainsForFiscalYear(gains, year, market).total.net;
  }
}
