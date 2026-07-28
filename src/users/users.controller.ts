import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateNotificationsDto } from './dto/update-notifications.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

/**
 * Every route is scoped to the caller's own token (`/me`) — the id comes from
 * the validated JWT, never from the request body or a path param, so one user
 * can't read or edit another's settings.
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  private userId(req: any): string {
    return req.user.id;
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
}
