// Small shared UI pieces. Status is always shown as text, never by colour alone (DF10).
// Built on the shadcn/ui primitives of components/ui (owner's choice of 20 Nov 2026). Each piece keeps its old marker classes (card,
// card-header, badge, empty, error, ok, pager…), which the contextual rules of styles.css look for: table rows as cards on a phone,
// decision queues, sticky column headings, notes inside cards. What a piece's look depends on is passed down to it (the card it is
// in, a quiet decision queue: components/card-context.ts) rather than read from the class names around it.
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { InCardContext, QuietWhenEmptyContext } from '@/components/card-context';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { Badge as BadgePrimitive } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ApiError, localDateTime } from './api';

/** A role's scope in plain words (FR-096: the acting scope is always visible). */
const SCOPE_WORDS: Readonly<Record<string, string>> = { COMPANY: 'Company-wide', TEAM: 'My team', ASSIGNED: 'Assigned people', OWN: 'My own record' };
export const scopeWords = (scopeKind: string) => SCOPE_WORDS[scopeKind.toUpperCase()] ?? scopeKind.toLowerCase();

/**
 * A status badge on shadcn's Badge, in the status token colours. It stays inline-block, not shadcn's inline-flex: the first letter
 * is raised (sentence case: "Manager pending") by ::first-letter, which applies only to a block container. The dot sits in the
 * left padding, drawn as a background.
 */
const STATUS_BADGE =
  'inline-block pl-[1.3rem] align-middle first-letter:uppercase bg-[radial-gradient(circle,currentColor_0_2.5px,transparent_3px)] bg-[length:8px_8px] bg-[position:0.55rem_50%] bg-no-repeat';
/**
 * On a phone a long status ("Review date passed: still withheld, needs review") wraps inside the badge and keeps to the card's width;
 * shadcn's badge never wraps, so such a badge ran past the edge of its card. A rounder-cornered box suits two lines better than a pill.
 */
const WRAPS_ON_PHONE = 'phone:max-w-full phone:whitespace-normal phone:rounded-lg';
/** The badge a note opens with (NotPermitted, WarningNote) is on the card colour, apart from the note's tint, a little before the words. */
const OPENS_NOTE = 'mr-[0.35rem] bg-card';

type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function Badge({ children, tone = 'neutral', opensNote = false }: { children: ReactNode; tone?: BadgeTone; opensNote?: boolean }) {
  return (
    <BadgePrimitive variant={tone} className={cn('badge', `badge-${tone}`, STATUS_BADGE, WRAPS_ON_PHONE, opensNote && OPENS_NOTE)}>
      {children}
    </BadgePrimitive>
  );
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

/** The lines under an error's title: running text (a code stays in its sentence), in the text colour. */
const ERROR_LINE = 'block';

/** A failed action, as a destructive shadcn Alert: the message (and code) as its title, what is missing or wrong below it. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const details = e?.details as { missing?: string[]; errors?: { line: number; code: string }[]; lines?: { line: number; flags: string[] }[] } | undefined;
  // The server's bare refusal says nothing a person can act on: say what it means and what to do; the code stays for support.
  const bareRefusal = e?.code === 'FORBIDDEN' && e.message === 'Not permitted';
  return (
    <Alert variant="destructive" className="error">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle asChild>
        <strong>{e ? (bareRefusal ? 'Not permitted' : `${e.message} (${e.code})`) : 'Something went wrong'}</strong>
      </AlertTitle>
      {bareRefusal && (
        <AlertDescription className={ERROR_LINE}>
          The selected role does not allow this. Switch to a role that does, or ask your administrator for access. <span className="error-code">FORBIDDEN</span>
        </AlertDescription>
      )}
      {details?.missing && <AlertDescription className={ERROR_LINE}>Missing: {details.missing.join(', ')}</AlertDescription>}
      {details?.errors && <AlertDescription className={ERROR_LINE}>{details.errors.map((x) => `line ${x.line}: ${x.code}`).join('; ')}</AlertDescription>}
      {details?.lines && (
        <AlertDescription className={ERROR_LINE}>{details.lines.map((x) => `line ${x.line} needs a reason (${x.flags.join(', ')})`).join('; ')}</AlertDescription>
      )}
    </Alert>
  );
}

/**
 * A note that opens with a warning badge: a quiet callout in the warning tint. Running text (the badge stays in the sentence), so no
 * display is set: a decision queue with nothing waiting hides it.
 */
const WARNING_CALLOUT = 'm-0 rounded-lg border border-[var(--warn-edge)] bg-[var(--warn-soft)] px-4 py-3 text-sm leading-relaxed text-foreground';

/** What the selected role may not do here, said beside the place it would be done, opening with the "not permitted" badge. */
export function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note" className={WARNING_CALLOUT}>
      <Badge tone="warn" opensNote>not permitted</Badge> {children}
    </p>
  );
}

/**
 * A warning said beside what it is about, opening with a badge of its own words ("unmapped", "payroll locked", "waived"), with room
 * under it when something follows in its card. A note (role="note"), unless it reports what an action did (`role="status"`).
 */
export function WarningNote({ badge, role = 'note', children }: { badge: ReactNode; role?: 'note' | 'status'; children: ReactNode }) {
  return (
    <p role={role} className={cn(WARNING_CALLOUT, 'not-last:mb-4')}>
      <Badge tone="warn" opensNote>{badge}</Badge> {children}
    </p>
  );
}

/** One term and its value in a `dl.kv` list. */
export function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** An instant as its local day and time, or a dash when there is none. */
export function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

/** The outcome of the last action: a status when it worked, an alert when it did not (a shadcn Alert on the paragraph itself). */
export function Notice({ notice }: { notice: { text: string; ok: boolean } | null }) {
  if (!notice) return null;
  return (
    <Alert asChild variant={notice.ok ? 'success' : 'destructive'}>
      <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
        {notice.ok ? <CircleCheckIcon aria-hidden="true" /> : <CircleAlertIcon aria-hidden="true" />}
        {notice.text}
      </p>
    </Alert>
  );
}

/** Inside it, an empty state is one quiet line: a page of many lists (the decision inbox) is not a column of large blanks. */
export const CompactEmptyContext = createContext(false);

/**
 * `refusal`: the line says the selected role may not see this, which is not the same as an empty list (styled apart).
 * Its class names are exactly these (a11y-markup.test.tsx), so it carries no utility classes: the `.empty` rules of styles.css draw it
 * in the shape of shadcn's Empty (a centred, muted line under a framed mark; a dashed panel in a card; one line in a table cell, a
 * list or a compact page).
 */
export function Empty({ children, refusal }: { children: ReactNode; refusal?: boolean }) {
  const compact = useContext(CompactEmptyContext);
  return (
    <p data-slot="empty" className={(compact ? 'empty compact' : 'empty') + (refusal ? ' empty-refusal' : '')}>
      {children}
    </p>
  );
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

/** A sortable heading's cell, as TableHead (components/ui/table.tsx) draws the other headings of its table: height and side padding. */
const SORT_HEAD = 'h-10 px-2 align-middle';
/**
 * The heading's button fills its cell, so the whole heading is clickable, in the size, weight and text colour of the table's other
 * headings; the sorted column is marked by its arrow. The cell's padding above and below is the `th` rule's of styles.css, which the
 * button takes back so that it fills the cell. Keyboard focus is the HRMS ring, drawn inside the cell.
 */
const SORT_BUTTON =
  '-mx-2 -my-[0.68rem] block w-[calc(100%+1rem)] min-h-0 cursor-pointer rounded-none border-0 bg-transparent px-2 py-[0.68rem] [text-align:inherit] text-[length:inherit] leading-[inherit] font-medium text-foreground shadow-none transition-colors outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset';

/**
 * A sortable column heading in a shadcn Table (FR-056, FR-007). The server applies the order, so it holds across pages; the order is
 * announced.
 */
export function SortHeader<K extends string>({ column, label, sort, onSort }: { column: K; label: string; sort: SortState<K>; onSort: (column: K) => void }) {
  const active = sort?.column === column;
  return (
    <th scope="col" data-slot="table-head" className={SORT_HEAD} aria-sort={active ? (sort.direction === 'ASC' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" data-slot="sort-button" className={SORT_BUTTON} onClick={() => onSort(column)}>
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
  // On a narrow screen the count wraps below the buttons rather than overflowing.
  return (
    <PagerRow className="pager" role="navigation" aria-label={label}>
      <PagerButton disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous page
      </PagerButton>
      <PagerCount>{`Page ${page} of ${pages} · ${total} ${total === 1 ? noun : plural}`}</PagerCount>
      <PagerButton disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next page
      </PagerButton>
    </PagerRow>
  );
}

/**
 * The title of the page the shell shows above the content (App.tsx), or null when the page shows its own. A card whose title only
 * repeats it (say "Employees (16)" under the page "Employees") keeps its heading for assistive technology but does not print it again:
 * its count, if any, and its actions stay.
 */
export const PageTitleContext = createContext<string | null>(null);

const bareTitle = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();

/**
 * Section is a shadcn Card drawn on the <section> itself, with the card's padding on it: its children stay direct children of the
 * section, where Hint and FormGrid read their place in the card and the `.card > .empty` rule of styles.css finds an empty line, and
 * the header is a <header> holding the <h2> and the actions (section-bar.tsx looks for `section > header > h2`). The card scrolls
 * sideways when its content is wider, except where its table's headings stick (`data-fit`, sticky-heads.ts).
 * Its forms and tables know they are in a card (InCardContext).
 */
const CARD = 'card rounded-xl border border-border bg-card p-6 shadow-sm overflow-x-auto min-[561px]:data-fit:overflow-visible';

/** CardHeader: the title and the actions on one line (wrapping on a phone), the actions at the end. */
const HEADER = 'card-header -mx-6 flex items-center justify-between gap-3 px-6 pt-0 phone:flex-wrap';
/**
 * A header over a task list still loading (the `ul.tasks` of the decision lists, empty and last) has no rule under it. The list is
 * the screen's own markup, so the header looks at the sibling after it.
 */
const HEADER_OVER_LOADING_TASKS = 'has-[+.tasks:empty:last-child]:mb-0 has-[+.tasks:empty:last-child]:border-b-0 has-[+.tasks:empty:last-child]:pb-0';

/** CardTitle, as the section's <h2>. */
const TITLE = 'text-base leading-snug font-semibold';

/** A decision queue with nothing waiting, as one quiet line (QuietWhenEmptyContext, components/card-context.ts). */
const QUIET_CARD = 'group/queue has-[p[data-slot=empty]]:bg-accent has-[p[data-slot=empty]]:px-[1.1rem] has-[p[data-slot=empty]]:py-[0.7rem] has-[p[data-slot=empty]]:shadow-none';
const QUIET_HEADER = 'group-has-[p[data-slot=empty]]/queue:m-0 group-has-[p[data-slot=empty]]/queue:border-0 group-has-[p[data-slot=empty]]/queue:p-0';
const QUIET_TITLE = 'group-has-[p[data-slot=empty]]/queue:text-[0.92rem]';

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const page = useContext(PageTitleContext);
  const quiet = useContext(QuietWhenEmptyContext);
  const card = cn(CARD, quiet && QUIET_CARD);
  const header = cn(HEADER, HEADER_OVER_LOADING_TASKS, quiet && QUIET_HEADER);
  if (page !== null && bareTitle(title) === bareTitle(page)) {
    const extra = /\(([^)]*)\)\s*$/.exec(title)?.[1];
    return (
      <section data-slot="card" className={card}>
        <InCardContext.Provider value={true}>
          <h2 className="sr-only">{title}</h2>
          {(extra || actions) && (
            <header data-slot="card-header" className={cn(header, 'card-header-plain mb-4 min-h-0 border-b-0 pb-0', !extra && 'justify-end')}>
              <span data-slot="card-description" className="card-count text-sm font-medium text-muted-foreground">
                {extra ? (/^\d+$/.test(extra) ? `${extra} in total` : extra) : ''}
              </span>
              {actions}
            </header>
          )}
          {children}
        </InCardContext.Provider>
      </section>
    );
  }
  return (
    <section data-slot="card" className={card}>
      <InCardContext.Provider value={true}>
        <header data-slot="card-header" className={cn(header, 'mb-5 min-h-[2.1rem] border-b border-border pb-5')}>
          <h2 data-slot="card-title" className={cn(TITLE, quiet && QUIET_TITLE)}>
            {title}
          </h2>
          {actions}
        </header>
        {children}
      </InCardContext.Provider>
    </section>
  );
}
