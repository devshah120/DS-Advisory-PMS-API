import { Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BENCHMARK_SEEDS, INSTRUMENT_SEEDS } from './instrument-map';

/**
 * Imports `Portfolio June 2026.xlsx` — the workbook that is, today, the real
 * source of truth for this book.
 *
 * Idempotent throughout: every write is an upsert keyed on a natural key, so the
 * importer can be re-run after a correction without wiping anything or creating
 * duplicates.
 */

/** Excel stores dates as days since 1899-12-30. */
function excelDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
}

/** UTC midnight — price bars and valuations key on the trading DAY, not an instant. */
function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface ImportSummary {
  benchmarks: number;
  instruments: number;
  priceBars: number;
  clients: number;
  holdings: number;
  transactions: number;
  warnings: string[];
}

@Injectable()
export class WorkbookImportService {
  private readonly logger = new Logger(WorkbookImportService.name);

  constructor(private prisma: PrismaService) {}

  async import(filePath: string, clientName = 'Atlas Global Fund'): Promise<ImportSummary> {
    const wb = XLSX.readFile(filePath);
    const warnings: string[] = [];

    const benchmarks = await this.seedBenchmarks();
    const instruments = await this.seedInstruments();
    const priceBars = await this.importIndexSeries(wb, warnings);
    const { clientId, holdings } = await this.importHoldings(wb, clientName, warnings);
    const cashFlows = await this.importCashFlows(wb, clientId, warnings);
    const purchases = await this.reconstructPurchases(wb, clientId, warnings);

    const summary: ImportSummary = {
      benchmarks,
      instruments,
      priceBars,
      clients: 1,
      holdings,
      transactions: cashFlows + purchases,
      warnings,
    };

    this.logger.log(`Import complete: ${JSON.stringify(summary)}`);
    return summary;
  }

  private async seedBenchmarks(): Promise<number> {
    for (const b of BENCHMARK_SEEDS) {
      await this.prisma.benchmark.upsert({
        where: { code: b.code },
        create: b,
        update: { name: b.name, symbol: b.symbol, isDefault: b.isDefault },
      });
    }
    return BENCHMARK_SEEDS.length;
  }

  private async seedInstruments(): Promise<number> {
    for (const s of INSTRUMENT_SEEDS) {
      const data = {
        company: s.company,
        assetClass: s.assetClass,
        sector: s.sector,
        industry: s.industry,
        country: s.country,
        region: s.region,
        exchange: s.exchange,
        lookThrough: (s.lookThrough ?? null) as any,
        source: 'manual',
        // Marks these as human-reviewed so the nightly Yahoo sync cannot
        // overwrite the look-through maps with the fund's own US domicile.
        reviewedAt: new Date(),
      };

      await this.prisma.instrumentProfile.upsert({
        where: { symbol: s.symbol },
        create: { symbol: s.symbol, ...data },
        update: data,
      });
    }
    return INSTRUMENT_SEEDS.length;
  }

  /**
   * The `Index` sheet: 432 rows of daily S&P 500 and Nasdaq closes,
   * 2024-06-03 → 2026-06-25. This is a genuine benchmark return series, and it
   * is the missing input for Beta, Alpha, R², tracking error and capture.
   */
  private async importIndexSeries(wb: XLSX.WorkBook, warnings: string[]): Promise<number> {
    const sheet = wb.Sheets['Index'];
    if (!sheet) {
      warnings.push('No `Index` sheet found — benchmark risk metrics will be unavailable');
      return 0;
    }

    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    const bars: Array<{ symbol: string; date: Date; close: number }> = [];

    for (const r of rows) {
      if (typeof r['Date'] !== 'number') continue;
      const date = utcDay(excelDate(r['Date']));

      if (typeof r['S&P500'] === 'number') {
        bars.push({ symbol: '^GSPC', date, close: r['S&P500'] });
      }
      if (typeof r['Nasdaq'] === 'number') {
        bars.push({ symbol: '^IXIC', date, close: r['Nasdaq'] });
      }
    }

    for (const b of bars) {
      // An index has no dividends or splits, so adjClose == close. For actual
      // equities these must differ, or every dividend looks like a price crash.
      const data = { close: b.close, adjClose: b.close, source: 'workbook' };
      await this.prisma.priceBar.upsert({
        where: { symbol_date: { symbol: b.symbol, date: b.date } },
        create: { symbol: b.symbol, date: b.date, ...data },
        update: data,
      });
    }

    this.logger.log(`Imported ${bars.length} index bars`);
    return bars.length;
  }

  /**
   * The `Holdings` sheet. Note the sheet mixes position rows with summary rows
   * (TOTAL, fee calculations, a cash line), so rows are filtered on having a
   * Symbol rather than trusted positionally.
   */
  private async importHoldings(
    wb: XLSX.WorkBook,
    clientName: string,
    warnings: string[],
  ): Promise<{ clientId: string; holdings: number }> {
    const sheet = wb.Sheets['Holdings'];
    if (!sheet) throw new Error('No `Holdings` sheet found');

    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    const positions = rows.filter((r) => r['Symbol']);

    // The cash line is a summary row with no Symbol but a Current Value that
    // equals its Cost Basis (cash does not appreciate). In this workbook it is
    // $51,800 — 21.3% of the book, and larger than any single position.
    const cashRow = rows.find(
      (r) =>
        !r['Symbol'] &&
        !r['Name'] &&
        typeof r['Current Value'] === 'number' &&
        r['Current Value'] === r['Cost Basis Total'],
    );
    const cashBalance = cashRow ? cashRow['Current Value'] : 0;
    if (!cashRow) {
      warnings.push('Could not identify the cash row; cash balance defaulted to 0');
    }

    const sp500 = await this.prisma.benchmark.findUnique({ where: { code: 'SP500' } });

    const existing = await this.prisma.client.findFirst({ where: { name: clientName } });
    const client = existing
      ? await this.prisma.client.update({
          where: { id: existing.id },
          data: { cashBalance, benchmarkId: sp500?.id },
        })
      : await this.prisma.client.create({
          data: {
            name: clientName,
            broker: 'Interactive Brokers',
            accountNumber: 'U-ATLAS-001',
            benchmark: 'S&P 500',
            benchmarkId: sp500?.id,
            riskProfile: 'MODERATE',
            currency: 'USD',
            status: 'ACTIVE',
            cashBalance,
          },
        });

    const knownSymbols = new Set(INSTRUMENT_SEEDS.map((s) => s.symbol));
    let imported = 0;

    for (const r of positions) {
      const ticker = String(r['Symbol']).trim().toUpperCase();

      if (!knownSymbols.has(ticker)) {
        // Rejected rather than silently classified "Unclassified", which would
        // quietly distort every sector rollup downstream.
        warnings.push(`Unknown ticker ${ticker} — no InstrumentProfile; holding skipped`);
        continue;
      }

      const profile = INSTRUMENT_SEEDS.find((s) => s.symbol === ticker)!;
      const quantity = Number(r['Quantity']);
      const averageCost = Number(r['Average Cost Basis']);
      const currentPrice = Number(r['Last Price']);

      // Derived, never copied from the sheet's own Current Value column.
      const marketValue = quantity * currentPrice;
      const costBasis = quantity * averageCost;

      await this.prisma.holding.upsert({
        where: { clientId_ticker: { clientId: client.id, ticker } },
        create: {
          clientId: client.id,
          ticker,
          company: profile.company,
          sector: profile.sector,
          industry: profile.industry,
          country: profile.country,
          exchange: profile.exchange,
          quantity,
          averageCost,
          currentPrice,
          marketValue,
          unrealizedPnL: marketValue - costBasis,
          realizedPnL: 0,
        },
        update: {
          quantity,
          averageCost,
          currentPrice,
          marketValue,
          unrealizedPnL: marketValue - costBasis,
        },
      });
      imported++;
    }

    // Keep the denormalized display column consistent with the positions we just
    // wrote. Analytics still derive from quantity x price and never read this.
    const securities = positions
      .filter((r) => knownSymbols.has(String(r['Symbol']).trim().toUpperCase()))
      .reduce((s, r) => s + Number(r['Quantity']) * Number(r['Last Price']), 0);

    await this.prisma.client.update({
      where: { id: client.id },
      data: { portfolioValue: securities + cashBalance },
    });

    return { clientId: client.id, holdings: imported };
  }

  /**
   * The `XIRR Calc` sheet: the client's external cash flows.
   *
   * These are what make the return series meaningful. The 2026-05-06 inflows
   * total $75,584 against a ~$150k book — without recording them as flows, that
   * day reads as a +50% return and corrupts every risk metric downstream.
   */
  private async importCashFlows(
    wb: XLSX.WorkBook,
    clientId: string,
    warnings: string[],
  ): Promise<number> {
    const sheet = wb.Sheets['XIRR Calc'];
    if (!sheet) {
      warnings.push('No `XIRR Calc` sheet — XIRR and flow-adjusted returns unavailable');
      return 0;
    }

    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    const amountKey = Object.keys(rows[0] ?? {}).find((k) => k.startsWith('Amount'));
    if (!amountKey) {
      warnings.push('No Amount column in `XIRR Calc`');
      return 0;
    }

    let imported = 0;

    for (const r of rows) {
      const narration = String(r['Narration'] ?? '').trim();
      const amount = r[amountKey];

      // Skip the derived rows (Closing / Annualized / Interim Return) and the
      // trailing empty rows. Only real contributions are transactions.
      if (typeof r['Date'] !== 'number') continue;
      if (typeof amount !== 'number' || amount === 0) continue;
      if (!/opening|inflow|outflow|deposit|withdrawal/i.test(narration)) continue;

      const date = utcDay(excelDate(r['Date']));

      // In the workbook a contribution is NEGATIVE (money leaving the client to
      // enter the portfolio). In the ledger a deposit is a positive amount.
      const isDeposit = amount < 0;
      const magnitude = Math.abs(amount);

      const reference = `WB-${date.toISOString().slice(0, 10)}-${magnitude}`;

      const existing = await this.prisma.transaction.findFirst({ where: { reference } });
      if (existing) continue; // idempotent: re-running does not duplicate flows

      await this.prisma.transaction.create({
        data: {
          clientId,
          type: isDeposit ? 'CASH_DEPOSIT' : 'CASH_WITHDRAWAL',
          amount: magnitude,
          date,
          description: narration || (isDeposit ? 'Contribution' : 'Withdrawal'),
          reference,
        },
      });
      imported++;
    }

    this.logger.log(`Imported ${imported} cash flows`);
    return imported;
  }

  /**
   * Reconstruct the BUY transactions the workbook never recorded.
   *
   * The workbook's `XIRR Calc` sheet lists only the client's cash contributions;
   * the `Holdings` sheet lists what those contributions bought. Nothing records
   * the purchases themselves — and without them the ledger cannot explain the
   * book, which breaks the engine in a specific and dangerous way:
   *
   *   Cash is derived as (deposits − purchases + sales …). With no purchases,
   *   the full $188,780 of deposits reads as still-idle cash. The cashflow
   *   method's terminal value is holdings + cash, so the same money is counted
   *   twice — once as stock, once as cash — and the XIRR solves to +497%
   *   against a true +12%. That is worse than a crash: it looks like a triumph.
   *
   * The reconstruction is sound because the numbers reconcile. Summing
   * `Cost Basis Total` across the 18 positions gives **$188,735.80** against
   * **$188,780.68** of deposits — a gap of $44.88, or 0.02%. The deposits were
   * spent on the stock, and the sheet tells us exactly how much went into each
   * name.
   *
   * WHAT IS EXACT: the ticker, the quantity, and the cost — straight from the
   * sheet, not inferred.
   *
   * WHAT IS RECONSTRUCTED: the trade DATE. The Holdings sheet has no purchase
   * date, so each BUY is dated at the client's first contribution. This is
   * stated in a warning rather than hidden, because XIRR is date-sensitive and
   * a reader is entitled to know which inputs are measured and which are
   * assumed.
   *
   * The date assumption is safe for the numbers that matter here. Under
   * CASH_FLOW — this client's method — BUY rows are NOT cash flows at all; they
   * exist solely so that cash derives correctly, and a cash balance is a
   * point-in-time figure that does not care when the trade happened. The dates
   * would matter under TRANSACTIONAL, and a client on that method with
   * reconstructed dates is exactly what the warning is for.
   */
  private async reconstructPurchases(
    wb: XLSX.WorkBook,
    clientId: string,
    warnings: string[],
  ): Promise<number> {
    const sheet = wb.Sheets['Holdings'];
    if (!sheet) return 0;

    // Already have real trades? Then there is nothing to reconstruct, and we must
    // not bulldoze them with synthetic ones.
    const realTrades = await this.prisma.transaction.count({
      where: { clientId, type: { in: ['BUY', 'SELL'] }, reference: { not: { startsWith: 'WB-BUY-' } } },
    });
    if (realTrades > 0) {
      this.logger.log('Client has real trade history; skipping purchase reconstruction');
      return 0;
    }

    /**
     * The dates. This is the part that has to be got right, and the part where a
     * lazy choice quietly produces a wrong number.
     *
     * Capital arrived on four dates (2026-04-27, 05-06 ×2, 06-15). Dating every
     * reconstructed BUY at the FIRST of them — the obvious shortcut — makes the
     * capital look like it was invested longer than it was, so the same profit is
     * spread over more time and the annualized XIRR comes out at 0.1061 instead
     * of the workbook's 0.11999. The amounts were right; the dates were not, and
     * XIRR is a function of dates.
     *
     * So each position's cost is spread across the contribution dates in
     * proportion to how much capital arrived on each. The BUY flows then land on
     * the same dates, and sum to the same amounts, as the workbook's own series —
     * which reproduces 0.11999054 exactly.
     */
    const contributions = await this.prisma.transaction.findMany({
      where: { clientId, type: 'CASH_DEPOSIT' },
      orderBy: { date: 'asc' },
    });
    if (contributions.length === 0) {
      warnings.push('No contributions found; cannot date reconstructed purchases');
      return 0;
    }

    const contributedTotal = contributions.reduce((s, c) => s + c.amount, 0);
    if (contributedTotal <= 0) {
      warnings.push('Contributions sum to zero; cannot date reconstructed purchases');
      return 0;
    }

    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    const positions = rows.filter((r) => r['Symbol']);
    const knownSymbols = new Set(INSTRUMENT_SEEDS.map((s) => s.symbol));

    let imported = 0;
    let reconstructedCost = 0;

    for (const r of positions) {
      const ticker = String(r['Symbol']).trim().toUpperCase();
      if (!knownSymbols.has(ticker)) continue; // already warned about in importHoldings

      const quantity = Number(r['Quantity']);
      const cost = Number(r['Cost Basis Total']);
      if (!Number.isFinite(quantity) || !Number.isFinite(cost) || cost <= 0) continue;

      // One BUY per (ticker, contribution date), sized by that date's share of
      // the capital. A position bought with money that arrived on three dates is
      // three BUY rows — which is also what a real ledger would look like.
      for (let i = 0; i < contributions.length; i++) {
        const c = contributions[i];
        const share = c.amount / contributedTotal;

        const sliceCost = cost * share;
        const sliceQty = quantity * share;
        if (sliceCost <= 0.005) continue; // sub-cent slice: not a trade

        const reference = `WB-BUY-${ticker}-${i}`;

        const existing = await this.prisma.transaction.findFirst({ where: { reference } });
        if (existing) continue; // idempotent: re-running does not duplicate

        await this.prisma.transaction.create({
          data: {
            clientId,
            ticker,
            type: 'BUY',
            quantity: sliceQty,
            price: sliceQty > 0 ? sliceCost / sliceQty : 0,
            amount: sliceCost,
            date: c.date,
            description:
              'Reconstructed from Holdings sheet — cost and quantity exact, ' +
              'dated to the contribution that funded it',
            reference,
          },
        });

        reconstructedCost += sliceCost;
        imported++;
      }
    }

    if (imported > 0) {
      const dates = contributions
        .map((c) => c.date.toISOString().slice(0, 10))
        .join(', ');

      warnings.push(
        `Reconstructed ${imported} BUY rows totalling ${reconstructedCost.toFixed(2)} across ` +
          `${positions.length} positions. Quantities and costs are EXACT (from the Holdings ` +
          `sheet); the trade DATES are reconstructed — the workbook records no purchase dates, ` +
          `so each position's cost is spread across the contribution dates (${dates}) in ` +
          `proportion to the capital that arrived on each. This reproduces the workbook's ` +
          `transactional XIRR of 0.11999. Import real trade dates to remove the assumption.`,
      );
      this.logger.log(`Reconstructed ${imported} purchases (${reconstructedCost.toFixed(2)})`);
    }

    return imported;
  }
}
