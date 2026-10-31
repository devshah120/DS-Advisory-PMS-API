import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsNotFutureDate } from '../../common/not-future-date.validator';

/**
 * One reviewed trade from a contract-note preview.
 *
 * It comes back from the browser rather than being re-read from the PDF on
 * commit because the review step is where the user fixes what the statement
 * could not tell us — an ISIN NSE does not list, a symbol they hold under a
 * different listing — and those corrections have to be what lands.
 */
export class ContractNoteTradeDto {
  /** Line in the statement, echoed back on the result so the UI can match it. */
  @IsInt()
  @Min(1)
  line: number;

  @IsDateString({}, { message: 'A valid trade date is required' })
  @IsNotFutureDate()
  date: string;

  @IsIn(['BUY', 'SELL'])
  side: 'BUY' | 'SELL';

  @IsString()
  @IsNotEmpty({ message: 'Symbol is required' })
  @MaxLength(24)
  symbol: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  /** Quantity × rate as printed — excludes charges. */
  @IsNumber()
  @IsPositive()
  total: number;

  @IsNumber()
  @Min(0)
  charges: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  reference: string;

  @IsString()
  @IsOptional()
  @MaxLength(12)
  isin?: string;
}

export class CommitContractNoteDto {
  @IsString()
  @IsNotEmpty({ message: 'Choose the client this statement belongs to' })
  clientId: string;

  /**
   * Fold brokerage and taxes into the cost (buys) or out of the proceeds
   * (sells). Off by default: every trade already on the ledger was entered at
   * quantity × price, and mixing the two conventions inside one position would
   * make its average cost mean two different things.
   */
  @IsBoolean()
  includeCharges: boolean;

  @IsArray()
  @ArrayNotEmpty({ message: 'Select at least one trade to import' })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ContractNoteTradeDto)
  trades: ContractNoteTradeDto[];
}
