/** One row's outcome in a bulk import, keyed back to its source spreadsheet row. */
export interface BulkImportRowResult {
  /** 1-based row number as it appears in the spreadsheet (header is row 1). */
  row: number;
  ticker: string | null;
  status: 'imported' | 'failed';
  /** Present when status is 'failed'. */
  error?: string;
}

export interface BulkImportSummary {
  total: number;
  imported: number;
  failed: number;
  results: BulkImportRowResult[];
}
