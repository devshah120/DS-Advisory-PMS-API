import { Injectable, NotFoundException } from '@nestjs/common';
import { Role, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { decryptSecret, encryptSecret, lastFour } from '../common/crypto.util';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/** The singleton row's fixed id — see the AppSetting schema note. */
const SETTINGS_ID = 'app';

/**
 * What the settings endpoint returns. Deliberately NOT the Prisma row:
 * `razorpayKeySecret` is absent from this shape by construction, so a future
 * edit can't accidentally start leaking it by spreading the record.
 */
export interface AppSettingsView {
  trialDays: number;
  monthlyAmount: number;
  yearlyAmount: number;
  currency: string;
  razorpayKeyId: string | null;
  razorpayMode: string;
  /** Proof a secret exists, without the secret. */
  razorpaySecretSet: boolean;
  razorpaySecretLast4: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  /**
   * The settings row, created with defaults on first read.
   *
   * Upsert rather than findUnique-then-throw so a fresh deployment works with
   * no seeding step: the first Super Admin to open the screen materialises the
   * documented defaults instead of meeting a 404.
   */
  private async loadRaw() {
    return this.prisma.appSetting.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
  }

  /** Public view — never includes the secret. */
  async getSettings(): Promise<AppSettingsView> {
    const row = await this.loadRaw();

    let updatedBy: string | null = null;
    if (row.updatedById) {
      // Best-effort: the id is stored without a relation precisely so the audit
      // line survives the user being deleted, so a miss here is expected.
      const user = await this.prisma.user.findUnique({
        where: { id: row.updatedById },
        select: { firstName: true, lastName: true },
      });
      if (user) updatedBy = `${user.firstName} ${user.lastName}`.trim();
    }

    return {
      trialDays: row.trialDays,
      monthlyAmount: row.monthlyAmount,
      yearlyAmount: row.yearlyAmount,
      currency: row.currency,
      razorpayKeyId: row.razorpayKeyId ?? null,
      razorpayMode: row.razorpayMode,
      razorpaySecretSet: Boolean(row.razorpayKeySecret),
      razorpaySecretLast4: row.razorpaySecretLast4 ?? null,
      updatedAt: row.updatedAt,
      updatedBy,
    };
  }

  /**
   * The decrypted secret, for server-side Razorpay calls only.
   *
   * Never route this through a controller. It exists so the payment code can
   * sign requests; everything user-facing goes through `getSettings`.
   */
  async getRazorpayCredentials(): Promise<{ keyId: string; keySecret: string } | null> {
    const row = await this.loadRaw();
    const keySecret = decryptSecret(row.razorpayKeySecret);
    if (!row.razorpayKeyId || !keySecret) return null;
    return { keyId: row.razorpayKeyId, keySecret };
  }

  async updateSettings(actorId: string, dto: UpdateSettingsDto): Promise<AppSettingsView> {
    await this.loadRaw();

    const data: Record<string, unknown> = { updatedById: actorId };

    // Explicit undefined checks, not truthiness: 0 is a valid trialDays and a
    // valid amount ("free trial off", "yearly plan not offered"), and `if (dto.x)`
    // would silently discard all three.
    if (dto.trialDays !== undefined) data.trialDays = dto.trialDays;
    if (dto.monthlyAmount !== undefined) data.monthlyAmount = dto.monthlyAmount;
    if (dto.yearlyAmount !== undefined) data.yearlyAmount = dto.yearlyAmount;
    if (dto.currency !== undefined) data.currency = dto.currency.toUpperCase();
    if (dto.razorpayKeyId !== undefined) data.razorpayKeyId = dto.razorpayKeyId || null;
    if (dto.razorpayMode !== undefined) data.razorpayMode = dto.razorpayMode;

    // Three distinct cases, which is why this is not a one-liner:
    //   · undefined  — field not sent; leave the stored secret untouched.
    //   · ''         — sent empty; the operator is clearing the key.
    //   · a value    — encrypt it, and cache its tail for display.
    if (dto.razorpayKeySecret !== undefined) {
      if (dto.razorpayKeySecret === '') {
        data.razorpayKeySecret = null;
        data.razorpaySecretLast4 = null;
      } else {
        data.razorpayKeySecret = encryptSecret(dto.razorpayKeySecret);
        data.razorpaySecretLast4 = lastFour(dto.razorpayKeySecret);
      }
    }

    await this.prisma.appSetting.update({ where: { id: SETTINGS_ID }, data });
    return this.getSettings();
  }

  /**
   * The trial window for a manager being created now, or null when trials are
   * switched off (trialDays = 0).
   *
   * Called by UsersService at creation time. The value is stamped onto the user
   * and never recomputed — see the schema note on why changing trialDays later
   * must not move an existing manager's deadline.
   */
  async trialEndsAtForNewManager(): Promise<Date | null> {
    const row = await this.loadRaw();
    if (row.trialDays <= 0) return null;

    const end = new Date();
    end.setDate(end.getDate() + row.trialDays);
    return end;
  }

  /**
   * Every billable seat with its live status.
   *
   * The stored `subscriptionStatus` is the LAST WRITTEN state, not necessarily
   * the current one: a trial that lapsed overnight still reads TRIALING until
   * something rewrites it. Rather than depend on a sweep having run, the
   * effective status is derived from the dates on read, so the screen is
   * correct even if no scheduler exists yet.
   */
  async listSubscribers() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: [Role.PORTFOLIO_MANAGER, Role.RESEARCH_ANALYST] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        active: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        billingCycle: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((u) => {
      const effective = this.effectiveStatus(u);
      return {
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        active: u.active,
        status: effective,
        trialEndsAt: u.trialEndsAt,
        currentPeriodEnd: u.currentPeriodEnd,
        billingCycle: u.billingCycle,
        daysRemaining: this.daysRemaining(u, effective),
        createdAt: u.createdAt,
      };
    });
  }

  /**
   * Derives the status the dates actually imply.
   *
   * Order matters: CANCELLED is an administrative decision and outranks any
   * date, so it is checked before the expiry arithmetic.
   */
  private effectiveStatus(u: {
    subscriptionStatus: SubscriptionStatus | null;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
  }): SubscriptionStatus | null {
    if (!u.subscriptionStatus) return null;
    if (u.subscriptionStatus === SubscriptionStatus.CANCELLED) return u.subscriptionStatus;

    const now = new Date();

    if (u.subscriptionStatus === SubscriptionStatus.TRIALING) {
      if (u.trialEndsAt && u.trialEndsAt.getTime() < now.getTime()) {
        return SubscriptionStatus.EXPIRED;
      }
      return SubscriptionStatus.TRIALING;
    }

    if (u.subscriptionStatus === SubscriptionStatus.ACTIVE) {
      if (u.currentPeriodEnd && u.currentPeriodEnd.getTime() < now.getTime()) {
        return SubscriptionStatus.PAST_DUE;
      }
      return SubscriptionStatus.ACTIVE;
    }

    return u.subscriptionStatus;
  }

  /** Whole days left on whichever window applies; null when nothing is running. */
  private daysRemaining(
    u: { trialEndsAt: Date | null; currentPeriodEnd: Date | null },
    status: SubscriptionStatus | null
  ): number | null {
    const deadline =
      status === SubscriptionStatus.TRIALING
        ? u.trialEndsAt
        : status === SubscriptionStatus.ACTIVE
          ? u.currentPeriodEnd
          : null;

    if (!deadline) return null;

    const ms = deadline.getTime() - Date.now();
    // Ceil, so "expires in 4 hours" reads as 1 day left rather than 0.
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }

  /**
   * Super Admin overrides for one manager's seat — extend a trial, mark a seat
   * paid after an offline bank transfer, or switch it off.
   *
   * Deliberately manual: this is the escape hatch that keeps the firm running
   * when Razorpay is misconfigured or a customer pays by another route.
   */
  async updateSubscriber(
    userId: string,
    input: { status?: SubscriptionStatus; extendDays?: number; billingCycle?: 'MONTHLY' | 'YEARLY' }
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const data: Record<string, unknown> = {};
    if (input.status) data.subscriptionStatus = input.status;
    if (input.billingCycle) data.billingCycle = input.billingCycle;

    if (input.extendDays) {
      // Extend from whichever window is live, or from today when the seat has
      // already lapsed — extending from a past date would add days that are
      // already spent and appear to do nothing.
      const status = this.effectiveStatus(user);
      const isTrial = status === SubscriptionStatus.TRIALING || status === SubscriptionStatus.EXPIRED;
      const base = isTrial ? user.trialEndsAt : user.currentPeriodEnd;
      const from = base && base.getTime() > Date.now() ? new Date(base) : new Date();
      from.setDate(from.getDate() + input.extendDays);

      if (isTrial) {
        data.trialEndsAt = from;
        data.subscriptionStatus = input.status ?? SubscriptionStatus.TRIALING;
      } else {
        data.currentPeriodEnd = from;
        data.subscriptionStatus = input.status ?? SubscriptionStatus.ACTIVE;
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data });
    return { ok: true };
  }
}
