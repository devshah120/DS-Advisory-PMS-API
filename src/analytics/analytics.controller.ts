import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExposureService } from './services/exposure.service';
import { HouseService } from './services/house.service';
import { PerformanceService } from './services/performance.service';
import { Denominator, Dimension } from './calculators/types';
import { HeatmapDimension, HeatmapMetric } from './calculators/overlap';
import { Actor } from '../common/ownership-scope';

type AuthedRequest = { user: Actor };

const DIMENSIONS: Dimension[] = ['sector', 'industry', 'region', 'country', 'assetClass'];
const HEATMAP_DIMS: HeatmapDimension[] = ['client', 'sector', 'industry', 'ticker', 'region'];
const HEATMAP_METRICS: HeatmapMetric[] = ['weight', 'marketValue', 'gainLoss', 'return'];

/** Rejects unknown values rather than silently defaulting them to something plausible. */
function oneOf<T extends string>(value: string | undefined, allowed: T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new BadRequestException(`Expected one of: ${allowed.join(', ')} — got "${value}"`);
  }
  return value as T;
}

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(
    private exposure: ExposureService,
    private house: HouseService,
    private performance: PerformanceService,
  ) {}

  // ── Client ────────────────────────────────────────────────────────────────

  @Get('client/:id/allocation')
  allocation(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Query('dim') dim?: string,
    @Query('lookThrough') lookThrough?: string,
    @Query('denominator') denominator?: string,
  ) {
    return this.exposure.allocation(id, oneOf(dim, DIMENSIONS, 'sector'), {
      // Undefined means "let the service decide" — it defaults look-through ON
      // for region/country, where omitting it would report 0% China exposure.
      lookThrough: lookThrough === undefined ? undefined : lookThrough === 'true',
      denominator: oneOf<Denominator>(
        denominator,
        ['TOTAL_ASSETS', 'SECURITIES_ONLY'],
        'TOTAL_ASSETS',
      ),
    }, req.user);
  }

  @Get('client/:id/exposure')
  clientExposure(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Query('denominator') denominator?: string,
  ) {
    return this.exposure.exposure(
      id,
      oneOf<Denominator>(denominator, ['TOTAL_ASSETS', 'SECURITIES_ONLY'], 'TOTAL_ASSETS'),
      req.user,
    );
  }

  @Get('client/:id/concentration')
  concentration(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.exposure.concentration(id, req.user);
  }

  @Get('client/:id/diversification')
  diversification(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.exposure.diversification(id, req.user);
  }

  @Get('client/:id/performance')
  clientPerformance(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Query('benchmark') benchmark?: string,
  ) {
    return this.performance.forClient(id, benchmark, undefined, req.user);
  }

  // ── House ─────────────────────────────────────────────────────────────────

  // "House" means the caller's house: a manager's own merged book, or the whole
  // firm's for a Super Admin. Without req.user these were a firm-wide rollup for
  // everyone — the overlap matrix in particular listed every client by name.
  @Get('house/exposure')
  houseExposure(@Req() req: AuthedRequest) {
    return this.house.exposure(undefined, req.user);
  }

  @Get('house/overlap')
  overlap(@Req() req: AuthedRequest) {
    return this.house.overlap(req.user);
  }

  @Get('house/concentration')
  houseConcentration(@Req() req: AuthedRequest) {
    return this.house.concentration(req.user);
  }

  /** All eight heatmaps in the brief are one endpoint with parameters. */
  @Get('house/heatmap')
  heatmap(
    @Req() req: AuthedRequest,
    @Query('rows') rows?: string,
    @Query('cols') cols?: string,
    @Query('metric') metric?: string,
  ) {
    return this.house.heatmap(
      oneOf(rows, HEATMAP_DIMS, 'client'),
      oneOf(cols, HEATMAP_DIMS, 'sector'),
      oneOf(metric, HEATMAP_METRICS, 'weight'),
      req.user,
    );
  }
}
