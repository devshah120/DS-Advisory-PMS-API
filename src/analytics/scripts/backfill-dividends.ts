/**
 * Backfills dividends and splits from 1 July 2026 to today into the Corporate
 * Action Engine, from every registered provider (FMP, then Yahoo).
 *
 * WHY
 *
 * Until 2026-11-18 the ledger held no DIVIDEND rows, so every client's return
 * left out its dividend income. FMP, the only source until then, refuses
 * history older than about 25 days and most of this book's symbols on the
 * firm's plan. Yahoo fills both gaps (see yahoo-corporate-action.provider.ts).
 *
 * WHAT IT WRITES
 *
 * Dry run (default): nothing. For every event found it prints whether it would
 * create an action or merge into an existing one, the confidence the action
 * would carry, whether automatic booking would pick it up, and the net cash it
 * would book, worked out by the same entitlement code processing uses.
 *
 * --apply: ingests and validates each event, exactly as the daily sweep does.
 * It does NOT book anything. Booking is the scheduler's processDue(), which on
 * its next run books every open action that has reached its effective date,
 * passes validation, has no source conflict and meets the confidence threshold.
 *
 * Only dividends and splits are ingested. Mergers and ticker changes from FMP's
 * "latest" feeds are left to the daily sweep.
 *
 * USAGE
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/backfill-dividends.ts           # dry run
 *   npx ts-node -r tsconfig-paths/register src/analytics/scripts/backfill-dividends.ts --apply
 *   --from=YYYY-MM-DD   start date, default and minimum 2026-07-01 (the 30-June
 *                       baseline already holds everything before it)
 *   --exclude=SYMBOL:YYYY-MM-DD[,...]   leave out these events (symbol and
 *                       ex-date), e.g. an amount that needs checking first
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { CorporateAction } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { marketForSymbol } from '../../common/market-scope';
import { CorporateActionService } from '../../corporate-actions/corporate-action.service';
import { CorporateActionsModule } from '../../corporate-actions/corporate-actions.module';
import {
  calculateConfidence,
  detectConflicts,
  mergeSources,
  tierRank,
  toSourceReference,
} from '../../corporate-actions/corporate-action.dedupe';
import { NormalizedCorporateAction, SourceReference } from '../../corporate-actions/corporate-action.types';
import { settle } from '../../corporate-actions/dividend-entitlement';
import { CorporateActionProvider } from '../../corporate-actions/providers/corporate-action-provider.interface';
import { CORPORATE_ACTION_PROVIDERS } from '../../corporate-actions/providers/corporate-actions.tokens';

const EARLIEST = '2026-07-01';
const BACKFILL_TYPES = new Set(['DIVIDEND', 'STOCK_SPLIT', 'REVERSE_SPLIT']);
const SHARE_EPSILON = 1e-9;

interface EventRow {
  key: string;
  reports: NormalizedCorporateAction[];
  primary: NormalizedCorporateAction;
  existing: CorporateAction | null;
  outcome: 'new' | 'merge' | 'already booked' | 'closed';
  confidence: number;
  conflicts: string[];
  booksAutomatically: boolean;
  clients: number;
  blockedClients: number;
  /** Why each blocked client cannot be paid, from the entitlement notes. */
  blockedReasons: string[];
  netCash: number;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fromArg = process.argv.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? EARLIEST;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromArg) || fromArg < EARLIEST) {
    throw new Error(`--from must be a date on or after ${EARLIEST}; got ${fromArg}.`);
  }
  const from = new Date(`${fromArg}T00:00:00.000Z`);
  const now = new Date();
  const excluded = new Set(
    (process.argv.find((a) => a.startsWith('--exclude='))?.slice('--exclude='.length) ?? '')
      .split(',')
      .map((e) => e.trim().toUpperCase())
      .filter(Boolean),
  );

  // The engine's own module only: no ScheduleModule, so no cron job can fire mid-run.
  const app = await NestFactory.createApplicationContext(CorporateActionsModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const service = app.get(CorporateActionService);
    const providers = app.get<CorporateActionProvider[]>(CORPORATE_ACTION_PROVIDERS);
    const settings = await service.settings();

    const symbols = await universe(prisma, from);
    console.log(
      `${apply ? 'APPLY' : 'DRY RUN (nothing is written)'}: ${fromArg} to ${iso(now)}, ` +
        `${symbols.length} symbols held now or traded since.`,
    );

    // ── Fetch ────────────────────────────────────────────────────────────────
    const reports: NormalizedCorporateAction[] = [];
    const universeSet = new Set(symbols);
    for (const provider of providers) {
      const found = (await provider.getCorporateActions({ from, to: now, symbols })).filter(
        (a) => BACKFILL_TYPES.has(a.actionType) && universeSet.has(a.symbol.toUpperCase()),
      );
      console.log(`  ${provider.name}: ${found.length} dividend/split reports`);
      reports.push(...found);
    }

    // ── Group reports of one event ───────────────────────────────────────────
    const groups = new Map<string, NormalizedCorporateAction[]>();
    for (const r of reports) {
      const exDay = iso(r.exDate ?? r.effectiveDate);
      if (excluded.has(`${r.symbol.toUpperCase()}:${exDay}`)) continue;
      const key = `${r.symbol.toUpperCase()}|${r.actionType}|${exDay}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    if (excluded.size) console.log(`  excluded: ${[...excluded].join(', ')}`);

    const rows: EventRow[] = [];
    for (const [key, group] of groups) {
      rows.push(await assess(key, group, service, settings.minimumConfidenceScore, now));
    }
    rows.sort((a, b) => a.key.split('|')[2].localeCompare(b.key.split('|')[2]) || a.key.localeCompare(b.key));

    print(rows, symbols, settings.minimumConfidenceScore);

    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to ingest these for automatic booking.');
      return;
    }

    // ── Apply: ingest + validate, never book ─────────────────────────────────
    let created = 0;
    let merged = 0;
    const invalid: string[] = [];
    const errors: string[] = [];
    for (const row of rows) {
      // Highest-priority source first, so it creates the action and the others merge into it.
      for (const report of [...row.reports].sort((a, b) => tierRank(a.tier) - tierRank(b.tier))) {
        try {
          const result = await service.ingest(report);
          if (result.created) created++;
          else merged++;
          if (result.action.status === 'PROCESSED') continue;
          const outcome = await service.validate(result.action.id);
          if (!outcome.valid) {
            invalid.push(
              `${row.key}: ${outcome.findings.filter((f) => f.severity === 'ERROR').map((f) => f.code).join(', ')}`,
            );
          }
        } catch (error) {
          errors.push(`${row.key} (${report.source}): ${(error as Error).message}`);
        }
      }
    }
    console.log(
      `\nApplied: ${created} created, ${merged} merged, ${invalid.length} failed validation, ` +
        `${errors.length} error(s).`,
    );
    for (const e of invalid) console.log(`  invalid: ${e}`);
    for (const e of errors) console.log(`  error: ${e}`);
    console.log('Nothing was booked. The next scheduled sweep books whatever clears its gates.');
  } finally {
    await app.close();
  }
}

/**
 * What ingesting one event would do, and what booking it would pay. Reads only.
 */
async function assess(
  key: string,
  group: NormalizedCorporateAction[],
  service: CorporateActionService,
  threshold: number,
  now: Date,
): Promise<EventRow> {
  const sorted = [...group].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  const primary = sorted[0];
  const existing = await service.previewIngest(primary);

  let sources: SourceReference[] = existing && Array.isArray(existing.sources)
    ? (existing.sources as unknown as SourceReference[])
    : [];
  for (const report of sorted) sources = mergeSources(sources, toSourceReference(report));
  const conflicts = detectConflicts(sources);

  // Figures as they would stand: the stored row's, or the best new report's.
  const basis = existing ?? primary;
  const confidence = calculateConfidence({
    sources,
    actionType: basis.actionType,
    oldRatio: basis.oldRatio,
    newRatio: basis.newRatio,
    cashAmount: basis.cashAmount,
    recordDate: basis.recordDate ?? null,
    effectiveDate: basis.effectiveDate,
    conflicts,
  });

  const status = existing?.status;
  const outcome: EventRow['outcome'] = !existing
    ? 'new'
    : status === 'PROCESSED'
      ? 'already booked'
      : status === 'REJECTED' || status === 'CANCELLED'
        ? 'closed'
        : 'merge';

  const booksAutomatically =
    (outcome === 'new' || outcome === 'merge') &&
    conflicts.length === 0 &&
    confidence >= threshold &&
    basis.effectiveDate <= now;

  let clients = 0;
  let blockedClients = 0;
  const blockedReasons: string[] = [];
  let netCash = 0;
  if (primary.actionType === 'DIVIDEND' && (outcome === 'new' || outcome === 'merge')) {
    const perShare = basis.cashAmount ?? 0;
    const holders = await service.entitledHolders({
      symbol: primary.symbol.toUpperCase(),
      actionType: primary.actionType,
      exDate: basis.exDate ?? null,
      recordDate: basis.recordDate ?? null,
      market: primary.market ?? marketForSymbol(primary.symbol),
      company: null,
    });
    for (const h of holders) {
      if (h.entitlement?.status === 'BLOCKED') {
        blockedClients++;
        blockedReasons.push(h.entitlement.notes.join(' '));
        continue;
      }
      const shares = h.entitlement?.shares ?? 0;
      if (shares <= SHARE_EPSILON) continue;
      clients++;
      netCash += settle(shares, perShare, h.dividendWithholdingRate ?? 0).net;
    }
  }

  return {
    key,
    reports: group,
    primary,
    existing,
    outcome,
    confidence,
    conflicts: conflicts.map((c) => c.field),
    booksAutomatically,
    clients,
    blockedClients,
    blockedReasons,
    netCash,
  };
}

/** Tickers held now, plus any traded since `from`: a client who sold after an ex-date is still owed. */
async function universe(prisma: PrismaService, from: Date): Promise<string[]> {
  const [held, traded] = await Promise.all([
    prisma.holding.findMany({ where: { quantity: { gt: 0 } }, select: { ticker: true }, distinct: ['ticker'] }),
    prisma.transaction.findMany({
      where: { date: { gte: from }, ticker: { not: null } },
      select: { ticker: true },
      distinct: ['ticker'],
    }),
  ]);
  const out = new Set<string>();
  for (const r of [...held, ...traded]) if (r.ticker) out.add(r.ticker.trim().toUpperCase());
  return [...out].sort();
}

function print(rows: EventRow[], symbols: string[], threshold: number) {
  console.log(
    '\n' +
      [
        'ex-date   ',
        'symbol        ',
        'type        ',
        'per share  ',
        'ccy',
        'sources     ',
        'outcome        ',
        'conf',
        'books?',
        'clients',
        'est. net cash',
      ].join(' '),
  );
  for (const r of rows) {
    const [symbol, type, exDay] = r.key.split('|');
    const amount =
      r.primary.actionType === 'DIVIDEND'
        ? String(r.existing?.cashAmount ?? r.primary.cashAmount ?? '')
        : `${r.primary.oldRatio}:${r.primary.newRatio} (old:new)`;
    console.log(
      [
        exDay,
        symbol.padEnd(14),
        type.padEnd(12),
        amount.padEnd(11),
        (r.primary.currency ?? '').padEnd(3),
        [...new Set(r.reports.map((x) => x.source))].join('+').padEnd(12),
        r.outcome.padEnd(15),
        String(r.confidence).padStart(4),
        (r.booksAutomatically ? 'yes' : 'no').padEnd(6),
        `${r.clients}${r.blockedClients ? ` +${r.blockedClients} blocked` : ''}`.padEnd(7),
        r.netCash ? r.netCash.toFixed(2).padStart(12) : '',
      ].join(' ') + (r.conflicts.length ? `  CONFLICT: ${r.conflicts.join(', ')}` : ''),
    );
  }

  const dividends = rows.filter((r) => r.primary.actionType === 'DIVIDEND');
  const splits = rows.filter((r) => r.primary.actionType !== 'DIVIDEND');
  const covered = new Set(rows.map((r) => r.key.split('|')[0]));
  const india = symbols.filter((s) => marketForSymbol(s) === 'INDIA');

  console.log('\nSummary');
  console.log(`  dividends: ${dividends.length}  |  splits: ${splits.length}`);
  for (const outcome of ['new', 'merge', 'already booked', 'closed'] as const) {
    const n = rows.filter((r) => r.outcome === outcome).length;
    if (n) console.log(`  ${outcome}: ${n}`);
  }
  console.log(
    `  symbols with at least one event: ${covered.size} of ${symbols.length} ` +
      `(India: ${india.filter((s) => covered.has(s)).length} of ${india.length})`,
  );

  const byCurrency = new Map<string, { auto: number; waits: number }>();
  for (const r of dividends) {
    const ccy = r.primary.currency ?? '?';
    const t = byCurrency.get(ccy) ?? { auto: 0, waits: 0 };
    if (r.booksAutomatically) t.auto += r.netCash;
    else t.waits += r.netCash;
    byCurrency.set(ccy, t);
  }
  for (const [ccy, t] of byCurrency) {
    console.log(
      `  est. net cash ${ccy}: ${t.auto.toFixed(2)} would book automatically, ` +
        `${t.waits.toFixed(2)} would wait (confidence below ${threshold}, a conflict, or a blocked client)`,
    );
  }
  const blocked = dividends.filter((r) => r.blockedClients > 0);
  if (blocked.length) {
    console.log(`  blocked client entitlements (not paid until the ledger is fixed):`);
    for (const r of blocked) {
      for (const reason of r.blockedReasons) console.log(`    ${r.key.split('|')[0]} ${r.key.split('|')[2]}: ${reason}`);
    }
  }
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
