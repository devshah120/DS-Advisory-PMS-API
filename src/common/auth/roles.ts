import { Role } from '@prisma/client';

/**
 * The single place that answers "what is this role allowed to do".
 *
 * The API contract is lowercase (it matches the frontend `UserRole` type);
 * Prisma stores the uppercase variants. Both directions are mapped here rather
 * than in each service, so a new role is added in exactly one file.
 */
export enum ApiRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  PORTFOLIO_MANAGER = 'portfolio_manager',
  RESEARCH_ANALYST = 'research_analyst',
  VIEWER = 'viewer',
}

export const ROLE_TO_API: Record<Role, ApiRole> = {
  SUPER_ADMIN: ApiRole.SUPER_ADMIN,
  ADMIN: ApiRole.ADMIN,
  PORTFOLIO_MANAGER: ApiRole.PORTFOLIO_MANAGER,
  RESEARCH_ANALYST: ApiRole.RESEARCH_ANALYST,
  VIEWER: ApiRole.VIEWER,
};

export const ROLE_TO_DB: Record<ApiRole, Role> = {
  [ApiRole.SUPER_ADMIN]: Role.SUPER_ADMIN,
  [ApiRole.ADMIN]: Role.ADMIN,
  [ApiRole.PORTFOLIO_MANAGER]: Role.PORTFOLIO_MANAGER,
  [ApiRole.RESEARCH_ANALYST]: Role.RESEARCH_ANALYST,
  [ApiRole.VIEWER]: Role.VIEWER,
};

/** Human labels, used in emails and error messages. */
export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  PORTFOLIO_MANAGER: 'Portfolio Manager',
  RESEARCH_ANALYST: 'Research Analyst',
  VIEWER: 'Viewer',
};

/**
 * Roles a Super Admin may hand out from the Users screen.
 *
 * SUPER_ADMIN is absent on purpose: the tier is provisioned by the
 * `create-super-admin` script, not through the UI, so a compromised session
 * cannot mint a second one. ADMIN is absent because it is legacy — nothing new
 * should be created with it.
 */
export const ASSIGNABLE_ROLES: Role[] = [
  Role.PORTFOLIO_MANAGER,
  Role.RESEARCH_ANALYST,
  Role.VIEWER,
];

/** The only role that may create, edit, or deactivate other users. */
export function isSuperAdmin(role: unknown): boolean {
  return role === Role.SUPER_ADMIN;
}

/**
 * Staff logins — everyone who works *in* the firm rather than a client peeking
 * at their own mandate. ADMIN is folded in here because it is the pre-rename
 * spelling of a full-access staff account.
 */
export function isStaff(role: unknown): boolean {
  return (
    role === Role.SUPER_ADMIN ||
    role === Role.ADMIN ||
    role === Role.PORTFOLIO_MANAGER
  );
}
