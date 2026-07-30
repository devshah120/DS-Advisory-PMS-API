import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BaselineHoldingDto {
  @IsString()
  @MinLength(1)
  ticker: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  averageCost: number;

  @IsString()
  currency: string;

  @IsString()
  sector: string;

  @IsString()
  industry: string;
}

/**
 * One-time import payload for a client's Legacy Portfolio Baseline. There is
 * no update DTO — see BaselineService, which exposes no update path at all,
 * and BaselineAdminService (amend-baseline.dto.ts) for the only way to
 * change a baseline after creation.
 */
export class CreateBaselineDto {
  @IsDateString()
  baselineDate: string;

  @IsNumber()
  openingPortfolioValue: number;

  @IsNumber()
  openingCash: number;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BaselineHoldingDto)
  holdings: BaselineHoldingDto[];
}
