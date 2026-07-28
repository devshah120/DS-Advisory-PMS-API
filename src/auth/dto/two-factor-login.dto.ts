import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Step 2 of a two-factor login. The challenge token stands in for the password
 * that was already accepted, so the password is never sent twice and never has
 * to be held in browser state between the two steps.
 */
export class TwoFactorLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Your sign-in attempt has expired. Please start again.' })
  challengeToken: string;

  @IsString()
  @IsNotEmpty({ message: 'Enter your authentication code' })
  code: string;

  /** True when `code` is a recovery code rather than a 6-digit app code. */
  @IsOptional()
  @IsBoolean()
  isRecoveryCode?: boolean;
}
