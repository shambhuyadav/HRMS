// Test helpers for XLSX outputs (not a test file): an independent reader of the ZIP container that checks every
// structural field and recomputes each entry's CRC-32 with its own table (not the writer's zlib.crc32), and a reader
// of the worksheet's cells.
import { expect } from 'vitest';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (IEEE 802.3, the ZIP checksum), bit-reflected table form. */
export function crc32Reference(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The entries of a ZIP archive written by zipStored, after checking that the end record, the central directory and
 * each local header agree (signatures, method, sizes, names, offsets, no gaps) and that every CRC-32 matches the data.
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end), 'end of central directory signature').toBe(0x06054b50);
  expect(zip.readUInt16LE(end + 4)).toBe(0);
  expect(zip.readUInt16LE(end + 6)).toBe(0);
  const count = zip.readUInt16LE(end + 10);
  expect(zip.readUInt16LE(end + 8)).toBe(count);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryStart = zip.readUInt32LE(end + 16);
  expect(directoryStart + directorySize, 'the central directory ends where the end record starts').toBe(end);
  expect(zip.readUInt16LE(end + 20)).toBe(0);
  const entries = new Map<string, Buffer>();
  let p = directoryStart;
  let next = 0;
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p), 'central directory signature').toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    expect([method, compressed], `${name} is stored`).toEqual([0, size]);
    expect(offset, `${name} follows the previous entry`).toBe(next);
    // The local header repeats what the central directory says.
    expect(zip.readUInt32LE(offset), `${name} local header signature`).toBe(0x04034b50);
    expect([zip.readUInt16LE(offset + 8), zip.readUInt32LE(offset + 14), zip.readUInt32LE(offset + 18), zip.readUInt32LE(offset + 22)]).toEqual([method, crc, compressed, size]);
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    expect(zip.subarray(offset + 30, offset + 30 + localName).toString('utf8')).toBe(name);
    const start = offset + 30 + localName + localExtra;
    const data = zip.subarray(start, start + size);
    expect(data.length).toBe(size);
    expect(crc32Reference(data), `${name} CRC-32`).toBe(crc);
    expect(entries.has(name), `${name} is unique`).toBe(false);
    entries.set(name, Buffer.from(data));
    next = start + size;
    p += 46 + nameLength + extraLength + commentLength;
  }
  expect(next, 'the entries end where the central directory starts').toBe(directoryStart);
  expect(p).toBe(end);
  return entries;
}

export interface SheetCellRead {
  ref: string;
  kind: 'text' | 'number';
  value: string;
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The cells of sheet1.xml, row by row: inline strings as text, <v> cells as numbers; no cell may be a formula. */
export function sheetCells(xml: string): SheetCellRead[][] {
  expect(xml).not.toContain('<f>');
  expect(xml).not.toContain('<f ');
  return [...xml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)].map((row, i) => {
    expect(Number(row[1])).toBe(i + 1);
    return [...row[2]!.matchAll(/<c r="([A-Z]+\d+)"( t="inlineStr")?>(?:<is><t xml:space="preserve">([\s\S]*?)<\/t><\/is>|<v>([^<]*)<\/v>)<\/c>/g)].map((c) =>
      c[2] ? { ref: c[1]!, kind: 'text' as const, value: unescape(c[3]!) } : { ref: c[1]!, kind: 'number' as const, value: c[4]! },
    );
  });
}

/** A worksheet as plain rows of text, empty cells included, given the number of columns. */
export function sheetRows(xml: string, columns: number): string[][] {
  const letters = (i: number) => {
    let name = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  };
  return sheetCells(xml).map((cells, r) => Array.from({ length: columns }, (_, i) => cells.find((c) => c.ref === `${letters(i)}${r + 1}`)?.value ?? ''));
}
