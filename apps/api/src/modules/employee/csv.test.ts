import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads quoted values, escaped quotes, CRLF and a byte order mark', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\nlast,')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['last', ''],
    ]);
  });

  it('rejects unterminated and misplaced quotes', () => {
    expect(() => parseCsv('a,"open')).toThrow(CsvError);
    expect(() => parseCsv('a,b"c"')).toThrow(CsvError);
  });
});
