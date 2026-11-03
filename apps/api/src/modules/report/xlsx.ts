// FR-046 "Export XLSX": a minimal, dependency-free Office Open XML workbook (ECMA-376) with one worksheet.
//
// The package is a ZIP archive of stored (uncompressed) entries, each with its CRC-32 (zlib.crc32), a local file
// header before its data and a central directory record after all of them, closed by the end-of-central-directory
// record (APPNOTE 4.3). ZIP64 is not written, so an archive is limited to 65,535 entries and 4 GiB; a larger one is
// refused rather than written corrupt. Entries carry the DOS epoch (1980-01-01 00:00) as their time, so the same
// content always gives the same bytes.
//
// The parts are the minimal SpreadsheetML set: [Content_Types].xml, _rels/.rels, xl/workbook.xml,
// xl/_rels/workbook.xml.rels and xl/worksheets/sheet1.xml. Text is written as inline strings (no shared-string
// table, no styles); a number cell holds a plain decimal only. No cell is ever a formula: the writer has no <f>
// element, and callers pass text already guarded against formula injection (catalogue.ts cellText).
import { crc32 } from 'node:zlib';

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A cell: text (an inline string) or a number written as given (a plain decimal such as "-12.50"). */
export type SheetCell = string | { number: string };

/** The numbers a number cell holds: an optional minus, digits and an optional fraction (no exponent, no grouping). */
export const PLAIN_DECIMAL = /^-?\d{1,15}(\.\d{1,15})?$/;

/** Text a worksheet can hold: XML escaped, with characters XML 1.0 cannot carry replaced by U+FFFD. */
export function xmlText(value: string): string {
  return value
    .replace(/[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The column letters of a zero-based column index (0 -> A, 25 -> Z, 26 -> AA). */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A worksheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ], not starting or ending with '. */
export function sheetName(title: string): string {
  const name = title
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .replace(/^'+|'+$/g, '')
    .trim();
  return name || 'Report';
}

function cellXml(ref: string, cell: SheetCell): string {
  if (typeof cell === 'string') return cell === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
  if (!PLAIN_DECIMAL.test(cell.number)) throw new Error(`Not a plain decimal: ${cell.number}`);
  return `<c r="${ref}"><v>${cell.number}</v></c>`;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function worksheetXml(rows: readonly (readonly SheetCell[])[]): string {
  const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => cellXml(`${columnName(i)}${r + 1}`, c)).join('')}</row>`).join('');
  return `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetData>${body}</sheetData></worksheet>`;
}

/** The workbook package: one worksheet named after `title`, rows in order (the first is usually the header). */
export function xlsxWorkbook(title: string, rows: readonly (readonly SheetCell[])[]): Buffer {
  const parts: [string, string][] = [
    [
      '[Content_Types].xml',
      `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ],
    ['_rels/.rels', `${XML_DECLARATION}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      'xl/workbook.xml',
      `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL}"><sheets><sheet name="${xmlText(sheetName(title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    ['xl/_rels/workbook.xml.rels', `${XML_DECLARATION}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', worksheetXml(rows)],
  ];
  return zipStored(parts.map(([name, xml]) => ({ name, data: Buffer.from(xml, 'utf8') })));
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const VERSION = 20; // 2.0 (entry names with folders), made by MS-DOS (no Unix attributes)
const UTF8_NAMES = 0x0800; // general purpose bit 11: names are UTF-8

/** A ZIP archive of stored entries (no compression, no ZIP64, no encryption). */
export function zipStored(entries: readonly { name: string; data: Buffer }[]): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many ZIP entries');
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    if (offset + 30 + fileName.length + data.length > 0xffffffff) throw new Error('ZIP archive too large');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(VERSION, 4); // made by: MS-DOS / FAT attributes, 2.0
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8_NAMES, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt16LE(0, 30); // extra field length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number start
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(offset, 42); // local header offset
    chunks.push(local, fileName, data);
    central.push(record, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > 0xffffffff) throw new Error('ZIP archive too large');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, directory, end]);
}
