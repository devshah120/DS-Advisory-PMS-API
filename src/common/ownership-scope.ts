/**
 * Ownership scope — the single source of truth for "whose data may I see".
 *
 * The firm runs several fund managers out of one database. A manager's book is
 * private: they see the mandates they own and nothing else, and only a Super
 * Admin sees the firm holistically. That rule is written down HERE and nowhere
 * else, for the same reason `market-scope.ts` exists — a privacy boundary
 * re-implemented per service is a privacy boundary that will eventually be
 * implemented wrong in one of them.
 *
 * The dimension lives on `Client.ownerId`. Holdings, transactions, valuations,
 * research, baselines and fee schedules all reach their manager THROUGH the
 * client relation, so filtering the client is sufficient to scope the whole
 * tree — `where: { client: ownershipFilter(user) }` rather than an owner column
 * copied onto six collections that could drift out of step.
 *
 * ── The two failure modes this file is shaped to prevent ────────────────────
 *
 * 1. Fail-open. A caller that forgets to scope leaks the entire firm. Every
 *    helper here therefore takes the ACTOR, never an optional owner id: there
 *    is no way to call `ownershipFilter()` with nothing and get "no filter"
 *    back. Unscoped reads are possible only through `FIRM_WIDE`, which is named
 *    to be conspicuous in a diff and in a code review.
 *
 * 2. Existence disclosure. A manager who guesses another manager's client id
 *    must get a 404, not a 403 — "forbidden" confirms the record exists and
 *    turns an id enumeration into a client census. `assertCanAccess` throws
 *    NotFound for both "absent" and "not yours", deliberately.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * The authenticated caller, as `JwtStrategy.validate` puts it on the request.
 *
 * Structurally typed rather than importing a Nest request type so this module
 * stays dependency-free and unit-testable: the scope rule is pure logic over
 * (role, id) and should be provable without constructing an HTTP context.
 */
export interface Actor {
  id: string;
  email?: string;
  role: Role | string;
  /** Set only for a client-portal login (role VIEWER) — see User.clientId. */
  clientId?: string | null;
}

/**
 * A Prisma `where` fragment for the Client model, or FIRM_WIDE.
 *
 * `{ ownerId: string }` narrows to one manager's book; `{ id: string }` pins a
 * client login to its single mandate.
 */
export type ClientScope =
  | typeof FIRM_WIDE
  | { ownerId: string }
  | { id: string };

/**
 * The unscoped marker — "every client in the firm".
 *
 * A symbol-like sentinel rather than `{}` or `undefined` so that an unscoped
 * read is a deliberate, greppable act. `{}` spread into a where-clause is
 * invisible; `FIRM_WIDE` shows up in review.
 */
export const FIRM_WIDE = Symbol('firm-wide') as unknown as { __firmWide: true };

/**
 * Roles that see the whole firm.
 *
 * ADMIN is grouped with SUPER_ADMIN here, which is a judgement call worth
 * stating: the schema calls ADMIN a legacy spelling "treated as equivalent to
 * PORTFOLIO_MANAGER", but those accounts were provisioned as full-access staff
 * before the tiers split, and silently shrinking an existing admin's view to an
 * empty book would look like data loss rather than a policy change. If an ADMIN
 * account should instead be scoped to its own book, move it one line down —
 * that is the entire change.
 */
const FIRM_WIDE_ROLES: ReadonlySet<string> = new Set<string>([
  Role.SUPER_ADMIN,
  Role.ADMIN,
]);

/** Only a Super Admin may reassign a mandate or view the holistic rollup. */
export function isFirmWide(actor: Actor | undefined | null): boolean {
  return !!actor && FIRM_WIDE_ROLES.has(String(actor.role));
}

/**
 * The Client `where` fragment for this actor.
 *
 * A VIEWER with no `clientId` is a client login whose mandate has been deleted;
 * it resolves to a filter that matches nothing rather than to FIRM_WIDE, so the
 * degenerate case fails closed.
 */
export function clientScope(actor: Actor): ClientScope {
  if (isFirmWide(actor)) return FIRM_WIDE;

  if (String(actor.role) === Role.VIEWER) {
    return { id: actor.clientId ?? '__no_client__' };
  }

  // PORTFOLIO_MANAGER and RESEARCH_ANALYST both see exactly their own book.
  return { ownerId: actor.id };
}

/**
 * Spread-ready Client filter: `where: { ...clientWhere(actor), market }`.
 *
 * Returns `{}` for a firm-wide actor, which is what makes the call site read
 * identically whether or not scoping applies.
 */
export function clientWhere(actor: Actor): Record<string, unknown> {
  const scope = clientScope(actor);
  return scope === FIRM_WIDE ? {} : (scope as Record<string, unknown>);
}

/**
 * The same filter, nested for models that reach ownership through a relation:
 * `where: { ...relatedClientWhere(actor), ticker }` on Holding/Transaction.
 *
 * Returns `{}` firm-wide, so the relation is not traversed at all for a Super
 * Admin — an unnecessary `client: {}` join would cost a lookup on every row.
 */
export function relatedClientWhere(actor: Actor): Record<string, unknown> {
  const scope = clientScope(actor);
  return scope === FIRM_WIDE ? {} : { client: scope };
}

/**
 * Ownership filter for the models that carry `ownerId` directly rather than
 * through a client — Family, Watchlist, WatchlistFolder.
 *
 * Note this is NOT the same as `clientWhere`: a VIEWER has no watchlist and no
 * households of their own, so they get a filter matching nothing rather than
 * their client id (which would be compared against an owner column and match
 * some unrelated manager's row only by cuid collision, but the intent matters
 * more than the odds).
 */
export function ownedWhere(actor: Actor): Record<string, unknown> {
  if (isFirmWide(actor)) return {};
  if (String(actor.role) === Role.VIEWER) return { ownerId: '__no_owner__' };
  return { ownerId: actor.id };
}

/**
 * The owner to stamp on a record this actor is creating.
 *
 * A manager always owns what they create. A Super Admin may name someone else
 * via `requestedOwnerId` (the client form's "Assigned Manager" field); when
 * they name nobody the record is left UNASSIGNED (null) rather than owned by
 * the Super Admin, because a Super Admin is an administrator, not a book of
 * business — quietly filing a mandate under their login would hide it from the
 * manager who actually runs it.
 */
export function ownerForCreate(
  actor: Actor,
  requestedOwnerId?: string | null,
): string | null {
  if (isFirmWide(actor)) return requestedOwnerId ?? null;
  return actor.id;
}

/**
 * Whether this actor may read/write a client row that has already been loaded.
 *
 * Takes the row (not an id) so the caller does the single fetch it was going to
 * do anyway, instead of this helper issuing a second one.
 */
export function canAccessClient(
  actor: Actor,
  client: { id: string; ownerId?: string | null } | null | undefined,
): boolean {
  if (!client) return false;
  if (isFirmWide(actor)) return true;
  if (String(actor.role) === Role.VIEWER) return client.id === actor.clientId;
  return !!client.ownerId && client.ownerId === actor.id;
}

/**
 * Guard for a single-record route. Throws NotFound when the record is absent OR
 * not the actor's — see the existence-disclosure note at the top of this file.
 *
 * `subject` only shapes the message ("Client not found"); it never reveals
 * whether the id exists.
 */
export function assertCanAccessClient(
  actor: Actor,
  client: { id: string; ownerId?: string | null } | null | undefined,
  subject = 'Client',
): void {
  if (!canAccessClient(actor, client)) {
    throw new NotFoundException(`${subject} not found`);
  }
}

/**
 * Guard for records owned directly (Family, Watchlist). Same 404-not-403 rule.
 */
export function assertOwns(
  actor: Actor,
  row: { ownerId?: string | null } | null | undefined,
  subject = 'Record',
): void {
  const ok =
    !!row &&
    (isFirmWide(actor) || (!!row.ownerId && row.ownerId === actor.id));
  if (!ok) {
    throw new NotFoundException(`${subject} not found`);
  }
}

/**
 * Guard for the genuinely firm-wide surfaces — the holistic aggregate rollup
 * and reassigning a mandate between managers.
 *
 * Forbidden (not NotFound) is correct here, unlike the record guards above:
 * the existence of an admin capability is not a secret, and a manager hitting
 * it deserves to be told they lack the permission rather than that the feature
 * does not exist.
 */
export function assertFirmWide(actor: Actor, action = 'perform this action'): void {
  if (!isFirmWide(actor)) {
    throw new ForbiddenException(`Only a Super Admin may ${action}`);
  }
}
