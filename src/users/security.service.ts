import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../common/prisma/prisma.service';

/** Shown in the authenticator app above the code. */
const TOTP_ISSUER = 'DS Advisory';

/** How many single-use recovery codes are issued at enrolment. */
const RECOVERY_CODE_COUNT = 10;

/**
 * Seconds of clock skew tolerated on either side of the current 30-second step.
 * Phone and server clocks drift, and a code typed just as it rolls over is the
 * single most common reason a correct code gets rejected. One step's worth is
 * the usual compromise — forgiving enough in practice without meaningfully
 * widening the window for guessing.
 */
const TOTP_TOLERANCE_SECONDS = 30;

@Injectable()
export class SecurityService {
  constructor(private prisma: PrismaService) {}

  private get bypassEnabled() {
    return process.env.AUTH_BYPASS === 'true';
  }

  private isBypassUser(userId: string) {
    return this.bypassEnabled && userId === 'dev-bypass-user';
  }

  /**
   * The synthetic AUTH_BYPASS user has no database row, so security writes have
   * nowhere to land. Rejecting explicitly gives a readable 400 instead of the
   * opaque 500 a Prisma "record not found" would produce.
   */
  private rejectBypassWrite(): never {
    throw new BadRequestException(
      'Security settings cannot be changed while AUTH_BYPASS is enabled — sign in with a real account.'
    );
  }

  private async findUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // --- Two-factor authentication -------------------------------------------

  async getStatus(userId: string) {
    if (this.isBypassUser(userId)) {
      return { enabled: false, enabledAt: null, recoveryCodesRemaining: 0 };
    }

    const user = await this.findUserOrThrow(userId);
    return {
      enabled: user.twoFactorEnabled,
      enabledAt: user.twoFactorEnabledAt,
      recoveryCodesRemaining: user.twoFactorRecoveryCodes.length,
    };
  }

  /**
   * Step 1 of enrolment: mint a secret and return it as a scannable QR code.
   *
   * The secret is persisted immediately but `twoFactorEnabled` stays false, so
   * an abandoned setup never locks anyone out — the login gate reads the flag,
   * not the secret. Re-running this replaces any unconfirmed secret, which is
   * what makes "close the modal and start over" work.
   */
  async startTwoFactorSetup(userId: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const user = await this.findUserOrThrow(userId);
    if (user.twoFactorEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled. Disable it first to re-enrol.'
      );
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({
      issuer: TOTP_ISSUER,
      label: user.email,
      secret,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
    });

    return {
      secret,
      otpauthUrl,
      // Data URI so the client can render it in an <img> with no QR library.
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }),
    };
  }

  /**
   * Step 2: prove the authenticator is working before the factor goes live.
   * Only on a valid code do we flip the flag and issue recovery codes — that
   * ordering is what stops a mistyped or unscanned secret from locking the user
   * out of their own account.
   */
  async confirmTwoFactorSetup(userId: string, code: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const user = await this.findUserOrThrow(userId);
    if (user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled.');
    }
    if (!user.twoFactorSecret) {
      throw new BadRequestException(
        'Start the setup again — no pending two-factor secret was found.'
      );
    }

    if (!this.verifyTotp(code, user.twoFactorSecret)) {
      throw new BadRequestException("That code isn't valid. Check your app and try again.");
    }

    // Returned once, in the clear, and never again — only hashes are stored.
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      this.generateRecoveryCode()
    );
    const hashed = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10)));

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorEnabledAt: new Date(),
        twoFactorRecoveryCodes: hashed,
      },
    });

    return { enabled: true, recoveryCodes };
  }

  /**
   * Turning the factor off is a downgrade in account security, so it demands
   * the account password — a hijacked session alone shouldn't be able to strip
   * the protection that exists to contain hijacked sessions.
   */
  async disableTwoFactor(userId: string, password: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const user = await this.findUserOrThrow(userId);
    if (!user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is not enabled.');
    }

    if (!(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Your password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorEnabledAt: null,
        twoFactorRecoveryCodes: [],
      },
    });

    return { enabled: false };
  }

  /** Replaces every unused recovery code. Also password-gated, for the same reason. */
  async regenerateRecoveryCodes(userId: string, password: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const user = await this.findUserOrThrow(userId);
    if (!user.twoFactorEnabled) {
      throw new BadRequestException(
        'Enable two-factor authentication before generating recovery codes.'
      );
    }

    if (!(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Your password is incorrect');
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      this.generateRecoveryCode()
    );
    const hashed = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10)));

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: hashed },
    });

    return { recoveryCodes };
  }

  /** Verifies a 6-digit TOTP against a secret. Used here and by AuthService. */
  verifyTotp(code: string, secret: string) {
    const normalized = (code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    try {
      return verifySync({
        token: normalized,
        secret,
        epochTolerance: TOTP_TOLERANCE_SECONDS,
      }).valid;
    } catch {
      // otplib throws on a malformed secret rather than returning false.
      return false;
    }
  }

  /**
   * Consumes a recovery code if it matches an unused one. Single-use: the
   * matching hash is removed, so the same slip of paper can't be replayed.
   */
  async consumeRecoveryCode(userId: string, code: string) {
    const normalized = (code || '').replace(/\s/g, '').toUpperCase();
    if (!normalized) return false;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return false;

    const remaining = [...user.twoFactorRecoveryCodes];
    for (let i = 0; i < remaining.length; i++) {
      if (await bcrypt.compare(normalized, remaining[i])) {
        remaining.splice(i, 1);
        await this.prisma.user.update({
          where: { id: userId },
          data: { twoFactorRecoveryCodes: remaining },
        });
        return true;
      }
    }
    return false;
  }

  /** Format: XXXX-XXXX, from an unambiguous alphabet (no O/0, I/1). */
  private generateRecoveryCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const pick = () =>
      Array.from(
        { length: 4 },
        () => alphabet[crypto.randomInt(0, alphabet.length)]
      ).join('');
    return `${pick()}-${pick()}`;
  }

  // --- Sessions -------------------------------------------------------------

  /**
   * Lists the caller's signed-in devices, newest activity first, with the one
   * making this request marked so the UI can label it and hide its Revoke
   * button. Expired rows are swept here rather than by a scheduled job — the
   * list is the only place staleness is visible, so it's the natural place to
   * clean up.
   */
  async listSessions(userId: string, currentRefreshToken?: string) {
    if (this.isBypassUser(userId)) return [];

    await this.prisma.session.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });

    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });

    const currentHash = currentRefreshToken
      ? this.hashToken(currentRefreshToken)
      : null;

    return sessions.map((s) => ({
      id: s.id,
      browser: s.browser ?? 'Unknown browser',
      os: s.os ?? 'Unknown device',
      ip: s.ip,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
      current: currentHash !== null && s.refreshTokenHash === currentHash,
    }));
  }

  /**
   * Ends one session. Scoped by userId as well as id so a valid token for one
   * account can't be used to revoke another account's device.
   */
  async revokeSession(userId: string, sessionId: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const result = await this.prisma.session.deleteMany({
      where: { id: sessionId, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('That session no longer exists');
    }

    return { success: true, id: sessionId };
  }

  /** Signs out every other device, leaving the caller's own session intact. */
  async revokeOtherSessions(userId: string, currentRefreshToken?: string) {
    if (this.isBypassUser(userId)) this.rejectBypassWrite();

    const result = await this.prisma.session.deleteMany({
      where: {
        userId,
        ...(currentRefreshToken && {
          refreshTokenHash: { not: this.hashToken(currentRefreshToken) },
        }),
      },
    });

    return { success: true, revoked: result.count };
  }

  /**
   * SHA-256 rather than bcrypt: sessions are looked up *by* this value on every
   * token refresh, which needs an indexed equality match. The input is a
   * 200-plus-character random JWT, not a guessable password, so the slow hash
   * bcrypt exists to provide buys nothing here.
   */
  hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
