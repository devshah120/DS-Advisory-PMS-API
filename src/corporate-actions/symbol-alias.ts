/**
 * Symbol aliasing across a ticker change — the other half of PART 19.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * PART 19 and PART 50 forbid rewriting historical transactions, and they are
 * right to: a BUY row that said ABC on the day it was keyed must still say ABC
 * ten years later, or the accounting history is a fiction.
 *
 * But PortfolioReconstructionService replays transactions into positions keyed
 * by ticker. After ABC becomes XYZ, a client's ledger holds BUY ABC rows and
 * (later) SELL XYZ rows, and a naive replay builds TWO positions: a phantom
 * ABC the client no longer holds, and an XYZ with a negative or partial
 * quantity. The client's own history makes their portfolio look wrong.
 *
 * ── The resolution ──────────────────────────────────────────────────────────
 *
 * Alias at READ time, never at write time. The stored rows keep their original
 * symbols; the replay maps each row's ticker through a canonical-symbol
 * function before accumulating it. ABC and XYZ collapse into one position, and
 * the position is labelled with whichever symbol was in force on the date being
 * reconstructed — so a report dated before the change reads ABC, and one after
 * reads XYZ, from the same untouched rows.
 *
 * This is why `InstrumentProfile.previousSymbols` exists and why the
 * TICKER_CHANGE corporate action is queried here rather than the alias being
 * hardcoded anywhere.
 */
import { CorporateActionType } from '@prisma/client';

/** One rename, as the resolver needs it. */
export interface SymbolRename {
  from: string;
  to: string;
  effectiveDate: Date;
}

/**
 * Resolves symbols through a chain of renames.
 *
 * Built once per reconstruction from the TICKER_CHANGE actions in the system
 * and then queried per transaction row, because a replay touches thousands of
 * rows and must not hit the database for each one.
 */
export class SymbolAliasResolver {
  /** from -> [{ to, effectiveDate }], oldest first. */
  private readonly forward = new Map<string, Array<{ to: string; on: Date }>>();

  constructor(renames: SymbolRename[] = []) {
    for (const rename of renames) {
      const from = normalizeKey(rename.from);
      const list = this.forward.get(from) ?? [];
      list.push({ to: normalizeKey(rename.to), on: rename.effectiveDate });
      list.sort((a, b) => a.on.getTime() - b.on.getTime());
      this.forward.set(from, list);
    }
  }

  /** True when no renames are known, letting callers skip aliasing entirely. */
  get isEmpty(): boolean {
    return this.forward.size === 0;
  }

  /**
   * The symbol a security trades under AS OF a given date.
   *
   * Walks the rename chain forward, applying only the renames that had taken
   * effect by `asOf`. ABC→XYZ (2026-03) and XYZ→QRS (2027-01) resolve ABC to
   * XYZ for a 2026-06 report and to QRS for a 2027-06 one.
   *
   * The guard against cycles is not paranoia: a mis-keyed pair of actions
   * (A→B and B→A) would otherwise spin forever inside a replay loop.
   */
  resolveAsOf(symbol: string, asOf: Date): string {
    let current = normalizeKey(symbol);
    const seen = new Set<string>([current]);

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const next = this.forward
        .get(current)
        ?.find((entry) => entry.on <= asOf && !seen.has(entry.to));

      if (!next) return current;

      current = next.to;
      seen.add(current);
    }

    return current;
  }

  /**
   * The CANONICAL symbol — the end of the rename chain, ignoring dates.
   *
   * This is what a replay groups positions by: every historical alias of one
   * security must accumulate into a single position regardless of when each
   * row was written. The display label is then chosen separately with
   * `resolveAsOf`.
   */
  canonical(symbol: string): string {
    let current = normalizeKey(symbol);
    const seen = new Set<string>([current]);

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const next = this.forward.get(current)?.find((entry) => !seen.has(entry.to));
      if (!next) return current;
      current = next.to;
      seen.add(current);
    }

    return current;
  }

  /** Every symbol that resolves to `canonicalSymbol`, including itself. */
  aliasesOf(canonicalSymbol: string): string[] {
    const target = normalizeKey(canonicalSymbol);
    const aliases = [target];

    for (const from of this.forward.keys()) {
      if (from !== target && this.canonical(from) === target) aliases.push(from);
    }

    return aliases;
  }
}

/**
 * Ten hops is far more than any real security accumulates, and the cap exists
 * to bound a cycle rather than to model a limit.
 */
const MAX_HOPS = 10;

function normalizeKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Loads every ticker change into a resolver.
 *
 * Takes a minimal Prisma-shaped client rather than PrismaService so it can be
 * called from inside a transaction, and unit-tested with a plain object.
 *
 * Only PROCESSED actions are honoured: a rename that has been detected but not
 * yet applied has not happened to anyone's book, and aliasing on it would make
 * a report disagree with the holdings screen.
 */
export async function loadSymbolAliases(db: {
  corporateAction: {
    findMany(args: unknown): Promise<
      Array<{ symbol: string; newSymbol: string | null; effectiveDate: Date }>
    >;
  };
}): Promise<SymbolAliasResolver> {
  const renames = await db.corporateAction.findMany({
    where: {
      actionType: 'TICKER_CHANGE' satisfies CorporateActionType,
      status: 'PROCESSED',
      newSymbol: { not: null },
    },
    select: { symbol: true, newSymbol: true, effectiveDate: true },
    orderBy: { effectiveDate: 'asc' },
  });

  return new SymbolAliasResolver(
    renames
      .filter((r) => !!r.newSymbol)
      .map((r) => ({ from: r.symbol, to: r.newSymbol as string, effectiveDate: r.effectiveDate })),
  );
}
