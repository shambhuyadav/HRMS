// Small shared UI pieces. Status is always shown as text, never by colour alone (DF10).
import { createContext, type ReactNode, useContext } from 'react';
import { ApiError } from './api';

/** A role's scope in plain words (FR-096: the acting scope is always visible). */
const SCOPE_WORDS: Readonly<Record<string, string>> = { COMPANY: 'Company-wide', TEAM: 'My team', ASSIGNED: 'Assigned people', OWN: 'My own record' };
export const scopeWords = (scopeKind: string) => SCOPE_WORDS[scopeKind.toUpperCase()] ?? scopeKind.toLowerCase();

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const TONES: Record<string, 'good' | 'warn' | 'bad'> = {
  APPROVED: 'good',
  CONFIRMED: 'good',
  PRESENT: 'good',
  PAID: 'good',
  APPLIED: 'good',
  ACTIVE_CONFIRMED: 'good',
  SUBMITTED: 'warn',
  MANAGER_PENDING: 'warn',
  FINANCE_PENDING: 'warn',
  HIGH_VALUE_PENDING: 'warn',
  REVIEW_PENDING: 'warn',
  RETURNED: 'warn',
  EXCEPTION: 'warn',
  PART_PAID: 'warn',
  UNPAID: 'warn',
  REJECTED: 'bad',
  ABSENT: 'bad',
  FAILED: 'bad',
};

/** States whose code does not read as words: an employee's employment status, and a day attendance has not yet worked out. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  ACTIVE_CONFIRMED: 'confirmed',
  ACTIVE_PROBATION: 'on probation',
  NOTICE: 'serving notice',
  INACTIVE_SEPARATED: 'separated',
  NOT_PROCESSED: 'not yet calculated',
};

export function StateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <Badge>—</Badge>;
  return <Badge tone={TONES[state] ?? 'neutral'}>{STATE_WORDS[state] ?? state.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const details = e?.details as { missing?: string[]; errors?: { line: number; code: string }[]; lines?: { line: number; flags: string[] }[] } | undefined;
  // The server's bare refusal says nothing a person can act on: say what it means and what to do; the code stays for support.
  const bareRefusal = e?.code === 'FORBIDDEN' && e.message === 'Not permitted';
  return (
    <div role="alert" className="error">
      <strong>{e ? (bareRefusal ? 'Not permitted' : `${e.message} (${e.code})`) : 'Something went wrong'}</strong>
      {bareRefusal && (
        <div>
          The selected role does not allow this. Switch to a role that does, or ask your administrator for access. <span className="error-code">FORBIDDEN</span>
        </div>
      )}
      {details?.missing && <div>Missing: {details.missing.join(', ')}</div>}
      {details?.errors && <div>{details.errors.map((x) => `line ${x.line}: ${x.code}`).join('; ')}</div>}
      {details?.lines && <div>{details.lines.map((x) => `line ${x.line} needs a reason (${x.flags.join(', ')})`).join('; ')}</div>}
    </div>
  );
}

/** Inside it, an empty state is one quiet line: a page of many lists (the decision inbox) is not a column of large blanks. */
export const CompactEmptyContext = createContext(false);

export function Empty({ children }: { children: ReactNode }) {
  const compact = useContext(CompactEmptyContext);
  return <p className={compact ? 'empty compact' : 'empty'}>{children}</p>;
}

/** The page size the paged lists ask for (the API accepts 25, 50 or 100). */
export const LIST_PAGE_SIZE = 25;

/** `page` and `pageSize` query parameters for a paged list (FR-056). */
export const pageParams = (page: number, pageSize = LIST_PAGE_SIZE) => `page=${page}&pageSize=${pageSize}`;

/** A list's chosen column and direction (FR-056); null keeps the list's own default order. */
export type SortState<K extends string = string> = { column: K; direction: 'ASC' | 'DESC' } | null;

/** The first click on a column sorts ascending, the next reverses it. */
export const nextSort = <K extends string>(current: SortState<K>, column: K): NonNullable<SortState<K>> => ({
  column,
  direction: current?.column === column && current.direction === 'ASC' ? 'DESC' : 'ASC',
});

/** `sort` and `direction` query parameters of a sortable list, as URLSearchParams entries. */
export const sortParams = (sort: SortState): Record<string, string> => (sort ? { sort: sort.column, direction: sort.direction } : {});

/** A sortable column heading (FR-056, FR-007). The server applies the order, so it holds across pages; the order is announced. */
export function SortHeader<K extends string>({ column, label, sort, onSort }: { column: K; label: string; sort: SortState<K>; onSort: (column: K) => void }) {
  const active = sort?.column === column;
  return (
    <th scope="col" aria-sort={active ? (sort.direction === 'ASC' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="link" onClick={() => onSort(column)}>
        {label}
        {active ? (sort.direction === 'ASC' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
}

/**
 * FR-056 paging of a list the API answers in pages with the total of every match: the page, the page count and the
 * total, with previous and next. Hidden when everything fits on one page; the total is still shown by the caller.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  label,
  noun = 'item',
  plural = `${noun}s`,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  label: string;
  noun?: string;
  plural?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1 && page <= 1) return null;
  return (
    <div className="pager" role="navigation" aria-label={label}>
      <button type="button" className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous page
      </button>
      <span>{`Page ${page} of ${pages} · ${total} ${total === 1 ? noun : plural}`}</span>
      <button type="button" className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next page
      </button>
    </div>
  );
}

/**
 * The title of the page the shell shows above the content (App.tsx), or null when the page shows its own. A card whose title only
 * repeats it (say "Employees (16)" under the page "Employees") keeps its heading for assistive technology but does not print it again:
 * its count, if any, and its actions stay.
 */
export const PageTitleContext = createContext<string | null>(null);

const bareTitle = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const page = useContext(PageTitleContext);
  if (page !== null && bareTitle(title) === bareTitle(page)) {
    const extra = /\(([^)]*)\)\s*$/.exec(title)?.[1];
    return (
      <section className="card">
        <h2 className="sr-only">{title}</h2>
        {(extra || actions) && (
          <header className="card-header card-header-plain">
            <span className="card-count">{extra ? (/^\d+$/.test(extra) ? `${extra} in total` : extra) : ''}</span>
            {actions}
          </header>
        )}
        {children}
      </section>
    );
  }
  return (
    <section className="card">
      <header className="card-header">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
