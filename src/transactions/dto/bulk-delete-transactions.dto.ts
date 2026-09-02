import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * The ids to delete in one call.
 *
 * Capped because the ids arrive as a single `IN (...)` list — an uncapped array
 * lets one request build a statement large enough to stall the connection, and
 * no screen in the app can select more than a page of rows at a time anyway.
 */
export class BulkDeleteTransactionsDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Select at least one transaction to delete' })
  @ArrayMaxSize(500, { message: 'Cannot delete more than 500 transactions at once' })
  @IsString({ each: true })
  ids: string[];
}
