// Minimal RFC 4180 CSV reader for bulk imports: comma separated, double-quote escaping, CRLF or LF rows.
// Values are returned as text; each import validates and converts its own columns.

export class CsvError extends Error {}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      if (field !== '') throw new CsvError(`Unexpected quote in row ${rows.length + 1}`);
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new CsvError('Unterminated quoted value');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry no data.
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}
