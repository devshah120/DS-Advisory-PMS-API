import { IsIn, IsOptional, IsString } from 'class-validator';

export const WATCHLIST_SLOTS = ['1', '2', '3', '4', '5'] as const;

export class CreateWatchlistDto {
  @IsString()
  ticker: string;

  @IsOptional()
  @IsIn(WATCHLIST_SLOTS)
  slot?: string;
}

export class BulkAddWatchlistDto {
  @IsString({ each: true })
  tickers: string[];

  @IsOptional()
  @IsIn(WATCHLIST_SLOTS)
  slot?: string;
}

export class RenameWatchlistFolderDto {
  @IsString()
  name: string;
}
