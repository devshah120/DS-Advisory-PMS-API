import { Transform } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';

// Closed sets rather than free strings: these values drive formatting across the
// whole app, so an unknown value would silently render wrong numbers or dates.

export enum Theme {
  SYSTEM = 'system',
  LIGHT = 'light',
  DARK = 'dark',
}

export enum BaseCurrency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  INR = 'INR',
}

export enum DateFormat {
  MED = 'MMM D, YYYY',
  DMY = 'DD/MM/YYYY',
  MDY = 'MM/DD/YYYY',
  ISO = 'YYYY-MM-DD',
}

/** BCP-47 locale tags — passed straight to Intl.NumberFormat on the client. */
export enum NumberFormat {
  EN_US = 'en-US',
  DE_DE = 'de-DE',
  EN_IN = 'en-IN',
}

export enum Density {
  COMFORTABLE = 'comfortable',
  COMPACT = 'compact',
}

const lower = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  );

const upper = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  );

export class UpdatePreferencesDto {
  @IsEnum(Theme, { message: 'theme must be system, light, or dark' })
  @lower()
  @IsOptional()
  theme?: Theme;

  @IsEnum(BaseCurrency, { message: 'baseCurrency must be USD, EUR, GBP, or INR' })
  @upper()
  @IsOptional()
  baseCurrency?: BaseCurrency;

  // Case-sensitive on purpose: these are format tokens ("MMM D, YYYY"), not
  // identifiers, so neither a lower() nor an upper() transform applies.
  @IsEnum(DateFormat, {
    message: 'dateFormat must be one of MMM D, YYYY | DD/MM/YYYY | MM/DD/YYYY | YYYY-MM-DD',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  dateFormat?: DateFormat;

  @IsEnum(NumberFormat, { message: 'numberFormat must be en-US, de-DE, or en-IN' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  numberFormat?: NumberFormat;

  @IsEnum(Density, { message: 'density must be comfortable or compact' })
  @lower()
  @IsOptional()
  density?: Density;
}
