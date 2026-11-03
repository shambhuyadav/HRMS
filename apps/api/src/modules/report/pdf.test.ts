// The dependency-free PDF writer (FR-054 "Generate PDF"): a valid PDF 1.4 file (header, cross-reference offsets,
// trailer, stream lengths and page tree checked by an independent reader), the standard Helvetica font with
// WinAnsiEncoding, string escaping, column layout with wrapping measured in Helvetica widths, and pagination.
import { describe, expect, it } from 'vitest';
import { COLUMN_GAP, PAGE, pdfDocument, type PdfColumn, pdfString, textWidth, wrapText } from './pdf.js';
import { pdfLines, readPdf } from './pdf.fixtures.js';

const COLUMNS: PdfColumn[] = [{ width: 100 }, { width: 200 }, { width: 100, align: 'right' }];
/** The baselines of one page: from the top margin down while above the bottom margin. */
const LINES_PER_PAGE = Math.floor((PAGE.height - PAGE.margin - PAGE.fontSize - PAGE.margin) / PAGE.leading) + 1;

describe('PDF file structure', () => {
  it('writes a catalog, page tree, the standard Helvetica font and one page whose offsets and lengths agree', () => {
    const pdf = pdfDocument([['Code', 'Name', 'Amount'], ['BASIC', 'Basic pay (synthetic)', '100.00']], COLUMNS);
    const read = readPdf(pdf);
    expect(read.font).toBe('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    expect(read.mediaBoxes).toEqual(['0 0 595 842']);
    expect(read.pages).toHaveLength(1);
    expect(pdfLines(pdf)).toEqual([
      ['Code', 'Name', 'Amount'],
      ['BASIC', 'Basic pay (synthetic)', '100.00'],
    ]);
    // Nothing varies between runs: no date, producer or identifier.
    expect(pdfDocument([['Code', 'Name', 'Amount'], ['BASIC', 'Basic pay (synthetic)', '100.00']], COLUMNS).equals(pdf)).toBe(true);
    expect(pdf.toString('latin1')).not.toMatch(/CreationDate|Producer|\/ID/);
  });

  it('writes one empty page for no rows', () => {
    const read = readPdf(pdfDocument([], COLUMNS));
    expect(read.pages).toEqual([[]]);
  });

  it('refuses a row with more cells than columns', () => {
    expect(() => pdfDocument([['a', 'b', 'c', 'd']], COLUMNS)).toThrow(/more cells/);
  });
});

describe('PDF text', () => {
  it('escapes backslashes and parentheses, writes ISO-8859-1 letters as octal codes and anything else as ?', () => {
    expect(pdfString('a (b) \\ c')).toBe('(a \\(b\\) \\\\ c)');
    expect(pdfString('Café')).toBe('(Caf\\351)');
    expect(pdfString('€ अ \u0007 \u{1F600}')).toBe('(? ? ? ?)');
    // Text that would be a formula in a spreadsheet is ordinary text in a PDF.
    const pdf = pdfDocument([['=HYPERLINK("x")', 'Tom & (Jerry) \\ Café ½', 'Ω']], COLUMNS);
    expect(pdfLines(pdf)).toEqual([['=HYPERLINK("x")', 'Tom & (Jerry) \\ Café ½', '?']]);
    expect(pdf.toString('latin1')).toContain('(Tom & \\(Jerry\\) \\\\ Caf\\351 \\275) Tj');
  });

  it('measures text in Helvetica widths (1/1000 em at 8 pt)', () => {
    const at8 = (units: number) => (units * PAGE.fontSize) / 1000;
    expect(textWidth('')).toBe(0);
    expect(textWidth(' ')).toBeCloseTo(at8(278));
    expect(textWidth('0123456789')).toBeCloseTo(at8(5560));
    expect(textWidth('il')).toBeCloseTo(at8(444));
    expect(textWidth('MW')).toBeCloseTo(at8(833 + 944));
    expect(textWidth('@~')).toBeCloseTo(at8(1015 + 584));
    expect(textWidth("'`")).toBeCloseTo(at8(191 + 333));
    // ISO-8859-1 letters count at the widest glyph (an upper bound); other characters as the ? printed for them.
    expect(textWidth('é')).toBeCloseTo(at8(1000));
    expect(textWidth('€')).toBeCloseTo(textWidth('?'));
  });

  it('wraps a cell at spaces within its column, splits a word wider than the column, and drops empty cells', () => {
    const width = 60;
    const lines = wrapText('Leave encashment for unused annual days', width);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(width);
    expect(lines.join(' ')).toBe('Leave encashment for unused annual days');
    const word = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS_COMPONENT';
    const pieces = wrapText(word, width);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(textWidth(p)).toBeLessThanOrEqual(width);
    expect(pieces.join('')).toBe(word);
    // Each piece but the last is full: one more character would not fit.
    for (const [i, p] of pieces.slice(0, -1).entries()) expect(textWidth(p + pieces[i + 1]![0])).toBeGreaterThan(width);
    expect(wrapText('tab\tand\r\nbreaks  collapse', 500)).toEqual(['tab and breaks collapse']);
    expect(wrapText('', 50)).toEqual([]);
    expect(wrapText('   ', 50)).toEqual([]);
    // A column narrower than one character still prints every character, one per line.
    expect(wrapText('WW', 1)).toEqual(['W', 'W']);
  });
});

describe('PDF layout', () => {
  it('starts each column at its left edge and ends right-aligned text at its right edge, less the gap', () => {
    const page = readPdf(pdfDocument([['A', 'B', '1234.5678']], COLUMNS)).pages[0]!;
    const [a, b, amount] = page;
    expect(a).toMatchObject({ x: PAGE.margin, y: PAGE.height - PAGE.margin - PAGE.fontSize, text: 'A' });
    expect(b).toMatchObject({ x: PAGE.margin + 100, text: 'B' });
    expect(amount!.x + textWidth('1234.5678')).toBeCloseTo(PAGE.margin + 300 + 100 - COLUMN_GAP, 1);
  });

  it('gives a wrapped row as many lines as its tallest cell, and an empty row one blank line', () => {
    const name = 'A component name long enough to need several lines in its column of the synthetic layout';
    const page = readPdf(pdfDocument([['X', name, '1'], [], ['Y', 'short', '2']], COLUMNS)).pages[0]!;
    const nameLines = wrapText(name, 200 - COLUMN_GAP);
    expect(nameLines.length).toBeGreaterThan(1);
    const top = PAGE.height - PAGE.margin - PAGE.fontSize;
    expect(page.filter((t) => t.x === PAGE.margin + 100).map((t) => [t.y, t.text])).toEqual([
      ...nameLines.map((l, i) => [top - i * PAGE.leading, l]),
      [top - (nameLines.length + 1) * PAGE.leading, 'short'],
    ]);
    expect(page.find((t) => t.text === 'Y')!.y).toBe(top - (nameLines.length + 1) * PAGE.leading);
  });

  it('continues on new pages when a page is full, keeping every row in order', () => {
    const rows = Array.from({ length: 2 * LINES_PER_PAGE + 12 }, (_, i) => [`R${i + 1}`, `row ${i + 1}`, `${i + 1}.00`]);
    const pdf = pdfDocument(rows, COLUMNS);
    const read = readPdf(pdf);
    expect(read.pages.map((p) => p.length / 3)).toEqual([LINES_PER_PAGE, LINES_PER_PAGE, 12]);
    // The lowest baseline stays above the bottom margin.
    for (const p of read.pages) expect(Math.min(...p.map((t) => t.y))).toBeGreaterThanOrEqual(PAGE.margin);
    expect(pdfLines(pdf)).toEqual(rows);
  });

  it('splits a row taller than the rest of the page across pages', () => {
    const filler = Array.from({ length: LINES_PER_PAGE - 1 }, (_, i) => [`F${i}`]);
    const pdf = pdfDocument([...filler, ['TALL', 'word '.repeat(80).trim(), 'END']], COLUMNS);
    const read = readPdf(pdf);
    expect(read.pages).toHaveLength(2);
    // The row's first line (all three cells) ends page 1; the rest of its wrapped cell is on page 2.
    expect(read.pages[0]!.slice(-3).map((t) => t.text.split(' ')[0])).toEqual(['TALL', 'word', 'END']);
    expect(read.pages[1]!.length).toBeGreaterThan(0);
    expect(read.pages[1]!.every((t) => t.x === PAGE.margin + 100 && t.text.startsWith('word'))).toBe(true);
    expect(pdfLines(pdf).slice(LINES_PER_PAGE).flat().join(' ').split(' ').length + read.pages[0]!.at(-2)!.text.split(' ').length).toBe(80);
  });
});
