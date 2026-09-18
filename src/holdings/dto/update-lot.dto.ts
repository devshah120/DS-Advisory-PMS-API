import { IsNumber, IsOptional, IsDateString, IsIn, Min } from 'class-validator';

/**
 * A correction to one dated fill behind a position.
 *
 * Every field is optional so the caller patches only what the user actually
 * changed, but a correction that leaves quantity and amount alone still has to
 * be applied through here rather than through the transactions module directly:
 * the holding this lot belongs to is recomputed from the ledger afterwards, and
 * that recompute is the whole point of the endpoint.
 */
export class UpdateLotDto {
  // When the fill actually happened. XIRR weights every flow by its date, so
  // this is the field that makes a back-dated correction worth doing at all.
  @IsDateString()
  @IsOptional()
  date?: string;

  // BUY or SELL. Correcting the side is rare but is the only way to fix a
  // trade booked in the wrong direction without deleting and re-entering it.
  @IsIn(['BUY', 'SELL'])
  @IsOptional()
  side?: 'BUY' | 'SELL';

  // Always the absolute size of the fill; the side carries the direction.
  @IsNumber()
  @Min(0)
  @IsOptional()
  quantity?: number;

  // What the fill actually cost (or realised). Price is derived from
  // amount / quantity so the two can never disagree on the blotter — the same
  // rule holdings.service applies when it writes a lot in the first place.
  @IsNumber()
  @Min(0)
  @IsOptional()
  amount?: number;
}
