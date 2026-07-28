import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  currentPassword: string;

  // Same bounds as the client-login password in CreateClientDto, so a password
  // that's acceptable in one place is acceptable in the other.
  @IsString()
  @IsNotEmpty({ message: 'A new password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  newPassword: string;
}
