import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiRole } from '../../common/auth/roles';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const lower = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  );

/**
 * PATCH /users/:id — Super Admin edits another account. Every field is optional
 * so the Users screen can send a partial patch, but a field that *is* sent must
 * be usable: blank names and short passwords are rejected here rather than
 * reaching the database.
 *
 * `password` is a reset, not a change: there is no `currentPassword` because
 * the Super Admin is not the account holder and cannot know it.
 */
export class AdminUpdateUserDto {
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  @MaxLength(80)
  @trim()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  @MaxLength(80)
  @trim()
  @IsOptional()
  lastName?: string;

  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  @lower()
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @IsOptional()
  password?: string;

  @IsEnum(ApiRole, { message: 'Choose a valid role' })
  @lower()
  @IsOptional()
  role?: ApiRole;

  @IsString()
  @MaxLength(120)
  @trim()
  @IsOptional()
  organization?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
