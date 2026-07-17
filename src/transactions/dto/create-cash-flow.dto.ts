import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * An external cash flow given by the client — the input for the cash-flow-basis
 * method.
 *
 * Deliberately NOT the same shape as CreateTransactionDto: there is no ticker,
 * no quantity and no price, because none of those exist for "the client wired us
 * $50,000". Direction is a two-way choice rather than a free enum, so the form
 * cannot record a BUY here by mistake.
 */
export class CreateCashFlowDto {
  @IsString()
  @IsNotEmpty({ message: 'Client is required' })
  clientId: string;

  @IsEnum(['in', 'out'], { message: 'direction must be "in" (inflow) or "out" (outflow)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  direction: 'in' | 'out';

  // Always positive. The direction carries the sign — see TransactionsService.
  @IsNumber({}, { message: 'Amount must be a number' })
  @IsPositive({ message: 'Amount must be greater than zero' })
  amount: number;

  @IsDateString({}, { message: 'A valid date is required' })
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
