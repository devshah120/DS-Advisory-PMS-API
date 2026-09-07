/**
 * The firm's sector vocabulary — the closed list a human may classify into.
 *
 * These are the eleven GICS-style sectors Yahoo already returns for the names
 * it does cover, spelled exactly as Yahoo spells them. That matching matters:
 * a manually-classified holding and an auto-classified one must land in the
 * SAME pie slice, and "Financial Services" typed by hand next to "Financial
 * Services" from Yahoo would otherwise split one sector into two wedges that
 * look like different things.
 *
 * MISCELLANEOUS is the deliberate escape hatch, and it is the last entry rather
 * than an omission. A book will always contain something that genuinely does
 * not fit — an SME listing, a demerged entity, a holding company of unrelated
 * businesses — and forcing that into an ill-fitting real sector corrupts the
 * allocation it lands in. Choosing "Miscellaneous" is a decision on the record;
 * "Unclassified" is the absence of one, and the difference is the whole point
 * of this list.
 */
export const SECTORS = [
  'Basic Materials',
  'Communication Services',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Energy',
  'Financial Services',
  'Healthcare',
  'Industrials',
  'Real Estate',
  'Technology',
  'Utilities',
  'Miscellaneous',
] as const;

export type Sector = (typeof SECTORS)[number];

/**
 * The placeholders that mean "nobody has decided yet".
 *
 * Written by the ingest paths when a provider returns nothing — see
 * HoldingsService.create and the reconstruction replay. Distinguishing these
 * from a real sector is what lets the UI single them out for review instead of
 * charting them as though they were an answer.
 */
const UNSET = new Set(['', 'unclassified', 'uncategorized', 'unknown', 'n/a', 'none', '-']);

/** True when `sector` is a placeholder rather than a classification. */
export function isUnclassified(sector: string | null | undefined): boolean {
  return UNSET.has((sector ?? '').trim().toLowerCase());
}

/**
 * The label the UI shows for an unclassified position.
 *
 * Deliberately NOT 'Miscellaneous': a position nobody has looked at and a
 * position someone decided is miscellaneous are different states, and collapsing
 * them would hide the queue of work this feature exists to clear.
 */
export const UNCLASSIFIED_LABEL = 'Unclassified';

/**
 * Case-insensitive match onto the canonical spelling, so 'healthcare' or
 * 'HEALTHCARE' from a provider or a hand-typed import both normalise onto
 * 'Healthcare' rather than opening a third wedge in the pie.
 *
 * Returns null for anything not in the vocabulary, including the placeholders —
 * callers decide whether that is a validation error or a fallback.
 */
export function normalizeSector(raw: string | null | undefined): Sector | null {
  const value = (raw ?? '').trim();
  if (!value || isUnclassified(value)) return null;
  return SECTORS.find((s) => s.toLowerCase() === value.toLowerCase()) ?? null;
}
