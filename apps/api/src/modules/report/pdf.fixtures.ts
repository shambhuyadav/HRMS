// Test helpers for PDF outputs (not a test file): an independent reader of the files pdf.ts writes that checks the
// header, every cross-reference offset, the trailer, each stream length and the page tree, and returns the text each
// page shows with its position.
import { expect } from 'vitest';

export interface PdfText {
  x: number;
  y: number;
  text: string;
}

export interface PdfRead {
  pages: PdfText[][];
  font: string;
  mediaBoxes: string[];
}

/** A literal string's text: \\ \( \) and \ddd (octal, one WinAnsiEncoding code) unescaped. */
function unescape(literal: string): string {
  return literal.replace(/\\([\\()]|[0-7]{3})/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(Number.parseInt(e, 8)) : e));
}

export function readPdf(pdf: Buffer): PdfRead {
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-1.4\n%'), 'PDF 1.4 header').toBe(true);
  expect(text.endsWith('\n%%EOF\n'), 'end-of-file marker').toBe(true);
  // Only the binary marker comment (second line) has bytes above 127: the rest is 7-bit text.
  const marker = text.indexOf('\n', 9);
  expect(pdf.subarray(marker).findIndex((byte) => byte > 0x7f), 'a byte above 127 after the marker line').toBe(-1);
  const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  expect(startxref, 'startxref').not.toBeNull();
  const xrefAt = Number(startxref![1]);
  expect(text.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt))!;
  const size = Number(head[1]);
  const entriesAt = xrefAt + head[0].length;
  // Each entry is exactly 20 bytes; the first is the head of the free list.
  expect(text.slice(entriesAt, entriesAt + 20)).toBe('0000000000 65535 f \n');
  const objects = new Map<number, string>();
  for (let i = 1; i < size; i++) {
    const entry = text.slice(entriesAt + 20 * i, entriesAt + 20 * (i + 1));
    expect(entry, `cross-reference entry ${i}`).toMatch(/^\d{10} 00000 n \n$/);
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${i} 0 obj\n`.length), `object ${i} starts at its offset`).toBe(`${i} 0 obj\n`);
    const end = text.indexOf('\nendobj\n', offset);
    objects.set(i, text.slice(offset + `${i} 0 obj\n`.length, end));
  }
  expect(text.slice(entriesAt + 20 * size)).toMatch(new RegExp(`^trailer\\n<< /Size ${size} /Root 1 0 R >>\\nstartxref\\n`));
  expect(objects.get(1)).toBe('<< /Type /Catalog /Pages 2 0 R >>');
  const tree = /^<< \/Type \/Pages \/Kids \[([\d R]+)\] \/Count (\d+) >>$/.exec(objects.get(2)!)!;
  const kids = [...tree[1]!.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  expect(kids).toHaveLength(Number(tree[2]));
  const font = objects.get(3)!;
  const pages: PdfText[][] = [];
  const mediaBoxes: string[] = [];
  for (const kid of kids) {
    const page = /^<< \/Type \/Page \/Parent 2 0 R \/MediaBox \[([\d ]+)\] \/Resources << \/Font << \/F1 3 0 R >> >> \/Contents (\d+) 0 R >>$/.exec(objects.get(kid)!);
    expect(page, `page object ${kid}`).not.toBeNull();
    mediaBoxes.push(page![1]!);
    const stream = /^<< \/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/.exec(objects.get(Number(page![2]))!)!;
    expect(stream[2]!.length, 'stream length').toBe(Number(stream[1]));
    const content = stream[2]!;
    if (content === '') {
      pages.push([]);
      continue;
    }
    expect(content.startsWith('BT\n/F1 8 Tf\n') && content.endsWith('\nET')).toBe(true);
    const ops = content.slice('BT\n/F1 8 Tf\n'.length, -'\nET'.length).split('\n');
    pages.push(
      ops.map((op) => {
        const m = /^1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Tm \(((?:[^\\()]|\\[\\()]|\\[0-7]{3})*)\) Tj$/.exec(op);
        expect(m, `text operator ${op}`).not.toBeNull();
        return { x: Number(m![1]), y: Number(m![2]), text: unescape(m![3]!) };
      }),
    );
  }
  return { pages, font, mediaBoxes };
}

/** The text of every printed line, page after page, top to bottom; within a line the texts left to right. */
export function pdfLines(pdf: Buffer): string[][] {
  const lines: string[][] = [];
  for (const page of readPdf(pdf).pages) {
    const ys = [...new Set(page.map((t) => t.y))].sort((a, b) => b - a);
    for (const y of ys) lines.push(page.filter((t) => t.y === y).sort((a, b) => a.x - b.x).map((t) => t.text));
  }
  return lines;
}
