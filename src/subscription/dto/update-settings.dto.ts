import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * PATCH /subscription/settings — Super Admin edits the seat plan and the
 * Razorpay credentials.
 *
 * Every field is optional so the screen can save one section without resending
 * the others. That matters most for `razorpayKeySecret`: the GET never returns
 * it, so a form that echoed back what it received would otherwise blank the
 * stored secret on every unrelated save. Omitted means "leave it alone".
 */
export class UpdateSettingsDto {
  /**
   * Capped at 365 rather than left unbounded — a typo of 3650 would hand out a
   * decade of free access, and no legitimate trial runs longer than a year.
   */
  @IsInt({ message: 'Trial days must be a whole number' })
  @Min(0, { message: 'Trial days cannot be negative' })
  @Max(365, { message: 'Trial days cannot exceed 365' })
  @IsOptional()
  trialDays?: number;

  @IsNumber({}, { message: 'Monthly amount must be a number' })
  @Min(0, { message: 'Monthly amount cannot be negative' })
  @IsOptional()
  monthlyAmount?: number;

  @IsNumber({}, { message: 'Yearly amount must be a number' })
  @Min(0, { message: 'Yearly amount cannot be negative' })
  @IsOptional()
  yearlyAmount?: number;

  @IsString()
  @MaxLength(3)
  @trim()
  @IsOptional()
  currency?: string;

  @IsString()
  @MaxLength(80)
  @trim()
  @IsOptional()
  razorpayKeyId?: string;

  /**
   * Write-only. Never returned by any endpoint — see AppSetting's schema note.
   * An empty string is meaningful here and is handled in the service: it means
   * "clear the stored secret", as distinct from omitting the field entirely.
   */
  @IsString()
  @MaxLength(200)
  @trim()
  @IsOptional()
  razorpayKeySecret?: string;

  @IsIn(['test', 'live'], { message: 'Mode must be test or live' })
  @IsOptional()
  razorpayMode?: 'test' | 'live';
}
