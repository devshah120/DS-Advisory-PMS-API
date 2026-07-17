import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CreateHoldingDto {
  @IsString()
  clientId: string;

  @IsString()
  ticker: string;

  @IsString()
  company: string;

  // Classification is resolved from the ticker lookup, which returns blanks for
  // instruments Yahoo does not classify (ETFs, indices, funds).
  @IsString()
  @IsOptional()
  sector?: string;

  @IsString()
  @IsOptional()
  industry?: string;

  @IsString()
  @IsOptional()
  country?: string;

  @IsString()
  @IsOptional()
  theme?: string;

  @IsString()
  @IsOptional()
  exchange?: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  averageCost: number;

  @IsNumber()
  currentPrice: number;

  // Accepted for backwards compatibility but ignored: marketValue and
  // unrealizedPnL are always derived server-side from quantity, averageCost
  // and currentPrice so they cannot drift from the stored position.
  @IsNumber()
  @IsOptional()
  marketValue?: number;

  @IsNumber()
  @IsOptional()
  targetWeight?: number;

  @IsString()
  @IsOptional()
  investmentThesis?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
