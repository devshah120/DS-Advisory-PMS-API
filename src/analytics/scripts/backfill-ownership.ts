/**
 * One-off backfill: hand every pre-ownership record to its owning manager.
 *
 * Until `Client.ownerId` existed there was no owner dimension at all, so every
 * manager's queries returned the whole firm's book. This script assigns the
 * existing India AND US records to a single target manager, which is correct by
 * definition: they were all created and are all run by one desk today. Nothing
 * is split by market — deliberately. Both books move to the same user, and no
 * record is ever moved BETWEEN managers here.
 *
 * What it stamps (all keyed on `ownerId` being absent):
 *   · clients           → the target user. Holdings, transactions, valuations,
 *                         research, baselines and fee schedules follow
 *                         automatically: they reach ownership through the
 *                         client relation and carry no owner of their own.
 *   · families          → the target user, so households stay visible alongside
 *                         the mandates inside them.
 *   · watchlists        → the target user, plus watchlist_folders so the slot
 *                         NAMES move with the tickers rather than reverting to
 *                         "Slot 1" for everyone.
 *
 * ── Why raw MongoDB rather than Prisma ──────────────────────────────────────
 *
 * MongoDB does not rewrite existing documents when a Prisma field is added, so
 * these rows have no `ownerId` key at all. Prisma materialises the schema
 * default on READ, so `findMany({ where: { ownerId: null } })` and a plain
 * `client.findMany()` would both report the rows as already null/unowned and
 * make this script look unnecessary — while `where: { ownerId: <id> }` matched
 * nothing and every manager, including the target, saw an empty app. That is
 * exactly the trap `backfill-market.ts` was written to dodge; this follows the
 * same `$exists: false` approach for the same reason.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * DRY RUN BY DEFAULT. It prints every record it would touch and writes nothing
 * unless `--apply` is passed. It only ever matches documents where `ownerId` is
 * ABSENT, so it can never move a mandate that has already been assigned, and
 * re-running it after a successful apply is a no-op.
 *
 * Run with:
 *   npm run backfill:ownership              # dry run — shows the plan
 *   npm run backfill:ownership -- --apply   # writes
 *   npm run backfill:ownership -- --apply --owner someone@else.com
 */
import { PrismaClient } from '@prisma/client';

/** The desk that owns the existing book. Override with `--owner <email>`. */
const DEFAULT_OWNER_EMAIL = 'deepshah612@gmail.com';

/** Collections carrying an `ownerId`, in the order they are reported. */
const COLLECTIONS = [
  { name: 'clients', label: 'Clients', projection: { name: 1, market: 1 } },
  { name: 'families', label: 'Families', projection: { name: 1, market: 1 } },
  { name: 'watchlists', label: 'Watchlist rows', projection: { ticker: 1, slot: 1, market: 1 } },
  { name: 'watchlist_folders', label: 'Watchlist folders', projection: { name: 1, slot: 1, market: 1 } },
] as const;

/**
 * Documents in `collection` with no `ownerId` key.
 *
 * Raw rather than Prisma for the reason in the header: Prisma cannot express
 * "key is absent" for this field, and would report these as already-null.
 */
async function withoutOwner(
  prisma: PrismaClient,
  collection: string,
  projection: Record<string, 1>,
): Promise<any[]> {
  const res: any = await prisma.$runCommandRaw({
    find: collection,
    filter: { ownerId: { $exists: false } },
    projection,
    batchSize: 1000,
  });
  return res?.cursor?.firstBatch ?? [];
}

/** Stamps `ownerId` on every document in `collection` that lacks one. */
async function stampAll(
  prisma: PrismaClient,
  collection: string,
  ownerId: string,
): Promise<number> {
  const res: any = await prisma.$runCommandRaw({
    update: collection,
    updates: [
      {
        q: { ownerId: { $exists: false } },
        u: { $set: { ownerId } },
        multi: true,
      },
    ],
  });
  return res?.nModified ?? res?.n ?? 0;
}

/** One line describing a row, for the plan output. */
function describe(collection: string, row: any): string {
  switch (collection) {
    case 'clients':
    case 'families':
      return `${row.name ?? '(unnamed)'} [${row.market ?? 'US'}]`;
    case 'watchlists':
      return `${row.ticker} — slot ${row.slot} [${row.market ?? 'US'}]`;
    case 'watchlist_folders':
      return `slot ${row.slot} = "${row.name}" [${row.market ?? 'US'}]`;
    default:
      return String(row._id);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ownerFlag = args.indexOf('--owner');
  const ownerEmail =
    ownerFlag !== -1 && args[ownerFlag + 1] ? args[ownerFlag + 1] : DEFAULT_OWNER_EMAIL;

  const prisma = new PrismaClient();
  try {
    const owner = await prisma.user.findUnique({
      where: { email: ownerEmail },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, active: true },
    });

    if (!owner) {
      console.error(`\n  No user found with email "${ownerEmail}".`);
      console.error('  Nothing was written. Pass --owner <email> to name a different target.\n');
      process.exit(1);
    }

    // A client login owns nothing — assigning the firm's book to one would hide
    // every mandate behind a portal account rather than a manager.
    if (owner.role === 'VIEWER') {
      console.error(`\n  "${ownerEmail}" is a client-portal login (VIEWER) and cannot own mandates.`);
      console.error('  Nothing was written.\n');
      process.exit(1);
    }

    console.log('');
    console.log(`  Target owner : ${owner.firstName} ${owner.lastName} <${owner.email}>`);
    console.log(`  Role         : ${owner.role}${owner.active ? '' : '  (INACTIVE)'}`);
    console.log(`  User id      : ${owner.id}`);
    console.log(`  Mode         : ${apply ? 'APPLY — will write' : 'DRY RUN — no writes'}`);
    console.log('');

    let grandTotal = 0;

    for (const { name, label, projection } of COLLECTIONS) {
      const rows = await withoutOwner(prisma, name, projection as Record<string, 1>);

      if (rows.length === 0) {
        console.log(`  ${label}: nothing to do — every row already carries an owner.`);
        continue;
      }

      grandTotal += rows.length;
      console.log(`  ${label}: ${rows.length} unowned`);
      for (const row of rows) {
        console.log(`     · ${describe(name, row)}`);
      }

      if (apply) {
        const n = await stampAll(prisma, name, owner.id);
        console.log(`     → assigned ${n} to ${owner.email}`);
      }
      console.log('');
    }

    if (grandTotal === 0) {
      console.log('  Nothing to migrate. Ownership is already fully assigned.\n');
    } else if (apply) {
      console.log(`  Done — ${grandTotal} record(s) now owned by ${owner.email}.`);
      console.log('  Every other manager starts with an empty book.\n');
    } else {
      console.log(`  ${grandTotal} record(s) would be assigned to ${owner.email}.`);
      console.log('  Nothing was written. Re-run with --apply to commit.\n');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
