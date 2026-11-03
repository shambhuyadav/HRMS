// Bank file template definitions and rendering (FR-102; DB112 "exact ordered mapping and control totals
// configured"; H8 "accepted bank-format contract"). No bank format is presumed: a definition is the company's
// transcription of the bank-accepted specification into an ordered list of fields per record type (optional header,
// one detail record per payment allocation, optional trailer). Only a delimited layout is supported; a definition
// that needs anything else (fixed width, padding, checksums, quoting) cannot be expressed and is not activatable.
// Rendering never alters a value to make it fit: a value that is too long, contains the delimiter or a line break,
// or an amount with more decimals than the template allows is a row error, and a manifest with any row error is not
// produced (H2: "failed validation has a recoverable exception list and no partial final file").
import { createHash } from 'node:crypto';
import { HttpError } from '../../http/errors.js';

export const DETAIL_SOURCES = [
  'LINE_SEQUENCE',
  'ALLOCATION_KEY',
  'EMPLOYEE_CODE',
  'HOLDER_NAME',
  'ACCOUNT_IDENTIFIER',
  'ROUTING_REFERENCE',
  'COUNTRY_CODE',
  'AMOUNT',
  'CURRENCY_CODE',
  'PAYMENT_DATE',
  'BATCH_REFERENCE',
  'LITERAL',
] as const;
export const CONTROL_SOURCES = ['BATCH_REFERENCE', 'RECORD_COUNT', 'TOTAL_AMOUNT', 'CURRENCY_CODE', 'PAYMENT_DATE', 'LITERAL'] as const;
const DELIMITERS: Record<string, string> = { COMMA: ',', SEMICOLON: ';', PIPE: '|', TAB: '\t' };
const DATE_FORMATS = ['YYYY-MM-DD', 'YYYYMMDD', 'DD-MM-YYYY', 'DDMMYYYY', 'DD/MM/YYYY'] as const;
const MAX_FIELDS = 60;

export interface FieldSpec {
  source: string;
  value?: string;
  maxLength?: number;
}

export interface FormatDefinition {
  layout: 'DELIMITED';
  delimiter: keyof typeof DELIMITERS | string;
  lineEnding: 'CRLF' | 'LF';
  amountDecimals: number;
  decimalSeparator: '.' | ',';
  dateFormat: (typeof DATE_FORMATS)[number];
  fileExtension: 'csv' | 'txt';
  header?: FieldSpec[] | undefined;
  detail: FieldSpec[];
  trailer?: FieldSpec[] | undefined;
}

const invalid = (message: string, field?: string): never => {
  throw new HttpError(422, 'INVALID_TEMPLATE_DEFINITION', message, field ? { field } : undefined);
};

function checkFields(value: unknown, allowed: readonly string[], part: string, delimiter: string): FieldSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELDS) invalid(`The ${part} record needs 1 to ${MAX_FIELDS} fields`, part);
  return (value as unknown[]).map((f, i) => {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return invalid(`Field ${i + 1} of the ${part} record is not valid`, part);
    const o = f as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['source', 'value', 'maxLength'].includes(k));
    if (extra.length > 0) invalid(`Field ${i + 1} of the ${part} record has unknown settings`, part);
    if (typeof o.source !== 'string' || !allowed.includes(o.source)) invalid(`Field ${i + 1} of the ${part} record has an unknown source`, part);
    const spec: FieldSpec = { source: o.source as string };
    if (o.source === 'LITERAL') {
      if (typeof o.value !== 'string' || o.value.length > 100 || o.value.includes(delimiter) || /[\r\n]/.test(o.value)) {
        invalid(`Literal field ${i + 1} of the ${part} record needs a value of at most 100 characters without the delimiter or line breaks`, part);
      }
      spec.value = o.value as string;
    } else if (o.value !== undefined) invalid(`Only a literal field has a value (field ${i + 1} of the ${part} record)`, part);
    if (o.maxLength !== undefined) {
      if (typeof o.maxLength !== 'number' || !Number.isInteger(o.maxLength) || o.maxLength < 1 || o.maxLength > 500) {
        invalid(`The maximum length of field ${i + 1} of the ${part} record is 1 to 500`, part);
      }
      spec.maxLength = o.maxLength as number;
    }
    return spec;
  });
}

/** Validates and normalises a definition (unknown settings are refused, never ignored). */
export function checkDefinition(raw: unknown): FormatDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('The format definition must be an object');
  const o = raw as Record<string, unknown>;
  const known = ['layout', 'delimiter', 'lineEnding', 'amountDecimals', 'decimalSeparator', 'dateFormat', 'fileExtension', 'header', 'detail', 'trailer'];
  if (Object.keys(o).some((k) => !known.includes(k))) invalid('The format definition has unknown settings');
  if (o.layout !== 'DELIMITED') invalid('Only a DELIMITED layout can be configured', 'layout');
  if (typeof o.delimiter !== 'string' || !(o.delimiter in DELIMITERS)) invalid('The delimiter is COMMA, SEMICOLON, PIPE or TAB', 'delimiter');
  const delimiter = DELIMITERS[o.delimiter as string]!;
  if (o.lineEnding !== 'CRLF' && o.lineEnding !== 'LF') invalid('The line ending is CRLF or LF', 'lineEnding');
  if (typeof o.amountDecimals !== 'number' || !Number.isInteger(o.amountDecimals) || o.amountDecimals < 0 || o.amountDecimals > 4) {
    invalid('The amount decimals are 0 to 4', 'amountDecimals');
  }
  if (o.decimalSeparator !== '.' && o.decimalSeparator !== ',') invalid('The decimal separator is . or ,', 'decimalSeparator');
  if (o.decimalSeparator === delimiter && (o.amountDecimals as number) > 0) invalid('The decimal separator cannot be the delimiter', 'decimalSeparator');
  if (typeof o.dateFormat !== 'string' || !(DATE_FORMATS as readonly string[]).includes(o.dateFormat)) invalid(`The date format is one of ${DATE_FORMATS.join(', ')}`, 'dateFormat');
  if (o.fileExtension !== 'csv' && o.fileExtension !== 'txt') invalid('The file extension is csv or txt', 'fileExtension');
  const detail = checkFields(o.detail, DETAIL_SOURCES, 'detail', delimiter);
  if (!detail.some((f) => f.source === 'AMOUNT') || !detail.some((f) => f.source === 'ACCOUNT_IDENTIFIER')) {
    invalid('The detail record must carry the amount and the account identifier', 'detail');
  }
  const def: FormatDefinition = {
    layout: 'DELIMITED',
    delimiter: o.delimiter as string,
    lineEnding: o.lineEnding as 'CRLF' | 'LF',
    amountDecimals: o.amountDecimals as number,
    decimalSeparator: o.decimalSeparator as '.' | ',',
    dateFormat: o.dateFormat as FormatDefinition['dateFormat'],
    fileExtension: o.fileExtension as 'csv' | 'txt',
    detail,
  };
  if (o.header !== undefined && o.header !== null) def.header = checkFields(o.header, CONTROL_SOURCES, 'header', delimiter);
  if (o.trailer !== undefined && o.trailer !== null) def.trailer = checkFields(o.trailer, CONTROL_SOURCES, 'trailer', delimiter);
  return def;
}

/** Canonical JSON (sorted keys) so the same definition always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * An exact decimal string formatted with exactly `decimals` decimals; null when it has more significant decimals
 * than the template allows (never rounded: the amount is what was authorised).
 */
export function formatAmount(value: string, decimals: number, separator: '.' | ','): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const intPart = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) return null;
  return decimals === 0 ? intPart : `${intPart}${separator}${frac.padEnd(decimals, '0')}`;
}

export function formatDate(iso: string, format: FormatDefinition['dateFormat']): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  switch (format) {
    case 'YYYYMMDD':
      return `${y}${m}${d}`;
    case 'DD-MM-YYYY':
      return `${d}-${m}-${y}`;
    case 'DDMMYYYY':
      return `${d}${m}${y}`;
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`;
    default:
      return iso;
  }
}

export interface RenderLine {
  lineSequence: number;
  allocationKey: string;
  employeeCode: string;
  amount: string;
  bank: { holderName?: unknown; accountIdentifier?: unknown; routingReference?: unknown; countryCode?: unknown } | null;
}

export interface RenderBatch {
  batchReference: string;
  currencyCode: string;
  paymentDate: string;
  recordCount: number;
  totalAmount: string;
}

export interface RowError {
  lineSequence: number | null;
  employeeCode: string | null;
  code: 'BANK_VALUES_UNAVAILABLE' | 'MISSING_VALUE' | 'FIELD_TOO_LONG' | 'INVALID_CHARACTER' | 'AMOUNT_PRECISION';
  source: string;
}

/** Renders the file; with any row error the content must not be used (the caller refuses the manifest). */
export function render(def: FormatDefinition, batch: RenderBatch, lines: readonly RenderLine[]): { content: string; errors: RowError[] } {
  const delimiter = DELIMITERS[def.delimiter]!;
  const eol = def.lineEnding === 'CRLF' ? '\r\n' : '\n';
  const errors: RowError[] = [];
  const records: string[] = [];
  const cell = (spec: FieldSpec, raw: string | null, at: { lineSequence: number | null; employeeCode: string | null }): string => {
    if (raw === null || raw === '') {
      errors.push({ ...at, code: 'MISSING_VALUE', source: spec.source });
      return '';
    }
    if (raw.includes(delimiter) || /[\r\n]/.test(raw)) {
      errors.push({ ...at, code: 'INVALID_CHARACTER', source: spec.source });
      return '';
    }
    if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
      errors.push({ ...at, code: 'FIELD_TOO_LONG', source: spec.source });
      return '';
    }
    return raw;
  };
  const amount = (value: string, spec: FieldSpec, at: { lineSequence: number | null; employeeCode: string | null }): string | null => {
    const out = formatAmount(value, def.amountDecimals, def.decimalSeparator);
    if (out === null) errors.push({ ...at, code: 'AMOUNT_PRECISION', source: spec.source });
    return out;
  };
  const control = (fields: FieldSpec[]) => {
    const at = { lineSequence: null, employeeCode: null };
    return fields
      .map((f) => {
        switch (f.source) {
          case 'BATCH_REFERENCE':
            return cell(f, batch.batchReference, at);
          case 'RECORD_COUNT':
            return cell(f, String(batch.recordCount), at);
          case 'TOTAL_AMOUNT': {
            const v = amount(batch.totalAmount, f, at);
            return v === null ? '' : cell(f, v, at);
          }
          case 'CURRENCY_CODE':
            return cell(f, batch.currencyCode, at);
          case 'PAYMENT_DATE':
            return cell(f, formatDate(batch.paymentDate, def.dateFormat), at);
          default:
            return f.value ?? '';
        }
      })
      .join(delimiter);
  };
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  if (def.header) records.push(control(def.header));
  for (const l of lines) {
    const at = { lineSequence: l.lineSequence, employeeCode: l.employeeCode };
    if (!l.bank) errors.push({ ...at, code: 'BANK_VALUES_UNAVAILABLE', source: 'BANK_REVISION' });
    const b = l.bank ?? {};
    records.push(
      def.detail
        .map((f) => {
          switch (f.source) {
            case 'LINE_SEQUENCE':
              return cell(f, String(l.lineSequence), at);
            case 'ALLOCATION_KEY':
              return cell(f, l.allocationKey, at);
            case 'EMPLOYEE_CODE':
              return cell(f, l.employeeCode, at);
            case 'HOLDER_NAME':
              return l.bank ? cell(f, text(b.holderName), at) : '';
            case 'ACCOUNT_IDENTIFIER':
              return l.bank ? cell(f, text(b.accountIdentifier), at) : '';
            case 'ROUTING_REFERENCE':
              return l.bank ? cell(f, text(b.routingReference), at) : '';
            case 'COUNTRY_CODE':
              return l.bank ? cell(f, text(b.countryCode), at) : '';
            case 'AMOUNT': {
              const v = amount(l.amount, f, at);
              return v === null ? '' : cell(f, v, at);
            }
            case 'CURRENCY_CODE':
              return cell(f, batch.currencyCode, at);
            case 'PAYMENT_DATE':
              return cell(f, formatDate(batch.paymentDate, def.dateFormat), at);
            case 'BATCH_REFERENCE':
              return cell(f, batch.batchReference, at);
            default:
              return f.value ?? '';
          }
        })
        .join(delimiter),
    );
  }
  if (def.trailer) records.push(control(def.trailer));
  return { content: records.join(eol) + eol, errors };
}

/**
 * The template's validation sample: two synthetic allocations with obviously fake values, rendered exactly as a
 * manifest would be. Its hash binds the independent sample validation to this exact definition.
 */
export function sampleFile(def: FormatDefinition, currencyCode: string): { content: string; hash: string; errors: RowError[] } {
  const one = def.amountDecimals === 0 ? '1' : `1.${'0'.repeat(def.amountDecimals)}`;
  const two = def.amountDecimals === 0 ? '2' : `2.${'0'.repeat(def.amountDecimals)}`;
  const total = def.amountDecimals === 0 ? '3' : `3.${'0'.repeat(def.amountDecimals)}`;
  const lines: RenderLine[] = [
    {
      lineSequence: 1,
      allocationKey: 'PAY-00000000-0000-0000-0000-000000000001-1',
      employeeCode: 'SAMPLE0001',
      amount: one,
      bank: { holderName: 'SAMPLE HOLDER ONE', accountIdentifier: '000000000001', routingReference: 'SAMPLE0001', countryCode: 'ZZ' },
    },
    {
      lineSequence: 2,
      allocationKey: 'PAY-00000000-0000-0000-0000-000000000002-1',
      employeeCode: 'SAMPLE0002',
      amount: two,
      bank: { holderName: 'SAMPLE HOLDER TWO', accountIdentifier: '000000000002', routingReference: 'SAMPLE0002', countryCode: 'ZZ' },
    },
  ];
  const out = render(def, { batchReference: 'SAMPLE-NOT-PAYABLE', currencyCode, paymentDate: '2000-01-01', recordCount: 2, totalAmount: total }, lines);
  return { content: out.content, hash: sha256(out.content), errors: out.errors };
}
