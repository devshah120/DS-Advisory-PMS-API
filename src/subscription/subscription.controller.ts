import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { Role, SubscriptionStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/auth/roles.guard';
import { SubscriptionService } from './subscription.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Seat plan and payment configuration. SUPER_ADMIN only, at the controller
 * level — every route here either exposes pricing config or edits another
 * user's billing state, and neither is a Portfolio Manager's business.
 *
 * The Razorpay SECRET is never returned by any route on this controller. See
 * SubscriptionService.getSettings.
 */
@Controller('subscription')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class SubscriptionController {
  constructor(private subscriptions: SubscriptionService) {}

  @Get('settings')
  getSettings() {
    return this.subscriptions.getSettings();
  }

  @Patch('settings')
  updateSettings(@Req() req: any, @Body() dto: UpdateSettingsDto) {
    return this.subscriptions.updateSettings(req.user.id, dto);
  }

  /** Every billable seat, with trial/period countdowns resolved. */
  @Get('subscribers')
  listSubscribers() {
    return this.subscriptions.listSubscribers();
  }

  @Patch('subscribers/:id')
  updateSubscriber(
    @Param('id') id: string,
    @Body()
    body: {
      status?: SubscriptionStatus;
      extendDays?: number;
      billingCycle?: 'MONTHLY' | 'YEARLY';
    }
  ) {
    return this.subscriptions.updateSubscriber(id, body);
  }
}
