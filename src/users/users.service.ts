import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma/prisma.service';
import { UpdateProfileDto, UserRole } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateNotificationsDto } from './dto/update-notifications.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

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

/** API contract is lowercase; Prisma's Role enum is uppercase. */
const ROLE_TO_API: Record<Role, UserRole> = {
  ADMIN: UserRole.ADMIN,
  PORTFOLIO_MANAGER: UserRole.PORTFOLIO_MANAGER,
  RESEARCH_ANALYST: UserRole.RESEARCH_ANALYST,
  VIEWER: UserRole.VIEWER,
};

const ROLE_TO_DB: Record<UserRole, Role> = {
  [UserRole.ADMIN]: Role.ADMIN,
  [UserRole.PORTFOLIO_MANAGER]: Role.PORTFOLIO_MANAGER,
  [UserRole.RESEARCH_ANALYST]: Role.RESEARCH_ANALYST,
  [UserRole.VIEWER]: Role.VIEWER,
};

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
        ...(dto.role !== undefined && { role: ROLE_TO_DB[dto.role] }),
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

    const password = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { password } });

    return { message: 'Your password has been updated.' };
  }
}
