import { IsIn, IsString } from 'class-validator';
import { SECTORS } from '../../common/sectors';

export class SetSectorDto {
  /**
   * Validated against the closed vocabulary at the edge as well as in the
   * service. Two checks rather than one because they fail differently and both
   * failures are worth having: this one rejects a malformed request before it
   * reaches any business logic, and the service's `normalizeSector` also
   * accepts a differently-cased spelling from an internal caller.
   */
  @IsString()
  @IsIn(SECTORS as unknown as string[], {
    message: `sector must be one of: ${SECTORS.join(', ')}`,
  })
  sector: string;
}
