// Test helpers for CSV report files (not a test file). A generated file starts with its context rows (DF09) and a blank line;
// the report's own header and rows follow. A file without the block fails here rather than reading as a table.

function blankLine(body: string): number {
  const at = body.indexOf('\r\n\r\n');
  if (at < 0) throw new Error('A report file has a context block ending in a blank line');
  return at;
}

/** The report's own table: exactly what catalogue.ts toCsv wrote. */
export const csvTable = (body: string): string => body.slice(blankLine(body) + 4);

/** The context rows by label. */
export function csvContext(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .slice(0, blankLine(body))
      .split('\r\n')
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')) as [string, string]),
  );
}
