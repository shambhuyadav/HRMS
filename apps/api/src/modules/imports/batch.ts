// Shared batch-import mechanics (DF09; FR-009; FR-023; FR-064). Published versioned templates with an exact
// header; every data row must have exactly the header's cells; maximum 10,000 rows and 10 MB per batch.
// Preview runs every row through the real apply path inside a transaction that is always rolled back, so
// preview and commit apply the same rules. Batches are all-or-nothing (DF09: master imports reject the whole
// batch on a critical identity/company/reference error; this applies that to every row error): any row error
// rejects the job, and commit applies every row in one transaction or none. The one exception is an import declaring
// `partial` (jobs.ts; DF09 attendance imports), whose rows stand on their own.
import type pg from 'pg';
import type { Database } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { CsvError, parseCsv } from '../employee/csv.js';

/** DF09 initial batch limits. */
export const MAX_BATCH_ROWS = 10_000;
export const MAX_BATCH_BYTES = 10 * 1024 * 1024;

export interface Template<C extends string> {
  /** Published template identifier, e.g. EMPLOYEE_ONBOARDING_V1. */
  code: string;
  columns: readonly C[];
}

export type TemplateRow<C extends string> = {
  rowNumber: number;
  row: Record<C, string>;
  columnCountMismatch?: boolean;
  /** A file-level rule the row breaks (e.g. a repeated key), found while parsing. */
  rowError?: string;
};

/** What an update row would change: operational values only, field -> { from, to }. */
export type RowChanges = Record<string, { from: string | null; to: string | null }>;

export interface RowOutcome {
  rowNumber: number;
  businessKey: string;
  errorCode: string | null;
  changes?: RowChanges | undefined;
}

/** Marks every repeat of a business key after its first row (one row per record in a batch). */
export function markRepeats<C extends string>(rows: TemplateRow<C>[], keyOf: (row: Record<C, string>) => string, code: string): TemplateRow<C>[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const key = keyOf(r.row);
    if (key && seen.has(key)) return { ...r, rowError: code };
    seen.add(key);
    return r;
  });
}

/** A row-level failure raised by an apply function; anything else aborts the batch as a server error. */
export class RowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseTemplate<C extends string>(bytes: Buffer, template: Template<C>): TemplateRow<C>[] {
  if (bytes.length === 0 || bytes.length > MAX_BATCH_BYTES) throw new HttpError(422, 'FILE_SIZE', 'Import files must be between 1 byte and 10 MB');
  let rows: string[][];
  try {
    rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    if (err instanceof CsvError || err instanceof TypeError) throw new HttpError(422, 'INVALID_FILE', 'The file is not valid UTF-8 CSV');
    throw err;
  }
  const [header, ...data] = rows;
  if (!header || header.map((h) => h.trim()).join(',') !== template.columns.join(',')) {
    throw new HttpError(422, 'INVALID_HEADER', `Template ${template.code}: the header must be exactly ${template.columns.join(',')}`);
  }
  if (data.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file has no data rows');
  if (data.length > MAX_BATCH_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `A batch may hold at most ${MAX_BATCH_ROWS} rows; split larger loads`);
  return data.map((cells, i) => ({
    rowNumber: i + 1,
    row: Object.fromEntries(template.columns.map((c, j) => [c, (cells[j] ?? '').trim()])) as Record<C, string>,
    // Extra or missing cells are reported per row rather than silently dropped or padded.
    ...(cells.length !== template.columns.length ? { columnCountMismatch: true } : {}),
  }));
}

const PG_ROW_ERRORS: Record<string, string> = { '23505': 'DUPLICATE', '23503': 'INVALID_REFERENCE', '23514': 'RULE_VIOLATION', '23P01': 'OVERLAPPING_PERIOD', '22007': 'INVALID_VALUE', '22008': 'INVALID_VALUE', '22P02': 'INVALID_VALUE' };

/** Maps a thrown error to a row error code, or undefined when it is not a row-level failure. */
export function rowErrorCode(err: unknown): string | undefined {
  if (err instanceof RowError) return err.code;
  if (err instanceof HttpError) return err.statusCode === 404 || err.statusCode === 403 ? 'OUT_OF_SCOPE' : err.code;
  return PG_ROW_ERRORS[(err as { code?: string }).code ?? ''];
}

/** A row error code as import_row can store it. */
export const storedRowCode = (code: string): string => (/^[A-Z][A-Z0-9_]{0,59}$/.test(code) ? code : 'INVALID_ROW');

type Apply<C extends string> = (client: pg.PoolClient, row: Record<C, string>) => Promise<RowChanges | void>;
type KeyOf<C extends string> = (row: Record<C, string>, rowNumber: number) => string;

/** Validation only: every row in its own savepoint inside a transaction that is always rolled back. */
export async function previewBatch<C extends string>(db: Database, rows: TemplateRow<C>[], apply: Apply<C>, keyOf: KeyOf<C>): Promise<RowOutcome[]> {
  const client = await db.connect();
  const outcomes: RowOutcome[] = [];
  try {
    await client.query('begin');
    for (const r of rows) {
      const outcome: RowOutcome = { rowNumber: r.rowNumber, businessKey: keyOf(r.row, r.rowNumber), errorCode: null };
      if (r.columnCountMismatch || r.rowError) {
        outcome.errorCode = r.columnCountMismatch ? 'COLUMN_COUNT' : r.rowError!;
        outcomes.push(outcome);
        continue;
      }
      await client.query('savepoint batch_row');
      try {
        const changes = await apply(client, r.row);
        if (changes && Object.keys(changes).length > 0) outcome.changes = changes;
        await client.query('release savepoint batch_row');
      } catch (err) {
        await client.query('rollback to savepoint batch_row');
        const code = rowErrorCode(err);
        if (!code) throw err;
        outcome.errorCode = storedRowCode(code);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/** Commit: all rows on `client` (already in a transaction) with no savepoints; the first failure aborts all. */
export async function applyBatch<C extends string>(client: pg.PoolClient, rows: TemplateRow<C>[], apply: Apply<C>): Promise<{ failedRow: number; errorCode: string } | null> {
  for (const r of rows) {
    if (r.columnCountMismatch) return { failedRow: r.rowNumber, errorCode: 'COLUMN_COUNT' };
    if (r.rowError) return { failedRow: r.rowNumber, errorCode: r.rowError };
    try {
      await apply(client, r.row);
    } catch (err) {
      const code = rowErrorCode(err);
      if (!code) throw err;
      return { failedRow: r.rowNumber, errorCode: storedRowCode(code) };
    }
  }
  return null;
}

export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
