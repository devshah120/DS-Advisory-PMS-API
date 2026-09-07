import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor, clientWhere } from '../common/ownership-scope';
import { Market, marketForSymbol } from '../common/market-scope';
import { SECTORS, Sector, isUnclassified, normalizeSector } from '../common/sectors';

/** One symbol awaiting a sector decision, with the exposure it represents. */
export interface UnclassifiedSymbol {
  symbol: string;
  company: string;
  market: Market;
  /** Summed across every account in scope — the reason this one matters. */
  quantity: number;
  marketValue: number;
  /** Share of the in-scope book, so the list can be worked largest-first. */
  weight: number;
  /** Which accounts hold it. Classifying the symbol fixes all of them at once. */
  holders: Array<{ clientId: string; clientName: string; quantity: number; marketValue: number }>;
}

export interface ClassificationQueue {
  sectors: readonly string[];
  symbols: UnclassifiedSymbol[];
  totals: {
    symbolCount: number;
    marketValue: number;
    /** The share of the book that is currently unclassified — the 11.23%. */
    weight: number;
  };
}

/**
 * Manual sector classification, held PER SYMBOL rather than per holding.
 *
 * The distinction is the feature. SAHAJSOLAR.NS sits in three different
 * accounts; classifying it on each holding row would be three decisions that
 * can silently drift apart, and a fourth client buying it tomorrow would
 * reintroduce the gap. Writing the decision onto InstrumentProfile — which
 * every allocation reader already prefers over the Holding row — makes it one
 * decision that covers every account now and every account later.
 *
 * The Holding rows are updated too, but as a CACHE rather than as the record:
 * several read paths (the holdings table, the family roll-up) group straight
 * off Holding.sector, and leaving those stale would show a symbol as classified
 * on one screen and unclassified on another. The profile stays the source of
 * truth, which is what `reviewedAt` protects.
 */
@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Every symbol in the actor's book that still has no sector, largest exposure
   * first.
   *
   * Scoped by ownership like every other read: a manager sees the unclassified
   * names in their OWN book. Grouped by symbol because that is the unit of the
   * decision — a reader should be asked about SAHAJSOLAR once, not once per
   * account that holds it.
   */
  async queue(actor: Actor, market?: Market): Promise<ClassificationQueue> {
    const holdings = await this.prisma.holding.findMany({
      where: { client: clientWhere(actor) },
      include: { client: { select: { id: true, name: true, market: true } } },
    });

    const inScope = market ? holdings.filter((h) => h.client.market === market) : holdings;

    // The denominator is the whole in-scope book, not just its unclassified
    // part — the figure that matters is "how much of the book is unlabelled",
    // which is meaningless as a share of itself.
    const bookValue = inScope.reduce((s, h) => s + h.quantity * h.currentPrice, 0);

    const bySymbol = new Map<string, UnclassifiedSymbol>();

    for (const h of inScope) {
      if (!isUnclassified(h.sector)) continue;
      // A closed position carries no exposure and needs no decision.
      if (Math.abs(h.quantity) < 1e-9) continue;

      const marketValue = h.quantity * h.currentPrice;
      const cur =
        bySymbol.get(h.ticker) ??
        ({
          symbol: h.ticker,
          company: h.company,
          market: marketForSymbol(h.ticker),
          quantity: 0,
          marketValue: 0,
          weight: 0,
          holders: [],
        } satisfies UnclassifiedSymbol);

      cur.quantity += h.quantity;
      cur.marketValue += marketValue;
      cur.holders.push({
        clientId: h.client.id,
        clientName: h.client.name,
        quantity: h.quantity,
        marketValue,
      });
      bySymbol.set(h.ticker, cur);
    }

    const symbols = [...bySymbol.values()]
      .map((s) => ({ ...s, weight: bookValue > 0 ? s.marketValue / bookValue : 0 }))
      .sort((a, b) => b.marketValue - a.marketValue);

    const marketValue = symbols.reduce((s, x) => s + x.marketValue, 0);

    return {
      sectors: SECTORS,
      symbols,
      totals: {
        symbolCount: symbols.length,
        marketValue,
        weight: bookValue > 0 ? marketValue / bookValue : 0,
      },
    };
  }

  /**
   * Classify one symbol, for good.
   *
   * Writes the decision to InstrumentProfile with `reviewedAt` set, which is
   * what stops the nightly provider sync from reverting it — a human who looked
   * at an SME listing and decided it is Utilities outranks a provider that
   * returned nothing for it.
   */
  async setSector(
    symbol: string,
    rawSector: string,
    actor: Actor,
  ): Promise<{ symbol: string; sector: Sector; holdingsUpdated: number }> {
    const ticker = symbol.trim().toUpperCase();
    if (!ticker) throw new BadRequestException('A symbol is required');

    // Validated against the closed vocabulary rather than accepted as free
    // text: a hand-typed "Healthcare " or "healthcare" would open a second pie
    // wedge that looks like a different sector, which is the exact defect this
    // feature exists to remove.
    const sector = normalizeSector(rawSector);
    if (!sector) {
      throw new BadRequestException(
        `"${rawSector}" is not a known sector. Expected one of: ${SECTORS.join(', ')}.`,
      );
    }

    /**
     * The actor must actually hold the symbol to classify it.
     *
     * The profile row is firm-wide, so without this a manager could set the
     * sector of a name only another manager's clients hold — writing into a
     * book they cannot see. Requiring a holding in their own scope keeps the
     * write inside the boundary the read already respects.
     */
    const owned = await this.prisma.holding.findFirst({
      where: { ticker, client: clientWhere(actor) },
      include: { client: { select: { market: true } } },
    });
    if (!owned) {
      throw new BadRequestException(`No holding in ${ticker} to classify`);
    }

    const existing = await this.prisma.instrumentProfile.findUnique({ where: { symbol: ticker } });

    await this.prisma.instrumentProfile.upsert({
      where: { symbol: ticker },
      create: {
        symbol: ticker,
        company: owned.company,
        sector,
        // Industry is left as the placeholder rather than being set to the
        // sector name. They are different fields and copying one into the other
        // would fabricate a precision the classifier never supplied.
        industry: owned.industry || 'Unclassified',
        country: owned.country || 'Unknown',
        exchange: owned.exchange || 'Unknown',
        market: marketForSymbol(ticker),
        source: 'manual',
        reviewedAt: new Date(),
      },
      update: {
        sector,
        source: 'manual',
        reviewedAt: new Date(),
        // Only fill company/country if the profile has nothing better; a manual
        // sector edit must not clobber a richer profile written by the importer.
        ...(existing?.company ? {} : { company: owned.company }),
      },
    });

    /**
     * Mirror onto the Holding rows the actor owns.
     *
     * A cache refresh, not a second source of truth — see the class doc. Scoped
     * to the actor's own clients for the same reason the guard above exists:
     * classifying a symbol must not write into another manager's rows, even
     * though the profile it just set will (correctly) improve their reads too.
     */
    const { count } = await this.prisma.holding.updateMany({
      where: { ticker, client: clientWhere(actor) },
      data: { sector },
    });

    this.logger.log(
      `Classified ${ticker} as ${sector} by ${actor.id}; ${count} holding row(s) refreshed`,
    );

    return { symbol: ticker, sector, holdingsUpdated: count };
  }
}
