import { IsString, IsNumber, IsOptional, IsEnum, IsDateString } from 'class-validator';

enum TransactionType {
  BUY = 'BUY',
  SELL = 'SELL',
  DIVIDEND = 'DIVIDEND',
  SPLIT = 'SPLIT',
  BONUS = 'BONUS',
  TRANSFER = 'TRANSFER',
  CASH_DEPOSIT = 'CASH_DEPOSIT',
  CASH_WITHDRAWAL = 'CASH_WITHDRAWAL',
  FEES = 'FEES',
}

export class CreateTransactionDto {
  @IsString()
  clientId: string;

  @IsString()
  @IsOptional()
  ticker?: string;

  @IsEnum(TransactionType)
  type: TransactionType;

  @IsNumber()
  @IsOptional()
  quantity?: number;

  @IsNumber()
  @IsOptional()
  price?: number;

  @IsNumber()
  amount: number;

  @IsDateString()
  date: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  reference?: string;
}
