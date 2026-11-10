// Value parsing for the data migration toolkit (DQ-04): dates in the extract's declared pattern, exact decimals (never JavaScript
// floating point; B1 MONEY/QTY), flags, and the CSV the import templates read. Nothing here guesses: a value that does not match
// the declared format is a finding, never silently converted.
import { createHash } from 'node:crypto';
import { isCalendarDate } from '../../apps/api/src/modules/imports/batch.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A parser for one declared date pattern (tokens YYYY, MMM, MM, M, DD, D; anything else literal) returning YYYY-MM-DD or null. */
export function dateParser(pattern: string): (value: string) => string | null {
  const order: ('Y' | 'M' | 'MMM' | 'D')[] = [];
  let source = '';
  for (let i = 0; i < pattern.length; ) {
    const rest = pattern.slice(i);
    const token = ['YYYY', 'MMM', 'MM', 'DD', 'M', 'D'].find((t) => rest.startsWith(t));
    if (token) {
      source += { YYYY: '(\\d{4})', MMM: '([A-Za-z]{3})', MM: '(\\d{2})', DD: '(\\d{2})', M: '(\\d{1,2})', D: '(\\d{1,2})' }[token];
      order.push(token === 'YYYY' ? 'Y' : token === 'MMM' ? 'MMM' : token.startsWith('M') ? 'M' : 'D');
      i += token.length;
    } else {
      source += rest[0]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 1;
    }
  }
  const re = new RegExp(`^${source}$`);
  return (value) => {
    const m = re.exec(value.trim());
    if (!m) return null;
    let y = '';
    let mo = '';
    let d = '';
    order.forEach((t, i) => {
      const part = m[i + 1]!;
      if (t === 'Y') y = part;
      else if (t === 'D') d = part.padStart(2, '0');
      else if (t === 'M') mo = part.padStart(2, '0');
      else {
        const n = MONTHS.indexOf(part.toUpperCase());
        mo = n < 0 ? '' : String(n + 1).padStart(2, '0');
      }
    });
    const iso = `${y}-${mo}-${d}`;
    return isCalendarDate(iso) ? iso : null;
  };
}

export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

export interface ParsedDecimal {
  /** Canonical text without grouping, as typed after the point (e.g. "1200000.50"). */
  text: string;
  /** The value times 10^4. */
  scaled: bigint;
  decimals: number;
  negative: boolean;
}

/** An exact decimal, with the extract's thousands separator allowed only between proper groups (so "1,5" is never 15). */
export function parseDecimal(value: string, thousandsSeparator = ''): ParsedDecimal | null {
  const v = value.trim();
  const sep = thousandsSeparator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const grouped = sep ? new RegExp(`^-?\\d{1,3}(?:${sep}\\d{2,3})+(?:\\.\\d+)?$`) : null;
  if (!/^-?\d+(\.\d+)?$/.test(v) && !(grouped && grouped.test(v))) return null;
  const plain = sep ? v.split(thousandsSeparator).join('') : v;
  const negative = plain.startsWith('-');
  const [int, frac = ''] = plain.replace('-', '').split('.') as [string, string?];
  if (frac.length > SCALE) return { text: plain, scaled: 0n, decimals: frac.length, negative };
  const scaled = BigInt(int) * FACTOR + BigInt((frac + '0000').slice(0, SCALE));
  return { text: plain.replace(/^-?0+(?=\d)/, negative ? '-' : ''), scaled: negative ? -scaled : scaled, decimals: frac.length, negative };
}

/** A database numeric (text) times 10^4. */
export function scaledOf(text: string): bigint {
  const parsed = parseDecimal(text);
  if (!parsed) throw new Error(`not a decimal: ${text}`);
  return parsed.scaled;
}

/** Shows a scaled value with `decimals` places (default: as many as needed, at least two). */
export function formatScaled(scaled: bigint, decimals?: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const int = abs / FACTOR;
  let frac = (abs % FACTOR).toString().padStart(SCALE, '0');
  if (decimals === undefined) frac = frac.replace(/0+$/, '').padEnd(2, '0');
  else frac = frac.slice(0, decimals);
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export const DEFAULT_TRUE = ['Y', 'YES', 'TRUE', '1', 'ACTIVE'];
export const DEFAULT_FALSE = ['N', 'NO', 'FALSE', '0', 'INACTIVE'];

export function parseFlag(value: string, trueValues = DEFAULT_TRUE, falseValues = DEFAULT_FALSE): boolean | null {
  const v = value.trim().toUpperCase();
  if (trueValues.some((t) => t.toUpperCase() === v)) return true;
  if (falseValues.some((f) => f.toUpperCase() === v)) return false;
  return null;
}

/** The minor unit of an ISO 4217 currency as the runtime knows it, or null for a code it does not know. */
export function isoMinorUnit(code: string): number | null {
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const known = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency');
  if (known && !known.includes(code)) return null;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

export const EMPLOYEE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const TARGET_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOAN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/;

/** Identity numbers compared without spaces, hyphens or case; the value itself is never reported. */
export const normaliseIdentity = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV in a template's exact column order, CRLF rows (imports/batch.ts parseTemplate reads it). */
export function toCsv<C extends string>(columns: readonly C[], rows: Record<C, string>[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c] ?? '')).join(','))].join('\r\n') + '\r\n';
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
