/**
 * The corporate-action audit trail — PART 43.
 *
 * Append-only by construction: this service exposes `record` and `history` and
 * no update or delete of any kind. "Never delete audit records" is not
 * enforceable by a comment, so the capability simply does not exist here, and
 * anything wanting to erase one would have to reach past this service to
 * Prisma directly — which is conspicuous in a diff.
 *
 * ── Why writes are allowed to fail quietly ──────────────────────────────────
 *
 * `record` swallows its own errors. That is a deliberate inversion of the
 * usual rule, and it applies to this class only: an audit write must never be
 * the reason a corporate action fails. If the audit collection is unavailable,
 * the correct outcome is a processed action with a missing log line and a
 * loud server-side error — not ten clients left unprocessed because the
 * paperwork could not be filed. The processing path's own atomicity is what
 * protects the client data; the audit trail is evidence about it.
 *
 * Note the one exception: audit writes made INSIDE a processing transaction
 * are passed that transaction and therefore roll back with it. A run that was
 * rolled back must not leave a log line claiming it happened.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Actor } from '../common/ownership-scope';

/** Where a request's originating IP and agent come from, when available. */
export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  corporateActionId: string;
  /** Verb, e.g. 'APPROVED'. Free-form but conventionally SCREAMING_CASE. */
  action: string;
  actor?: Actor | null;
  before?: unknown;
  after?: unknown;
  source?: string | null;
  reason?: string | null;
  request?: RequestContext;
}

@Injectable()
export class CorporateActionAuditService {
  private readonly logger = new Logger(CorporateActionAuditService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Writes one audit line.
   *
   * `tx` should be supplied whenever the entry describes work being done
   * inside a transaction, so the two commit or roll back together.
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;

    try {
      await db.corporateActionAuditLog.create({
        data: {
          corporateActionId: entry.corporateActionId,
          action: entry.action,
          userId: entry.actor?.id ?? null,
          // A scheduler-driven entry is labelled 'system' rather than being
          // attributed to a service account, so automated and human actions
          // are distinguishable in the log at a glance.
          actorLabel: entry.actor?.email ?? entry.actor?.id ?? 'system',
          beforeValue: toJson(entry.before),
          afterValue: toJson(entry.after),
          source: entry.source ?? null,
          ipAddress: entry.request?.ipAddress ?? null,
          userAgent: entry.request?.userAgent ?? null,
          reason: entry.reason ?? null,
        },
      });
    } catch (error) {
      // See the header note: never let the paperwork break the work. Inside a
      // transaction the caller's own rollback still applies.
      this.logger.error(
        `Failed to write audit entry ${entry.action} for action ${entry.corporateActionId}: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /** Full history for one action, newest first. */
  async history(corporateActionId: string) {
    return this.prisma.corporateActionAuditLog.findMany({
      where: { corporateActionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Recent activity across every action — the Review Center's activity feed.
   * Capped because this collection only ever grows.
   */
  async recent(limit = 100) {
    return this.prisma.corporateActionAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }
}

/**
 * Coerces an arbitrary value into something Prisma will accept as Json.
 *
 * Dates become ISO strings rather than Date objects: an audit line is read
 * years later, possibly by a different system, and an ISO string means the
 * same thing to all of them.
 */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (v instanceof Date ? v.toISOString() : v)),
  ) as Prisma.InputJsonValue;
}
