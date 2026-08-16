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
 * POST /users — Super Admin creates a staff login (normally a Portfolio
 * Manager). `role` is validated against the full API enum here; whether the
 * value is actually *assignable* is enforced in UsersService against
 * ASSIGNABLE_ROLES, so the "no minting a second Super Admin" rule lives with
 * the other authorization logic rather than in validation metadata.
 */
export class CreateUserDto {
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  @MaxLength(80)
  @trim()
  firstName!: string;

  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  @MaxLength(80)
  @trim()
  lastName!: string;

  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  @lower()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  password!: string;

  @IsEnum(ApiRole, { message: 'Choose a valid role' })
  @lower()
  role!: ApiRole;

  @IsString()
  @MaxLength(120)
  @trim()
  @IsOptional()
  organization?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
