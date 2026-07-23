import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

/** How long a reset code stays valid, and how many wrong tries are allowed. */
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService
  ) {}

  private get bypassEnabled() {
    return process.env.AUTH_BYPASS === 'true';
  }

  private bypassUser(email: string, firstName = 'Dev', lastName = 'User') {
    return {
      id: 'dev-bypass-user',
      email: email || 'dev@local',
      firstName,
      lastName,
      role: 'PORTFOLIO_MANAGER',
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    if (this.bypassEnabled) {
      return this.generateTokens(this.bypassUser(email));
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.generateTokens(user);
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

  async refreshTokens(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
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

  private generateTokens(user: any) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
    });

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
}
