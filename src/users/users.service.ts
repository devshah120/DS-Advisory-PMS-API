import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ApiRole as UserRole,
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  ROLE_TO_API,
  ROLE_TO_DB,
} from '../common/auth/roles';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateNotificationsDto } from './dto/update-notifications.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';

/**
 * Applied whenever a column is null — i.e. the user has never touched that
 * setting. Kept here (not as Prisma `@default`s) so existing rows written before
 * these columns existed resolve identically to new ones, without a backfill.
 */
const DEFAULT_PREFERENCES = {
  theme: 'system',
  baseCurrency: 'USD',
  dateFormat: 'MMM D, YYYY',
  numberFormat: 'en-US',
  density: 'comfortable',
};

const DEFAULT_NOTIFICATIONS = {
  tradeAlerts: true,
  priceTargets: true,
  weeklyDigest: true,
  corporateActions: false,
  productUpdates: false,
};

/** Cost factor for password hashing, matching the rest of the codebase. */
const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  /**
   * With AUTH_BYPASS=true, AuthService issues a token for a synthetic user that
   * has no row in the database. Reads fall back to a stub so the Settings page
   * renders; writes are rejected explicitly rather than throwing a Prisma
   * "record not found", which would surface as an opaque 500.
   */
  private get bypassEnabled() {
    return process.env.AUTH_BYPASS === 'true';
  }

  private isBypassUser(userId: string) {
    return this.bypassEnabled && userId === 'dev-bypass-user';
  }

  private bypassProfile() {
    return {
      id: 'dev-bypass-user',
      email: 'dev@local',
      firstName: 'Dev',
      lastName: 'User',
      organization: null as string | null,
      role: UserRole.PORTFOLIO_MANAGER,
      avatar: null as string | null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  private rejectBypassWrite(): never {
    throw new BadRequestException(
      'Settings cannot be saved while AUTH_BYPASS is enabled — sign in with a real account.'
    );
  }

  /** Shape returned by GET/PATCH /users/me. Never includes the password hash. */
  private toProfile(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    organization: string | null;
    role: Role;
    avatar: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organization: user.organization,
      role: ROLE_TO_API[user.role],
      avatar: user.avatar,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private async findUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async getProfile(userId: string) {
    if (this.isBypassUser(userId)) return this.bypassProfile();
    return this.toProfile(await this.findUserOrThrow(userId));
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    await this.findUserOrThrow(userId);

    // Email is the login identifier and is @unique — check before writing so the
    // caller gets a 409 with a usable message instead of a raw P2002.
    if (dto.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (taken && taken.id !== userId) {
        throw new ConflictException('That email address is already in use');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.email !== undefined && { email: dto.email }),
        // Blank clears the field; store null rather than "" so the column has a
        // single representation for "not set".
        ...(dto.organization !== undefined && {
          organization: dto.organization || null,
        }),
        // No `role` here by design — see UpdateProfileDto. A user editing their
        // own profile must not be able to change their own permissions.
      },
    });

    return this.toProfile(updated);
  }

  async getPreferences(userId: string) {
    if (this.isBypassUser(userId)) return { ...DEFAULT_PREFERENCES };

    const user = await this.findUserOrThrow(userId);
    return {
      theme: user.theme ?? DEFAULT_PREFERENCES.theme,
      baseCurrency: user.baseCurrency ?? DEFAULT_PREFERENCES.baseCurrency,
      dateFormat: user.dateFormat ?? DEFAULT_PREFERENCES.dateFormat,
      numberFormat: user.numberFormat ?? DEFAULT_PREFERENCES.numberFormat,
      density: user.density ?? DEFAULT_PREFERENCES.density,
    };
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    await this.findUserOrThrow(userId);

    // Only the keys actually sent are written, so a partial PATCH leaves the
    // rest untouched instead of resetting them to their defaults.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.theme !== undefined && { theme: dto.theme }),
        ...(dto.baseCurrency !== undefined && { baseCurrency: dto.baseCurrency }),
        ...(dto.dateFormat !== undefined && { dateFormat: dto.dateFormat }),
        ...(dto.numberFormat !== undefined && { numberFormat: dto.numberFormat }),
        ...(dto.density !== undefined && { density: dto.density }),
      },
    });

    return this.getPreferences(userId);
  }

  async getNotifications(userId: string) {
    if (this.isBypassUser(userId)) return { ...DEFAULT_NOTIFICATIONS };

    const user = await this.findUserOrThrow(userId);
    return {
      tradeAlerts: user.notifyTradeAlerts ?? DEFAULT_NOTIFICATIONS.tradeAlerts,
      priceTargets: user.notifyPriceTargets ?? DEFAULT_NOTIFICATIONS.priceTargets,
      weeklyDigest: user.notifyWeeklyDigest ?? DEFAULT_NOTIFICATIONS.weeklyDigest,
      corporateActions:
        user.notifyCorporateActions ?? DEFAULT_NOTIFICATIONS.corporateActions,
      productUpdates:
        user.notifyProductUpdates ?? DEFAULT_NOTIFICATIONS.productUpdates,
    };
  }

  async updateNotifications(userId: string, dto: UpdateNotificationsDto) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    await this.findUserOrThrow(userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.tradeAlerts !== undefined && { notifyTradeAlerts: dto.tradeAlerts }),
        ...(dto.priceTargets !== undefined && {
          notifyPriceTargets: dto.priceTargets,
        }),
        ...(dto.weeklyDigest !== undefined && {
          notifyWeeklyDigest: dto.weeklyDigest,
        }),
        ...(dto.corporateActions !== undefined && {
          notifyCorporateActions: dto.corporateActions,
        }),
        ...(dto.productUpdates !== undefined && {
          notifyProductUpdates: dto.productUpdates,
        }),
      },
    });

    return this.getNotifications(userId);
  }

  /**
   * Verifies the current password before writing the new one, so a hijacked
   * session alone isn't enough to lock the real owner out of their account.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const user = await this.findUserOrThrow(userId);

    const matches = await bcrypt.compare(dto.currentPassword, user.password);
    if (!matches) {
      throw new UnauthorizedException('Your current password is incorrect');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'Your new password must be different from your current one'
      );
    }

    const password = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({ where: { id: userId }, data: { password } });

    return { message: 'Your password has been updated.' };
  }

  // --- Super Admin: staff account management -------------------------------
  //
  // Everything below is reachable only through routes guarded by
  // `@Roles(Role.SUPER_ADMIN)`. The service still re-checks the rules that
  // protect the account tier itself (below), because those are invariants about
  // the data — "the firm must always have a working Super Admin" — not just
  // about who called.

  /** Shape returned by the Users admin screen. Never includes the hash. */
  private toStaffUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    organization: string | null;
    role: Role;
    active: boolean;
    avatar: string | null;
    clientId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organization: user.organization,
      role: ROLE_TO_API[user.role],
      roleLabel: ROLE_LABEL[user.role],
      active: user.active,
      avatar: user.avatar,
      // True for logins created from the client add/edit form. The UI shows
      // these as read-only: they belong to a mandate, and editing them here
      // would desynchronise them from the Client record that owns them.
      isClientLogin: user.clientId !== null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Rejects any role the Users screen is not allowed to hand out — chiefly
   * SUPER_ADMIN, which is provisioned by script only so that a stolen Super
   * Admin session cannot quietly mint a second permanent one.
   */
  private assertAssignable(role: Role) {
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new ForbiddenException(
        `${ROLE_LABEL[role]} cannot be assigned from the Users screen`
      );
    }
  }

  /**
   * Guards the two ways a firm could lock itself out: demoting the last Super
   * Admin, or deactivating them. Counting on every such write is cheap next to
   * the cost of an unrecoverable account.
   */
  private async assertNotLastSuperAdmin(userId: string, action: string) {
    const remaining = await this.prisma.user.count({
      where: { role: Role.SUPER_ADMIN, active: true, id: { not: userId } },
    });

    if (remaining === 0) {
      throw new BadRequestException(
        `You cannot ${action} the last Super Admin — promote another one first.`
      );
    }
  }

  /**
   * Staff who can own a book of business, for the "Assigned Manager" selector.
   *
   * Excludes client-portal logins (they exist to read one mandate, not manage
   * others') and deactivated accounts (assigning to one would make the mandate
   * invisible to everyone but a Super Admin). ClientsService.assertOwnerIsManager
   * rejects exactly the same two cases server-side, so the dropdown and the
   * validation cannot disagree.
   *
   * Returns the minimum the UI needs — no emails-as-identity, no password
   * metadata — because this is the one user-listing a non-admin screen consumes.
   */
  async listAssignableManagers() {
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        clientId: null,
        role: { in: [Role.SUPER_ADMIN, Role.ADMIN, Role.PORTFOLIO_MANAGER, Role.RESEARCH_ANALYST] },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        organization: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    return users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      role: ROLE_TO_API[u.role],
      roleLabel: ROLE_LABEL[u.role],
      organization: u.organization,
    }));
  }

  /** Every staff login, newest first. Client logins are listed but read-only. */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => this.toStaffUser(u));
  }

  async createUser(dto: CreateUserDto) {
    const role = ROLE_TO_DB[dto.role];
    this.assertAssignable(role);

    const taken = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (taken) {
      throw new ConflictException('That email address is already in use');
    }

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        password: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        role,
        organization: dto.organization || null,
        active: dto.active ?? true,
      },
    });

    return this.toStaffUser(user);
  }

  async updateUser(actorId: string, targetId: string, dto: AdminUpdateUserDto) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('User not found');
    }

    // Client logins are owned by their Client row — ClientsService creates and
    // deletes them alongside the mandate. Editing one here would leave the two
    // out of step, so the Users screen only displays them.
    if (target.clientId) {
      throw new BadRequestException(
        'This is a client portal login. Edit it from the client record instead.'
      );
    }

    if (dto.role !== undefined) {
      const nextRole = ROLE_TO_DB[dto.role];
      this.assertAssignable(nextRole);

      // Reassigning an existing Super Admin means demotion — the new role can
      // never be SUPER_ADMIN, since assertAssignable just excluded it.
      if (target.role === Role.SUPER_ADMIN) {
        await this.assertNotLastSuperAdmin(targetId, 'demote');
      }
    }

    if (dto.active === false) {
      if (targetId === actorId) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      if (target.role === Role.SUPER_ADMIN) {
        await this.assertNotLastSuperAdmin(targetId, 'deactivate');
      }
    }

    if (dto.email && dto.email !== target.email) {
      const taken = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (taken) {
        throw new ConflictException('That email address is already in use');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.organization !== undefined && {
          organization: dto.organization || null,
        }),
        ...(dto.role !== undefined && { role: ROLE_TO_DB[dto.role] }),
        ...(dto.active !== undefined && { active: dto.active }),
        ...(dto.password !== undefined && {
          password: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        }),
      },
    });

    // A demoted or deactivated user keeps whatever access token they already
    // hold until it expires, because the role is a JWT claim. Dropping their
    // sessions makes the change take effect at the next refresh instead.
    if (dto.role !== undefined || dto.active === false || dto.password) {
      await this.prisma.session.deleteMany({ where: { userId: targetId } });
    }

    return this.toStaffUser(updated);
  }

  async deleteUser(actorId: string, targetId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (targetId === actorId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    if (target.clientId) {
      throw new BadRequestException(
        'This is a client portal login. Remove it from the client record instead.'
      );
    }

    if (target.role === Role.SUPER_ADMIN) {
      await this.assertNotLastSuperAdmin(targetId, 'delete');
    }

    // A manager who still owns mandates cannot be deleted.
    //
    // This check IS the guarantee — it is not a convenience on top of a
    // database constraint. MongoDB has no foreign keys, so `onDelete` on
    // Client.owner (see schema.prisma) is enforced by nothing at the storage
    // layer: deleting this row would leave every one of their clients pointing
    // at a user id that no longer exists, invisible to every manager and
    // reachable only by a Super Admin. Reassign the book first.
    const ownedClients = await this.prisma.client.count({
      where: { ownerId: targetId },
    });
    if (ownedClients > 0) {
      throw new BadRequestException(
        `${target.firstName} ${target.lastName} still manages ${ownedClients} ` +
          `client${ownedClients === 1 ? '' : 's'}. Reassign them to another manager first.`
      );
    }

    const ownedFamilies = await this.prisma.family.count({
      where: { ownerId: targetId },
    });
    if (ownedFamilies > 0) {
      throw new BadRequestException(
        `${target.firstName} ${target.lastName} still owns ${ownedFamilies} ` +
          `famil${ownedFamilies === 1 ? 'y' : 'ies'}. Reassign or delete them first.`
      );
    }

    // Watchlist rows and folder names carry no client data and are worthless to
    // anyone else, so they go with the account rather than blocking the delete.
    await this.prisma.watchlist.deleteMany({ where: { ownerId: targetId } });
    await this.prisma.watchlistFolder.deleteMany({ where: { ownerId: targetId } });

    await this.prisma.user.delete({ where: { id: targetId } });

    return { message: 'User deleted.' };
  }
}
