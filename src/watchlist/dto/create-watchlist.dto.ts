import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const WATCHLIST_SLOTS = ['1', '2', '3', '4', '5'] as const;

/**
 * Which book the ticker is being added to.
 *
 * Optional on the wire so a caller that predates the Indian book keeps writing
 * to the US watchlist; the service defaults it. Uppercased on the way in to
 * match the Market enum, as the client DTO does.
 */
const marketTransform = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

export class CreateWatchlistDto {
  @IsString()
  ticker: string;

  @IsOptional()
  @IsIn(WATCHLIST_SLOTS)
  slot?: string;

  /**
   * The book to resolve the ticker against AND file it under. This is what
   * turns a bare "RELIANCE" into "RELIANCE.NS" — without it Yahoo knows nothing
   * about the symbol and the add fails.
   */
  @IsOptional()
  @IsIn(['US', 'INDIA'])
  @marketTransform()
  market?: string;
}

export class BulkAddWatchlistDto {
  @IsString({ each: true })
  tickers: string[];

  @IsOptional()
  @IsIn(WATCHLIST_SLOTS)
  slot?: string;

  @IsOptional()
  @IsIn(['US', 'INDIA'])
  @marketTransform()
  market?: string;
}

export class RenameWatchlistFolderDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsIn(['US', 'INDIA'])
  @marketTransform()
  market?: string;
}
