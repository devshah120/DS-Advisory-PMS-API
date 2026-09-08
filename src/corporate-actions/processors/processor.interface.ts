/**
 * The contract every corporate-action processor fills in.
 *
 * ── Why processors are given a transaction client, not a Prisma service ─────
 *
 * `ProcessorContext.tx` is a Prisma TRANSACTION client, handed down from
 * CorporateActionProcessorService's `$transaction` callback. A processor
 * cannot reach the unwrapped PrismaService at all, which is what makes PART
 * 36's "if client 7 fails, roll back all 10" structural rather than a
 * convention people have to remember: a write that escaped the transaction
 * would need a database handle that is not in scope.
 *
 * ── Why every processor is a dry-run first ──────────────────────────────────
 *
 * `plan()` computes what WOULD change and writes nothing. `apply()` takes that
 * plan and performs it. The Preview screen (PART 39) and the real run are
 * therefore the same computation, not two implementations that can disagree —
 * a preview that says "$0 impact" and a run that does something else is
 * exactly the failure a review step is supposed to prevent.
 */
import { CorporateAction, Prisma } from '@prisma/client';
import { ClientImpact } from '../corporate-action.types';

/**
 * The Prisma client inside an interactive transaction. Everything a processor
 * writes goes through this.
 */
export type TxClient = Prisma.TransactionClient;

/** Engine settings a processor needs, resolved once per run from AppSetting. */
export interface ProcessorSettings {
  fractionalSharePolicy: 'RETAIN' | 'CASH_IN_LIEU' | 'ROUND_DOWN';
  cashInLieuPolicy: 'MARKET_PRICE' | 'COST_BASIS';
}

/** One client's current position in the action's symbol, loaded once. */
export interface AffectedHolding {
  holdingId: string;
  clientId: string;
  clientName: string;
  /** The client's book currency, for the ledger's currency column. */
  clientCurrency: string;
  ticker: string;
  company: string;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  marketValue: number;
  sector: string;
  industry: string;
  country: string;
  exchange: string;
}

export interface ProcessorContext {
  action: CorporateAction;
  /** Every client position the action touches, already ownership-unscoped. */
  holdings: AffectedHolding[];
  settings: ProcessorSettings;
  tx: TxClient;
  /** Stamped on every Transaction row so a run's writes can be found together. */
  runReference: string;
}

/**
 * What `plan()` returns for one client: the impact, plus the writes `apply()`
 * should perform. Keeping the writes as data rather than as closures means a
 * plan can be inspected, logged and asserted on in a test without executing.
 */
export interface PlannedClientChange {
  impact: ClientImpact;
  /** Transaction rows to create. Shaped for prisma.transaction.create. */
  transactions: PlannedTransaction[];
  /**
   * The holding mutation. Null when the action changes no position (a name
   * change, or a dividend, which moves cash only).
   */
  holdingUpdate: PlannedHoldingUpdate | null;
  /**
   * A position in a DIFFERENT security to create or add to — spin-offs and
   * mergers. Null otherwise.
   */
  newHolding: PlannedNewHolding | null;
}

export interface PlannedTransaction {
  clientId: string;
  ticker: string;
  type: Prisma.TransactionCreateInput['type'];
  /**
   * DELTA shares, never the post-action total — negative for a reverse split.
   * Null for rows that move only cash.
   *
   * This convention is load-bearing: PortfolioReconstructionService replays a
   * SPLIT/BONUS row by ADDING this figure to the running quantity, so a total
   * here would silently triple a position on the next historical report.
   */
  quantity: number | null;
  price: number | null;
  /** Cash moved. 0 for share-only actions — never the notional share value. */
  amount: number;
  date: Date;
  description: string;
  reference: string;
}

export interface PlannedHoldingUpdate {
  holdingId: string;
  quantity: number;
  averageCost: number;
  /** Recomputed at the holding's current price so the book stays consistent. */
  marketValue: number;
  /** Set only by a ticker/name change. */
  ticker?: string;
  company?: string;
  exchange?: string;
}

export interface PlannedNewHolding {
  clientId: string;
  ticker: string;
  company: string;
  quantity: number;
  averageCost: number;
  sector: string;
  industry: string;
  country: string;
  exchange: string;
}

/**
 * A processor turns one validated corporate action into per-client changes.
 *
 * Registering a new action type means writing one of these and adding it to
 * ProcessorRegistry — no change to the service, the controller, the scheduler
 * or the schema. That is what PART 1's "architecture must allow additional
 * types later" means in practice.
 */
export interface CorporateActionProcessor {
  /** Human-readable name, used in logs and audit entries. */
  readonly name: string;

  /**
   * Computes every client's change without writing anything.
   *
   * Must be pure with respect to the database: given the same context it
   * returns the same plan, and calling it twice has no effect. The Preview
   * endpoint calls exactly this.
   */
  plan(context: ProcessorContext): Promise<PlannedClientChange[]> | PlannedClientChange[];
}
