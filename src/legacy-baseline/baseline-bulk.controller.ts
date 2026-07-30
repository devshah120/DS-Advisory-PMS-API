import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BaselineService } from './baseline.service';

/**
 * House-wide baseline actions — split from BaselineController
 * (`clients/:clientId/baseline`) because "do this for every client" isn't
 * scoped to one client id and would collide with that route's prefix.
 */
@Controller('clients/baselines')
@UseGuards(JwtAuthGuard)
export class BaselineBulkController {
  constructor(private baselineService: BaselineService) {}

  /**
   * Auto-seeds a baseline for every ACTIVE client that doesn't have one yet,
   * from their current Holding rows valued at the 30-June-2026 close (or
   * recorded average cost when no price bar exists). Never overwrites an
   * existing baseline — no admin gate needed, unlike the amend path.
   */
  @Post('auto-seed')
  autoSeedAll() {
    return this.baselineService.autoSeedAllClients();
  }
}
