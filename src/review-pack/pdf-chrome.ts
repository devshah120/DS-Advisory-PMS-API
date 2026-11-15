import * as fs from 'fs';
import * as path from 'path';
import { jsPDF } from 'jspdf';

/**
 * The firm's PDF furniture — the masthead, the identity block, the footer and
 * the page stamps — shared by every client-facing document the app emits.
 *
 * Extracted from `performancePdf.ts`, which drew all of this privately. The
 * Performance Summary was the only PDF for a while, so keeping its chrome
 * inside it cost nothing; now that the Review Pack and the Risk Report are also
 * documents a client receives, a private copy in each would be three
 * independently-drifting versions of the firm's letterhead. A client who
 * receives a review pack and a risk report in the same email must not be able
 * to tell they came from different code.
 *
 * This module owns only the frame: colours, typeface, page geometry, and the
 * blocks that appear on every document regardless of subject. What goes INSIDE
 * the frame is each report's own business.
 *
 * SERVER-SIDE MIRROR of DS-Advisory-PMS/src/lib/pdfChrome.ts, generated from it
 * with only the font loader swapped (disk instead of fetch). The two packages
 * share no code path, so mirror any change to one in the other: a Review Pack
 * built here must be indistinguishable from the frontend's own reports.
 */

/* ── Palette ────────────────────────────────────────────────────────────────
 * A monochromatic navy scheme, as RGB triples (workbooks speak ARGB hex; jsPDF
 * speaks RGB). No gold, no royal blue, no red/green on figures: the sign of a
 * number carries its direction, not its colour. */

/** #1B365D — banner, table headers. */
export const NAVY: [number, number, number] = [27, 54, 93];
/** #EDF2F8 — KPI band and total/summary rows. */
export const LIGHT_NAVY: [number, number, number] = [237, 242, 248];
/** #F7F9FC — alternate-row tint on data tables. */
export const ZEBRA: [number, number, number] = [247, 249, 252];
/** #CBD5E1 — 0.5pt table and divider rules. */
export const BORDER: [number, number, number] = [203, 213, 225];
/** #0F172A — every figure and label. */
export const INK: [number, number, number] = [15, 23, 42];
/** #475569 — captions and secondary text only. */
export const MUTED: [number, number, number] = [71, 85, 105];
export const WHITE: [number, number, number] = [255, 255, 255];
/** Rule weight for every table border and divider. */
export const RULE_W = 0.5;

/*
 * Legacy names, mapped onto the navy scheme so the Risk Report and Review Pack
 * inherit it without each re-plumbing its imports.
 */
export const GOLD = NAVY;
export const GOLD_FILL = LIGHT_NAVY;
export const STONE = ZEBRA;
export const HAIRLINE = BORDER;
export const GREY = MUTED;
/** Status colours, kept for the Risk Report's limit flags only. */
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

/** The one line every document closes on. */
export const DISCLAIMER = 'Generated for informational and reporting purposes only.';

/* ── Typeface ───────────────────────────────────────────────────────────────
 * Perpetua, embedded in every document so it renders identically on every
 * machine. The TTFs are read from assets/fonts on first use; `newDoc` refuses
 * to build without them rather than quietly falling back to Helvetica on a
 * document that goes to a client. */

export const PDF_FONT = 'Perpetua';

type FontStyle = 'normal' | 'bold' | 'italic' | 'bolditalic';

const FONT_FILES: Record<FontStyle, string> = {
  normal: 'Perpetua.ttf',
  bold: 'Perpetua-Bold.ttf',
  italic: 'Perpetua-Italic.ttf',
  bolditalic: 'Perpetua-BoldItalic.ttf',
};

let fontData: Record<FontStyle, string> | null = null;

/**
 * Where the TTFs live: `PDF_FONT_DIR` when set, else `assets/fonts` at the
 * package root — found relative to this file (src/ or dist/) or the cwd.
 */
function fontDir(): string {
  const candidates = [
    process.env.PDF_FONT_DIR,
    path.resolve(__dirname, '../../assets/fonts'),
    path.resolve(process.cwd(), 'assets/fonts'),
  ].filter(Boolean) as string[];
  const found = candidates.find((d) => fs.existsSync(path.join(d, FONT_FILES.normal)));
  if (!found) {
    throw new Error(`Perpetua font files not found; looked in: ${candidates.join(', ')}`);
  }
  return found;
}

/** Reads the Perpetua family from disk once and caches it for every later document. */
export function loadPdfFonts(): void {
  if (fontData) return;
  const dir = fontDir();
  fontData = Object.fromEntries(
    (Object.keys(FONT_FILES) as FontStyle[]).map((style) => [
      style,
      fs.readFileSync(path.join(dir, FONT_FILES[style])).toString('base64'),
    ]),
  ) as Record<FontStyle, string>;
}

function normaliseStyle(style: unknown): FontStyle {
  const s = String(style ?? 'normal').toLowerCase().replace(/[\s-]/g, '');
  if (s === 'bolditalic' || s === 'italicbold' || s === 'boldoblique') return 'bolditalic';
  if (s === 'bold') return 'bold';
  if (s === 'italic' || s === 'oblique') return 'italic';
  return 'normal';
}

/* ── Numbers ────────────────────────────────────────────────────────────── */

/**
 * Money, in the mandate's own currency and its own digit grouping, with the
 * symbol prepended. Used by the Risk Report and Review Pack.
 *
 * Indian statements group in lakh/crore, and a ₹1,24,50,000 rendered as
 * ₹12,450,000 is the kind of error a client notices immediately and an adviser
 * never does. Perpetua has no ₹ glyph, so INR reads "INR ".
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
 * Bare amounts — grouping only, no symbol, a plain leading minus. Used where
 * the page carries a single "All amounts in …" caption instead of repeating the
 * currency in every cell.
 */
export function amountFormatter(currency: string): (n: number) => string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return (n: number) => {
    const rounded = Math.round(n);
    return rounded < 0 ? `-${nf.format(-rounded)}` : nf.format(rounded);
  };
}

/** The currency's prefix, in characters the PDF's font can actually draw. */
export function currencyPrefix(currency: string): string {
  if (currency === 'INR') return 'INR ';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

export const pct = (v: number, dp = 2) => `${(v * 100).toFixed(dp)}%`;

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/* ── Glyphs ─────────────────────────────────────────────────────────────── */

/**
 * Characters Perpetua cannot draw, rewritten to ones it can.
 *
 * The embedded font is Unicode (Identity-H), so dashes, curly quotes and the
 * ellipsis now render as themselves. What Perpetua lacks — arrows, and ₹ — is
 * mapped here; anything else outside its coverage becomes a visible "?" rather
 * than an empty box. Applied at every draw call by `newDoc`.
 */
const GLYPH_MAP: Array<[RegExp, string]> = [
  [/[→➡]/g, '->'],
  [/[←]/g, '<-'],
  [/₹/g, 'INR '],
  [/ /g, ' '],
];

/** Latin-1 plus the WinAnsi punctuation Perpetua covers. */
const DRAWABLE = /[^\x20-\x7E\xA0-\xFF‘’‚“”„•…€™–—−≤≥]/g;

export function ascii(text: string): string {
  let out = text;
  for (const [re, to] of GLYPH_MAP) out = out.replace(re, to);
  return out.replace(DRAWABLE, '?');
}

/** `ascii` applied through a string or an array of them, preserving shape. */
function asciiAny<T extends string | string[]>(text: T): T {
  return (Array.isArray(text) ? text.map(ascii) : ascii(text as string)) as T;
}

/**
 * A document set in Perpetua whose text primitives transcode on the way in.
 *
 * `setFont` is patched so that every family request — the reports' own
 * `setFont('helvetica', …)` calls and the `font: 'helvetica'` autoTable passes
 * internally — resolves to Perpetua in the requested style. That makes the
 * typeface structural rather than a convention each report must remember.
 *
 * Throws if the font files cannot be found, rather than falling back to Helvetica.
 */
export function newDoc(orientation: 'portrait' | 'landscape' = 'portrait'): jsPDF {
  loadPdfFonts();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation });

  for (const style of Object.keys(FONT_FILES) as FontStyle[]) {
    doc.addFileToVFS(FONT_FILES[style], fontData[style]);
    doc.addFont(FONT_FILES[style], PDF_FONT, style);
  }

  const setFont = doc.setFont.bind(doc);
  (doc as any).setFont = (_family: string, style?: string, weight?: string | number) =>
    setFont(PDF_FONT, normaliseStyle(style ?? 'normal'), weight as any);
  doc.setFont(PDF_FONT, 'normal');

  const text = doc.text.bind(doc);
  (doc as any).text = (t: any, x: number, y: number, ...rest: any[]) =>
    text(typeof t === 'string' || Array.isArray(t) ? asciiAny(t) : t, x, y, ...rest);

  const split = doc.splitTextToSize.bind(doc);
  (doc as any).splitTextToSize = (t: any, w: number, ...rest: any[]) =>
    split(typeof t === 'string' ? ascii(t) : t, w, ...rest);

  return doc;
}

/* ── Furniture ──────────────────────────────────────────────────────────── */

/**
 * The navy masthead. The firm's name alone, with `docType` beneath it when the
 * document needs naming (Risk Report, Review Pack); the Performance Summary
 * omits it because its identity block carries the subject.
 */
export function drawBanner(doc: jsPDF, docType?: string): number {
  const h = 54;
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_W, h, 'F');

  const titleY = docType ? 26 : 32;
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...WHITE);
  doc.text(FIRM_NAME.toUpperCase(), MARGIN, titleY);

  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...LIGHT_NAVY);
  if (docType) doc.text(docType, MARGIN, 41);
  doc.text('PRIVATE & CONFIDENTIAL', PAGE_W - MARGIN, titleY, { align: 'right' });

  return h + 20;
}

/**
 * Who the statement is for, when it was struck, and the window it covers.
 * The sub-line is wrapped rather than clipped.
 */
export function drawIdentity(
  doc: jsPDF,
  subject: string,
  asOf: Date,
  subLine: string,
  y: number,
): number {
  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...INK);
  doc.text(subject, MARGIN, y);

  doc.setFont(PDF_FONT, 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(`Statement as at ${fmtDate(asOf)}`, PAGE_W - MARGIN, y, { align: 'right' });

  let cursor = y + 15;

  const wrapped = doc.splitTextToSize(subLine, CONTENT_W);
  doc.text(wrapped, MARGIN, cursor);
  cursor += wrapped.length * 12;

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(RULE_W);
  doc.line(MARGIN, cursor, PAGE_W - MARGIN, cursor);

  return cursor + 16;
}

/**
 * Draws ₹ as vector strokes. Perpetua has no rupee glyph, and the caption is
 * the one place the symbol is wanted; returns the advance width.
 */
function drawRupee(doc: jsPDF, x: number, baseline: number, size: number): number {
  const w = size * 0.5;
  const h = size * 0.66;
  const top = baseline - h;
  doc.setLineWidth(size * 0.06);
  doc.line(x, top, x + w, top);
  doc.line(x, top + h * 0.27, x + w, top + h * 0.27);
  // The bowl: off the top bar, round to the right, back to the left at mid-height…
  const p0x = x + w * 0.25;
  const p3x = x;
  const p3y = top + h * 0.54;
  doc.lines(
    [
      [w * 0.7, 0, w * 0.7, h * 0.54, p3x - p0x, p3y - top],
      // …then the leg, diagonally down to the baseline.
      [w * 0.85, baseline - p3y],
    ],
    p0x,
    top,
    [1, 1],
    'S',
    false,
  );
  return w + size * 0.12;
}

/**
 * The single right-aligned "All amounts in …" caption that replaces a currency
 * prefix on every figure. Returns the y below it.
 */
export function drawAmountsCaption(
  doc: jsPDF,
  currency: string,
  y: number,
  right = PAGE_W - MARGIN,
): number {
  const size = 9;
  doc.setFont(PDF_FONT, 'italic');
  doc.setFontSize(size);
  doc.setTextColor(...MUTED);
  doc.setDrawColor(...MUTED);

  if (currency === 'INR') {
    const head = 'All amounts in ';
    const tail = ' (Indian Rupees)';
    const glyphW = size * 0.62;
    const total = doc.getTextWidth(head) + glyphW + doc.getTextWidth(tail);
    let x = right - total;
    doc.text(head, x, y);
    x += doc.getTextWidth(head);
    drawRupee(doc, x + size * 0.06, y, size);
    x += glyphW;
    doc.text(tail, x, y);
  } else {
    const label = currency === 'USD' ? 'All amounts in $ (US Dollars)' : `All amounts in ${currency}`;
    doc.text(label, right, y, { align: 'right' });
  }
  return y + 8;
}

/**
 * The closing notes and the disclaimer, flowed under the content.
 *
 * Used by the Risk Report and Review Pack, whose notes are part of the
 * analysis. `currency` and `opts` are kept for call-site compatibility; the old
 * calculated-vs-recorded legend and units line are gone.
 */
export function drawFooter(
  doc: jsPDF,
  y: number,
  _currency: string,
  notes: string[],
  _opts: { legend?: boolean } = {},
): void {
  const lines: string[] = [...notes, DISCLAIMER];

  doc.setFont(PDF_FONT, 'italic');
  doc.setFontSize(8);
  const wrapped = lines.flatMap((l) => doc.splitTextToSize(l, CONTENT_W) as string[]);
  const needed = wrapped.length * 10 + 20;

  let cursor = y + 14;
  if (cursor + needed > PAGE_H - MARGIN) {
    doc.addPage();
    cursor = MARGIN + 10;
  }

  doc.setDrawColor(...BORDER);
  doc.setLineWidth(RULE_W);
  doc.line(MARGIN, cursor - 8, PAGE_W - MARGIN, cursor - 8);

  doc.setTextColor(...MUTED);
  for (const line of wrapped) {
    doc.text(line, MARGIN, cursor);
    cursor += 10;
  }
}

/**
 * The bottom line of every page: `footer` (or the firm's name) on the left,
 * the page number on the right, under a hairline. Stamped once at the end when
 * the total is known; reads each page's own size so landscape pages stay true.
 */
export function stampPageNumbers(doc: jsPDF, footer?: string): void {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(RULE_W);
    doc.line(MARGIN, h - 30, w - MARGIN, h - 30);
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Page ${i} of ${total}`, w - MARGIN, h - 18, { align: 'right' });
    doc.text(footer ?? FIRM_NAME, MARGIN, h - 18);
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

  doc.setFont(PDF_FONT, 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...NAVY);
  doc.text(title.toUpperCase(), MARGIN, cursor);

  doc.setDrawColor(...NAVY);
  doc.setLineWidth(1);
  doc.line(MARGIN, cursor + 5, MARGIN + 28, cursor + 5);

  return cursor + 18;
}

/** Slugifies a subject and a qualifier into a filename stem. */
export function fileSlug(subject: string, kind: string, asOf: Date): string {
  const name = subject.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  return `${name}-${kind}-${asOf.toISOString().slice(0, 10)}`;
}
