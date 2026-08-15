import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Which book the household belongs to. Same casing rule as the client DTO —
 * 'US'/'INDIA' stay uppercase across the HTTP boundary.
 */
export enum FamilyMarket {
  US = 'US',
  INDIA = 'INDIA',
}

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateFamilyDto {
  @IsString()
  @IsNotEmpty({ message: 'Family name is required' })
  @MaxLength(120)
  @trim()
  name: string;

  @IsEnum(FamilyMarket, { message: 'market must be US or INDIA' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  market?: FamilyMarket;

  /**
   * Client ids to place in the household on create. Optional — a family can be
   * created empty and populated from each client's own edit form afterwards,
   * which is how a manager adding one account at a time works.
   */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  clientIds?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  @trim()
  notes?: string;
}
