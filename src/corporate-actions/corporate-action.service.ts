/**
 * The Corporate Action Engine's orchestration layer.
 *
 * Owns the lifecycle (detect -> validate -> approve -> process -> reconcile),
 * the atomic write path, and the queries behind the Review Center. The
 * arithmetic lives in ratio.ts and the processors; the provider adapters own
 * fetching; this owns SEQUENCE and SAFETY.
 *
 * ── The four guarantees this file is responsible for ────────────────────────
 *
 * 1. ATOMICITY (PART 36/49). All ten clients or none. Every write goes through
 *    one interactive Prisma transaction, and a processor cannot reach the
 *    database except through the transaction client it is handed.
 *
 * 2. IDEMPOTENCY (PART 37). Processing twice must not double-adjust. Enforced
 *    by `@@unique([corporateActionId, clientId])` on the ledger — the DATABASE
 *    rejects the second write, so two concurrent runs cannot both succeed the
 *    way they could past a read-then-write guard.
 *
 * 3. HISTORY (PART 24/25/50). Nothing here updates a Transaction row, a
 *    PortfolioValuation, or a HoldingSnapshot. Ever. It appends new
 *    transactions and updates current holdings, which is what makes a report
 *    dated before an action still show the pre-action book.
 *
 * 4. PROVENANCE (PART 5/47). No action is created without a source, and merged
 *    reports accumulate sources rather than overwriting them.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CorporateAction,
  CorporateActionStatus,
  CorporateActionType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor, isFirmWide, relatedClientWhere } from '../common/ownership-scope';
import { Market, marketForSymbol, normalizeSymbol } from '../common/market-scope';
import { CorporateActionAuditService, RequestContext } from './audit.service';
import {
  calculateConfidence,
  detectConflicts,
  EX_DATE_IDENTIFIED,
  fingerprintOf,
  mergeSources,
  sameDayRange,
  tierForScore,
  toSourceReference,
} from './corporate-action.dedupe';
import {
  ClientImpact,
  CorporateActionPreview,
  NormalizedCorporateAction,
  ProcessingResult,
  SourceReference,
  ValidationOutcome,
} from './corporate-action.types';
import { CorporateActionValidator } from './corporate-action.validator';
import { formatRatioLabel, normalize, ratioMultiplier } from './ratio';
import { SplitEvent, sharesHeldOnEve } from './dividend-entitlement';
import {
  isBulkImportClient,
  isImportArtifact,
  JUN30_REBASE_DATE,
} from '../analytics/calculators/flows';
import {
  AffectedHolding,
  PlannedClientChange,
  ProcessorSettings,
  TxClient,
} from './processors/processor.interface';
import { ProcessorRegistry } from './processors/processor.registry';
import { ReconciliationService } from './reconciliation.service';

/**
 * Ceiling on how long a processing transaction may hold open.
 *
 * MongoDB aborts long-running transactions server-side (60s by default), and a
 * client-side timeout that outlives the server's produces a confusing
 * "transaction already aborted" rather than a clean failure. 30s comfortably
 * covers a few hundred clients while staying well inside the server's limit.
 */
const TRANSACTION_TIMEOUT_MS = 30_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;

/** Statuses from which processing may legitimately begin. */
const PROCESSABLE: ReadonlySet<CorporateActionStatus> = new Set<CorporateActionStatus>([
  'APPROVED',
  // PART 36: "after fixing the error, re-run entire corporate action."
  'FAILED',
]);

/**
 * Actions that pay cash per share held on the ex-date. Their holders are
 * worked out from the ledger, not just from today's Holding rows; see
 * `withEntitlements`.
 */
const CASH_ENTITLEMENT_TYPES: ReadonlySet<CorporateActionType> = new Set<CorporateActionType>([
  'DIVIDEND',
  'SPECIAL_DIVIDEND',
  'CASH_DISTRIBUTION',
  'RETURN_OF_CAPITAL',
]);

/** The fields of an action that decide who holds it and what they are owed. */
export type EntitlementSubject = Pick<
  CorporateAction,
  'symbol' | 'actionType' | 'exDate' | 'recordDate' | 'market' | 'company'
>;

/**
 * Statuses a merged report never changes. PROCESSED is booked; PROCESSING
 * belongs to a run in flight; REJECTED and CANCELLED were judged not real.
 */
const CLOSED_TO_MERGE: ReadonlySet<CorporateActionStatus> = new Set<CorporateActionStatus>([
  'PROCESSED',
  'PROCESSING',
  'REJECTED',
  'CANCELLED',
]);

/** Actions that change the share count by a ratio, which a later dividend's entitlement must pass through. */
const SPLIT_TYPES: CorporateActionType[] = ['STOCK_SPLIT', 'REVERSE_SPLIT', 'BONUS_ISSUE', 'STOCK_DIVIDEND'];

@Injectable()
export class CorporateActionService {
  private readonly logger = new Logger(CorporateActionService.name);

  constructor(
    private prisma: PrismaService,
    private validator: CorporateActionValidator,
    private registry: ProcessorRegistry,
    private reconciliation: ReconciliationService,
    private audit: CorporateActionAuditService,
  ) {}

  // ══ Ingestion ═════════════════════════════════════════════════════════════

  /**
   * Stores one normalised action, merging it into an existing row when the
   * same event has already been reported (PART 7).
   *
   * Returns the stored row and whether it was newly created, so a caller
   * (the scheduler) can report "3 new, 12 merged" rather than a bare count.
   */
  async ingest(
    incoming: NormalizedCorporateAction,
    actor?: Actor | null,
  ): Promise<{ action: CorporateAction; created: boolean; merged: boolean }> {
    const normalized = withCanonicalSymbol(incoming);
    const symbol = normalized.symbol;

    const fingerprint = fingerprintOf(normalized);
    const reference = toSourceReference(normalized);

    const existing = await this.findExisting(normalized);

    if (existing) {
      return { action: await this.mergeInto(existing, normalized, reference, actor), created: false, merged: true };
    }

    const market = normalized.market ?? marketForSymbol(symbol);
    const securityId = await this.resolveSecurityId(symbol);

    const conflicts = detectConflicts([reference]);
    const confidence = calculateConfidence({
      sources: [reference],
      actionType: normalized.actionType,
      oldRatio: normalized.oldRatio,
      newRatio: normalized.newRatio,
      cashAmount: normalized.cashAmount,
      recordDate: normalized.recordDate ?? null,
      effectiveDate: normalized.effectiveDate,
      conflicts,
    });

    const action = await this.prisma.corporateAction.create({
      data: {
        securityId,
        symbol,
        company: normalized.company ?? null,
        market,
        actionType: normalized.actionType,
        announcementDate: normalized.announcementDate ?? null,
        declarationDate: normalized.declarationDate ?? null,
        recordDate: normalized.recordDate ?? null,
        exDate: normalized.exDate ?? null,
        effectiveDate: normalized.effectiveDate,
        paymentDate: normalized.paymentDate ?? null,
        oldRatio: normalized.oldRatio ?? null,
        newRatio: normalized.newRatio ?? null,
        cashAmount: normalized.cashAmount ?? null,
        currency: normalized.currency ?? null,
        newSymbol: normalized.newSymbol ?? null,
        newCompany: normalized.newCompany ?? null,
        details: (normalized.details ?? undefined) as Prisma.InputJsonValue | undefined,
        source: normalized.source,
        sourceUrl: normalized.sourceUrl ?? null,
        sourceReference: normalized.sourceReference ?? null,
        sources: [reference] as unknown as Prisma.InputJsonValue,
        fingerprint,
        confidenceScore: confidence,
        status: 'DETECTED',
        createdBy: actor?.id ?? null,
      },
    });

    await this.audit.record({
      corporateActionId: action.id,
      action: 'DETECTED',
      actor,
      after: { symbol, actionType: action.actionType, source: action.source, confidence },
      source: normalized.source,
    });

    return { action, created: true, merged: false };
  }

  /**
   * What `ingest` would do with this report, without writing anything: the
   * stored action it would merge into, or null if it would create one. Backs
   * the sweep's dry run.
   */
  async previewIngest(incoming: NormalizedCorporateAction): Promise<CorporateAction | null> {
    return this.findExisting(withCanonicalSymbol(incoming));
  }

  /**
   * The stored action a report describes, if any. Matches on the fingerprint
   * first, then, for types identified by their ex-date, on symbol, type and
   * ex-date. Without the second match, FMP's report of a dividend (dated by pay
   * date) and Yahoo's (dated by ex-date) became two actions and would have been
   * paid twice. See EX_DATE_IDENTIFIED.
   */
  private async findExisting(normalized: NormalizedCorporateAction): Promise<CorporateAction | null> {
    const byFingerprint = await this.prisma.corporateAction.findUnique({
      where: { fingerprint: fingerprintOf(normalized) },
    });
    if (byFingerprint || !normalized.exDate || !EX_DATE_IDENTIFIED.has(normalized.actionType)) {
      return byFingerprint;
    }

    return this.prisma.corporateAction.findFirst({
      where: {
        symbol: normalized.symbol,
        actionType: normalized.actionType,
        exDate: sameDayRange(normalized.exDate),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Folds a second report of the same event into the existing row (PART 7/32).
   *
   * Two rules govern what happens to the stored figures:
   *
   *  - A HIGHER-priority source overwrites the values. An SEC filing arriving
   *    after an API guess should correct it.
   *  - A LOWER-priority source never overwrites; it is recorded as a secondary
   *    reference and, if it disagrees, raises a conflict.
   *
   * Neither rule applies to an action that has already been PROCESSED — its
   * figures are what was actually applied to client books, and rewriting them
   * would make the ledger disagree with the action that produced it. A late
   * correction to a processed action is a new action plus a reversal, not an
   * edit.
   */
  private async mergeInto(
    existing: CorporateAction,
    incoming: NormalizedCorporateAction,
    reference: SourceReference,
    actor?: Actor | null,
  ): Promise<CorporateAction> {
    // A row written outside ingest() may have no sources recorded. Seed one
    // from the row itself, or the first merge would replace its provenance with
    // the newcomer's. The APH split written by its repair script had a score of
    // 100 and became "yahoo, 75".
    const priorSources = readSources(existing.sources);
    const sources = mergeSources(
      priorSources.length > 0 ? priorSources : [rowAsSource(existing)],
      reference,
    );
    const conflicts = detectConflicts(sources);

    const primary = sources[0];
    const incomingIsPrimary = primary?.source === reference.source;
    const alreadyApplied = existing.status === 'PROCESSED';

    const confidence = calculateConfidence({
      sources,
      actionType: existing.actionType,
      oldRatio: existing.oldRatio,
      newRatio: existing.newRatio,
      cashAmount: existing.cashAmount,
      recordDate: existing.recordDate,
      effectiveDate: existing.effectiveDate,
      conflicts,
    });

    const data: Prisma.CorporateActionUpdateInput = {
      sources: sources as unknown as Prisma.InputJsonValue,
      conflicts: (conflicts.length ? conflicts : undefined) as unknown as Prisma.InputJsonValue,
      hasConflict: conflicts.length > 0,
      // A booked action keeps the score it was booked on. A later source can
      // corroborate it, not demote it after the fact.
      confidenceScore: alreadyApplied ? Math.max(existing.confidenceScore, confidence) : confidence,
    };

    // A better source may correct the figures — but never on a processed action.
    if (incomingIsPrimary && !alreadyApplied) {
      data.source = reference.source;
      data.sourceUrl = reference.url ?? existing.sourceUrl;
      data.sourceReference = reference.reference ?? existing.sourceReference;
      data.company = incoming.company ?? existing.company;
      data.announcementDate = incoming.announcementDate ?? existing.announcementDate;
      data.declarationDate = incoming.declarationDate ?? existing.declarationDate;
      data.recordDate = incoming.recordDate ?? existing.recordDate;
      data.exDate = incoming.exDate ?? existing.exDate;
      data.paymentDate = incoming.paymentDate ?? existing.paymentDate;
      data.cashAmount = incoming.cashAmount ?? existing.cashAmount;
      data.currency = incoming.currency ?? existing.currency;
      data.newSymbol = incoming.newSymbol ?? existing.newSymbol;
      data.newCompany = incoming.newCompany ?? existing.newCompany;
      if (incoming.details) {
        data.details = {
          ...(existing.details as Record<string, unknown> | null),
          ...incoming.details,
        } as Prisma.InputJsonValue;
      }
    }

    /**
     * A conflict on an action already cleared for processing sends it back for
     * review. Leaving it APPROVED would let the scheduler process figures a
     * source now disputes.
     *
     * Only an OPEN action is sent back. A processed, cancelled, rejected or
     * in-flight one keeps its status. With booking automatic, a cancelled
     * action reopened by a conflict would be booked by the next sweep once a
     * later report cleared that conflict.
     */
    if (conflicts.length > 0 && !CLOSED_TO_MERGE.has(existing.status)) {
      data.status = 'PENDING_APPROVAL';
    }

    const updated = await this.prisma.corporateAction.update({
      where: { id: existing.id },
      data,
    });

    await this.audit.record({
      corporateActionId: existing.id,
      action: conflicts.length > 0 ? 'DATA_CONFLICT' : 'MERGED_SOURCE',
      actor,
      before: { source: existing.source, confidence: existing.confidenceScore },
      after: {
        source: updated.source,
        confidence: updated.confidenceScore,
        sources: sources.map((s) => s.source),
        conflicts: conflicts.map((c) => c.field),
      },
      source: reference.source,
      reason:
        conflicts.length > 0
          ? `Sources disagree on: ${conflicts.map((c) => c.field).join(', ')}`
          : `Merged report from ${reference.source}`,
    });

    return updated;
  }

  /**
   * InstrumentProfile.id for a symbol, or null.
   *
   * Null is the normal case for the Indian book (that table is populated by
   * the US workbook importer), which is exactly why CorporateAction.securityId
   * is a soft reference and `symbol` remains the join key that always works.
   */
  private async resolveSecurityId(symbol: string): Promise<string | null> {
    const profile = await this.prisma.instrumentProfile.findUnique({
      where: { symbol },
      select: { id: true },
    });
    return profile?.id ?? null;
  }

  // ══ Lifecycle ═════════════════════════════════════════════════════════════

  /** Runs validation and records the outcome (PART 6). */
  async validate(id: string, actor?: Actor | null): Promise<ValidationOutcome> {
    const action = await this.findOrThrow(id);
    const outcome = await this.validator.validate(action);

    await this.prisma.corporateAction.update({
      where: { id },
      data: {
        validationErrors: outcome.findings as unknown as Prisma.InputJsonValue,
        validatedAt: new Date(),
        // A processed action's status is terminal; validation on it is a
        // re-check for the record, not a state change.
        status:
          action.status === 'PROCESSED'
            ? action.status
            : outcome.valid
              ? 'PENDING_APPROVAL'
              : 'REJECTED',
        rejectionReason: outcome.valid
          ? null
          : outcome.findings
              .filter((f) => f.severity === 'ERROR')
              .map((f) => f.message)
              .join(' '),
      },
    });

    await this.audit.record({
      corporateActionId: id,
      action: outcome.valid ? 'VALIDATED' : 'VALIDATION_FAILED',
      actor,
      after: { findings: outcome.findings },
      reason: outcome.valid ? null : 'Validation produced blocking errors',
    });

    return outcome;
  }

  /**
   * Marks an action cleared for processing.
   *
   * ── What approval means in this system ──────────────────────────────────
   *
   * It is a DATA-QUALITY gate, not a permissions gate. A corporate action is a
   * fact about a security: if Amphenol split 2-for-1, every client holding
   * Amphenol is affected, and no manager gets to decide otherwise for their
   * own book. What a reviewer is confirming is that the RECORD is right — the
   * ratio parsed correctly, the source is real, the dates are coherent — not
   * that they consent to it applying to their clients.
   *
   * That is why approval is available to any authenticated staff user rather
   * than restricted to a Super Admin, and why processing always runs
   * firm-wide.
   */
  async approve(id: string, actor: Actor, request?: RequestContext): Promise<CorporateAction> {
    const action = await this.findOrThrow(id);

    if (action.status === 'PROCESSED') {
      throw new BadRequestException(
        `${action.symbol} ${action.actionType} has already been processed; it cannot be re-approved.`,
      );
    }

    // Approval does not bypass validation — it follows it.
    const outcome = await this.validator.validate(action);
    if (!outcome.valid) {
      const errors = outcome.findings.filter((f) => f.severity === 'ERROR');
      throw new BadRequestException(
        `Cannot approve ${action.symbol} ${action.actionType}: ` +
          errors.map((f) => f.message).join(' '),
      );
    }

    const updated = await this.prisma.corporateAction.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedBy: actor.id,
        approvedAt: new Date(),
        rejectionReason: null,
        validationErrors: outcome.findings as unknown as Prisma.InputJsonValue,
        validatedAt: new Date(),
      },
    });

    await this.audit.record({
      corporateActionId: id,
      action: 'APPROVED',
      actor,
      before: { status: action.status },
      after: { status: 'APPROVED' },
      request,
    });

    return updated;
  }

  async reject(
    id: string,
    reason: string,
    actor: Actor,
    request?: RequestContext,
  ): Promise<CorporateAction> {
    const action = await this.findOrThrow(id);

    if (action.status === 'PROCESSED') {
      throw new BadRequestException(
        `${action.symbol} ${action.actionType} has already been applied to client holdings and ` +
          'cannot be rejected. Record a reversing action instead.',
      );
    }

    const updated = await this.prisma.corporateAction.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason },
    });

    await this.audit.record({
      corporateActionId: id,
      action: 'REJECTED',
      actor,
      before: { status: action.status },
      after: { status: 'REJECTED' },
      reason,
      request,
    });

    return updated;
  }

  // ══ Preview (PART 39/40) ══════════════════════════════════════════════════

  /**
   * Computes what processing WOULD do, writing nothing.
   *
   * Runs the identical `plan()` the real processing run uses, so the preview
   * and the outcome cannot disagree — a preview computed by separate code is a
   * preview that eventually lies.
   */
  async preview(id: string): Promise<CorporateActionPreview> {
    const action = await this.findOrThrow(id);
    const holdings = await this.affectedHoldings(action);
    const settings = await this.settings();

    const warnings: string[] = [];

    if (!this.registry.supports(action.actionType)) {
      throw new BadRequestException(
        `No processor is registered for ${action.actionType}; it cannot be previewed or processed.`,
      );
    }

    let changes: PlannedClientChange[] = [];
    if (holdings.length > 0) {
      try {
        changes = await this.registry.for(action.actionType).plan({
          action,
          holdings,
          settings,
          // A preview must not write, and handing it the real client would
          // make that a matter of discipline rather than of structure.
          tx: readOnlyTx(),
          runReference: `preview:${action.id}`,
        });
      } catch (error) {
        throw new BadRequestException(
          `Cannot compute preview for ${action.symbol} ${action.actionType}: ${(error as Error).message}`,
        );
      }
    } else {
      warnings.push(`No client currently holds ${action.symbol}; processing would affect nobody.`);
    }

    const blocked = blockedClients(changes);
    if (blocked) {
      warnings.push(`${blocked} Processing will fail until each is fixed.`);
    }

    if (action.hasConflict) {
      warnings.push('Sources disagree on this action. Resolve the conflict before processing.');
    }

    const existingLedger = await this.prisma.corporateActionLedger.count({
      where: { corporateActionId: id, status: 'APPLIED' },
    });
    if (existingLedger > 0) {
      warnings.push(
        `${existingLedger} client(s) have already been processed for this action. ` +
          'Re-running will skip them — holdings will not be double-adjusted.',
      );
    }

    const impacts = changes.map((c) => c.impact);

    const sharesBefore = normalize(impacts.reduce((s, i) => s + i.quantityBefore, 0));
    const sharesAfter = normalize(impacts.reduce((s, i) => s + i.quantityAfter, 0));
    const valueBefore = normalize(impacts.reduce((s, i) => s + i.marketValueBefore, 0));
    const valueAfter = normalize(impacts.reduce((s, i) => s + i.marketValueAfter, 0));
    const cashImpact = normalize(impacts.reduce((s, i) => s + i.cashImpact, 0));

    const costBefore = normalize(
      impacts.reduce((s, i) => s + i.quantityBefore * i.averageCostBefore, 0),
    );
    const costAfter = normalize(
      impacts.reduce((s, i) => s + i.quantityAfter * i.averageCostAfter, 0),
    );

    return {
      corporateActionId: action.id,
      symbol: action.symbol,
      company: action.company,
      actionType: action.actionType,
      ratioLabel:
        action.oldRatio !== null && action.newRatio !== null
          ? formatRatioLabel(action.oldRatio, action.newRatio)
          : null,
      affectedClients: impacts.length,
      sharesBefore,
      sharesAfter,
      averageCostBefore: sharesBefore > 0 ? normalize(costBefore / sharesBefore) : null,
      averageCostAfter: sharesAfter > 0 ? normalize(costAfter / sharesAfter) : null,
      portfolioValueBefore: valueBefore,
      portfolioValueAfter: valueAfter,
      /**
       * For a ratio action this is zero by construction — quantity rose and
       * per-share price will fall by the same factor. It is displayed because
       * PART 39 asks the preview to PROVE the split creates no value, and a
       * number the reviewer can check is better than a claim they cannot.
       *
       * It may read non-zero on the morning of a split, before the market
       * refresh halves the quoted price. That is the stale price showing, not
       * a calculation error — see StockSplitProcessor's note on currentPrice.
       */
      portfolioValueImpact: normalize(valueAfter - valueBefore),
      cashImpact,
      // Cash actions move real money and DO affect performance; ratio actions
      // must not, and their zero here is the assertion of that.
      performanceImpact: cashImpact,
      clients: impacts,
      warnings,
    };
  }

  // ══ Processing (PART 35/36/37/49) ═════════════════════════════════════════

  /**
   * Applies a corporate action to every affected client, atomically.
   *
   * The whole run is one interactive transaction. On any failure — a bad
   * ratio, a missing holding, a reconciliation mismatch — the transaction
   * rolls back and NOTHING is applied, which is PART 36's requirement stated
   * as code rather than as intent.
   */
  async process(
    id: string,
    actor: Actor,
    request?: RequestContext,
  ): Promise<ProcessingResult> {
    const action = await this.findOrThrow(id);

    if (!PROCESSABLE.has(action.status)) {
      throw new BadRequestException(
        `${action.symbol} ${action.actionType} is ${action.status}; only APPROVED or FAILED ` +
          'actions may be processed.',
      );
    }

    if (action.hasConflict) {
      throw new BadRequestException(
        `${action.symbol} ${action.actionType} has an unresolved source conflict and must not be ` +
          'processed automatically (PART 32).',
      );
    }

    const processor = this.registry.for(action.actionType);
    const settings = await this.settings();
    const runReference = `CA:${action.id}:${Date.now()}`;

    await this.prisma.corporateAction.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          /**
           * Holdings are re-read INSIDE the transaction.
           *
           * The preview's copy is stale by definition — a trade could have
           * settled between preview and approval — and adjusting a position
           * from a figure read minutes ago would apply the split to a quantity
           * the client no longer holds.
           */
          const holdings = await this.affectedHoldings(action, tx);

          /**
           * Idempotency (PART 37). Clients already applied are excluded from
           * this run. The unique index is the real guarantee; this filter is
           * what turns "the second run crashes" into "the second run is a
           * clean no-op", which is the behaviour PART 37 actually describes.
           */
          const applied = await tx.corporateActionLedger.findMany({
            where: { corporateActionId: id, status: 'APPLIED' },
            select: { clientId: true },
          });
          const alreadyApplied = new Set(applied.map((l) => l.clientId));
          const pending = holdings.filter((h) => !alreadyApplied.has(h.clientId));

          if (pending.length === 0) {
            return {
              changes: [] as PlannedClientChange[],
              transactionsCreated: 0,
              skipped: alreadyApplied.size,
              reconciliation: {
                status: 'NOT_APPLICABLE' as const,
                expectedShares: 0,
                actualShares: 0,
                variance: 0,
                message:
                  alreadyApplied.size > 0
                    ? `All ${alreadyApplied.size} affected client(s) were already processed. No changes made.`
                    : `No client holds ${action.symbol}.`,
              },
            };
          }

          const changes = await processor.plan({
            action,
            holdings: pending,
            settings,
            tx,
            runReference,
          });

          // A blocked entitlement is a client whose ex-date share count the
          // ledger cannot support (an unrecorded split, more sold than held).
          // Paying everyone else and marking the action PROCESSED would leave
          // that client unpaid with no way to re-run, so the whole run fails
          // and stays re-runnable once the ledger is fixed.
          const blocked = blockedClients(changes);
          if (blocked) throw new Error(blocked);

          let transactionsCreated = 0;

          for (const change of changes) {
            // 1. The ledger row FIRST — its unique index is the idempotency
            //    guard, so it must be claimed before any holding is touched.
            //    If a concurrent run holds it, this write throws and the whole
            //    transaction rolls back rather than double-adjusting.
            const ledgerRow = await tx.corporateActionLedger.create({
              data: {
                corporateActionId: id,
                clientId: change.impact.clientId,
                portfolioId: change.impact.clientId,
                securityId: action.securityId,
                symbol: change.impact.symbol,
                quantityBefore: change.impact.quantityBefore,
                quantityAfter: change.impact.quantityAfter,
                averageCostBefore: change.impact.averageCostBefore,
                averageCostAfter: change.impact.averageCostAfter,
                marketValueBefore: change.impact.marketValueBefore,
                marketValueAfter: change.impact.marketValueAfter,
                cashImpact: change.impact.cashImpact,
                currency: change.impact.currency,
                fractionalShares: change.impact.fractionalShares,
                status: 'APPLIED',
                processedAt: new Date(),
              },
            });

            // 2. Transaction rows — appended, never editing existing history.
            const createdIds: string[] = [];
            for (const planned of change.transactions) {
              const row = await tx.transaction.create({
                data: {
                  clientId: planned.clientId,
                  ticker: planned.ticker,
                  type: planned.type,
                  quantity: planned.quantity,
                  price: planned.price,
                  amount: planned.amount,
                  date: planned.date,
                  description: planned.description,
                  reference: planned.reference,
                },
                select: { id: true },
              });
              createdIds.push(row.id);
              transactionsCreated++;
            }

            if (createdIds.length > 0) {
              await tx.corporateActionLedger.update({
                where: { id: ledgerRow.id },
                data: { transactionIds: createdIds },
              });
            }

            // 3. The CURRENT holding. Historical snapshots are untouched.
            if (change.holdingUpdate) {
              const update = change.holdingUpdate;
              await tx.holding.update({
                where: { id: update.holdingId },
                data: {
                  quantity: update.quantity,
                  averageCost: update.averageCost,
                  marketValue: update.marketValue,
                  ...(update.ticker ? { ticker: update.ticker } : {}),
                  ...(update.company ? { company: update.company } : {}),
                  ...(update.exchange ? { exchange: update.exchange } : {}),
                },
              });
            }

            // 4. A position in a new security (spin-off, merger).
            if (change.newHolding) {
              await this.upsertNewHolding(tx, change.newHolding);
            }
          }

          // 5. Reconciliation BEFORE commit (PART 38). A failure here rolls
          //    the whole run back rather than reporting a corruption that has
          //    already landed.
          const reconciliation = await this.reconciliation.verify(tx, changes, {
            symbol: action.symbol,
            expectNewSymbol: action.newSymbol,
          });

          if (reconciliation.status === 'RECONCILIATION_FAILED') {
            throw new Error(`Reconciliation failed: ${reconciliation.message}`);
          }

          return {
            changes,
            transactionsCreated,
            skipped: alreadyApplied.size,
            reconciliation,
          };
        },
        { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
      );

      const totalBefore = normalize(
        result.changes.reduce((s, c) => s + c.impact.quantityBefore, 0),
      );
      const totalAfter = normalize(
        result.changes.reduce((s, c) => s + c.impact.quantityAfter, 0),
      );
      const totalCash = normalize(result.changes.reduce((s, c) => s + c.impact.cashImpact, 0));

      await this.prisma.corporateAction.update({
        where: { id },
        data: { status: 'PROCESSED', processingDate: new Date() },
      });

      await this.audit.record({
        corporateActionId: id,
        action: 'PROCESSED',
        actor,
        before: { status: action.status, totalShares: totalBefore },
        after: {
          status: 'PROCESSED',
          totalShares: totalAfter,
          clients: result.changes.length,
          skipped: result.skipped,
          transactions: result.transactionsCreated,
          reconciliation: result.reconciliation.status,
        },
        source: action.source,
        request,
      });

      this.logger.log(
        `Processed ${action.symbol} ${action.actionType}: ${result.changes.length} client(s), ` +
          `${result.transactionsCreated} transaction(s), ${result.reconciliation.status}`,
      );

      return {
        corporateActionId: id,
        clientsProcessed: result.changes.length,
        transactionsCreated: result.transactionsCreated,
        totalSharesBefore: totalBefore,
        totalSharesAfter: totalAfter,
        totalCashImpact: totalCash,
        reconciliation: result.reconciliation,
      };
    } catch (error) {
      const message = (error as Error).message;

      /**
       * The transaction has already rolled back by the time we get here, so
       * no client was partially processed. This write is on a fresh
       * connection and records the failure for the desk.
       */
      await this.prisma.corporateAction.update({
        where: { id },
        data: { status: 'FAILED', notes: message.slice(0, 2000) },
      });

      await this.audit.record({
        corporateActionId: id,
        action: 'FAILED',
        actor,
        before: { status: action.status },
        after: { status: 'FAILED' },
        reason: message,
        request,
      });

      this.logger.error(
        `Processing ${action.symbol} ${action.actionType} failed and was rolled back: ${message}`,
      );

      throw new BadRequestException(
        `Processing failed and every change was rolled back — no client was partially ` +
          `processed. Cause: ${message}`,
      );
    }
  }

  /**
   * Creates or adds to a position in a security the client did not previously
   * hold (spin-off, merger).
   *
   * An upsert rather than a create: a client may already hold the acquirer, in
   * which case the incoming shares merge into that position at a blended
   * average cost — the same treatment a second BUY would receive, because
   * economically that is what it is.
   */
  private async upsertNewHolding(
    tx: TxClient,
    plan: {
      clientId: string;
      ticker: string;
      company: string;
      quantity: number;
      averageCost: number;
      sector: string;
      industry: string;
      country: string;
      exchange: string;
    },
  ): Promise<void> {
    const existing = await tx.holding.findUnique({
      where: { clientId_ticker: { clientId: plan.clientId, ticker: plan.ticker } },
    });

    if (!existing) {
      await tx.holding.create({
        data: {
          clientId: plan.clientId,
          ticker: plan.ticker,
          company: plan.company,
          sector: plan.sector,
          industry: plan.industry,
          country: plan.country,
          exchange: plan.exchange,
          quantity: plan.quantity,
          averageCost: plan.averageCost,
          // No price is known for a security this book has never held. Left at
          // the cost basis so market value is not wildly wrong until the next
          // market refresh prices it properly — MarketService owns prices, and
          // this engine does not invent them.
          currentPrice: plan.averageCost,
          marketValue: normalize(plan.quantity * plan.averageCost),
        },
      });
      return;
    }

    const combinedQuantity = normalize(existing.quantity + plan.quantity);
    const combinedCost = normalize(
      existing.quantity * existing.averageCost + plan.quantity * plan.averageCost,
    );

    await tx.holding.update({
      where: { id: existing.id },
      data: {
        quantity: combinedQuantity,
        averageCost: combinedQuantity > 0 ? normalize(combinedCost / combinedQuantity) : 0,
        marketValue: normalize(combinedQuantity * existing.currentPrice),
      },
    });
  }

  // ══ Queries ═══════════════════════════════════════════════════════════════

  /**
   * Each client's entitlement to a distribution that need not be stored yet,
   * worked out by the same code processing uses. Read-only. Backs the dividend
   * backfill's dry run, so its cash estimate cannot disagree with what booking
   * would do.
   */
  async entitledHolders(action: EntitlementSubject): Promise<AffectedHolding[]> {
    return this.affectedHoldings(action);
  }

  /**
   * Re-dates each bulk-import client's import rows to the 30-June baseline.
   *
   * Those clients' 1-July BUY rows are not purchases made on 1 July. They are
   * the position held at the 30-June close, written as a day of trading by the
   * import (see `isImportArtifact`). Left as dated, a dividend that went ex on
   * 1 July treated them as bought ON the ex-date, so those shares were not
   * entitled. That dropped 3 of STT's 4 holders from its 1-July dividend, and
   * a duplicated import row turned one HEI-A holder's balance negative.
   */
  private async importRowsAtBaseline<T extends { type: string; date: Date }>(
    rowsByClient: Map<string, T[]>,
    db: TxClient | PrismaService,
  ): Promise<Map<string, T[]>> {
    const baselines = await db.portfolioBaseline.findMany({
      where: { clientId: { in: [...rowsByClient.keys()] } },
      select: { clientId: true, baselineDate: true },
    });

    for (const { clientId, baselineDate } of baselines) {
      if (!isBulkImportClient({ baselineDate })) continue;
      const rows = rowsByClient.get(clientId) ?? [];
      rowsByClient.set(
        clientId,
        rows.map((r) => (isImportArtifact(r, true) ? { ...r, date: JUN30_REBASE_DATE } : r)),
      );
    }
    return rowsByClient;
  }

  /**
   * Every client position an action touches.
   *
   * Deliberately UNSCOPED by ownership. A corporate action is a fact about a
   * security, so a 2-for-1 split affects every holder of that security
   * regardless of which manager runs their mandate — scoping this to the
   * approving user's book would leave other managers' clients holding
   * pre-split quantities forever. The READ endpoints are scoped; the
   * PROCESSING is not, and that asymmetry is the point.
   */
  private async affectedHoldings(
    action: EntitlementSubject,
    tx?: TxClient,
  ): Promise<AffectedHolding[]> {
    const db = tx ?? this.prisma;

    const holdings = await db.holding.findMany({
      where: { ticker: action.symbol },
      include: {
        client: {
          select: { id: true, name: true, currency: true, dividendWithholdingPercent: true },
        },
      },
    });

    const current: AffectedHolding[] = holdings.map((h) => ({
      holdingId: h.id,
      clientId: h.clientId,
      clientName: h.client.name,
      clientCurrency: h.client.currency,
      ticker: h.ticker,
      company: h.company,
      quantity: h.quantity,
      averageCost: h.averageCost,
      currentPrice: h.currentPrice,
      marketValue: h.marketValue,
      sector: h.sector,
      industry: h.industry,
      country: h.country,
      exchange: h.exchange,
      dividendWithholdingRate: (h.client.dividendWithholdingPercent ?? 0) / 100,
    }));

    return CASH_ENTITLEMENT_TYPES.has(action.actionType)
      ? this.withEntitlements(action, current, db)
      : current;
  }

  /**
   * Attaches each holder's ex-date entitlement, and adds the clients who held
   * on the ex-date but have sold out since. They have no Holding row, but they
   * are owed the dividend. See dividend-entitlement.ts.
   *
   * Every figure comes from two indexed reads (the ticker's ledger rows and its
   * split actions), not a reconstruction per client. That is what makes doing
   * this inside the processing transaction affordable.
   */
  private async withEntitlements(
    action: EntitlementSubject,
    current: AffectedHolding[],
    db: TxClient | PrismaService,
  ): Promise<AffectedHolding[]> {
    const exDate = action.exDate ?? action.recordDate;
    if (!exDate) {
      throw new BadRequestException(
        `${action.symbol} ${action.actionType} has neither an ex-date nor a record date, ` +
          'so there is no date to measure entitlement on.',
      );
    }

    const [ledger, splitActions] = await Promise.all([
      db.transaction.findMany({
        where: { ticker: action.symbol },
        select: { clientId: true, ticker: true, type: true, quantity: true, date: true },
      }),
      db.corporateAction.findMany({
        where: {
          symbol: action.symbol,
          actionType: { in: SPLIT_TYPES },
          status: { notIn: ['REJECTED', 'CANCELLED'] },
        },
      }),
    ]);

    const splits = splitActions.map(toSplitEvent);
    const market = action.market;
    const rowsByClient = await this.importRowsAtBaseline(
      groupBy(ledger, (r) => r.clientId),
      db,
    );

    // One entitlement per client. A second Holding row for the same client and
    // ticker would otherwise be paid the whole entitlement again.
    const anchor = new Map<string, number>();
    for (const h of current) anchor.set(h.clientId, (anchor.get(h.clientId) ?? 0) + h.quantity);

    const entitled = (clientId: string) =>
      sharesHeldOnEve({
        rows: rowsByClient.get(clientId) ?? [],
        ticker: action.symbol,
        exDate,
        market,
        splits,
        anchorQuantity: anchor.get(clientId) ?? 0,
      });

    const seen = new Set<string>();
    const result: AffectedHolding[] = current.map((h) => {
      const first = !seen.has(h.clientId);
      seen.add(h.clientId);
      return {
        ...h,
        entitlement: first ? entitled(h.clientId) : { shares: 0, status: 'OK', notes: [] },
      };
    });

    const formerIds = [...rowsByClient.keys()].filter((id) => !seen.has(id));
    if (formerIds.length === 0) return result;

    const clients = await db.client.findMany({
      where: { id: { in: formerIds } },
      select: { id: true, name: true, currency: true, dividendWithholdingPercent: true },
    });

    for (const client of clients) {
      const entitlement = entitled(client.id);
      if (entitlement.status === 'OK' && entitlement.shares === 0) continue;

      result.push({
        holdingId: '',
        clientId: client.id,
        clientName: client.name,
        clientCurrency: client.currency,
        ticker: action.symbol,
        company: action.company ?? action.symbol,
        quantity: 0,
        averageCost: 0,
        currentPrice: 0,
        marketValue: 0,
        sector: '',
        industry: '',
        country: '',
        exchange: '',
        dividendWithholdingRate: (client.dividendWithholdingPercent ?? 0) / 100,
        entitlement,
      });
    }

    return result;
  }

  /**
   * The Review Center grid (PART 8).
   *
   * Read access IS ownership-scoped: a manager sees the affected-client counts
   * for their own book only. The action itself is not secret, but who holds
   * what is.
   */
  async list(
    actor: Actor,
    filters: {
      status?: CorporateActionStatus;
      actionType?: CorporateActionType;
      market?: Market;
      symbol?: string;
      from?: Date;
      to?: Date;
      limit?: number;
    } = {},
  ) {
    const where: Prisma.CorporateActionWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.actionType) where.actionType = filters.actionType;
    if (filters.market) where.market = filters.market;
    if (filters.symbol) where.symbol = filters.symbol.trim().toUpperCase();
    if (filters.from || filters.to) {
      where.effectiveDate = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    const actions = await this.prisma.corporateAction.findMany({
      where,
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(filters.limit ?? 200, 500),
    });

    return Promise.all(actions.map((action) => this.decorate(action, actor)));
  }

  /**
   * Adds the affected-client and affected-share counts the grid shows.
   *
   * Counted within the actor's scope, so two managers looking at the same
   * split legitimately see different numbers — each sees their own exposure.
   */
  private async decorate(action: CorporateAction, actor: Actor) {
    const scope = relatedClientWhere(actor);

    const holdings = await this.prisma.holding.findMany({
      where: { ticker: action.symbol, ...scope },
      select: { quantity: true, clientId: true },
    });

    const ledgerCount = await this.prisma.corporateActionLedger.count({
      where: { corporateActionId: action.id, status: 'APPLIED' },
    });

    return {
      ...action,
      ratioLabel:
        action.oldRatio !== null && action.newRatio !== null
          ? formatRatioLabel(action.oldRatio, action.newRatio)
          : null,
      affectedClients: new Set(holdings.map((h) => h.clientId)).size,
      affectedShares: normalize(holdings.reduce((s, h) => s + h.quantity, 0)),
      processedClients: ledgerCount,
      sources: readSources(action.sources),
      /** True when this actor sees the whole firm, so the UI can say so. */
      firmWideView: isFirmWide(actor),
    };
  }

  /** One action with its ledger and audit trail — the detail drawer. */
  async detail(id: string, actor: Actor) {
    const action = await this.findOrThrow(id);
    const [decorated, ledger, audit] = await Promise.all([
      this.decorate(action, actor),
      this.prisma.corporateActionLedger.findMany({
        where: { corporateActionId: id, ...(isFirmWide(actor) ? {} : { client: { ownerId: actor.id } }) },
        include: { client: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.audit.history(id),
    ]);

    return { ...decorated, ledger, audit };
  }

  async findOrThrow(id: string): Promise<CorporateAction> {
    const action = await this.prisma.corporateAction.findUnique({ where: { id } });
    if (!action) throw new NotFoundException('Corporate action not found');
    return action;
  }

  // ══ Settings (PART 44) ════════════════════════════════════════════════════

  /**
   * Engine settings, read from the AppSetting singleton.
   *
   * Falls back to the schema defaults when the singleton row does not exist
   * yet — a fresh install must not fail to process because nobody has visited
   * the settings page.
   */
  async settings(): Promise<ProcessorSettings & {
    autoProcessEnabled: boolean;
    minimumConfidenceScore: number;
    notificationEnabled: boolean;
    processingHourUtc: number;
    sourcePriority: string[];
  }> {
    const row = await this.prisma.appSetting.findUnique({ where: { id: 'app' } });

    return {
      fractionalSharePolicy:
        (row?.caFractionalSharePolicy as ProcessorSettings['fractionalSharePolicy']) ?? 'RETAIN',
      cashInLieuPolicy:
        (row?.caCashInLieuPolicy as ProcessorSettings['cashInLieuPolicy']) ?? 'MARKET_PRICE',
      // Still returned for the settings API, but nothing reads it any more:
      // booking is always automatic (see CorporateActionScheduler).
      autoProcessEnabled: row?.caAutoProcessEnabled ?? false,
      minimumConfidenceScore: row?.caMinimumConfidenceScore ?? 90,
      notificationEnabled: row?.caNotificationEnabled ?? true,
      processingHourUtc: row?.caProcessingHourUtc ?? 2,
      sourcePriority: row?.caSourcePriority ?? ['company_ir', 'sec', 'exchange', 'fmp', 'finnhub'],
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A stored row as the source reference it would have recorded, for a row that recorded none. */
function rowAsSource(row: CorporateAction): SourceReference {
  const reference = toSourceReference({
    symbol: row.symbol,
    actionType: row.actionType,
    recordDate: row.recordDate,
    exDate: row.exDate,
    effectiveDate: row.effectiveDate,
    paymentDate: row.paymentDate,
    oldRatio: row.oldRatio,
    newRatio: row.newRatio,
    cashAmount: row.cashAmount,
    newSymbol: row.newSymbol,
    source: row.source,
    tier: tierForScore(row.confidenceScore),
    sourceUrl: row.sourceUrl,
    sourceReference: row.sourceReference,
  });
  return { ...reference, fetchedAt: row.createdAt.toISOString() };
}

/** The report with its symbol in the form Holding.ticker uses, so lookups and joins agree. */
function withCanonicalSymbol(incoming: NormalizedCorporateAction): NormalizedCorporateAction {
  const market = incoming.market ?? marketForSymbol(incoming.symbol);
  return { ...incoming, symbol: normalizeSymbol(incoming.symbol, market) };
}

/** Reads the sources Json column back into typed references. */
function readSources(value: unknown): SourceReference[] {
  return Array.isArray(value) ? (value as SourceReference[]) : [];
}

/** The clients a plan cannot pay, with the reason for each, or null when there are none. */
function blockedClients(changes: PlannedClientChange[]): string | null {
  const blocked = changes.filter((c) => c.impact.status === 'BLOCKED');
  if (blocked.length === 0) return null;
  return (
    `${blocked.length} client(s) cannot be paid on the ledger as it stands: ` +
    blocked.map((c) => `${c.impact.clientName}: ${c.impact.note}`).join(' | ')
  );
}

/**
 * A split-type action as the entitlement check sees it. A split's multiplier
 * is newRatio/oldRatio (ratio.ts). A bonus uses its own convention, so a 1:1
 * bonus doubles the holding. A missing ratio still yields an event, because
 * the split still has to appear in the ledger; there is just no figure to
 * check the row against.
 */
function toSplitEvent(a: CorporateAction): SplitEvent {
  const usable =
    a.oldRatio !== null && a.newRatio !== null && a.oldRatio > 0 && a.newRatio > 0;
  const isBonus = a.actionType === 'BONUS_ISSUE' || a.actionType === 'STOCK_DIVIDEND';

  return {
    ticker: a.symbol,
    exDate: a.exDate ?? a.effectiveDate,
    multiplier: !usable
      ? null
      : isBonus
        ? 1 + a.newRatio! / a.oldRatio!
        : ratioMultiplier(a.oldRatio!, a.newRatio!),
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * A transaction client that throws on any write.
 *
 * Handed to `plan()` during a preview so that a processor which tried to write
 * during a dry run fails immediately and loudly, rather than silently mutating
 * the book from a screen the user believes is read-only. Processors do not
 * currently use `tx` inside `plan()`, and this is what keeps that true.
 */
function readOnlyTx(): TxClient {
  const deny = () => {
    throw new Error('A corporate-action preview must not write to the database.');
  };

  const emptyRead = async (): Promise<unknown[]> => [];

  return new Proxy({} as TxClient, {
    get: () =>
      new Proxy(
        {},
        {
          get: (_t, method: string) =>
            method.startsWith('find') || method === 'count' || method === 'aggregate'
              ? emptyRead
              : deny,
        },
      ),
  });
}
