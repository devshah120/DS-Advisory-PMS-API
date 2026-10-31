/**
 * Positioned text out of a PDF, one array per page.
 *
 * A broker statement is a table, and its text layer only makes sense with
 * coordinates attached: a narrow cell wraps "INE08N601015" onto two lines, and
 * reading the stream in order interleaves those fragments with the security
 * name beside them. Keeping x/y lets the parser rebuild each cell by column
 * instead of guessing where one value ends and the next begins.
 *
 * pdfjs-dist is pinned to 3.x deliberately: it is the last line that ships a
 * CommonJS legacy build, which this CommonJS Nest app can `require` without an
 * ESM loader shim.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

export interface TextItem {
  str: string;
  /** Left edge, PDF points from the page's left. */
  x: number;
  /** Baseline, PDF points from the page's BOTTOM — larger is higher up. */
  y: number;
  width: number;
}

export class PdfPasswordError extends Error {}

export async function extractPositionedText(
  data: Buffer,
  password?: string,
): Promise<TextItem[][]> {
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      password,
      // Text extraction only: no fonts to render, no eval'd glyph programs,
      // and no console noise about the standard fonts we never draw.
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    if ((error as { name?: string }).name === 'PasswordException') {
      throw new PdfPasswordError(
        password ? 'The PDF password is incorrect' : 'This PDF is password-protected',
      );
    }
    throw error;
  }

  try {
    const pages: TextItem[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .filter((it: any) => typeof it.str === 'string' && it.str.trim() !== '')
          .map((it: any) => ({
            str: it.str.trim(),
            x: it.transform[4],
            y: it.transform[5],
            width: it.width ?? 0,
          })),
      );
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}
