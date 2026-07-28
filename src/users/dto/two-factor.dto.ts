import { IsNotEmpty, IsString, Matches } from 'class-validator';

/** Confirms enrolment: the 6-digit code currently shown by the authenticator. */
export class ConfirmTwoFactorDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter the 6-digit code from your authenticator app' })
  @Matches(/^\d{6}$/, { message: 'The code must be 6 digits' })
  code: string;
}

/**
 * Disabling 2FA and regenerating recovery codes both weaken or rotate the
 * account's second factor, so both require the password rather than relying on
 * the session alone.
 */
export class PasswordConfirmDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter your password to confirm' })
  password: string;
}
