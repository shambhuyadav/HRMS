// DF09 "include filter/period/revision/generated-time context"; FR-065 "record the filter/run version": the labelled rows that say what a
// file holds, so it keeps its meaning once downloaded or forwarded. The queued reports (service.ts) and the exports modules answer
// directly (appraisal, training, settlement) state the same things, in the same order, through the same formula guard.
import type { Queryable } from '../../db/queryable.js';
import type { AccessGrant } from '../access/authorize.js';

export type ReportContext = readonly (readonly [label: string, value: string])[];

/**
 * FR-065 "formula-like employee text is written safely as data": a value that starts with a formula trigger (=, +, -, @, a tab or
 * a carriage return) gets a leading apostrophe so it stays text. Every output format writes cells through it.
 */
export function cellText(value: unknown): string {
  const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** FR-065: every cell is quoted, quotes are doubled, and formula-like text is guarded (cellText). */
export function csvCell(value: unknown): string {
  return `"${cellText(value).replace(/"/g, '""')}"`;
}

/** A context value on one line, so that the CSV block always ends at its first blank line. */
export const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, ' ');

/** The CSV lines of a context, and the blank line that ends the block. */
export function contextCsvLines(context: ReportContext): string[] {
  return [...context.map(([label, value]) => `${csvCell(label)},${csvCell(oneLine(value))}`), ''];
}

/** The grant's row scope in words: the kind, its department and location filters by code, and a count of named employees (never who). */
export async function scopeInWords(db: Queryable, grant: AccessGrant): Promise<string> {
  const codes = async (table: 'department' | 'location', ids: string[]) =>
    ids.length === 0 ? [] : (await db.query<{ code: string }>(`select code from ${table} where company_id = $1 and id = any($2::uuid[]) order by code`, [grant.companyId, ids])).rows.map((r) => r.code);
  const departments = await codes('department', grant.filters.departments);
  const locations = await codes('location', grant.filters.locations);
  return [
    grant.scopeKind,
    ...(departments.length > 0 ? [`departments ${departments.join(', ')}`] : []),
    ...(locations.length > 0 ? [`locations ${locations.join(', ')}`] : []),
    ...(grant.filters.employees.length > 0 ? [`employees ${grant.filters.employees.length}`] : []),
  ].join('; ');
}

export interface FileDescription {
  title: string;
  code: string;
  period?: { from?: string | null | undefined; to?: string | null | undefined };
  /** Named filters as the caller gave them; an absent one is left out. */
  filters?: Readonly<Record<string, unknown>>;
  revision?: string | null | undefined;
  rowCount: number;
}

/** What the file says about itself, under the access that generated it, in company time (the transaction's now()). */
export async function fileContext(db: Queryable, grant: AccessGrant, file: FileDescription): Promise<ReportContext> {
  const company = (
    await db.query<{ code: string; name: string; generated: string }>(
      `select code, name, to_char(now() at time zone business_timezone, 'YYYY-MM-DD HH24:MI:SS') || ' ' || business_timezone as generated from company where id = $1`,
      [grant.companyId],
    )
  ).rows[0]!;
  const { from, to } = file.period ?? {};
  const given = Object.entries(file.filters ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return [
    ['Report', file.title],
    ['Report code', file.code],
    ['Company', `${company.name} (${company.code})`],
    ['Acting role', grant.roleCode],
    ['Row scope', await scopeInWords(db, grant)],
    ['Period', from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Until ${to}` : 'None'],
    ['Filters', given.length > 0 ? given.map(([name, value]) => `${name}: ${String(value)}`).join('; ') : 'None'],
    ...(file.revision ? ([['Record revision', file.revision]] as const) : []),
    ['Generated at', company.generated],
    ['Rows', String(file.rowCount)],
  ];
}
