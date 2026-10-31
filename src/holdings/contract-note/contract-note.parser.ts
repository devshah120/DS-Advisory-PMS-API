import { TextItem } from './pdf-text';

/**
 * Reads the trade table out of a broker's equity statement PDF.
 *
 * Supported today: the Kotak Neo "Equity Statement" (Transaction_Statement_*.pdf).
 * Its letterhead — client name, client code, the buy/sell totals — is an image,
 * not text, so none of it can be read; the client code and period are taken
 * from the file name Kotak gives the download instead, and each row is checked
 * on its own (quantity × rate must equal the printed total) in place of a
 * whole-statement checksum.
 *
 * Another broker's layout is a new COLUMNS list plus whatever it needs for
 * detection, not a change to the row-building below: cells are rebuilt purely
 * from where each fragment sits relative to the header row.
 */

export interface ParsedTrade {
  /** 1-based position in the statement, for pointing the user at a row. */
  line: number;
  /** YYYY-MM-DD, the exchange trade date. */
  tradeDate: string;
  /** HH:MM:SS as printed, or null when the statement omits it. */
  tradeTime: string | null;
  securityName: string;
  isin: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  /** Per-share price as printed (Kotak prints the volume-weighted fill). */
  rate: number;
  /** Quantity × rate, as printed — brokerage and taxes are NOT in it. */
  total: number;
  /** Brokerage + exchange charges + taxes for the row, as printed. */
  charges: number;
  /**
   * Stamped on the ledger row, so re-uploading the same statement is
   * recognised and skipped rather than doubling every position.
   */
  reference: string;
  warnings: string[];
}

export interface ParsedContractNote {
  broker: string;
  clientCode: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  trades: ParsedTrade[];
  /** Rows that looked like trades but could not be read — never silently dropped. */
  errors: string[];
}

export class UnrecognisedStatementError extends Error {}

type ColumnKey =
  | 'tradeDate'
  | 'security'
  | 'isin'
  | 'exchange'
  | 'side'
  | 'product'
  | 'source'
  | 'quantity'
  | 'rate'
  | 'total'
  | 'charges';

/**
 * The first header line of each column. The second line ("Time", "Name",
 * "Type"…) is not needed: a column is located by its first line alone.
 */
const KOTAK_NEO_COLUMNS: { key: ColumnKey; header: string }[] = [
  { key: 'tradeDate', header: 'Trade Date' },
  { key: 'security', header: 'Security' },
  { key: 'isin', header: 'ISIN' },
  { key: 'exchange', header: 'Exchange' },
  { key: 'side', header: 'Transaction' },
  { key: 'product', header: 'Product' },
  { key: 'source', header: 'Order' },
  { key: 'quantity', header: 'Quantity' },
  { key: 'rate', header: 'Market Rate' },
  { key: 'total', header: 'Total' },
  { key: 'charges', header: 'Charges' },
];

/**
 * Header text sits on two lines a few points apart; anything this close below
 * the first line is still header, not the first trade.
 */
const HEADER_DEPTH = 6;

/** The total may differ from quantity × rate by paise of rounding, not more. */
const TOTAL_TOLERANCE = 0.5;

const center = (it: TextItem) => it.x + it.width / 2;

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Kotak's download is named Transaction_Statement_<CODE>_<YYYYMMDD>_<YYYYMMDD>.pdf.
 * The browser may append " (1)" to a repeat download, so the match is not
 * anchored at the end.
 */
function readFileName(fileName?: string) {
  const m = fileName?.match(/Transaction_Statement_([A-Z0-9]+)_(\d{8})_(\d{8})/i);
  if (!m) return { clientCode: null, periodFrom: null, periodTo: null };
  const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return { clientCode: m[1].toUpperCase(), periodFrom: iso(m[2]), periodTo: iso(m[3]) };
}

/** Locates the header row on a page, or null if this page has no trade table. */
function findHeader(items: TextItem[]) {
  const centers = new Map<ColumnKey, number>();
  let headerY = Infinity;
  for (const col of KOTAK_NEO_COLUMNS) {
    const hit = items.find((it) => it.str === col.header);
    if (!hit) return null;
    centers.set(col.key, center(hit));
    headerY = Math.min(headerY, hit.y);
  }
  return { centers, headerY };
}

/** The column whose header is horizontally nearest to the fragment. */
function columnOf(item: TextItem, centers: Map<ColumnKey, number>): ColumnKey {
  let best: ColumnKey = 'tradeDate';
  let bestDist = Infinity;
  for (const [key, x] of centers) {
    const d = Math.abs(center(item) - x);
    if (d < bestDist) {
      best = key;
      bestDist = d;
    }
  }
  return best;
}

export function parseContractNote(pages: TextItem[][], fileName?: string): ParsedContractNote {
  const meta = readFileName(fileName);
  const trades: ParsedTrade[] = [];
  const errors: string[] = [];
  let broker: string | null = null;
  let sawTable = false;

  for (const items of pages) {
    const header = findHeader(items);
    if (!header) continue;
    sawTable = true;
    const { centers, headerY } = header;

    const body = items
      .filter((it) => it.y < headerY - HEADER_DEPTH)
      .map((it) => ({ it, col: columnOf(it, centers) }));

    // One exchange code per trade, printed on the row's vertical centre — the
    // only cell that never wraps, which makes it the row's anchor. Every other
    // fragment belongs to whichever anchor it sits closest to.
    const anchors = body
      .filter((b) => b.col === 'exchange' && /^(NSE|BSE)$/i.test(b.it.str))
      .map((b) => b.it.y)
      .sort((a, b) => b - a);
    if (anchors.length === 0) continue;

    // Half the tightest row pitch: far enough to reach a three-line name, never
    // far enough to reach the neighbouring trade.
    let pitch = Infinity;
    for (let i = 1; i < anchors.length; i++) pitch = Math.min(pitch, anchors[i - 1] - anchors[i]);
    const reach = Number.isFinite(pitch) ? pitch / 2 : 16;

    const rows = anchors.map(() => new Map<ColumnKey, TextItem[]>());
    for (const { it, col } of body) {
      let idx = -1;
      let dist = Infinity;
      anchors.forEach((y, i) => {
        const d = Math.abs(it.y - y);
        if (d < dist) {
          idx = i;
          dist = d;
        }
      });
      if (idx < 0 || dist > reach) continue;
      const cell = rows[idx].get(col) ?? [];
      cell.push(it);
      rows[idx].set(col, cell);
    }

    for (const row of rows) {
      const line = trades.length + errors.length + 1;
      // Top-to-bottom, then left-to-right: the reading order of a wrapped cell.
      const cell = (key: ColumnKey, sep: string) =>
        (row.get(key) ?? [])
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((it) => it.str)
          .join(sep)
          .trim();

      try {
        const trade = readRow(cell, line);
        broker ??= cell('source', ' ') || null;
        trades.push(trade);
      } catch (error) {
        errors.push(`Row ${line}: ${(error as Error).message}`);
      }
    }
  }

  if (!sawTable) {
    throw new UnrecognisedStatementError(
      'This PDF is not a recognised contract note. Supported: Kotak Neo equity transaction statement.',
    );
  }

  return { broker: broker ?? 'Kotak Neo', ...meta, trades, errors };
}

function readRow(
  cell: (key: ColumnKey, sep: string) => string,
  line: number,
): ParsedTrade {
  const when = cell('tradeDate', ' ');
  const dm = when.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dm) throw new Error(`could not read the trade date ("${when}")`);
  const tradeDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const tradeTime = when.match(/\d{2}:\d{2}:\d{2}/)?.[0] ?? null;

  // A wrapped ISIN is split mid-code, so its fragments join with no space.
  const isin = cell('isin', '').toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) throw new Error(`could not read the ISIN ("${isin}")`);

  const sideText = cell('side', ' ').toUpperCase();
  const side = sideText.startsWith('B') ? 'BUY' : sideText.startsWith('S') ? 'SELL' : null;
  if (!side) throw new Error(`transaction type "${sideText}" is neither Buy nor Sell`);

  const quantity = parseNumber(cell('quantity', ''));
  const rateText = cell('rate', '');
  const rate = parseNumber(rateText);
  const total = parseNumber(cell('total', ''));
  const charges = parseNumber(cell('charges', '')) ?? 0;
  if (quantity === null || quantity <= 0) throw new Error('could not read the quantity');
  if (rate === null || rate <= 0) throw new Error('could not read the market rate');
  if (total === null || total <= 0) throw new Error('could not read the total');

  const warnings: string[] = [];
  if (Math.abs(quantity * rate - total) > TOTAL_TOLERANCE) {
    warnings.push(
      `Quantity × rate is ${(quantity * rate).toFixed(2)} but the statement prints ${total.toFixed(2)}`,
    );
  }

  const product = cell('product', ' ');
  if (product && !/^(cash|delivery|cnc)$/i.test(product)) {
    warnings.push(`Product type is "${product}", not a delivery trade`);
  }

  return {
    line,
    tradeDate,
    tradeTime,
    // A wrapped name can break mid-word ("Senores Phar maceuticals"); it is
    // display only — the company name stored comes from the symbol lookup.
    securityName: cell('security', ' '),
    isin,
    exchange: cell('exchange', ' ').toUpperCase(),
    side,
    quantity,
    rate,
    total,
    charges,
    // Built only from what the statement prints — not the file name, which a
    // user can rename — so the same trade always yields the same reference.
    reference: [
      'CN',
      `${tradeDate}${tradeTime ? `T${tradeTime}` : ''}`,
      isin,
      side,
      `${quantity}@${rateText}`,
    ].join(':'),
    warnings,
  };
}
