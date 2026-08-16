import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiRole } from '../../common/auth/roles';

// Re-exported under the old name so existing imports keep working; the enum
// itself now lives in common/auth/roles.ts alongside the mapping tables.
export { ApiRole as UserRole };

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
 *
 * There is deliberately no `role` field. Editing your own role is privilege
 * escalation: the Settings > Profile form used to expose a Role select, which
 * let any signed-in user make themselves an admin with one request. Roles are
 * now assigned only by a Super Admin through PATCH /users/:id, and the profile
 * form shows the role as a read-only badge. Because `ValidationPipe` runs with
 * `forbidNonWhitelisted`, a client that still sends `role` here is rejected
 * rather than silently ignored.
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
}
