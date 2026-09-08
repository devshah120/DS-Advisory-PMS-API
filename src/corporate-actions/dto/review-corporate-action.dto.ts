import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Rejecting requires a reason — an unexplained rejection is not an audit trail. */
export class RejectCorporateActionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

/**
 * PART 44's admin settings.
 *
 * Every field optional: the settings screen PATCHes only what changed, so a
 * concurrent edit to a different field is not clobbered by a full-object PUT.
 */
export class UpdateCorporateActionSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoProcessEnabled?: boolean;

  /**
   * Bounded 40-100 rather than 0-100. Below 40 is the unverified tier's own
   * score, so any threshold under it would auto-process literally anything —
   * a setting whose only use is to disable the safety it exists to configure.
   */
  @IsOptional()
  @IsInt()
  @Min(40)
  @Max(100)
  minimumConfidenceScore?: number;

  @IsOptional()
  @IsIn(['RETAIN', 'CASH_IN_LIEU', 'ROUND_DOWN'])
  fractionalSharePolicy?: 'RETAIN' | 'CASH_IN_LIEU' | 'ROUND_DOWN';

  @IsOptional()
  @IsIn(['MARKET_PRICE', 'COST_BASIS'])
  cashInLieuPolicy?: 'MARKET_PRICE' | 'COST_BASIS';

  @IsOptional()
  @IsBoolean()
  notificationEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  processingHourUtc?: number;
}
