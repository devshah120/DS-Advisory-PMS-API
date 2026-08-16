import { Controller, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BaselineService } from './baseline.service';
import { Roles, RolesGuard } from '../common/auth/roles.guard';

/**
 * House-wide baseline actions — split from BaselineController
 * (`clients/:clientId/baseline`) because "do this for every client" isn't
 * scoped to one client id and would collide with that route's prefix.
 */
@Controller('clients/baselines')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BaselineBulkController {
  constructor(private baselineService: BaselineService) {}

  /**
   * Auto-seeds a baseline for every ACTIVE client that doesn't have one yet,
   * from their current Holding rows valued at the 30-June-2026 close (or
   * recorded average cost when no price bar exists). Never overwrites an
   * existing baseline.
   *
   * Restricted to SUPER_ADMIN now that managers are isolated from one another.
   * This is a genuinely house-wide maintenance sweep — it writes baselines for
   * every manager's clients in one pass — so it is neither meaningful nor
   * appropriate for a single manager to trigger across books they cannot see.
   * Scoping it per-caller was the alternative and is worse: it would silently
   * seed only part of the firm and read as though it had done the whole job.
   */
  @Post('auto-seed')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  autoSeedAll() {
    return this.baselineService.autoSeedAllClients();
  }
}
