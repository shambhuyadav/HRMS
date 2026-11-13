// Assets: register, custody and custody requests (FR-110 assets part; H3 TN16; decision I-31; DF02; DF03; DF04; C4).
//
// A minimal custody register: no valuation, depreciation, cost, transfer or write-off. Items are IN_STOCK, ISSUED,
// RETURNED_TO_STOCK or RETIRED (final, never deleted). The register, issue, return and retirement are Admin duties of an
// unrestricted company-scope assignment, never recorded on one's own items; the server refuses anything else and these
// screens say so in plain words. An item is issued only from stock to an active employee and returned from ISSUED
// whatever the employee's status; dates are never in the future or before the last return; the history is append-only.
// Custody requests are submitted by the employee in the Employee OWN context (My ESS TN16: item or category with a
// reason) and decided by an independent eligible Admin: approve, or reject with a note the employee never sees.
// Approval issues nothing: issuing stays the separate custody action on the item, which may name the approved request.
// The employee reads their own items and history, acknowledges receipt once per issue and never issues, returns,
// retires, transfers or writes off anything. The server authorises every call and decides every rule; these screens
// hide what the selected assignment cannot use and render only what the API returned.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { type MeContext, useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';
import { DelegatedBadge } from './delegations';
import { canRaiseAgain, followedRequests, RaiseAgainNote, RaisedAgainHint } from './requests';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/assets/registration.ts, routes.ts; migration 0049_assets.sql) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/assets, /v1/assets/:id, /v1/asset-categories (company-wide) and /v1/employees/:id/assets (row scope). */
const ASSET_READ = 'asset.read.operational';
/** POST /v1/assets, PATCH /v1/assets/:id, POST /v1/assets/:id/retire. */
const ASSET_MANAGE = 'asset.manage.operational';
/** POST /v1/assets/:id/issue and /return. */
const ASSET_CUSTODY = 'asset.custody.operational';
/** POST /v1/me/asset-acknowledgments (Employee OWN context). */
const ASSET_ACKNOWLEDGE = 'asset.acknowledge.operational';
/** GET /v1/me/asset-categories, POST /v1/me/asset-requests and its withdrawal (Employee OWN context). */
const REQUEST_SUBMIT = 'asset_request.submit.operational';
/** GET /v1/asset-requests (row scope) and /v1/employees/:id/asset-requests. */
const REQUEST_READ = 'asset_request.read.operational';
/** GET /v1/asset-requests/tasks/mine and the decision. */
const REQUEST_DECIDE = 'asset_request.decide.operational';
/** GET /v1/employees: whom to issue an item to. */
const EMPLOYEE_LIST = 'employee.list.operational';
/** The own-ESS role: own items, acknowledgments and requests are served only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

const PATHS = {
  register: '/assets',
  asset: (id: string) => `/assets/items/${id}`,
  employee: (id: string) => `/assets/employees/${id}`,
  requests: '/assets/requests',
} as const;

const PAGE_SIZE = 25;
const ASSET_STATES = ['IN_STOCK', 'ISSUED', 'RETURNED_TO_STOCK', 'RETIRED'] as const;
const STATE_LABEL: Record<string, string> = { IN_STOCK: 'In stock', ISSUED: 'Issued', RETURNED_TO_STOCK: 'Returned to stock', RETIRED: 'Retired (final)' };
const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { IN_STOCK: 'good', ISSUED: 'warn', RETURNED_TO_STOCK: 'good', RETIRED: 'neutral' };
const REQUEST_LABEL: Record<string, string> = { SUBMITTED: 'Waiting for a decision', APPROVED: 'Approved', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };
const REQUEST_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { SUBMITTED: 'warn', APPROVED: 'good', REJECTED: 'bad', WITHDRAWN: 'neutral' };
const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected' };
/** GET /v1/asset-requests filters: a state, or approved requests no item has been issued for yet. */
const REQUEST_FILTERS: readonly (readonly [value: string, label: string])[] = [
  ['', 'All requests'],
  ['SUBMITTED', 'Waiting for a decision'],
  ['UNFULFILLED', 'Approved, waiting for an item'],
  ['APPROVED', 'Approved'],
  ['REJECTED', 'Rejected'],
  ['WITHDRAWN', 'Withdrawn'],
];

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/assets/service.ts and requests.ts views)
// ---------------------------------------------------------------------------------------------------------
interface Category {
  code: string;
  label: string;
}
interface Holder {
  custodyId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  issuedOn: string;
  acknowledgedAt: string | null;
}
interface Asset {
  id: string;
  assetCode: string;
  category: Category;
  description: string;
  identifier: string | null;
  state: string;
  retiredOn: string | null;
  retirementNote: string | null;
  holder: Holder | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Custody {
  custodyId: string;
  assetId: string;
  employeeId: string;
  issuedOn: string;
  issueCondition: string;
  acknowledgedAt: string | null;
  returnedOn: string | null;
  returnCondition: string | null;
  requestId: string | null;
  status: 'HELD' | 'RETURNED';
  /** The item's custody history names the employee. */
  employeeCode?: string;
  employeeName?: string;
  /** An employee's items name the item. */
  assetCode?: string;
  category?: Category;
  description?: string;
  identifier?: string | null;
}
interface AssetDetail extends Asset {
  custody: Custody[];
}
interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
interface HeldItem {
  assetCode: string;
  category: string;
  description: string;
  issuedOn: string;
}
interface AssetRequest {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  category: Category;
  itemDescription: string | null;
  reason: string;
  state: string;
  submittedAt: string;
  decidedAt: string | null;
  version: number;
  pendingWith: string | null;
  decisions: { decision: string; decidedAt: string }[];
  fulfilment: { custodyId: string; assetId: string; assetCode: string; issuedOn: string } | null;
  /** Present only when the reviewer's assignment may also read asset custody. */
  currentlyHeld?: HeldItem[];
  /** DF03: the rejected request this one raises again. */
  predecessorRequestId?: string | null;
}
interface RequestTask {
  taskId: string;
  transactionId: string;
  ownerEmployeeId: string;
  ownerEmployeeCode?: string | null;
  ownerName?: string | null;
  assignedAt?: string;
  /** null when the request's employee is outside the reviewer's row scope. */
  request: AssetRequest | null;
}
interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

// ---------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (the register, a reviewer's queue) must never be shown under another.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['assets', context] as const;
    return {
      all: base,
      categories: [...base, 'categories'] as const,
      register: (query: string) => [...base, 'register', query] as const,
      asset: (id: string) => [...base, 'asset', id] as const,
      employeeAssets: (id: string, status: string) => [...base, 'employee-assets', id, status] as const,
      employeeRequests: (id: string) => [...base, 'employee-requests', id] as const,
      requests: (query: string) => [...base, 'requests', query] as const,
      tasks: [...base, 'tasks'] as const,
      ownCategories: [...base, 'own-categories'] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
    };
  }, [context]);
}

/** After any change everything this module shows in the selected context is fetched again (never optimistic). */
function useRefetchAll() {
  const qc = useQueryClient();
  const keys = useKeys();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

/**
 * One idempotency key per user action: sending the same action again (same content) after a lost answer or a refusal
 * reuses its key, so it is never applied twice; a different action, or the next one after a success, gets a new key.
 */
function useAttemptKey(prefix: string) {
  const last = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(signature: string): string {
        if (last.current?.signature !== signature) last.current = { signature, key: idempotencyKey(prefix) };
        return last.current.key;
      },
      reset() {
        last.current = null;
      },
    }),
    [prefix],
  );
}

const SCROLL: CSSProperties = { overflowX: 'auto' };
const FLUSH: CSSProperties = { margin: 0 };
const SPACED: CSSProperties = { marginTop: '0.75rem' };
const TEXTAREA: CSSProperties = {
  font: 'inherit',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: 6,
  color: 'var(--text)',
  background: 'var(--surface)',
  resize: 'vertical',
};

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;
const personLabel = (p: { displayName: string; employeeCode: string }) => `${p.displayName} (${p.employeeCode})`;
const holderLabel = (p: { employeeName?: string | undefined; employeeCode?: string | undefined }) =>
  p.employeeName ? (p.employeeCode ? `${p.employeeName} (${p.employeeCode})` : p.employeeName) : (p.employeeCode ?? '—');
const optional = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
const dateIn = (text: string | undefined) => /\d{4}-\d{2}-\d{2}/.exec(text ?? '')?.[0];

function AssetState({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? readable(state)}</Badge>;
}
function RequestState({ state }: { state: string }) {
  return <Badge tone={REQUEST_TONE[state] ?? 'neutral'}>{REQUEST_LABEL[state] ?? readable(state)}</Badge>;
}

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'read' | 'create' | 'update' | 'retire' | 'issue' | 'return' | 'decide' | 'acknowledge' | 'submit' | 'withdraw';

const REGISTER_ACTS: readonly Act[] = ['read', 'create', 'update', 'retire', 'issue', 'return'];
/** Actions the server matches by idempotency key (or by nature), so sending them again never applies them twice. */
const REPEATABLE_ACTS: readonly Act[] = ['issue', 'return', 'decide', 'acknowledge', 'submit'];

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return REPEATABLE_ACTS.includes(action)
      ? 'No answer came back, so this may or may not have been recorded. Send it again unchanged: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const field = (error.details as { field?: string } | undefined)?.field;
  switch (error.code) {
    case 'FORBIDDEN':
      return REGISTER_ACTS.includes(action)
        ? 'The selected role is not permitted to do this. The asset register and custody actions need an unrestricted company-scope Admin assignment.'
        : 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'decide') return 'This request is no longer assigned to you, or its employee is outside the selected role’s scope.';
      if (action === 'issue') return 'The item or the employee is not available in the selected role’s scope.';
      if (action === 'acknowledge') return 'This item record is not available.';
      if (action === 'submit' || action === 'withdraw') return 'This request is not available.';
      return 'This item is not available.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own items and requests.';
    case 'INVALID_ASSET_CODE':
      return 'Use 1 to 40 letters, digits, dots, dashes, slashes or underscores for the asset code.';
    case 'ASSET_CODE_EXISTS':
      return 'An item with this asset code already exists. Asset codes are permanent and never reused.';
    case 'INVALID_CATEGORY':
      return 'Choose an active category from the list.';
    case 'INVALID_DESCRIPTION':
      return 'Describe the item.';
    case 'STALE_VERSION':
      return 'The item changed since it was loaded. It has been reloaded: check it and try again.';
    case 'NO_CHANGE':
      return 'Nothing differs from the register entry.';
    case 'ASSET_RETIRED':
      return 'The item is retired. A retired item is final: it is never issued or changed again.';
    case 'ASSET_ISSUED':
      return 'The item is held by an employee. Record its return before retiring it.';
    case 'ASSET_NOT_AVAILABLE':
      return 'The item is held by an employee. Record its return before issuing it again.';
    case 'ASSET_NOT_ISSUED':
      return 'The item is not held by anyone, so there is no return to record.';
    case 'DATE_IN_FUTURE':
      return 'The date cannot be later than today: record it on or after the day it happens.';
    case 'DATE_BEFORE_LAST_RETURN': {
      const on = dateIn(error.message);
      return `The date cannot be before the item’s last return${on ? ` on ${on}` : ''}.`;
    }
    case 'DATE_BEFORE_ISSUE': {
      const on = dateIn(error.message);
      return `The return cannot be dated before the issue${on ? ` on ${on}` : ''}.`;
    }
    case 'INVALID_DATE':
      return 'Enter a valid calendar date.';
    case 'CONDITION_REQUIRED':
      return 'Record the condition of the item.';
    case 'NOTE_REQUIRED':
      return 'Record why the item is retired.';
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'submit'
        ? 'Only active employees can ask for an item.'
        : 'Items are issued only to active employees (on probation, confirmed or serving notice).';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot record custody of your own items: another administrator does that.';
    case 'REQUEST_NOT_APPLICABLE':
      return 'The chosen custody request is not a request of this employee.';
    case 'REQUEST_NOT_APPROVED':
      return 'Only an approved custody request can be fulfilled.';
    case 'REQUEST_ALREADY_FULFILLED':
      return 'An item was already issued for this custody request.';
    case 'CUSTODY_CLOSED':
      return 'The item has been returned, so there is nothing to acknowledge.';
    case 'REASON_REQUIRED':
      return action === 'decide' ? 'Enter a note explaining the rejection. The employee never sees it.' : 'Explain why you need the item.';
    case 'RETURN_NOT_ALLOWED':
      return 'A custody request is approved or rejected; the employee can submit a new one.';
    case 'TASK_CLOSED':
      return 'This request has already been decided or withdrawn.';
    case 'INVALID_STATE':
      return action === 'withdraw' ? 'Only a request waiting for a decision can be withdrawn.' : null;
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'submit'
        ? 'No eligible reviewer is set up for custody requests. Ask HR to repair the reviewer list; nothing was submitted.'
        : 'No eligible reviewer is left for this request. Ask HR to repair the reviewer list; your decision was not recorded.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for custody requests yet. Ask HR to configure it; nothing was submitted.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different action. Send it again.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return field ? `Check the ${readable(field).toLowerCase()} field. ${error.message}` : null;
  }
}

function Refusal({ error, action }: { error: unknown; action: Act }) {
  if (!error) return null;
  const text = refusalText(error, action);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function QueryProblem({ error, forbidden, action = 'read' }: { error: unknown; forbidden: string; action?: Act }) {
  if (!error) return null;
  if (isForbidden(error) && !(error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED')) return <NotPermitted>{forbidden}</NotPermitted>;
  if (isNotFound(error)) return <Empty>{refusalText(error, action)}</Empty>;
  return <Refusal error={error} action={action} />;
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Notice({ notice }: { notice: { text: string; ok: boolean } | null }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
      {notice.text}
    </p>
  );
}

/** A local check before anything is sent (the server applies the same rule). */
function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Lookups: categories (DF04 controlled list) and employees
// ---------------------------------------------------------------------------------------------------------

/** The company's active categories: the register's list (asset.read) or, in the Employee OWN context, the request list. */
function useCategories(own: boolean, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: own ? keys.ownCategories : keys.categories,
    queryFn: () => api<{ items: Category[] }>(own ? '/v1/me/asset-categories' : '/v1/asset-categories'),
    enabled,
    retry: retryTransient,
    staleTime: 60_000,
  });
}

function CategorySelect({
  label,
  value,
  onChange,
  categories,
  allLabel,
  current,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  categories: Category[] | undefined;
  allLabel?: string;
  /** The item's category, kept selectable even if it has since been deactivated. */
  current?: Category;
}) {
  const list = categories ?? [];
  const options = current && !list.some((c) => c.code === current.code) ? [current, ...list] : list;
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel ?? 'Choose a category'}</option>
        {options.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Whom to issue an item to: found by an employee search (the server checks row scope and status, and refuses one's own record). */
function EmployeePicker({ value, onChange }: { value: EmployeeHit | null; onChange: (e: EmployeeHit | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
    retry: retryTransient,
  });
  if (!canSearch) return <NotPermitted>The selected role cannot search employees, so it cannot choose whom to issue the item to.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  return (
    <div className="wide">
      <p style={FLUSH}>
        Issue to: <strong>{value ? personLabel(value) : 'nobody chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </p>
      <label>
        Find the employee
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      <QueryProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {found && found.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {found.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${personLabel(e)}`}
                onClick={() => {
                  onChange(e);
                  setSearch('');
                  setTerm('');
                }}
              >
                {personLabel(e)} · {readable(e.status).toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Register (Admin): list, filters and new items
// ---------------------------------------------------------------------------------------------------------
interface RegisterFilters {
  state: string;
  categoryCode: string;
  search: string;
  page: number;
}

function registerQuery(f: RegisterFilters): string {
  const q = new URLSearchParams();
  if (f.state) q.set('state', f.state);
  if (f.categoryCode) q.set('categoryCode', f.categoryCode);
  if (f.search.trim()) q.set('search', f.search.trim());
  q.set('page', String(f.page));
  q.set('pageSize', String(PAGE_SIZE));
  return q.toString();
}

function RegisterScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const ownContext = me?.scopeKind === 'OWN';
  const allowed = can(ASSET_READ) && !ownContext;
  const [filters, setFilters] = useState<RegisterFilters>({ state: '', categoryCode: '', search: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const categories = useCategories(false, allowed);
  const query = registerQuery(filters);
  const list = useQuery({ queryKey: keys.register(query), queryFn: () => api<Page<Asset>>(`/v1/assets?${query}`), enabled: allowed, retry: retryTransient });

  if (!can(ASSET_READ)) {
    return (
      <div className="stack">
        <h1>Asset register</h1>
        <NotPermitted>The selected role cannot read the asset register.</NotPermitted>
      </div>
    );
  }
  if (ownContext) {
    return (
      <div className="stack">
        <h1>Asset register</h1>
        <NotPermitted>The asset register needs an unrestricted company-scope Admin assignment. Your own items are on My ESS.</NotPermitted>
      </div>
    );
  }
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const categoryList = shown(categories)?.items;
  return (
    <div className="stack">
      <h1>Asset register</h1>
      <p className="hint">
        Company items in custody: no value, cost or depreciation is kept. Retired items stay in the register for good. Custody requests are decided on{' '}
        {can(REQUEST_DECIDE) || can(REQUEST_READ) ? <Link to={PATHS.requests}>Custody requests</Link> : 'Custody requests'}.
      </p>
      {can(ASSET_MANAGE) && <CreateAssetForm categories={categoryList} />}
      <Section title="Items">
        <form
          className="grid-form"
          aria-label="Filter the register"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, search: searchText, page: 1 });
          }}
        >
          <label>
            State
            <select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value, page: 1 })}>
              <option value="">All states</option>
              {ASSET_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <CategorySelect
            label="Category"
            value={filters.categoryCode}
            onChange={(categoryCode) => setFilters({ ...filters, categoryCode, page: 1 })}
            categories={categoryList}
            allLabel="All categories"
          />
          <label>
            Search
            <input type="search" value={searchText} maxLength={100} placeholder="Asset code, description or identifier" onChange={(e) => setSearchText(e.target.value)} />
          </label>
          <button type="submit">Search</button>
        </form>
        {list.isPending && <p className="hint loading">Loading the register…</p>}
        <QueryProblem error={list.error} forbidden="The asset register needs an unrestricted company-scope Admin assignment." />
        {data && data.items.length === 0 && <Empty>No items match these filters.</Empty>}
        {data && data.items.length > 0 && (
          <>
            <div style={SCROLL}>
              <table aria-label="Register items">
                <thead>
                  <tr>
                    <th>Asset code</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Identifier</th>
                    <th>State</th>
                    <th>Held by</th>
                    <th>Issued on</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link to={PATHS.asset(a.id)}>{a.assetCode}</Link>
                      </td>
                      <td>{a.category.label}</td>
                      <td>{a.description}</td>
                      <td>{optional(a.identifier)}</td>
                      <td>
                        <AssetState state={a.state} />
                      </td>
                      <td>{a.holder ? <Link to={PATHS.employee(a.holder.employeeId)}>{holderLabel(a.holder)}</Link> : '—'}</td>
                      <td>{a.holder ? formatDate(a.holder.issuedOn) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>
                Previous page
              </button>
              <span>
                Page {data.page} of {pages} · {data.total} item{data.total === 1 ? '' : 's'}
              </span>
              <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>
                Next page
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

interface CreateInput {
  assetCode: string;
  categoryCode: string;
  description: string;
  identifier?: string;
}

function CreateAssetForm({ categories }: { categories: Category[] | undefined }) {
  const refetchAll = useRefetchAll();
  const empty = { assetCode: '', categoryCode: '', description: '', identifier: '' };
  const [draft, setDraft] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<Asset | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateInput) => api<Asset>('/v1/assets', { method: 'POST', body }),
    onSuccess: (asset) => {
      setCreated(asset);
      setDraft(empty);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    const assetCode = draft.assetCode.trim();
    const description = draft.description.trim();
    if (!assetCode || !draft.categoryCode || !description) {
      setProblem('Enter the asset code, choose a category and describe the item.');
      return;
    }
    setProblem(null);
    const identifier = draft.identifier.trim();
    create.mutate({ assetCode, categoryCode: draft.categoryCode, description, ...(identifier ? { identifier } : {}) });
  };
  return (
    <Section title="Add an item">
      <form className="grid-form" aria-label="Add an item" onSubmit={submit} noValidate>
        <label>
          Asset code
          <input value={draft.assetCode} maxLength={40} onChange={(e) => setDraft({ ...draft, assetCode: e.target.value })} />
        </label>
        <CategorySelect label="Category" value={draft.categoryCode} onChange={(categoryCode) => setDraft({ ...draft, categoryCode })} categories={categories} />
        <label>
          Identifier (optional, e.g. a serial number)
          <input value={draft.identifier} maxLength={200} onChange={(e) => setDraft({ ...draft, identifier: e.target.value })} />
        </label>
        <label className="wide">
          Description
          <input value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
        <p className="hint wide">The code is permanent and never reused. A new item starts in stock.</p>
        <div className="wide">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={create.error} action="create" />
      {created && (
        <p role="status" className="ok">
          <Link to={PATHS.asset(created.id)}>{created.assetCode}</Link> was added to the register ({STATE_LABEL[created.state] ?? readable(created.state)}).
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One item (Admin): details, custody history, issue, return, change and retirement
// ---------------------------------------------------------------------------------------------------------
function AssetDetailScreen() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const keys = useKeys();
  const allowed = can(ASSET_READ) && me?.scopeKind !== 'OWN';
  const detail = useQuery({ queryKey: keys.asset(id), queryFn: () => api<AssetDetail>(`/v1/assets/${id}`), enabled: allowed && id !== '', retry: retryTransient });
  const a = shown(detail);
  if (!allowed) {
    return (
      <div className="stack">
        <h1>Asset</h1>
        <NotPermitted>The asset register needs an unrestricted company-scope Admin assignment.</NotPermitted>
      </div>
    );
  }
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.register}>Back to the register</Link>
      </p>
      <h1>{a ? `${a.assetCode}: ${a.description}` : 'Asset'}</h1>
      {detail.isPending && <p className="hint loading">Loading the item…</p>}
      <QueryProblem error={detail.error} forbidden="The asset register needs an unrestricted company-scope Admin assignment." />
      {a && <AssetBody a={a} />}
    </div>
  );
}

function AssetBody({ a }: { a: AssetDetail }) {
  const { can } = useSession();
  const inStock = a.state === 'IN_STOCK' || a.state === 'RETURNED_TO_STOCK';
  // Kept here: an issue or return changes the state, which swaps the form that recorded it for the other one.
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <Notice notice={done ? { text: done, ok: true } : null} />
      <Section title="Item">
        <dl className="kv">
          <Item term="Asset code">{a.assetCode}</Item>
          <Item term="Category">{a.category.label}</Item>
          <Item term="Description">{a.description}</Item>
          <Item term="Identifier">{optional(a.identifier)}</Item>
          <Item term="State">
            <AssetState state={a.state} />
          </Item>
          <Item term="Held by">{a.holder ? <Link to={PATHS.employee(a.holder.employeeId)}>{holderLabel(a.holder)}</Link> : 'Nobody'}</Item>
          {a.holder && <Item term="Issued on">{formatDate(a.holder.issuedOn)}</Item>}
          {a.holder && <Item term="Receipt">{a.holder.acknowledgedAt ? <>Acknowledged <When at={a.holder.acknowledgedAt} /></> : 'Not acknowledged yet'}</Item>}
          {a.state === 'RETIRED' && <Item term="Retired on">{formatDate(a.retiredOn)}</Item>}
          {a.state === 'RETIRED' && a.retirementNote !== null && <Item term="Retirement note">{a.retirementNote}</Item>}
          <Item term="Added">
            <When at={a.createdAt} />
          </Item>
        </dl>
      </Section>
      {can(ASSET_CUSTODY) && inStock && <IssueForm a={a} onDone={setDone} />}
      {can(ASSET_CUSTODY) && a.state === 'ISSUED' && <ReturnForm a={a} onDone={setDone} />}
      <CustodyHistory a={a} />
      {can(ASSET_MANAGE) && a.state !== 'RETIRED' && <EditForm a={a} />}
      {can(ASSET_MANAGE) && inStock && <RetireForm a={a} />}
    </>
  );
}

function CustodyHistory({ a }: { a: AssetDetail }) {
  return (
    <Section title="Custody history">
      {a.custody.length === 0 ? (
        <Empty>The item has never been issued.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Custody history">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Issued on</th>
                <th>Condition at issue</th>
                <th>Receipt</th>
                <th>Returned on</th>
                <th>Condition at return</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {a.custody.map((k) => (
                <tr key={k.custodyId}>
                  <td>
                    <Link to={PATHS.employee(k.employeeId)}>{holderLabel(k)}</Link>
                  </td>
                  <td>{formatDate(k.issuedOn)}</td>
                  <td>{k.issueCondition}</td>
                  <td>{k.acknowledgedAt ? <>Acknowledged <When at={k.acknowledgedAt} /></> : 'Not acknowledged'}</td>
                  <td>{formatDate(k.returnedOn)}</td>
                  <td>{optional(k.returnCondition)}</td>
                  <td>
                    <Badge tone={k.status === 'HELD' ? 'warn' : 'neutral'}>{k.status === 'HELD' ? 'Held' : 'Returned'}</Badge>
                    {k.requestId && <span className="hint"> · fulfils a custody request</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function IssueForm({ a, onDone: setDone }: { a: AssetDetail; onDone: (text: string | null) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-issue');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [issuedOn, setIssuedOn] = useState('');
  const [condition, setCondition] = useState('');
  const [requestId, setRequestId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const canReadRequests = can(REQUEST_READ);
  const requests = useQuery({
    queryKey: keys.employeeRequests(employee?.id ?? '-'),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${employee!.id}/asset-requests`),
    enabled: canReadRequests && employee !== null,
    retry: retryTransient,
  });
  const open = (shown(requests)?.items ?? []).filter((r) => r.state === 'APPROVED' && r.fulfilment === null);
  const issue = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ custodyId: string; issuedOn: string }>(`/v1/assets/${a.id}/issue`, { method: 'POST', body }),
    onSuccess: (result, body) => {
      attempt.reset();
      setDone(`${a.assetCode} was issued to ${employee ? personLabel(employee) : 'the employee'} on ${formatDate(result.issuedOn ?? (body.issuedOn as string | undefined))}.`);
      setEmployee(null);
      setIssuedOn('');
      setCondition('');
      setRequestId('');
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (!employee) return setProblem('Choose the employee who receives the item.');
    if (!condition.trim()) return setProblem('Record the condition of the item.');
    setProblem(null);
    const content = { employeeId: employee.id, ...(issuedOn ? { issuedOn } : {}), condition: condition.trim(), ...(requestId ? { requestId } : {}) };
    issue.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify([a.id, content])) });
  };
  return (
    <Section title="Issue the item">
      <form className="grid-form" aria-label="Issue the item" onSubmit={submit} noValidate>
        <EmployeePicker
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setRequestId('');
          }}
        />
        <label>
          Issued on (empty for today)
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
        </label>
        {employee && canReadRequests && (
          <label>
            Fulfils the approved custody request (optional)
            <select value={requestId} onChange={(e) => setRequestId(e.target.value)}>
              <option value="">No request</option>
              {open.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${r.category.label}${r.itemDescription ? `: ${r.itemDescription}` : ''} (approved ${formatDate(r.decidedAt)})`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wide">
          Condition at issue
          <textarea style={TEXTAREA} rows={2} value={condition} maxLength={1000} onChange={(e) => setCondition(e.target.value)} />
        </label>
        <p className="hint wide">Items go only from stock to an active employee, dated today or earlier and not before the last return.</p>
        <div className="wide">
          <button type="submit" disabled={issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Issue the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={issue.error} action="issue" />
    </Section>
  );
}

function ReturnForm({ a, onDone: setDone }: { a: AssetDetail; onDone: (text: string | null) => void }) {
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-return');
  const [returnedOn, setReturnedOn] = useState('');
  const [condition, setCondition] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const giveBack = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ returnedOn: string }>(`/v1/assets/${a.id}/return`, { method: 'POST', body }),
    onSuccess: (result) => {
      attempt.reset();
      setDone(`The return of ${a.assetCode} on ${formatDate(result.returnedOn)} was recorded. The item is back in stock.`);
      setReturnedOn('');
      setCondition('');
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    if (!condition.trim()) return setProblem('Record the condition of the item.');
    setProblem(null);
    const content = { ...(returnedOn ? { returnedOn } : {}), condition: condition.trim() };
    giveBack.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify([a.id, a.holder?.custodyId ?? null, content])) });
  };
  return (
    <Section title="Record the return">
      <form className="grid-form" aria-label="Record the return" onSubmit={submit} noValidate>
        <p className="hint wide">
          Held by {a.holder ? holderLabel(a.holder) : 'an employee'} since {formatDate(a.holder?.issuedOn)}. A return is recorded whatever the employee’s status, so
          clearance works after separation.
        </p>
        <label>
          Returned on (empty for today)
          <input type="date" value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} />
        </label>
        <label className="wide">
          Condition at return
          <textarea style={TEXTAREA} rows={2} value={condition} maxLength={1000} onChange={(e) => setCondition(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={giveBack.isPending}>
            {giveBack.isPending ? 'Recording…' : 'Record the return'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={giveBack.error} action="return" />
    </Section>
  );
}

function EditForm({ a }: { a: AssetDetail }) {
  const refetchAll = useRefetchAll();
  const categories = useCategories(false, true);
  const [categoryCode, setCategoryCode] = useState(a.category.code);
  const [description, setDescription] = useState(a.description);
  const [identifier, setIdentifier] = useState(a.identifier ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Asset>(`/v1/assets/${a.id}`, { method: 'PATCH', body }),
    onSettled: (_data, error) => {
      // A success, or a refusal because the item changed, both reload it.
      if (!error || (error instanceof ApiError && (error.code === 'STALE_VERSION' || error.code === 'ASSET_RETIRED'))) void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (categoryCode !== a.category.code) changes.categoryCode = categoryCode;
    if (description.trim() !== a.description) changes.description = description.trim();
    const nextIdentifier = identifier.trim() === '' ? null : identifier.trim();
    if (nextIdentifier !== a.identifier) changes.identifier = nextIdentifier;
    if (!description.trim()) return setProblem('Describe the item.');
    if (Object.keys(changes).length === 0) return setProblem('Nothing differs from the register entry.');
    setProblem(null);
    save.mutate({ expectedVersion: a.version, ...changes });
  };
  return (
    <Section title="Correct the register entry">
      <form className="grid-form" aria-label="Correct the register entry" onSubmit={submit} noValidate>
        <CategorySelect label="Category" value={categoryCode} onChange={setCategoryCode} categories={shown(categories)?.items} current={a.category} />
        <label>
          Identifier (optional)
          <input value={identifier} maxLength={200} onChange={(e) => setIdentifier(e.target.value)} />
        </label>
        <label className="wide">
          Description
          <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the correction'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={save.error} action="update" />
      {save.isSuccess && (
        <p role="status" className="ok">
          The register entry was corrected.
        </p>
      )}
    </Section>
  );
}

function RetireForm({ a }: { a: AssetDetail }) {
  const refetchAll = useRefetchAll();
  const [retiredOn, setRetiredOn] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Asset>(`/v1/assets/${a.id}/retire`, { method: 'POST', body }),
    onSettled: (_data, error) => {
      if (!error || (error instanceof ApiError && ['STALE_VERSION', 'ASSET_RETIRED', 'ASSET_ISSUED'].includes(error.code))) void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return setProblem('Record why the item is retired.');
    setProblem(null);
    retire.mutate({ ...(retiredOn ? { retiredOn } : {}), note: note.trim(), expectedVersion: a.version });
  };
  return (
    <Section title="Retire the item">
      <form className="grid-form" aria-label="Retire the item" onSubmit={submit} noValidate>
        <p className="hint wide">Retirement is final: the item stays in the register and is never issued again. There is no write-off or transfer here.</p>
        <label>
          Retired on (empty for today)
          <input type="date" value={retiredOn} onChange={(e) => setRetiredOn(e.target.value)} />
        </label>
        <label className="wide">
          Why the item is retired
          <textarea style={TEXTAREA} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="wide">
          <button type="submit" className="danger" disabled={retire.isPending}>
            {retire.isPending ? 'Retiring…' : 'Retire the item'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={retire.error} action="retire" />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// An employee's items (Admin, row scope): what they hold and have returned, e.g. for exit clearance
// ---------------------------------------------------------------------------------------------------------
function EmployeeAssetsScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const [status, setStatus] = useState('');
  const items = useQuery({
    queryKey: keys.employeeAssets(id, status),
    queryFn: () =>
      api<{ employee?: { id: string; employeeCode: string; employeeName: string }; items: Custody[] }>(`/v1/employees/${id}/assets${status ? `?status=${status}` : ''}`),
    enabled: can(ASSET_READ) && id !== '',
    retry: retryTransient,
  });
  const requests = useQuery({
    queryKey: keys.employeeRequests(id),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${id}/asset-requests`),
    enabled: can(REQUEST_READ) && id !== '',
    retry: retryTransient,
  });
  if (!can(ASSET_READ)) {
    return (
      <div className="stack">
        <h1>Employee’s items</h1>
        <NotPermitted>The selected role cannot read asset custody.</NotPermitted>
      </div>
    );
  }
  const data = shown(items);
  const asked = shown(requests);
  return (
    <div className="stack">
      <h1>Employee’s items</h1>
      {data?.employee && <p>{holderLabel(data.employee)}</p>}
      <Section title="Items held and returned">
        <label>
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Held and returned items</option>
            <option value="HELD">Held now</option>
            <option value="RETURNED">Returned</option>
          </select>
        </label>
        {items.isPending && <p className="hint loading">Loading the items…</p>}
        <QueryProblem error={items.error} forbidden="The selected role cannot read this employee’s items." />
        {data && <CustodyTable items={data.items} label="The employee’s items" empty="No items match." />}
      </Section>
      {can(REQUEST_READ) && (
        <Section title="Custody requests">
          <QueryProblem error={requests.error} forbidden="The selected role cannot read custody requests." />
          {asked && <RequestHistory requests={asked.items} label="The employee’s custody requests" empty="The employee has no custody requests." showEmployee={false} />}
        </Section>
      )}
    </div>
  );
}

/** Items of one employee with their issue and return records (newest first, held items first, as the API orders them). */
function CustodyTable({ items, label, empty, acknowledge }: { items: Custody[]; label: string; empty: string; acknowledge?: (k: Custody) => ReactNode }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Category</th>
            <th>Description</th>
            <th>Identifier</th>
            <th>Issued on</th>
            <th>Condition at issue</th>
            <th>Returned on</th>
            <th>Condition at return</th>
            <th>Status</th>
            <th>Receipt</th>
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.custodyId}>
              <td>{optional(k.assetCode)}</td>
              <td>{k.category?.label ?? '—'}</td>
              <td>{optional(k.description)}</td>
              <td>{optional(k.identifier)}</td>
              <td>{formatDate(k.issuedOn)}</td>
              <td>{k.issueCondition}</td>
              <td>{formatDate(k.returnedOn)}</td>
              <td>{optional(k.returnCondition)}</td>
              <td>
                <Badge tone={k.status === 'HELD' ? 'warn' : 'neutral'}>{k.status === 'HELD' ? 'Held' : 'Returned'}</Badge>
              </td>
              <td>{k.acknowledgedAt ? <>Acknowledged <When at={k.acknowledgedAt} /></> : (acknowledge?.(k) ?? 'Not acknowledged')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function decisionsText(r: AssetRequest): ReactNode {
  if (r.decisions.length === 0) return r.state === 'WITHDRAWN' ? 'Withdrawn before a decision' : '—';
  return r.decisions.map((d, i) => (
    <span key={`${d.decision}-${i}`}>
      {i > 0 && '; '}
      {DECISION_LABEL[d.decision] ?? readable(d.decision)} <When at={d.decidedAt} />
    </span>
  ));
}

/** Custody requests with their state, who they wait for, the decision outcomes (never the reviewer's note) and the item issued for them. */
function RequestHistory({
  requests,
  label,
  empty,
  showEmployee,
  withdraw,
}: {
  requests: AssetRequest[];
  label: string;
  empty: string;
  showEmployee: boolean;
  withdraw?: (r: AssetRequest) => ReactNode;
}) {
  if (requests.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Submitted</th>
            {showEmployee && <th>Employee</th>}
            <th>Category</th>
            <th>Item asked for</th>
            <th>Reason</th>
            <th>Status</th>
            <th>Decision</th>
            <th>Item issued</th>
            {withdraw && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>
                <When at={r.submittedAt} />
              </td>
              {showEmployee && (
                <td>
                  <Link to={PATHS.employee(r.employeeId)}>{holderLabel(r)}</Link>
                </td>
              )}
              <td>{r.category.label}</td>
              <td>{optional(r.itemDescription)}</td>
              <td>{r.reason}</td>
              <td>
                <RequestState state={r.state} />
                {r.state === 'SUBMITTED' && r.pendingWith && <span className="hint"> · with {r.pendingWith}</span>}
                <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
              </td>
              <td>{decisionsText(r)}</td>
              <td>
                {r.fulfilment
                  ? `${r.fulfilment.assetCode}, issued ${formatDate(r.fulfilment.issuedOn)}`
                  : r.state === 'APPROVED'
                    ? 'Not issued yet (an administrator issues the item separately)'
                    : '—'}
              </td>
              {withdraw && <td>{withdraw(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Custody requests (Admin): the decision queue and the list within row scope
// ---------------------------------------------------------------------------------------------------------
function RequestsScreen() {
  const { can } = useSession();
  return (
    <div className="stack">
      <h1>Custody requests</h1>
      <p className="hint">
        Approving a request records the decision only: it never issues an item. Issue the item from the <Link to={PATHS.register}>asset register</Link> and name the
        approved request there.
      </p>
      {can(REQUEST_DECIDE) && <CustodyRequestQueue />}
      {can(REQUEST_READ) && <RequestList />}
      {!can(REQUEST_DECIDE) && !can(REQUEST_READ) && <NotPermitted>The selected role cannot read or decide custody requests.</NotPermitted>}
    </div>
  );
}

function RequestList() {
  const keys = useKeys();
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const q = new URLSearchParams();
  if (filter === 'UNFULFILLED') q.set('unfulfilled', 'true');
  else if (filter) q.set('state', filter);
  q.set('page', String(page));
  q.set('pageSize', String(PAGE_SIZE));
  const query = q.toString();
  const list = useQuery({ queryKey: keys.requests(query), queryFn: () => api<Page<AssetRequest>>(`/v1/asset-requests?${query}`), retry: retryTransient });
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Section title="All custody requests">
      <label>
        Show
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          {REQUEST_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {list.isPending && <p className="hint loading">Loading the requests…</p>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read custody requests." />
      {data && <RequestHistory requests={data.items} label="Custody requests" empty="No custody requests match." showEmployee />}
      {data && data.items.length > 0 && (
        <div className="pager">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous page
          </button>
          <span>
            Page {data.page} of {pages} · {data.total} request{data.total === 1 ? '' : 's'}
          </span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next page
          </button>
        </div>
      )}
    </Section>
  );
}

/** The independent reviewer's queue (GET /v1/asset-requests/tasks/mine): approve, or reject with a note the employee never sees. */
function CustodyRequestQueue() {
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: RequestTask[] }>('/v1/asset-requests/tasks/mine'), retry: retryTransient });
  /** Tasks decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  const done = (t: RequestTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void refetchAll();
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Custody requests to decide" tabIndex={-1}>
      <Section title={`Custody requests to decide${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Approve a request, or reject it with a note. Approval issues nothing: the item is issued separately from the register.</p>
        {tasks.isPending && <p className="hint loading">Loading the requests waiting for you…</p>}
        <QueryProblem error={tasks.error} forbidden="The selected role cannot decide custody requests." action="decide" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No custody requests are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Custody requests waiting for your decision">
            {items.map((t) => (
              <TaskItem key={t.taskId} task={t} onFinished={done} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function TaskItem({ task: t, onFinished }: { task: RequestTask; onFinished: (t: RequestTask, text: string, ok: boolean) => void }) {
  const attempt = useAttemptKey('asset-decision');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const r = t.request;
  const who = r ? holderLabel(r) : t.ownerName ? holderLabel({ employeeName: t.ownerName, employeeCode: t.ownerEmployeeCode ?? undefined }) : 'An employee';
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }) =>
      api<{ requestId: string; state: string }>(`/v1/asset-requests/tasks/${t.taskId}/decision`, { method: 'POST', body }),
    onSuccess: (result) => {
      attempt.reset();
      onFinished(
        t,
        result.state === 'APPROVED'
          ? `The request of ${who} was approved. No item has been issued: issue one from the register.`
          : `The request of ${who} was rejected. Your note is not shown to the employee.`,
        true,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
      if (error instanceof ApiError && (error.code === 'TASK_CLOSED' || error.code === 'NOT_FOUND')) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    const reason = note.trim();
    if (decision === 'REJECT' && !reason) return setProblem('Enter a note explaining the rejection. The employee never sees it.');
    setProblem(null);
    const content = { decision, ...(reason ? { reason } : {}) };
    decide.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify(content)) });
  };
  return (
    <li aria-label={`Custody request of ${who}`}>
      <strong>{who}</strong>
      <DelegatedBadge taskId={t.taskId} />
      {r ? (
        <>
          <dl className="kv">
            <Item term="Category">{r.category.label}</Item>
            <Item term="Item asked for">{optional(r.itemDescription)}</Item>
            <Item term="Reason">{r.reason}</Item>
            <Item term="Submitted">
              <When at={r.submittedAt} />
            </Item>
          </dl>
          {r.currentlyHeld !== undefined && (
            <div>
              <p style={FLUSH}>Items the employee holds now:</p>
              {r.currentlyHeld.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul aria-label={`Items ${who} holds now`}>
                  {r.currentlyHeld.map((h) => (
                    <li key={`${h.assetCode}-${h.issuedOn}`}>
                      {h.assetCode} · {h.category} · {h.description} · issued {formatDate(h.issuedOn)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <label>
            Note (required to reject; the employee never sees it)
            <textarea style={TEXTAREA} rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
              Approve
            </button>
            <button type="button" className="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
              Reject
            </button>
          </div>
          <Problem text={problem} />
          <Refusal error={decide.error} action="decide" />
        </>
      ) : (
        <p className="hint">This request’s employee is outside the selected role’s scope, so it cannot be shown or decided here.</p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// My ESS TN16 (Employee OWN context): own items, acknowledgment of receipt and custody requests
// ---------------------------------------------------------------------------------------------------------
function MyAssetsPanel() {
  const { me, can } = useSession();
  if (!inOwnContext(me)) return <Empty>Select your Employee role to see your own items and custody requests.</Empty>;
  const employeeId = me!.employeeId!;
  return <MyAssetsSections employeeId={employeeId} />;
}

function MyAssetsSections({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  // DF03: the rejected request being raised again fills the form.
  const [raisingAgain, setRaisingAgain] = useState<AssetRequest | null>(null);
  return (
    <div className="stack">
      {can(ASSET_READ) ? <MyItems employeeId={employeeId} /> : <NotPermitted>Your Employee role cannot read your items.</NotPermitted>}
      {can(REQUEST_SUBMIT) && <AskForItem raisingAgain={raisingAgain} onCancelRaising={() => setRaisingAgain(null)} />}
      {can(REQUEST_READ) && <MyRequests employeeId={employeeId} onRaiseAgain={setRaisingAgain} />}
    </div>
  );
}

function MyItems({ employeeId }: { employeeId: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const items = useQuery({
    queryKey: keys.employeeAssets(employeeId, ''),
    queryFn: () => api<{ items: Custody[] }>(`/v1/employees/${employeeId}/assets`),
    retry: retryTransient,
  });
  const acknowledge = useMutation({
    mutationFn: (custodyId: string) => api<{ custodyId: string; acknowledgedAt: string }>('/v1/me/asset-acknowledgments', { method: 'POST', body: { custodyId } }),
    onSettled: () => void refetchAll(),
  });
  const data = shown(items);
  const held = (data?.items ?? []).filter((k) => k.status === 'HELD');
  const returned = (data?.items ?? []).filter((k) => k.status === 'RETURNED');
  const ackButton = (k: Custody) =>
    k.status === 'HELD' && can(ASSET_ACKNOWLEDGE) ? (
      <button type="button" disabled={acknowledge.isPending} aria-label={`Acknowledge receipt of ${k.assetCode ?? 'the item'}`} onClick={() => acknowledge.mutate(k.custodyId)}>
        Acknowledge receipt
      </button>
    ) : (
      'Not acknowledged'
    );
  return (
    <>
      <Section title="Items I hold">
        <p className="hint">Acknowledge each item you have received, once per issue. Returns are recorded by an administrator.</p>
        {items.isPending && <p className="hint loading">Loading your items…</p>}
        <QueryProblem error={items.error} forbidden="Your Employee role cannot read your items." />
        <Refusal error={acknowledge.error} action="acknowledge" />
        {acknowledge.isSuccess && (
          <p role="status" className="ok">
            Your acknowledgment of receipt was recorded.
          </p>
        )}
        {data && <CustodyTable items={held} label="Items I hold" empty="You hold no company items." acknowledge={ackButton} />}
      </Section>
      {data && returned.length > 0 && (
        <Section title="Returned items">
          <CustodyTable items={returned} label="Items I have returned" empty="" />
        </Section>
      )}
    </>
  );
}

function AskForItem({ raisingAgain, onCancelRaising }: { raisingAgain: AssetRequest | null; onCancelRaising: () => void }) {
  const refetchAll = useRefetchAll();
  const attempt = useAttemptKey('asset-request');
  const categories = useCategories(true, true);
  const [categoryCode, setCategoryCode] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!raisingAgain) return;
    setCategoryCode(raisingAgain.category.code);
    setItemDescription(raisingAgain.itemDescription ?? '');
    setReason(raisingAgain.reason);
    setDone(false);
    setProblem(null);
  }, [raisingAgain]);
  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ requestId: string; state: string }>('/v1/me/asset-requests', { method: 'POST', body }),
    onSuccess: () => {
      attempt.reset();
      setDone(true);
      setCategoryCode('');
      setItemDescription('');
      setReason('');
      onCancelRaising();
      void refetchAll();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.reset();
    },
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (!categoryCode) return setProblem('Choose the kind of item you need.');
    if (!reason.trim()) return setProblem('Explain why you need the item.');
    setProblem(null);
    const content = { categoryCode, ...(itemDescription.trim() ? { itemDescription: itemDescription.trim() } : {}), reason: reason.trim(), ...(raisingAgain ? { predecessorRequestId: raisingAgain.id } : {}) };
    submit.mutate({ ...content, idempotencyKey: attempt.keyFor(JSON.stringify(content)) });
  };
  return (
    <Section title="Ask for an item">
      {raisingAgain && <RaiseAgainNote onCancel={onCancelRaising} />}
      <form className="grid-form" aria-label="Ask for an item" onSubmit={send} noValidate>
        <CategorySelect label="Category" value={categoryCode} onChange={setCategoryCode} categories={shown(categories)?.items} />
        <label>
          Specific item (optional)
          <input value={itemDescription} maxLength={300} onChange={(e) => setItemDescription(e.target.value)} />
        </label>
        <label className="wide">
          Why you need it
          <textarea style={TEXTAREA} rows={2} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="hint wide">An administrator decides the request. An approval does not hand over anything by itself: the item is issued to you separately.</p>
        <div className="wide">
          <button type="submit" disabled={submit.isPending}>
            {submit.isPending ? 'Sending…' : 'Send the request'}
          </button>
        </div>
      </form>
      <QueryProblem error={categories.error} forbidden="Your Employee role cannot ask for items." action="submit" />
      <Problem text={problem} />
      <Refusal error={submit.error} action="submit" />
      {done && (
        <p role="status" className="ok">
          Your request was sent and is waiting for a decision.
        </p>
      )}
    </Section>
  );
}

function MyRequests({ employeeId, onRaiseAgain }: { employeeId: string; onRaiseAgain: (r: AssetRequest) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const requests = useQuery({
    queryKey: keys.employeeRequests(employeeId),
    queryFn: () => api<{ items: AssetRequest[] }>(`/v1/employees/${employeeId}/asset-requests`),
    retry: retryTransient,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api<{ requestId: string; state: string }>(`/v1/me/asset-requests/${id}/withdraw`, { method: 'POST' }),
    onSettled: () => void refetchAll(),
  });
  const data = shown(requests);
  const action = (r: AssetRequest) =>
    r.state === 'SUBMITTED' && can(REQUEST_SUBMIT) ? (
      <button type="button" className="secondary" disabled={withdraw.isPending} aria-label={`Withdraw the request for ${r.category.label}`} onClick={() => withdraw.mutate(r.id)}>
        Withdraw
      </button>
    ) : canRaiseAgain(r, followedRequests(data?.items ?? [])) && can(REQUEST_SUBMIT) ? (
      <button type="button" className="secondary" aria-label={`Raise again the rejected request for ${r.category.label}`} onClick={() => onRaiseAgain(r)}>
        Raise again
      </button>
    ) : (
      '—'
    );
  return (
    <Section title="My custody requests">
      {requests.isPending && <p className="hint loading">Loading your requests…</p>}
      <QueryProblem error={requests.error} forbidden="Your Employee role cannot read your custody requests." />
      <Refusal error={withdraw.error} action="withdraw" />
      {withdraw.isSuccess && (
        <p role="status" className="ok">
          Your request was withdrawn.
        </p>
      )}
      {data && <RequestHistory requests={data.items} label="My custody requests" empty="You have not asked for any items." showEmployee={false} withdraw={action} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the assets module; detail screens are reached through links (nav: false). The register's menu entry is
 * keyed to asset.manage (an Admin duty) rather than asset.read, which the Employee role also holds for its own items on
 * My ESS TN16; the screens themselves check asset.read, as the API does, and the API also requires an unrestricted
 * company-scope assignment for the register.
 */
export const ASSETS_SCREENS: ScreenRoute[] = [
  { path: PATHS.register, title: 'Asset register', permission: ASSET_MANAGE, nav: true, component: RegisterScreen },
  { path: '/assets/items/:id', title: 'Asset', permission: ASSET_READ, nav: false, component: AssetDetailScreen },
  { path: '/assets/employees/:id', title: 'Employee’s items', permission: ASSET_READ, nav: false, component: EmployeeAssetsScreen },
  { path: PATHS.requests, title: 'Custody requests', permission: REQUEST_DECIDE, nav: true, component: RequestsScreen },
];

/** H3 TN16 in the Employee OWN context (registration essTabs: own assets, acknowledgment, categories, requests). */
export const ASSETS_ESS_PANELS: EssPanel[] = [{ tabId: 'TN16', component: MyAssetsPanel }];

/** The custody-request decision queue (GET /v1/asset-requests/tasks/mine; asset_request.decide), also on the Custody requests screen. */
export const ASSETS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: REQUEST_DECIDE, title: 'Custody requests', component: CustodyRequestQueue },
];
