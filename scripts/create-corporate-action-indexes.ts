/**
 * Creates the Corporate Action Engine's MongoDB indexes.
 *
 * ── Why this exists rather than `prisma db push` ────────────────────────────
 *
 * Prisma does NOT create MongoDB indexes as a side effect of `generate` or of
 * ordinary use — `@@unique` and `@@index` in schema.prisma are declarations
 * that something must run to realise. Until then they are fiction on disk, and
 * the engine's two most important safety properties are silently absent:
 *
 *   * `corporate_action_ledger (corporateActionId, clientId)` unique — the
 *     IDEMPOTENCY key (PART 37). Without it, processing an action twice
 *     doubles every holder's position instead of being rejected.
 *   * `corporate_actions.fingerprint` unique — the DEDUPE key (PART 7).
 *     Without it, two providers reporting one split create two actions, and
 *     processing both double-adjusts the book.
 *
 * `prisma db push` would normally do this, but it is all-or-nothing across the
 * WHOLE schema: this database currently holds two `families` rows sharing
 * (market, name), which fails that collection's own pre-existing unique index
 * and rolls back every other index in the same push — including these. That
 * duplicate predates the Corporate Action Engine and is a separate data
 * question; this script sidesteps it by creating only what this engine needs,
 * so a corporate-action deployment is not blocked on unrelated data cleanup.
 *
 * Idempotent: `createIndex` on an index that already exists is a no-op, so
 * this is safe to run repeatedly and safe to run on a live database.
 *
 * Run with:
 *   npx ts-node -T -r tsconfig-paths/register scripts/create-corporate-action-indexes.ts
 */
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config();

interface IndexSpec {
  collection: string;
  keys: Record<string, 1 | -1>;
  name: string;
  unique?: boolean;
}

/** Mirrors the @@unique/@@index declarations in schema.prisma exactly. */
const INDEXES: IndexSpec[] = [
  // ── corporate_actions ─────────────────────────────────────────────────────
  {
    collection: 'corporate_actions',
    keys: { fingerprint: 1 },
    name: 'corporate_actions_fingerprint_key',
    unique: true,
  },
  { collection: 'corporate_actions', keys: { symbol: 1 }, name: 'corporate_actions_symbol_idx' },
  { collection: 'corporate_actions', keys: { status: 1 }, name: 'corporate_actions_status_idx' },
  {
    collection: 'corporate_actions',
    keys: { actionType: 1 },
    name: 'corporate_actions_actionType_idx',
  },
  {
    collection: 'corporate_actions',
    keys: { effectiveDate: 1 },
    name: 'corporate_actions_effectiveDate_idx',
  },
  { collection: 'corporate_actions', keys: { market: 1 }, name: 'corporate_actions_market_idx' },
  {
    collection: 'corporate_actions',
    keys: { status: 1, effectiveDate: 1 },
    name: 'corporate_actions_status_effectiveDate_idx',
  },

  // ── corporate_action_ledger ───────────────────────────────────────────────
  // THE IDEMPOTENCY KEY. Everything PART 37 promises rests on this one line.
  {
    collection: 'corporate_action_ledger',
    keys: { corporateActionId: 1, clientId: 1 },
    name: 'corporate_action_ledger_corporateActionId_clientId_key',
    unique: true,
  },
  {
    collection: 'corporate_action_ledger',
    keys: { corporateActionId: 1 },
    name: 'corporate_action_ledger_corporateActionId_idx',
  },
  {
    collection: 'corporate_action_ledger',
    keys: { clientId: 1 },
    name: 'corporate_action_ledger_clientId_idx',
  },
  {
    collection: 'corporate_action_ledger',
    keys: { symbol: 1 },
    name: 'corporate_action_ledger_symbol_idx',
  },

  // ── corporate_action_audit_log ────────────────────────────────────────────
  {
    collection: 'corporate_action_audit_log',
    keys: { corporateActionId: 1 },
    name: 'corporate_action_audit_log_corporateActionId_idx',
  },
  {
    collection: 'corporate_action_audit_log',
    keys: { action: 1 },
    name: 'corporate_action_audit_log_action_idx',
  },
  {
    collection: 'corporate_action_audit_log',
    keys: { createdAt: 1 },
    name: 'corporate_action_audit_log_createdAt_idx',
  },

  // ── instrument_profiles (security master, PART 46) ────────────────────────
  { collection: 'instrument_profiles', keys: { isin: 1 }, name: 'instrument_profiles_isin_idx' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  console.log('\nCreating Corporate Action Engine indexes\n');

  let created = 0;
  let existing = 0;
  const failures: string[] = [];

  for (const spec of INDEXES) {
    try {
      const before = await db
        .collection(spec.collection)
        .indexes()
        .catch(() => [] as Array<{ name?: string }>);
      const already = before.some((i) => i.name === spec.name);

      await db
        .collection(spec.collection)
        .createIndex(spec.keys, { name: spec.name, unique: spec.unique ?? false });

      if (already) {
        existing++;
        console.log(`  =  ${spec.name}`);
      } else {
        created++;
        console.log(`  +  ${spec.name}${spec.unique ? '  [UNIQUE]' : ''}`);
      }
    } catch (error) {
      const message = (error as Error).message;
      failures.push(`${spec.name}: ${message}`);
      console.log(`  !  ${spec.name} — ${message}`);
    }
  }

  console.log(`\n${created} created, ${existing} already present, ${failures.length} failed`);

  if (failures.length) {
    console.log('\nA unique index fails when the collection already holds rows violating it.');
    console.log('Resolve the duplicates listed above, then re-run this script.\n');
  }

  await client.close();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Index creation failed:', error);
  process.exit(1);
});
