import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Every flag optional so the UI can PATCH a single toggle. Absent means "leave
 * as-is" — not "off" — which is why UsersService merges rather than replaces.
 */
export class UpdateNotificationsDto {
  @IsBoolean()
  @IsOptional()
  tradeAlerts?: boolean;

  @IsBoolean()
  @IsOptional()
  priceTargets?: boolean;

  @IsBoolean()
  @IsOptional()
  weeklyDigest?: boolean;

  @IsBoolean()
  @IsOptional()
  corporateActions?: boolean;

  @IsBoolean()
  @IsOptional()
  productUpdates?: boolean;
}
