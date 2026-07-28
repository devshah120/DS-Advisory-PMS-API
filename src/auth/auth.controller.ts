import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { AuthService, RequestContext } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TwoFactorLoginDto } from './dto/two-factor-login.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Device details recorded against the session this request creates, so the
   * Settings > Security list can name it. Behind a proxy the socket address is
   * the proxy's, so the forwarded header wins when present.
   */
  private context(req: any): RequestContext {
    const forwarded = req.headers?.['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
      req.ip ||
      req.socket?.remoteAddress;

    return {
      userAgent: req.headers?.['user-agent'],
      ip: ip || undefined,
    };
  }

  /**
   * Returns tokens, or `{ twoFactorRequired: true, challengeToken }` when the
   * account has a second factor — in which case the client must complete
   * `/auth/login/2fa` before it has a usable session.
   */
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: any) {
    return this.authService.login(loginDto, this.context(req));
  }

  @Post('login/2fa')
  @HttpCode(HttpStatus.OK)
  async loginTwoFactor(@Body() dto: TwoFactorLoginDto, @Req() req: any) {
    return this.authService.loginTwoFactor(dto, this.context(req));
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string, @Req() req: any) {
    return this.authService.refreshTokens(refreshToken, this.context(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body('refreshToken') refreshToken: string) {
    return this.authService.logout(refreshToken);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}
