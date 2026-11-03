// List paging shared by the modules (FR-056 "pagination, total counts"). A list that answered a capped first slice
// before it could page keeps that answer when no page is asked for, and every answer carries `total`, so a capped
// or partial answer says so instead of stopping silently.
import type { Queryable } from './queryable.js';

export const DEFAULT_PAGE_SIZE = 25;

export interface Paging {
  page?: number | undefined;
  pageSize?: number | undefined;
}

/**
 * Querystring paging for such lists: no defaults, so a request without page or pageSize keeps the capped answer
 * (backward compatible); either one asks for a page.
 */
export const optionalPaging = { page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100] } } as const;

export interface Page<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

/**
 * One page of a list (page/pageSize), or, when no page is asked for, the first `cap` rows as the list answered before
 * paging existed. `total` always counts every matching row, so a capped or partial answer says so. `sql` carries no
 * order or limit; `orderBy` names its output columns. Output columns named `hrms_*` (sort keys the answer does not
 * carry) are dropped from the items.
 */
export async function pageOf<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  sql: string,
  values: readonly unknown[],
  orderBy: string,
  paging: Paging,
  cap: number,
): Promise<Page<T>> {
  const paged = paging.page !== undefined || paging.pageSize !== undefined;
  const pageSize = paged ? (paging.pageSize ?? DEFAULT_PAGE_SIZE) : cap;
  const page = paged ? (paging.page ?? 1) : 1;
  const n = values.length;
  const rows = (
    await db.query<Record<string, unknown> & { hrms_total: string }>(
      `select x.*, count(*) over () as hrms_total from (${sql}) x order by ${orderBy} limit $${n + 1} offset $${n + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    )
  ).rows;
  // Past the last page no row carries the window count: count separately.
  const total = rows[0]
    ? Number(rows[0].hrms_total)
    : page > 1
      ? Number((await db.query<{ n: string }>(`select count(*) as n from (${sql}) x`, [...values])).rows[0]!.n)
      : 0;
  const items = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('hrms_'))) as T);
  return paged ? { items, total, page, pageSize } : { items, total };
}

/** FR-056 "sortable columns where appropriate": a list's sort key and direction, as its route accepts them. */
export interface Sorting {
  sort?: string | undefined;
  direction?: 'ASC' | 'DESC' | undefined;
}

/** Querystring of a sortable list: the keys are an allowlist, so a value picks a column and never reaches SQL. */
export const sortQuery = (sorts: readonly string[]) => ({ sort: { type: 'string', enum: [...sorts] }, direction: { type: 'string', enum: ['ASC', 'DESC'] } }) as const;

/**
 * The order of a sortable list: the chosen column with blanks last in either direction, then `tieBreak`, which must end
 * in a unique column so that pages neither overlap nor skip a row. Without a sort the list keeps `byDefault`.
 */
export function sortedBy(sorting: Sorting, columns: Readonly<Record<string, string>>, byDefault: string, tieBreak: string = byDefault): string {
  if (sorting.sort === undefined || !Object.hasOwn(columns, sorting.sort)) return byDefault;
  return `${columns[sorting.sort]} ${sorting.direction === 'DESC' ? 'desc' : 'asc'} nulls last, ${tieBreak}`;
}

/** The paging part of a page, for answers that carry their own items (e.g. mapped rows). */
export function pageMeta(p: Page<unknown>): { total: number; page?: number; pageSize?: number } {
  return p.page === undefined ? { total: p.total } : { total: p.total, page: p.page, pageSize: p.pageSize! };
}
