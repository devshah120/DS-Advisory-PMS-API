import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// The API contract is lowercase (it matches the frontend `UserRole` type);
// Prisma stores the uppercase variants. UsersService maps between them.
export enum UserRole {
  ADMIN = 'admin',
  PORTFOLIO_MANAGER = 'portfolio_manager',
  RESEARCH_ANALYST = 'research_analyst',
  VIEWER = 'viewer',
}

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const lower = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  );

/**
 * PATCH /users/me — every field optional so the client can send a partial patch,
 * but any field that *is* sent must be non-blank. `@IsNotEmpty` after the trim
 * transform is what rejects "   " for the name fields.
 */
export class UpdateProfileDto {
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

  // Blank is allowed here — clearing the organization is a legitimate edit, so
  // unlike the name fields this one has no @IsNotEmpty.
  @IsString()
  @MaxLength(120)
  @trim()
  @IsOptional()
  organization?: string;

  @IsEnum(UserRole, {
    message: 'role must be admin, portfolio_manager, research_analyst, or viewer',
  })
  @lower()
  @IsOptional()
  role?: UserRole;
}
