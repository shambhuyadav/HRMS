// The dependency-free XLSX writer (FR-046 "Export XLSX"; FR-065): a valid ZIP container (structure and CRC-32 checked
// by an independent reader), the minimal SpreadsheetML parts, XML escaping and the CSV writer's formula guard.
import { describe, expect, it } from 'vitest';
import { cellText, csvCell, type ReportDefinition, toCsv, toXlsx } from './catalogue.js';
import { columnName, sheetName, XLSX_MEDIA_TYPE, xlsxWorkbook, xmlText, zipStored } from './xlsx.js';
import { crc32Reference, readZip, sheetCells, sheetRows } from './xlsx.fixtures.js';

const PARTS = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml'];

const DEF: ReportDefinition = {
  code: 'SYNTHETIC',
  title: 'Synthetic: [hours] / week?',
  resource: 'timesheet',
  fieldGroup: 'operational',
  requiresPeriod: false,
  columns: [
    { key: 'code', header: 'Code' },
    { key: 'note', header: 'Note' },
    { key: 'hours', header: 'Hours', numeric: true },
    { key: 'lines', header: 'Lines', numeric: true },
  ],
  rows: async () => [],
};

const ROWS: Record<string, unknown>[] = [
  { code: 'E-1', note: 'Tom & Jerry <"quoted"> it\'s', hours: '12.50', lines: 3 },
  { code: '=HYPERLINK("http://example.test","x")', note: '+1', hours: '-2.25', lines: 0 },
  { code: '-5', note: '@SUM(A1)', hours: '=1+1', lines: null },
  { code: '\tTab', note: '\rReturn', hours: '', lines: undefined },
  { code: 'Line\nbreak', note: 'bell\u0007 and \ud800 lone', hours: '1e5', lines: 'n/a' },
];

describe('ZIP container', () => {
  it('writes stored entries whose local headers, central directory and CRC-32 agree', () => {
    expect(crc32Reference(Buffer.from('123456789'))).toBe(0xcbf43926);
    const zip = zipStored([
      { name: 'a.txt', data: Buffer.from('alpha') },
      { name: 'empty/', data: Buffer.alloc(0) },
      { name: 'dir/b.bin', data: Buffer.from([0, 255, 1, 254]) },
    ]);
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(['a.txt', 'empty/', 'dir/b.bin']);
    expect(entries.get('a.txt')!.toString()).toBe('alpha');
    expect([...entries.get('dir/b.bin')!]).toEqual([0, 255, 1, 254]);
    // The same content gives the same bytes (fixed DOS time).
    expect(zipStored([{ name: 'a.txt', data: Buffer.from('alpha') }]).equals(zipStored([{ name: 'a.txt', data: Buffer.from('alpha') }]))).toBe(true);
  });
});

describe('workbook parts', () => {
  it('holds the minimal SpreadsheetML parts with their content types and relationships', () => {
    const entries = readZip(xlsxWorkbook('Synthetic', [['Header'], ['Value']]));
    expect([...entries.keys()]).toEqual(PARTS);
    const types = entries.get('[Content_Types].xml')!.toString('utf8');
    expect(types).toContain('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>');
    expect(types).toContain('<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    expect(types).toContain('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>');
    expect(entries.get('_rels/.rels')!.toString('utf8')).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"');
    expect(entries.get('xl/_rels/workbook.xml.rels')!.toString('utf8')).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"');
    expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain('<sheet name="Synthetic" sheetId="1" r:id="rId1"/>');
    for (const xml of entries.values()) expect(xml.toString('utf8').startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(XLSX_MEDIA_TYPE).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('names columns and the sheet as Excel requires', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(sheetName('Synthetic: [hours] / week?')).toBe('Synthetic hours week');
    expect(sheetName('TMS hours by employee, project, job, activity and period')).toBe('TMS hours by employee, project,');
    expect(sheetName("'quoted'")).toBe('quoted');
    expect(sheetName('[]')).toBe('Report');
    expect(xmlText(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
    expect(xmlText('ok\u0000\u0008￾\t\n\r\u{1F600}')).toBe('ok���\t\n\r\u{1F600}');
  });
});

describe('report output (FR-046, FR-065)', () => {
  it('holds the same header and rows as the CSV, escaped, with formula-like text guarded and plain decimals as numbers', () => {
    const entries = readZip(toXlsx(DEF, ROWS));
    expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain('<sheet name="Synthetic hours week"');
    const xml = entries.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    // Escaped in the XML, never raw.
    expect(xml).toContain('Tom &amp; Jerry &lt;&quot;quoted&quot;&gt; it&apos;s');
    expect(xml).not.toContain('<"quoted">');
    const cells = sheetCells(xml);
    expect(cells[0]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A1', 'text', 'Code'],
      ['B1', 'text', 'Note'],
      ['C1', 'text', 'Hours'],
      ['D1', 'text', 'Lines'],
    ]);
    expect(cells[1]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A2', 'text', 'E-1'],
      ['B2', 'text', 'Tom & Jerry <"quoted"> it\'s'],
      ['C2', 'number', '12.50'],
      ['D2', 'number', '3'],
    ]);
    // Formula-like text keeps a leading apostrophe, exactly as in the CSV; a numeric column holds a number only when
    // the value is a plain decimal, and anything else there is guarded text.
    expect(cells[2]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A3', 'text', `'=HYPERLINK("http://example.test","x")`],
      ['B3', 'text', "'+1"],
      ['C3', 'number', '-2.25'],
      ['D3', 'number', '0'],
    ]);
    expect(cells[3]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A4', 'text', "'-5"],
      ['B4', 'text', "'@SUM(A1)"],
      ['C4', 'text', "'=1+1"],
    ]);
    expect(cells[4]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A5', 'text', "'\tTab"],
      ['B5', 'text', "'\rReturn"],
    ]);
    expect(cells[5]!.map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['A6', 'text', 'Line\nbreak'],
      ['B6', 'text', 'bell� and � lone'],
      ['C6', 'text', '1e5'],
      ['D6', 'text', 'n/a'],
    ]);
    // Cell for cell the CSV text (every CSV cell is quoted with quotes doubled), header included.
    const csv = toCsv(DEF, ROWS.slice(0, 4))
      .trimEnd()
      .split('\r\n')
      .map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
    expect(csv).toHaveLength(5);
    // The one difference: CSV has no cell types, so a negative decimal is guarded there; in the workbook it is a number
    // cell, which is never a formula.
    expect(csv[2]![2]).toBe("'-2.25");
    csv[2]![2] = '-2.25';
    expect(sheetRows(xml, 4).slice(0, 5)).toEqual(csv);
    expect(cellText('=x')).toBe("'=x");
    expect(csvCell('=x')).toBe(`"'=x"`);
  });
});
