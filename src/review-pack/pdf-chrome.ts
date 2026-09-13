import { jsPDF } from 'jspdf';

/**
 * The firm's PDF furniture — the masthead, the identity block, the footer and
 * the page stamps — shared by every client-facing document the app emits.
 *
 * This is a server-side port of DS-Advisory-PMS/src/lib/pdfChrome.ts, kept
 * byte-for-byte identical in its drawing logic so a backend-generated Review
 * Pack PDF is visually indistinguishable from the frontend's own reports.
 * jsPDF has no DOM dependency, so the same module runs unchanged in Node —
 * this is a copy rather than an import only because the frontend and backend
 * are separate npm packages with no shared-code path between them today.
 *
 * If the frontend's pdfChrome.ts changes (a colour, the glyph map, the page
 * geometry), mirror the change here — the two must not drift, for the same
 * reason the original module doc gives for extracting it in the first place.
 */

/** The palette, as RGB triples. Workbooks speak ARGB hex; jsPDF speaks RGB. */
export const NAVY: [number, number, number] = [11, 31, 58];
export const GOLD: [number, number, number] = [201, 162, 39];
export const GOLD_FILL: [number, number, number] = [244, 233, 199];
export const STONE: [number, number, number] = [247, 245, 240];
export const WHITE: [number, number, number] = [255, 255, 255];
export const GREY: [number, number, number] = [91, 100, 114];
export const INK: [number, number, number] = [26, 26, 26];
export const HAIRLINE: [number, number, number] = [217, 217, 217];
export const DANGER: [number, number, number] = [176, 42, 42];
export const SUCCESS: [number, number, number] = [30, 116, 66];

/** A4 portrait in points, with the margin the firm's print setup implies. */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 40;
export const CONTENT_W = PAGE_W - MARGIN * 2;
/** Two panel columns with a gutter, mirroring the workbook's A/B | D/E layout. */
export const GUTTER = 16;
export const COL_W = (CONTENT_W - GUTTER) / 2;

export const FIRM_NAME = 'Giriraj Global Consultants';

/**
 * Money, in the mandate's own currency and its own digit grouping.
 *
 * Indian statements group in lakh/crore, and a ₹1,24,50,000 rendered as
 * ₹12,450,000 is the kind of error a client notices immediately and an adviser
 * never does. `Intl` is asked for the grouping; the symbol is prepended
 * separately because jsPDF's standard fonts have no glyph for ₹ — see
 * `currencyPrefix`.
 */
export function moneyFormatter(currency: string): (n: number) => string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const prefix = currencyPrefix(currency);
  return (n: number) => {
    // Parentheses for negatives, the accounting convention the workbooks use.
    const body = `${prefix}${nf.format(Math.abs(n))}`;
    return n < 0 ? `(${body})` : body;
  };
}

/**
 * The currency's prefix, in characters the PDF's font can actually draw.
 *
 * jsPDF's built-in Helvetica is WinAnsi-encoded and has no ₹ glyph — emitting
 * one produces a blank or a mojibake box in the reader, on a document that goes
 * to a client. "INR " is used instead: unambiguous, and it renders. $ is in the
 * encoding, so it is used directly.
 */
export function currencyPrefix(currency: string): string {
  if (currency === 'INR') return 'INR ';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

export const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Typographic characters, rewritten to ones the PDF font can actually draw.
 *
 * jsPDF's built-in Helvetica is WinAnsi-encoded: anything above U+00FF is not
 * merely unsupported, it is silently corrupted. An arrow becomes "!", an em
 * dash and a curly apostrophe vanish entirely, and "₹" comes out as " ¹" — all
 * without an error, on a document that goes to a client.
 *
 * Applied at every draw call by `newDoc`, so no string reaches the page
 * untranslated.
 */
const GLYPH_MAP: Array<[RegExp, string]> = [
  [/[→➡]/g, '->'],
  [/[←]/g, '<-'],
  [/[—–]/g, '-'],
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, '...'],
  [/[•·]/g, '·'],
  [/−/g, '-'],
  [/₹/g, 'INR '],
  [/€/g, 'EUR '],
  [/ /g, ' '],
];

export function ascii(text: string): string {
  let out = text;
  for (const [re, to] of GLYPH_MAP) out = out.replace(re, to);
  // Anything still outside the encodable range would be corrupted silently.
  // A visible "?" is the honest rendering of a character this font cannot draw.
  return out.replace(/[^\x20-\xFF]/g, '?');
}

/** `ascii` applied through a string or an array of them, preserving shape. */
function asciiAny<T extends string | string[]>(text: T): T {
  return (Array.isArray(text) ? text.map(ascii) : ascii(text as string)) as T;
}

/**
 * A document whose text primitives transcode on the way in.
 *
 * Patched once at construction rather than at each call site: a report draws
 * from a dozen places and autoTable draws from many more inside itself, and a
 * single forgotten `ascii()` is an invisible defect — it produces a plausible
 * document with one mangled character in it. Wrapping the two entry points
 * (`text` and `splitTextToSize`, which also measures for wrapping and so must
 * see the same string that will be drawn) makes the guarantee structural.
 */
export function newDoc(orientation: 'portrait' | 'landscape' = 'portrait'): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation });

  const text = doc.text.bind(doc);
  (doc as any).text = (t: any, x: number, y: number, ...rest: any[]) =>
    text(typeof t === 'string' || Array.isArray(t) ? asciiAny(t) : t, x, y, ...rest);

  const split = doc.splitTextToSize.bind(doc);
  (doc as any).splitTextToSize = (t: any, w: number, ...rest: any[]) =>
    split(typeof t === 'string' ? ascii(t) : t, w, ...rest);

  return doc;
}

/**
 * The navy masthead and its gold confidentiality strip.
 *
 * `docType` names the document beneath the firm's strapline. The Performance
 * Summary omits it (its identity block carries the name), so it stays optional
 * rather than forcing that document to restate itself.
 */
export function drawBanner(doc: jsPDF, docType?: string): number {
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_W, 54, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...WHITE);
  doc.text(FIRM_NAME.toUpperCase(), MARGIN, 26);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...GOLD);
  doc.text(docType ? `Equity & ETF Advisory  ·  ${docType}` : 'Equity & ETF Advisory', MARGIN, 40);

  doc.setFillColor(...GOLD);
  doc.rect(0, 54, PAGE_W, 2.5, 'F');

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  doc.setTextColor(...GOLD);
  doc.text('PRIVATE & CONFIDENTIAL', PAGE_W - MARGIN, 40, { align: 'right' });

  return 74;
}

/**
 * Who the statement is for, when it was struck, and the window it covers.
 *
 * The sub-line is wrapped rather than clipped: on the Performance Summary it
 * carries the "opened at inception, N days short" qualification, and a
 * truncated "…short of the full window" is precisely the half of the sentence
 * that must not be lost.
 */
export function drawIdentity(
  doc: jsPDF,
  subject: string,
  asOf: Date,
  subLine: string,
  y: number,
): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(subject, MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...GREY);
  doc.text(`Statement as at ${fmtDate(asOf)}`, PAGE_W - MARGIN, y, { align: 'right' });

  let cursor = y + 15;

  doc.setFontSize(9);
  doc.setTextColor(...GREY);
  const wrapped = doc.splitTextToSize(subLine, CONTENT_W);
  doc.text(wrapped, MARGIN, cursor);
  cursor += wrapped.length * 11;

  doc.setDrawColor(...HAIRLINE);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, cursor, PAGE_W - MARGIN, cursor);

  return cursor + 16;
}

/**
 * The closing notes and the disclaimer.
 *
 * `legend` is the calculated-vs-recorded key, which only documents that make
 * that distinction should pass. A risk report has no such distinction and
 * passing it there would advertise a convention the page never uses.
 */
export function drawFooter(
  doc: jsPDF,
  y: number,
  currency: string,
  notes: string[],
  opts: { legend?: boolean } = {},
): void {
  const units =
    currency === 'INR'
      ? 'Figures in INR, Indian numbering (lakh/crore)'
      : `Figures in ${currencyPrefix(currency).trim() || currency}, thousands separated`;

  const lines: string[] = [
    opts.legend
      ? `Blue text = calculated field   |   Black text = as recorded   |   ${units}`
      : units,
    ...notes.map((n) => `Note: ${n}`),
    'This statement is generated for informational purposes only and does not constitute investment advice.',
  ];

  const wrapped = lines.flatMap((l) => doc.splitTextToSize(l, CONTENT_W) as string[]);
  const needed = wrapped.length * 9 + 20;

  let cursor = y + 14;
  if (cursor + needed > PAGE_H - MARGIN) {
    doc.addPage();
    cursor = MARGIN + 10;
  }

  doc.setDrawColor(...HAIRLINE);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, cursor - 8, PAGE_W - MARGIN, cursor - 8);

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(...GREY);
  for (const line of wrapped) {
    doc.text(line, MARGIN, cursor);
    cursor += 9;
  }
}

/**
 * Page numbers, stamped once at the end when the total is finally known.
 *
 * Reads each page's own width rather than assuming PAGE_W, so a landscape
 * detail page keeps its stamp at the right margin instead of mid-page.
 */
export function stampPageNumbers(doc: jsPDF): void {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...GREY);
    doc.text(`Page ${i} of ${total}`, w - MARGIN, h - 20, { align: 'right' });
    doc.text(FIRM_NAME, MARGIN, h - 20);
  }
}

/**
 * A section rule with a title — the divider between blocks of a report.
 * Breaks to a new page when the remaining space could not hold the heading
 * plus at least a couple of rows of whatever follows it.
 */
export function drawSectionTitle(doc: jsPDF, title: string, y: number, minBodyH = 60): number {
  let cursor = y;
  if (cursor + minBodyH > PAGE_H - MARGIN - 30) {
    doc.addPage();
    cursor = MARGIN + 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text(title.toUpperCase(), MARGIN, cursor);

  doc.setDrawColor(...GOLD);
  doc.setLineWidth(1);
  doc.line(MARGIN, cursor + 5, MARGIN + 28, cursor + 5);

  return cursor + 18;
}

/** Slugifies a subject and a qualifier into a filename stem. */
export function fileSlug(subject: string, kind: string, asOf: Date): string {
  const name = subject.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  return `${name}-${kind}-${asOf.toISOString().slice(0, 10)}`;
}
