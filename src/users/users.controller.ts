import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/auth/roles.guard';
import { UsersService } from './users.service';
import { SecurityService } from './security.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateNotificationsDto } from './dto/update-notifications.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ConfirmTwoFactorDto, PasswordConfirmDto } from './dto/two-factor.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';

/**
 * The `/me` routes are scoped to the caller's own token — the id comes from the
 * validated JWT, never from the request body or a path param, so one user can't
 * read or edit another's settings.
 *
 * The staff-management routes at the bottom are the exception: they take a
 * target id, and are restricted to SUPER_ADMIN by `RolesGuard`.
 */
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private securityService: SecurityService
  ) {}

  private userId(req: any): string {
    return req.user.id;
  }

  /**
   * The refresh token identifying the calling device, sent as `x-refresh-token`.
   * Only used to mark which row in the session list is "this device" and to
   * spare it from "sign out everywhere" — never to authorize anything, which is
   * the access token's job.
   */
  private refreshToken(req: any): string | undefined {
    const header = req.headers?.['x-refresh-token'];
    return typeof header === 'string' && header ? header : undefined;
  }

  @Get('me')
  getProfile(@Req() req: any) {
    return this.usersService.getProfile(this.userId(req));
  }

  @Patch('me')
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(this.userId(req), dto);
  }

  @Get('me/preferences')
  getPreferences(@Req() req: any) {
    return this.usersService.getPreferences(this.userId(req));
  }

  @Patch('me/preferences')
  updatePreferences(@Req() req: any, @Body() dto: UpdatePreferencesDto) {
    return this.usersService.updatePreferences(this.userId(req), dto);
  }

  @Get('me/notifications')
  getNotifications(@Req() req: any) {
    return this.usersService.getNotifications(this.userId(req));
  }

  @Patch('me/notifications')
  updateNotifications(@Req() req: any, @Body() dto: UpdateNotificationsDto) {
    return this.usersService.updateNotifications(this.userId(req), dto);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(this.userId(req), dto);
  }

  // --- Two-factor authentication ---

  @Get('me/2fa')
  getTwoFactorStatus(@Req() req: any) {
    return this.securityService.getStatus(this.userId(req));
  }

  /** Mints a secret and QR code. Does not enable anything on its own. */
  @Post('me/2fa/setup')
  @HttpCode(HttpStatus.OK)
  startTwoFactorSetup(@Req() req: any) {
    return this.securityService.startTwoFactorSetup(this.userId(req));
  }

  /** Verifies the first code, then turns the factor on and returns recovery codes. */
  @Post('me/2fa/confirm')
  @HttpCode(HttpStatus.OK)
  confirmTwoFactor(@Req() req: any, @Body() dto: ConfirmTwoFactorDto) {
    return this.securityService.confirmTwoFactorSetup(this.userId(req), dto.code);
  }

  @Post('me/2fa/disable')
  @HttpCode(HttpStatus.OK)
  disableTwoFactor(@Req() req: any, @Body() dto: PasswordConfirmDto) {
    return this.securityService.disableTwoFactor(this.userId(req), dto.password);
  }

  @Post('me/2fa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  regenerateRecoveryCodes(@Req() req: any, @Body() dto: PasswordConfirmDto) {
    return this.securityService.regenerateRecoveryCodes(
      this.userId(req),
      dto.password
    );
  }

  // --- Sessions ---

  @Get('me/sessions')
  listSessions(@Req() req: any) {
    return this.securityService.listSessions(
      this.userId(req),
      this.refreshToken(req)
    );
  }

  /** Signs out every device except the one making the request. */
  @Delete('me/sessions')
  revokeOtherSessions(@Req() req: any) {
    return this.securityService.revokeOtherSessions(
      this.userId(req),
      this.refreshToken(req)
    );
  }

  @Delete('me/sessions/:id')
  revokeSession(@Req() req: any, @Param('id') id: string) {
    return this.securityService.revokeSession(this.userId(req), id);
  }

  // --- Staff management (Super Admin only) ---
  //
  // Declared after every `me/...` route on purpose: Nest matches in
  // declaration order, so a `:id` pattern listed first would swallow `me`.

  @Get()
  @Roles(Role.SUPER_ADMIN)
  listUsers() {
    return this.usersService.listUsers();
  }

  /**
   * Staff who can hold a book — the "Assigned Manager" dropdown's options.
   *
   * Declared before `@Patch(':id')` for the same declaration-order reason as
   * the block comment above. Super-Admin-only, because assignment is: a manager
   * has no reason to enumerate their colleagues, and this would otherwise be a
   * staff directory available to every login.
   */
  @Get('assignable')
  @Roles(Role.SUPER_ADMIN)
  assignableManagers() {
    return this.usersService.listAssignableManagers();
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  createUser(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  updateUser(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto
  ) {
    return this.usersService.updateUser(this.userId(req), id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  deleteUser(@Req() req: any, @Param('id') id: string) {
    return this.usersService.deleteUser(this.userId(req), id);
  }
}
