/**
 * Manual entry of a corporate action.
 *
 * This is not a fallback for when the feed is down — it is the PRIMARY path
 * for the highest-confidence sources. An action keyed from a company's own
 * investor-relations announcement or an exchange filing is COMPANY_IR or
 * REGULATORY_FILING tier (confidence 100 under PART 33), outranking anything
 * an API reports. PART 5's hierarchy only means something if a human can enter
 * the top two tiers, and this DTO is how.
 */
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CorporateActionType } from '@prisma/client';
import { SourceTier } from '../corporate-action.types';

/**
 * Tiers a human may claim when keying an action.
 *
 * PRIMARY_API and below are deliberately absent: those describe machine
 * sources, and letting a person stamp "primary API" on a hand-keyed row would
 * make the provenance field a fiction. A human either read it from the company
 * or an exchange, or they are entering something unverified.
 */
const MANUAL_TIERS: SourceTier[] = [
  'COMPANY_IR',
  'REGULATORY_FILING',
  'EXCHANGE',
  'UNVERIFIED',
];

export class CreateCorporateActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  symbol!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsEnum(CorporateActionType)
  actionType!: CorporateActionType;

  /** The date holdings change on. The only mandatory date — see the schema. */
  @IsDateString()
  effectiveDate!: string;

  @IsOptional()
  @IsDateString()
  announcementDate?: string;

  @IsOptional()
  @IsDateString()
  declarationDate?: string;

  @IsOptional()
  @IsDateString()
  recordDate?: string;

  @IsOptional()
  @IsDateString()
  exDate?: string;

  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  /**
   * PART 6 storage convention: each `oldRatio` shares become `newRatio`.
   *
   * NOTE the inversion against how a split is spoken: a "2-for-1" split is
   * entered here as oldRatio 1, newRatio 2. The UI does this conversion for
   * the user (it asks for "2 : 1" and submits 1 and 2), so an API caller
   * posting directly is the only one who needs to know.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  oldRatio?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  newRatio?: number;

  /** Per-share cash. Never a total — totals are per-client and derived. */
  @IsOptional()
  @IsNumber()
  cashAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  newSymbol?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  newCompany?: string;

  /**
   * Type-specific fields: subscriptionRatio/subscriptionPrice for rights,
   * distributionRatio for spin-offs, exchangeRatio/cashPerShare for mergers,
   * oldExchange/newExchange for an exchange change, reason/cashSettlement/
   * replacementSymbol for a delisting.
   */
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;

  /** Free-text description of where this came from, e.g. 'Amphenol 8-K'. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  source!: string;

  @IsIn(MANUAL_TIERS)
  tier!: SourceTier;

  /**
   * Optional but strongly wanted — the validator raises a WARNING without one,
   * because provenance a reviewer cannot follow is provenance in name only.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
