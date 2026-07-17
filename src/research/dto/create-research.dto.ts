import { IsString, IsNumber, IsOptional, IsDateString, IsArray } from 'class-validator';

export class CreateResearchDto {
  @IsString()
  ticker: string;

  @IsString()
  @IsOptional()
  clientId?: string;

  @IsString()
  @IsOptional()
  investmentThesis?: string;

  @IsString()
  @IsOptional()
  whyBought?: string;

  @IsString()
  @IsOptional()
  catalysts?: string;

  @IsString()
  @IsOptional()
  risks?: string;

  @IsString()
  @IsOptional()
  valuation?: string;

  @IsNumber()
  @IsOptional()
  targetAllocation?: number;

  @IsNumber()
  @IsOptional()
  targetPrice?: number;

  @IsDateString()
  @IsOptional()
  reviewDate?: string;

  @IsString()
  @IsOptional()
  reviewNotes?: string;

  @IsArray()
  @IsOptional()
  attachments?: string[];
}
