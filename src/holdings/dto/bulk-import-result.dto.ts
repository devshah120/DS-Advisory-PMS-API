/** One row's outcome in a bulk import, keyed back to its source spreadsheet row. */
export interface BulkImportRowResult {
  /** 1-based row number as it appears in the spreadsheet (header is row 1). */
  row: number;
  ticker: string | null;
  /** 'skipped' is a trade already on the ledger — see ContractNoteService. */
  status: 'imported' | 'failed' | 'skipped';
  /** Present when status is 'failed' or 'skipped'. */
  error?: string;
}

export interface BulkImportSummary {
  total: number;
  imported: number;
  failed: number;
  skipped?: number;
  results: BulkImportRowResult[];
}
