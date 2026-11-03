// FR-054 "Generate PDF": a minimal, dependency-free PDF 1.4 document of text rows laid out in fixed columns.
//
// The file holds a catalog, a page tree, one font and one page object with an uncompressed content stream per page,
// then the cross-reference table and the trailer (PDF 1.4, sections 3.4 and 3.6). The font is the standard Type 1
// Helvetica with WinAnsiEncoding: one of the 14 standard fonts every reader carries, so nothing is embedded. Text is
// written as literal strings with \ ( ) escaped; ISO-8859-1 letters (which WinAnsiEncoding codes identically) are
// octal escapes, and any other character prints as "?", so the file itself stays 7-bit text after its binary marker
// comment. No date, producer or identifier is written: the same rows always give the same bytes. A PDF cell is plain
// text with no formula meaning, so no spreadsheet guard applies here.
//
// Layout: A4 portrait, 40 pt margins, 8 pt text on 11 pt lines. Each row is one or more lines: a cell wraps within its
// column (at spaces, or inside a word longer than the column), measured with Helvetica's own character widths; an
// empty row is a blank line. A row continues on the next page when the page is full.

export const PDF_MEDIA_TYPE = 'application/pdf';

export interface PdfColumn {
  /** The column width in points (1/72 inch); the columns are laid out left to right from the left margin. */
  width: number;
  /** Right-aligned text ends at the column's right edge (amounts); left-aligned starts at its left edge. */
  align?: 'left' | 'right';
}

export const PAGE = { width: 595, height: 842, margin: 40, fontSize: 8, leading: 11 } as const;
/** Space kept clear at the right of every column so that neighbouring cells never touch. */
export const COLUMN_GAP = 4;

/** Helvetica glyph widths (Adobe AFM, 1/1000 em) of the printable ASCII codes 32 (space) to 126 (~). */
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
  722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** No Helvetica glyph of codes 160 to 255 is wider than 1000/1000 em: an upper bound, so measured text never overflows. */
const LATIN1_MAX_WIDTH = 1000;

/** The character a WinAnsiEncoding string can print: ASCII and ISO-8859-1 letters as they are, anything else "?". */
function printable(ch: string): string {
  const code = ch.codePointAt(0)!;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?';
}

/** The width of text in glyph units (1/1000 of the font size), each character as printed. */
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    const code = printable(ch).codePointAt(0)!;
    units += code <= 0x7e ? HELVETICA_ASCII[code - 0x20]! : LATIN1_MAX_WIDTH;
  }
  return units;
}

/** The width in points of text at the page font size. */
export function textWidth(text: string): number {
  return (textUnits(text) * PAGE.fontSize) / 1000;
}

/** Whether a width in glyph units fits in `width` points (integer arithmetic, so no rounding decides a line). */
const fits = (units: number, width: number) => units * PAGE.fontSize <= width * 1000;

/** A PDF literal string: \ ( ) escaped, ISO-8859-1 letters as octal escapes, other characters "?". */
export function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const c = printable(ch);
    const code = c.codePointAt(0)!;
    if (c === '\\' || c === '(' || c === ')') out += `\\${c}`;
    else if (code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += c;
  }
  return `${out})`;
}

/**
 * The lines a cell takes in a column of `width` points: words (separated by spaces, tabs or line breaks, which print
 * as single spaces) kept whole where they fit, and a word wider than the column split after the last character that
 * fits (at least one character per line). An empty cell takes no line.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/[ \t\r\n]+/)) {
    if (word === '') continue;
    const candidate = line === '' ? word : `${line} ${word}`;
    if (fits(textUnits(candidate), width)) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    let part = '';
    let partUnits = 0;
    for (const ch of word) {
      const units = textUnits(ch);
      if (part !== '' && !fits(partUnits + units, width)) {
        lines.push(part);
        part = '';
        partUnits = 0;
      }
      part += ch;
      partUnits += units;
    }
    line = part;
  }
  if (line !== '') lines.push(line);
  return lines;
}

const fixed = (n: number) => (Math.round(n * 100) / 100).toString();

/** The content streams of the pages: every row laid out in the columns, top to bottom. */
export function layoutPages(rows: readonly (readonly string[])[], columns: readonly PdfColumn[]): string[] {
  const lefts = columns.map((_, i) => PAGE.margin + columns.slice(0, i).reduce((sum, c) => sum + c.width, 0));
  const top = PAGE.height - PAGE.margin - PAGE.fontSize;
  const pages: string[] = [];
  let ops: string[] = [];
  let y = top;
  const newLine = () => {
    if (y < PAGE.margin) {
      pages.push(ops.join('\n'));
      ops = [];
      y = top;
    }
  };
  for (const row of rows) {
    if (row.length > columns.length) throw new Error('A row has more cells than there are columns');
    const cells = row.map((text, i) => wrapText(text, columns[i]!.width - COLUMN_GAP));
    const height = Math.max(1, ...cells.map((c) => c.length));
    for (let line = 0; line < height; line++) {
      newLine();
      cells.forEach((lines, i) => {
        const text = lines[line];
        if (text === undefined) return;
        const column = columns[i]!;
        const x = column.align === 'right' ? lefts[i]! + column.width - COLUMN_GAP - textWidth(text) : lefts[i]!;
        ops.push(`1 0 0 1 ${fixed(x)} ${fixed(y)} Tm ${pdfString(text)} Tj`);
      });
      y -= PAGE.leading;
    }
  }
  pages.push(ops.join('\n'));
  return pages.map((body) => (body === '' ? '' : `BT\n/F1 ${PAGE.fontSize} Tf\n${body}\nET`));
}

/** The PDF file: the rows laid out in the columns over as many A4 pages as they need (always at least one). */
export function pdfDocument(rows: readonly (readonly string[])[], columns: readonly PdfColumn[]): Buffer {
  const contents = layoutPages(rows, columns);
  const pageCount = contents.length;
  // Objects: 1 catalog, 2 page tree, 3 font, then each page followed by its content stream.
  const pageId = (i: number) => 4 + 2 * i;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  contents.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  });
  // The binary comment after the header marks the file as binary for transfer tools (PDF 1.4, 3.4.1).
  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  // Each cross-reference entry is exactly 20 bytes: 10-digit offset, 5-digit generation, type, space and newline.
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
