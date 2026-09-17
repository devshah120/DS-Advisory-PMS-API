import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsNotFutureDate } from '../../common/not-future-date.validator';

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

/**
 * A correction to an existing ledger row.
 *
 * Deliberately NOT `PartialType(CreateTransactionDto)`:
 *
 *  - `clientId` is absent. Re-pointing a row at another client rewrites TWO
 *    clients' XIRRs in one edit — the one losing the flow and the one gaining
 *    it — and the operator sees neither figure move. That is a delete plus a
 *    re-entry, and the UI makes you do it as one.
 *  - Every field is optional, so a form can PATCH only what the operator
 *    actually changed. `undefined` means "leave it"; the service maps an
 *    explicit `null` on the nullable text fields to "clear it", which
 *    `undefined` cannot express.
 *
 * The date still cannot be in the future, for the same reason a new row's
 * cannot: a forward-dated flow makes XIRR solve over a period that has not
 * happened.
 */
export class UpdateTransactionDto {
  @IsString()
  @IsOptional()
  @MaxLength(24)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  )
  ticker?: string | null;

  @IsEnum(TransactionType)
  @IsOptional()
  type?: TransactionType;

  @IsNumber({}, { message: 'Quantity must be a number' })
  @IsOptional()
  quantity?: number | null;

  @IsNumber({}, { message: 'Price must be a number' })
  @IsOptional()
  price?: number | null;

  @IsNumber({}, { message: 'Amount must be a number' })
  @IsOptional()
  amount?: number;

  @IsDateString({}, { message: 'A valid date is required' })
  @IsNotFutureDate()
  @IsOptional()
  date?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  reference?: string | null;
}
