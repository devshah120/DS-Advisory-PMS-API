import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * A dividend received on a holding.
 *
 * Its own endpoint rather than a generic transaction because a dividend has no
 * price and no direction to choose: it is always cash arriving, always positive,
 * and always attributable to a ticker. Routing it through CreateTransactionDto
 * would let an operator file one with a negative amount or as an outflow.
 *
 * Dividends raise the client's return under both accounting methods — see
 * calculators/flows.ts.
 */
export class CreateDividendDto {
  @IsString()
  @IsNotEmpty({ message: 'Client is required' })
  clientId: string;

  @IsString()
  @IsNotEmpty({ message: 'Ticker is required' })
  @MaxLength(24)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  )
  ticker: string;

  /** Total cash received, not per-share. Always positive. */
  @IsNumber({}, { message: 'Amount must be a number' })
  @IsPositive({ message: 'Amount must be greater than zero' })
  amount: number;

  /** Shares held at the ex-date. Optional — recorded for audit, not used by XIRR. */
  @IsNumber()
  @IsOptional()
  quantity?: number;

  @IsDateString({}, { message: 'A valid payment date is required' })
  date: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  reference?: string;
}
