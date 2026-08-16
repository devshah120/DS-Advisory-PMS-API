import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UAParser } from 'ua-parser-js';
import { PrismaService } from '../common/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SecurityService } from '../users/security.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TwoFactorLoginDto } from './dto/two-factor-login.dto';

/** How long a reset code stays valid, and how many wrong tries are allowed. */
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** Lifetime of a refresh token, mirrored onto the Session row it creates. */
const REFRESH_TOKEN_DAYS = 7;

/**
 * How long the user has to enter their 2FA code before the challenge expires.
 * Short on purpose: it is a bearer token that has already cleared the password
 * check, so it should not outlive the screen that consumes it.
 */
const TWO_FACTOR_CHALLENGE_TTL = '5m';

/**
 * Marks a JWT as "password accepted, awaiting second factor". Checked when the
 * challenge is redeemed so a normal access token can't be passed off as one.
 */
const TWO_FACTOR_PURPOSE = '2fa_challenge';

/** Details of the calling device, passed down from the controller. */
export interface RequestContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
    private securityService: SecurityService
  ) {}

  private get bypassEnabled() {
    return process.env.AUTH_BYPASS === 'true';
  }

  /**
   * A deactivated login must not be able to obtain or renew tokens — otherwise
   * `active: false` from the Users screen would be cosmetic, and a suspended
   * Portfolio Manager could keep working until their refresh token aged out.
   */
  private assertActive(user: { active: boolean }) {
    if (!user.active) {
      throw new UnauthorizedException(
        'This account has been deactivated. Contact your administrator.'
      );
    }
  }

  /**
   * The AUTH_BYPASS identity (local development only).
   *
   * Note what ownership scoping does to this: `dev-bypass-user` is not a real
   * User row and therefore owns no clients, so under AUTH_BYPASS the app now
   * shows an EMPTY book rather than the whole firm's. That is correct — it is
   * the same rule every manager gets — but it looks like data loss if you hit it
   * unaware. Sign in as a real manager to see a book, or promote this to
   * SUPER_ADMIN below if a bypass session needs the holistic view.
   */
  private bypassUser(email: string, firstName = 'Dev', lastName = 'User') {
    return {
      id: 'dev-bypass-user',
      email: email || 'dev@local',
      firstName,
      lastName,
      role: 'PORTFOLIO_MANAGER',
      clientId: null as string | null,
    };
  }

  async login(loginDto: LoginDto, context: RequestContext = {}) {
    const { email, password } = loginDto;

    if (this.bypassEnabled) {
      return this.generateTokens(this.bypassUser(email), context);
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Checked only after the password verifies, so the disabled-account message
    // is never shown to someone who couldn't sign in anyway — it tells a real
    // owner why they're locked out without confirming the address to a guesser.
    this.assertActive(user);

    // Password was correct but the account has a second factor: hand back a
    // short-lived challenge instead of tokens. No session is recorded yet —
    // the sign-in isn't complete until the code is verified.
    if (user.twoFactorEnabled) {
      return {
        twoFactorRequired: true as const,
        challengeToken: this.jwtService.sign(
          { sub: user.id, purpose: TWO_FACTOR_PURPOSE },
          { expiresIn: TWO_FACTOR_CHALLENGE_TTL }
        ),
      };
    }

    return this.generateTokens(user, context);
  }

  /**
   * Step 2 of a two-factor login: exchange the challenge for real tokens.
   *
   * The `purpose` claim is checked explicitly so an access or refresh token
   * can't be replayed here as a challenge — without it, any valid token signed
   * with the same secret would satisfy this endpoint.
   */
  async loginTwoFactor(dto: TwoFactorLoginDto, context: RequestContext = {}) {
    let payload: any;
    try {
      payload = this.jwtService.verify(dto.challengeToken);
    } catch {
      throw new UnauthorizedException(
        'Your sign-in attempt has expired. Please sign in again.'
      );
    }

    if (payload?.purpose !== TWO_FACTOR_PURPOSE || !payload?.sub) {
      throw new UnauthorizedException('Invalid sign-in attempt. Please start again.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new UnauthorizedException('Invalid sign-in attempt. Please start again.');
    }

    // Re-checked here as well as in `login`: the account could have been
    // deactivated in the minutes between issuing the challenge and redeeming it.
    this.assertActive(user);

    const valid = dto.isRecoveryCode
      ? await this.securityService.consumeRecoveryCode(user.id, dto.code)
      : this.securityService.verifyTotp(dto.code, user.twoFactorSecret);

    if (!valid) {
      throw new UnauthorizedException(
        dto.isRecoveryCode
          ? 'That recovery code is not valid or has already been used.'
          : "That code isn't valid. Check your authenticator app and try again."
      );
    }

    return this.generateTokens(user, context);
  }

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (user && (await bcrypt.compare(password, user.password))) {
      const { password, ...result } = user;
      return result;
    }

    return null;
  }

  /**
   * Exchanges a refresh token for a fresh pair, and is what makes "Revoke"
   * actually end a session: the token must still match a Session row, so once
   * that row is deleted the device can no longer refresh and is signed out as
   * soon as its short-lived access token expires.
   */
  async refreshTokens(refreshToken: string, context: RequestContext = {}) {
    if (this.bypassEnabled) {
      try {
        const payload = this.jwtService.verify(refreshToken);
        return this.generateTokens(this.bypassUser(payload.email), context);
      } catch {
        throw new UnauthorizedException('Invalid refresh token');
      }
    }

    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Deactivation takes effect at the next refresh. The role is also re-read
    // from the row here (not carried over from the old token's claim), so a
    // demotion applies without waiting for the user to sign in again.
    this.assertActive(user);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.securityService.hashToken(refreshToken) },
    });

    if (!session || session.userId !== user.id) {
      throw new UnauthorizedException('This session has been signed out');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await this.prisma.session.delete({ where: { id: session.id } });
      throw new UnauthorizedException('This session has expired');
    }

    // Rotate in place rather than creating a new row, so the device keeps one
    // stable entry in the session list across refreshes instead of multiplying.
    return this.generateTokens(user, context, session.id);
  }

  /**
   * Step 1 of the reset flow: issue a one-time code and email it.
   *
   * The response is intentionally identical whether or not the email matches a
   * real account, so this endpoint can't be used to enumerate users. A code is
   * only generated/sent when the account actually exists; otherwise we return
   * quietly. The plaintext OTP is never stored — only its hash.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const generic = {
      message: 'If an account exists for that email, a reset code has been sent.',
    };

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) {
      return generic;
    }

    // 6-digit numeric code, zero-padded.
    const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // Only the newest request is valid — drop any earlier codes for this email.
    await this.prisma.passwordReset.deleteMany({ where: { email } });
    await this.prisma.passwordReset.create({
      data: { email, otpHash, expiresAt },
    });

    await this.mailService.sendPasswordResetOtp(email, otp, OTP_TTL_MINUTES);

    return generic;
  }

  /**
   * Step 2: verify the code and set the new password. On success every reset
   * row for the email is cleared so the code can't be reused.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase();

    const record = await this.prisma.passwordReset.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired code. Please request a new one.');
    }

    if (record.expiresAt.getTime() < Date.now()) {
      await this.prisma.passwordReset.deleteMany({ where: { email } });
      throw new BadRequestException('This code has expired. Please request a new one.');
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.passwordReset.deleteMany({ where: { email } });
      throw new BadRequestException('Too many attempts. Please request a new code.');
    }

    const matches = await bcrypt.compare(dto.otp, record.otpHash);
    if (!matches) {
      await this.prisma.passwordReset.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid code. Please check and try again.');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Shouldn't happen — a record only exists for real users — but guard anyway.
      await this.prisma.passwordReset.deleteMany({ where: { email } });
      throw new BadRequestException('Invalid or expired code. Please request a new one.');
    }

    const password = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { email }, data: { password } });
    await this.prisma.passwordReset.deleteMany({ where: { email } });

    return { message: 'Your password has been reset. You can now sign in.' };
  }

  /**
   * Issues a token pair and records the device against it.
   *
   * `sessionId` rotates an existing row (a refresh from a known device);
   * omitting it creates one (a fresh sign-in). Session tracking is skipped
   * entirely under AUTH_BYPASS, where the user has no database row to relate to.
   */
  private async generateTokens(
    user: any,
    context: RequestContext = {},
    sessionId?: string
  ) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      // The mandate a client-portal login (role VIEWER) is pinned to. Carried in
      // the token so ownership scoping can resolve a VIEWER's single client
      // without a database round-trip on every request — see
      // common/ownership-scope.ts, whose VIEWER branch reads exactly this.
      //
      // Null for staff, who are scoped by `ownerId` instead. It is safe in a
      // JWT: a client id is not a secret to the client it belongs to, and the
      // claim is signed, so it cannot be swapped for another mandate's id.
      clientId: user.clientId ?? null,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      {
        ...payload,
        // A random claim so two logins from the same account never produce an
        // identical refresh token. Without it, signing in twice in the same
        // second yields the same JWT, and `refreshTokenHash` is @unique — the
        // second device's session row would collide instead of being created.
        //
        // This is a payload claim, not a sign option: jsonwebtoken validates
        // its options object strictly and throws on anything it doesn't own.
        jti: crypto.randomUUID(),
      },
      { expiresIn: `${REFRESH_TOKEN_DAYS}d` }
    );

    if (!this.bypassEnabled) {
      const device = this.parseUserAgent(context.userAgent);
      const data = {
        refreshTokenHash: this.securityService.hashToken(refreshToken),
        userAgent: context.userAgent ?? null,
        browser: device.browser,
        os: device.os,
        ip: context.ip ?? null,
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
      };

      if (sessionId) {
        await this.prisma.session.update({ where: { id: sessionId }, data });
      } else {
        await this.prisma.session.create({ data: { ...data, userId: user.id } });
      }
    }

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  /**
   * Turns a User-Agent into the two labels the session list shows. Deliberately
   * coarse — this exists so a user can recognise their own devices ("Safari ·
   * iPhone"), not to fingerprint them.
   */
  private parseUserAgent(userAgent?: string) {
    if (!userAgent) return { browser: null, os: null };

    const { browser, os } = new UAParser(userAgent).getResult();
    return {
      browser: browser.name ?? null,
      // Version is included because "Windows" alone reads oddly next to
      // "iOS 17"; both come straight from the parser.
      os: os.name ? [os.name, os.version].filter(Boolean).join(' ') : null,
    };
  }

  /** Ends the calling device's session. Signing out elsewhere is a Settings action. */
  async logout(refreshToken?: string) {
    if (refreshToken && !this.bypassEnabled) {
      await this.prisma.session.deleteMany({
        where: { refreshTokenHash: this.securityService.hashToken(refreshToken) },
      });
    }
    return { success: true };
  }
}
