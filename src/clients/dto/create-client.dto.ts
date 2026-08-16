import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsNotEmpty,
  IsDateString,
  MaxLength,
  MinLength,
  Min,
  Max,
} from 'class-validator';

// The API contract is lowercase (it matches the frontend `Client` type);
// Prisma stores the uppercase variants. ClientsService maps between them.
export enum RiskProfile {
  CONSERVATIVE = 'conservative',
  MODERATE = 'moderate',
  AGGRESSIVE = 'aggressive',
}

export enum ClientStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  CLOSED = 'closed',
}

/**
 * Which book of business the mandate belongs to. Unlike the enums above, this
 * one does NOT lowercase across the HTTP boundary — 'US'/'INDIA' are codes
 * rather than words, and the uppercase form matches Prisma, the currency codes
 * and the ticker suffixes it governs. See common/market-scope.ts.
 */
export enum Market {
  US = 'US',
  INDIA = 'INDIA',
}

/**
 * Which ledger rows drive this client's XIRR.
 *
 * transactional — every buy is money in, every sell is money out.
 * cash_flow     — only the inflows/outflows the client actually handed over.
 */
export enum AccountingMethod {
  TRANSACTIONAL = 'transactional',
  CASH_FLOW = 'cash_flow',
}

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const lower = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  );

export class CreateClientDto {
  @IsString()
  @IsNotEmpty({ message: 'Client name is required' })
  @MaxLength(120)
  @trim()
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Broker is required' })
  @MaxLength(120)
  @trim()
  broker: string;

  @IsString()
  @IsNotEmpty({ message: 'Account number is required' })
  @MaxLength(64)
  @trim()
  accountNumber: string;

  // Login password for the client's own account (a User row, role VIEWER,
  // linked by clientId). Required on create; UpdateClientDto (PartialType) makes
  // it optional on edit, where a blank/absent value leaves the password
  // unchanged. Never persisted on the Client — ClientsService hashes it into the
  // linked User and strips it before writing the client row.
  @IsString()
  @IsNotEmpty({ message: 'A login password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  password: string;

  // Optional contact email for the mandate. Blank is allowed (many legacy
  // clients have none); the frontend omits it entirely rather than sending "".
  @IsEmail({}, { message: 'Enter a valid email address' })
  @IsOptional()
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  )
  email?: string;

  @IsString()
  @IsNotEmpty({ message: 'Benchmark is required' })
  @MaxLength(64)
  @trim()
  benchmark: string;

  @IsEnum(RiskProfile, {
    message: 'riskProfile must be conservative, moderate, or aggressive',
  })
  @lower()
  riskProfile: RiskProfile;

  // Retired: the cash-flow method has been removed from the product and every
  // client is now transactional. Accepted for backward compatibility with any
  // caller still sending it, but ignored — ClientsService forces TRANSACTIONAL.
  @IsEnum(AccountingMethod, {
    message: 'accountingMethod must be transactional or cash_flow',
  })
  @IsOptional()
  @lower()
  accountingMethod?: AccountingMethod;

  // Both default true (see schema.prisma). They only affect TRANSACTIONAL
  // clients: under cash_flow, dividends and fees are already inside the terminal
  // value, and counting them as flows too would double-count them.
  @IsBoolean()
  @IsOptional()
  includeDividends?: boolean;

  @IsBoolean()
  @IsOptional()
  includeFees?: boolean;

  // Optional on the wire so an existing caller that predates the Indian book
  // keeps creating US clients; ClientsService defaults it and derives the
  // currency from it.
  @IsEnum(Market, { message: 'market must be US or INDIA' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  )
  market?: Market;

  @IsString()
  @IsOptional()
  @MaxLength(3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  )
  currency?: string;

  /**
   * The household this mandate belongs to, if any.
   *
   * An empty string from a form's "no family" option is coerced to null, which
   * is what detaches a client from a household — sending "" would otherwise
   * fail the FK rather than clearing it.
   */
  @IsString()
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value
  )
  familyId?: string | null;

  /**
   * The staff user this mandate is assigned to — the "Assigned Manager" field.
   *
   * Honoured ONLY for a Super Admin; a Portfolio Manager always owns what they
   * create regardless of what they send, so this field cannot be used to push a
   * mandate into another manager's book. ClientsService resolves the effective
   * owner through ownerForCreate() and discards this value.
   *
   * Empty string (a form's "Unassigned" option) is coerced to null.
   */
  @IsString()
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value
  )
  ownerId?: string | null;

  @IsEnum(ClientStatus, {
    message: 'status must be active, inactive, or closed',
  })
  @IsOptional()
  @lower()
  status?: ClientStatus;

  @IsNumber()
  @Min(0)
  @IsOptional()
  cashBalance?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  portfolioValue?: number;

  // Required on create: the fee report can't compute anything meaningful
  // without a rate. 0 is a valid, explicit "no fee" — that's different from
  // "not entered yet", so this is not optional.
  @IsNumber()
  @Min(0)
  @Max(100, { message: 'feeRatePercent must be a percentage between 0 and 100' })
  feeRatePercent: number;

  // Required on create: prorating the first billing quarter needs a real
  // mandate start date, not the record's createdAt timestamp.
  @IsDateString({}, { message: 'inceptionDate must be a valid date' })
  inceptionDate: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  @trim()
  notes?: string;
}
