import { Type } from 'class-transformer';
import { IsArray, IsNumber, IsString, MinLength, ValidateNested } from 'class-validator';
import { BaselineHoldingDto } from './create-baseline.dto';

/**
 * The only shape that can change an already-locked PortfolioBaseline.
 * `reason` is required (not optional, unlike CreateBaselineDto.remarks) —
 * BaselineAdminService appends it to the audit trail, and an amendment with
 * no stated reason defeats the point of keeping one.
 */
export class AmendBaselineDto {
  @IsNumber()
  openingPortfolioValue: number;

  @IsNumber()
  openingCash: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BaselineHoldingDto)
  holdings: BaselineHoldingDto[];

  @IsString()
  @MinLength(1)
  reason: string;
}
