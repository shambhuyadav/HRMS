// Confirmation management (FR-080/FR-081/FR-082; BR-029/BR-030; DF11; DF02).
// HR opens a case for an employee on probation; the planned due date comes from the policy that applies on the start
// date. The employee's direct manager recommends confirming (with an effective date) or extending (by months); an
// independent HR reviewer decides in the Decision inbox (/tasks), never on this screen. Upcoming, due and overdue are
// views the server derives from the company business date: a due date passing never changes a case (BR-030).
// DF11 exceptions (I-19): HR proposes a due date override or an extra extension (one beyond the policy limit) with a
// private reason; a different eligible HR user approves or rejects it with a reason under Pending exceptions; neither
// the proposer nor the employee concerned decides it, and the proposer may withdraw it while it waits.
// The server authorises every call and decides every rule; this screen only hides what the selected assignment cannot
// use. Decision and exception reasons are confidential (DF02/DF11): they are shown only when the server returned them,
// and nothing here hints that a withheld reason exists.
// HR cancels a live review with a reason (FR-082, DF11); an approved exit or a separation closes it the same way.
// Confirmation policies (FR-080, BR-029, DF11) are their own screen, /confirmations/policies: every dated revision of
// every policy, a new policy, a new revision, and ending a policy; the server refuses overlaps and what a case in use
// forbids, and the screen shows its words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

const READ = 'confirmation.read.operational';
const MANAGE = 'confirmation.manage.operational';
const RECOMMEND = 'confirmation.recommend.operational';
const DECIDE = 'confirmation.decide.operational';
const EXPORT = 'confirmation.export.operational';
const PROPOSE_EXCEPTION = 'confirmation.propose_exception.operational';
const APPROVE_EXCEPTION = 'confirmation.approve_exception.operational';
const LIST_EMPLOYEES = 'employee.list.operational';
const MANAGE_POLICIES = 'confirmation_policy.manage.operational';
const POLICIES_PATH = '/confirmations/policies';

/** GET /v1/confirmation-exceptions/pending answers with the oldest 200 waiting proposals at most. */
const PENDING_LIMIT = 200;

/** GET /v1/employees accepts page sizes of 25, 50 or 100 only. */
const EMPLOYEE_PAGE_SIZE = 25;
/** The extension range the recommendation endpoint accepts. */
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/**
 * The views GET /v1/confirmations accepts. Cases also carry LATER, CANCELLED and NOT_ON_PROBATION (a live case left over
 * for an employee who is no longer on probation, which is not due); those appear under All only.
 * EXTENDED is a filter of its own (I-36): live cases extended at least once, which also keep their date view.
 */
type TabView = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'EXTENDED' | 'CONFIRMED' | 'ALL';
type CountedView = Exclude<TabView, 'ALL' | 'EXTENDED'>;

const TABS: readonly { view: TabView; label: string; empty: string }[] = [
  { view: 'UPCOMING', label: 'Upcoming', empty: 'No confirmations are coming up.' },
  { view: 'DUE', label: 'Due', empty: 'No confirmations are due today.' },
  { view: 'OVERDUE', label: 'Overdue', empty: 'No confirmations are overdue.' },
  { view: 'EXTENDED', label: 'Extended', empty: 'No case still open or under review has been extended.' },
  { view: 'CONFIRMED', label: 'Confirmed', empty: 'No confirmed cases yet.' },
  { view: 'ALL', label: 'All', empty: 'No confirmation cases in the selected role’s scope yet.' },
];
const COUNTED: ReadonlySet<string> = new Set<CountedView>(['UPCOMING', 'DUE', 'OVERDUE', 'CONFIRMED']);
/** Views whose cases span several date views, so each row shows its own timing. */
const MIXED_TIMING: ReadonlySet<TabView> = new Set<TabView>(['ALL', 'EXTENDED']);

interface ConfirmationCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  startDate: string;
  initialDueDate: string;
  dueDate: string;
  extensionCount: number;
  actualConfirmationDate: string | null;
  state: string;
  lastOutcome: string | null;
  version: number;
  /** Derived by the server from the company business date (FR-082). */
  view: string;
  /** A live case (open or under review) whose due date was extended at least once (I-36). */
  extended?: boolean;
  /** When a cancelled case was closed, by HR or by the employee's exit. */
  cancelledAt?: string | null;
  /** Confidential: present only when the selected assignment is granted confirmation.read.reason. */
  cancelReason?: string | null;
}

interface CaseList {
  view: string;
  items: ConfirmationCase[];
  total: number;
}

interface CaseAction {
  action: string;
  priorDueDate: string | null;
  newDueDate: string | null;
  actualConfirmationDate: string | null;
  /** Confidential: present only when the selected assignment is granted confirmation.read.reason. */
  reason?: string;
  occurredAt: string;
}

interface CaseDetail extends ConfirmationCase {
  actions: CaseAction[];
  /** False when the selected role has no confirmation history grant (C6): the actions are withheld, not absent. */
  historyIncluded?: boolean;
}

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

type RecommendationBody =
  | { expectedVersion: number; recommendation: 'CONFIRM'; effectiveDate: string; reason: string }
  | { expectedVersion: number; recommendation: 'EXTEND'; extensionMonths: number; reason: string };

type ExceptionKind = 'DUE_DATE_OVERRIDE' | 'EXTRA_EXTENSION';

/** A DF11 exception as GET /v1/confirmations/:id/exceptions lists it (oldest first). */
interface CaseException {
  id: string;
  confirmationId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  kind: ExceptionKind;
  /** The new due date of an override (a calendar date); null for an extra extension. */
  proposedDueDate: string | null;
  /** PROPOSED, APPROVED, REJECTED or WITHDRAWN. */
  state: string;
  /** The user who proposed it. */
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  proposedAt: string;
  /** Confidential: present only when the selected assignment is granted the confirmation reason group. */
  reason?: string;
  decisionReason?: string | null;
}

/** A proposal waiting for a decision; `ownProposal` marks the caller's own, which the caller cannot decide (C4). */
interface PendingException extends CaseException {
  ownProposal: boolean;
}

/** POST /v1/confirmations/:id/exceptions: an override carries its new due date, an extra extension has none. */
type ExceptionBody = { kind: 'DUE_DATE_OVERRIDE'; proposedDueDate: string; reason: string } | { kind: 'EXTRA_EXTENSION'; reason: string };
type ExceptionDecision = 'APPROVE' | 'REJECT';
/** POST /v1/confirmation-exceptions/:id/decision: the key lets a retry of this very decision be answered, not re-applied. */
type DecisionBody = { decision: ExceptionDecision; reason: string; idempotencyKey: string };

interface ExceptionDecided {
  exceptionId: string;
  /** The state the server recorded (APPROVED or REJECTED); for a replay, that of the earlier attempt. */
  state: string;
  /** What an approval changed on the case; null for a rejection and for a replay. */
  applied: { dueDate?: { from: string; to: string }; extensionLimit?: { from: number; to: number } } | null;
  /** True when the key was already used for this decision: the earlier attempt's result, nothing applied again. */
  replayed: boolean;
}

/** GET /v1/confirmations/attention (FR-082, I-36): read only; nothing is opened, assigned or changed by it. */
interface AttentionItem {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  joiningDate: string;
  /** The live case, when one is open; null when no case exists. */
  caseId: string | null;
  state: string | null;
  issues: string[];
}

interface AttentionList {
  items: AttentionItem[];
  total: number;
  /** The check stopped at its technical bound before every candidate was examined. */
  truncated: boolean;
}

/** What each attention issue (modules/confirmation/service.ts attentionList) means; any other code is shown as sent. */
const ISSUE_TEXT: Record<string, string> = {
  POLICY_NOT_FOUND: 'No confirmation policy applies on the employee’s start date, so no case can be opened.',
  POLICY_AMBIGUOUS: 'More than one confirmation policy applies equally on the employee’s start date; none is picked automatically, so no case can be opened.',
  CASE_NOT_OPENED: 'A confirmation policy applies, but no case has been opened yet. Open one under “Open a confirmation case”.',
  MANAGER_MISSING: 'The case has no current direct manager to make the recommendation.',
  REVIEWER_MISSING: 'No eligible HR reviewer is available on the confirmation review route, so the manager’s recommendation would be refused.',
};

const KIND_LABEL: Record<string, string> = { DUE_DATE_OVERRIDE: 'Due date override', EXTRA_EXTENSION: 'Extra extension' };

const OUTCOME_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  EXTENDED: 'Probation extended',
  RETURNED: 'Recommendation returned',
  REJECTED_RECOMMENDATION: 'Recommendation rejected',
};

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches and
 * sign-ins, and an answer given to one assignment (a scoped list, a case with its confidential reasons) must never be
 * shown under another, not even from the cache while the new answer loads.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(
    () => ({
      allCases: ['confirmation-cases', context] as const,
      cases: (view: TabView) => ['confirmation-cases', context, view] as const,
      case: (id: string) => ['confirmation-case', context, id] as const,
      exceptions: (caseId: string) => ['confirmation-exceptions', context, caseId] as const,
      pendingExceptions: ['confirmation-exceptions-pending', context] as const,
      employees: (term: string, probationOnly: boolean) => ['confirmation-employee-search', context, term, probationOnly] as const,
      attention: ['confirmation-attention', context] as const,
      policies: ['confirmation-policies', context] as const,
    }),
    [context],
  );
}

const SCROLL: CSSProperties = { overflowX: 'auto' };
const PANEL: CSSProperties = { marginTop: '0.75rem' };
const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const ISSUES: CSSProperties = { margin: 0, paddingLeft: '1.1rem' };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const pad = (n: number) => String(n).padStart(2, '0');

function asTabView(value: string | null): TabView {
  const upper = value?.toUpperCase();
  return TABS.find((t) => t.view === upper)?.view ?? 'ALL';
}

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const outcomeLabel = (code: string) => OUTCOME_LABEL[code] ?? readable(code);
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? readable(kind);

/** The signed-in user's id: GET /v1/me/context returns it with the role context, which the session keeps as `me`. */
function useUserId(): string | null {
  const { me } = useSession();
  return me && 'userId' in me && typeof me.userId === 'string' ? me.userId : null;
}

type ExceptionAction = 'propose' | 'decide' | 'withdraw';

/**
 * The API's refusals of an exception action (modules/confirmation/exceptions.ts) in plain words; null for anything
 * else, which is shown as the API sent it. `sent` is what a refused proposal asked for.
 */
function refusalText(error: unknown, action: ExceptionAction, sent?: { kind?: string | undefined; startDate?: string | undefined }): string | null {
  // No answer (the connection dropped, or the answer could not be read): a decision is sent again under its key.
  if (!(error instanceof ApiError)) return action === 'decide' ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.' : null;
  const propose = action === 'propose';
  switch (error.code) {
    case 'CASE_NOT_OPEN':
      // Not open: under review, or closed (a waiting proposal outlives a case that has been confirmed meanwhile).
      return `The due date can change only while the case is open, and it is not open now: a recommendation is under review, or the case has closed. ${
        propose ? 'Propose the new date once the case is open again.' : 'Approve this once the case is open again, or reject it.'
      }`;
    case 'CASE_CLOSED':
      return propose ? 'This confirmation is closed, so no exception can be proposed for it.' : 'This confirmation is closed, so the exception can no longer apply. Reject it to close the proposal.';
    case 'LIMIT_NOT_REACHED':
      return 'This case can still be extended within its policy limit, so an extra extension is not needed yet.';
    case 'OPEN_PROPOSAL_EXISTS':
      return 'An exception of this kind is already waiting for a decision on this case. It has to be decided or withdrawn before another one can be proposed.';
    case 'NO_CHANGE':
      return 'That date is already the case’s due date. Choose a different date.';
    case 'RULE_VIOLATION':
      // The rule the API names for a proposed due date; any other rule keeps the API's own words.
      return propose && sent?.kind === 'DUE_DATE_OVERRIDE'
        ? `The new due date cannot be before the employee’s start date${sent.startDate ? ` (${formatDate(sent.startDate)})` : ''}.`
        : null;
    case 'INVALID_DATE':
      return 'Enter a valid new due date.';
    case 'SELF_ACTION':
      return propose ? 'You cannot propose an exception for your own confirmation.' : 'You cannot decide an exception for your own confirmation.';
    case 'INDEPENDENT_APPROVER_REQUIRED':
      return 'You proposed this exception, so another eligible HR user has to decide it.';
    case 'INVALID_STATE':
      return action === 'withdraw' ? 'This proposal has already been decided or withdrawn, so it can no longer be withdrawn.' : 'This proposal has already been decided or withdrawn.';
    case 'NOT_FOUND':
      return propose ? null : action === 'withdraw' ? 'Only the HR user who proposed it can withdraw this proposal.' : 'This proposal is no longer available in the selected role’s scope.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    default:
      return null;
  }
}

/** A failed exception action: the API's refusals in plain words, anything else as the API sent it. */
function Refusal({ error, action, sent }: { error: unknown; action: ExceptionAction; sent?: { kind?: string | undefined; startDate?: string | undefined } }) {
  if (!error) return null;
  const text = refusalText(error, action, sent);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/**
 * What a decision did, in the API's own terms: the state it recorded and the change it applied. A replayed answer (a
 * retry of a decision whose first answer was lost) carries no change; the case reloads to show where it stands.
 */
function decidedText(x: PendingException, result: ExceptionDecided): string {
  const subject = `the ${kindLabel(x.kind).toLowerCase()} for ${x.employeeName} (${x.employeeCode})`;
  const replay = result.replayed ? ' Your earlier attempt had already been recorded, so nothing was applied twice.' : '';
  if (result.state === 'REJECTED') return `Rejected ${subject}; the case is unchanged.${replay}`;
  if (result.state !== 'APPROVED') return `The proposal for ${x.employeeName} (${x.employeeCode}) is now ${readable(result.state).toLowerCase()}.`;
  const dueDate = result.applied?.dueDate?.to;
  if (dueDate) return `Approved ${subject}: the due date is now ${formatDate(dueDate)}.${replay}`;
  const limit = result.applied?.extensionLimit?.to;
  if (limit !== undefined) return `Approved ${subject}: the case now allows up to ${limit} extensions.${replay}`;
  return `Approved ${subject}.${replay}`;
}

/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fetchCases = (view: TabView) => api<CaseList>(`/v1/confirmations?view=${view}`);

/** Tab counts come from the All list: every case carries the view the server derived for it, and its extended flag. */
function countByView(all: CaseList): Record<TabView, number> {
  const counts: Record<TabView, number> = { UPCOMING: 0, DUE: 0, OVERDUE: 0, EXTENDED: 0, CONFIRMED: 0, ALL: all.total };
  for (const c of all.items) {
    if (COUNTED.has(c.view)) counts[c.view as CountedView] += 1;
    if (c.extended) counts.EXTENDED += 1;
  }
  return counts;
}

function employeeSearch(term: string, probationOnly: boolean): string {
  const query = new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) });
  if (probationOnly) query.set('status', 'ACTIVE_PROBATION');
  return query.toString();
}

const viewButtonId = (caseId: string) => `confirmation-view-${caseId}`;

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

/** The server-derived timing of a case that is still running; confirmed and cancelled cases say so in their state. */
function TimingBadge({ view }: { view: string }) {
  if (view === 'CONFIRMED' || view === 'CANCELLED') return null;
  return <Badge tone={view === 'OVERDUE' ? 'bad' : view === 'DUE' || view === 'NOT_ON_PROBATION' ? 'warn' : 'neutral'}>{view.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ConfirmationsPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const view = asTabView(params.get('view'));
  const caseParam = params.get('case');
  const selectedId = caseParam && UUID.test(caseParam) ? caseParam : null;
  // Focus moves to the case panel only when the user picks a case (also the one already shown), never on a deep-linked
  // page load: each pick is a new request.
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canRead = can(READ);

  const setParam = (key: 'view' | 'case', value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const selectCase = (id: string, focus: boolean) => {
    setFocusRequest((prev) => (focus ? { id, n: (prev?.n ?? 0) + 1 } : null));
    setParam('case', id);
  };
  const closeCase = () => {
    setParam('case', null);
    // Back to the case's row; when the chosen view does not list the case (a deep link, a case just opened), to the
    // page heading, so focus does not fall to the document when the panel goes away.
    const row = selectedId ? document.getElementById(viewButtonId(selectedId)) : null;
    (row ?? heading.current)?.focus();
  };

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Confirmations
      </h1>
      {canRead ? (
        <CaseRegister view={view} onView={(v) => setParam('view', v === 'ALL' ? null : v)} selectedId={selectedId} onSelect={(id) => selectCase(id, true)} />
      ) : (
        <Section title="Confirmation cases">
          <NotPermitted>The selected role cannot view confirmation cases.</NotPermitted>
        </Section>
      )}
      {canRead && selectedId && <CasePanel key={selectedId} id={selectedId} focusRequest={focusRequest?.id === selectedId ? focusRequest.n : null} onClose={closeCase} />}
      {can(APPROVE_EXCEPTION) && <PendingExceptions onOpenCase={canRead ? (id) => selectCase(id, true) : null} />}
      {can(MANAGE_POLICIES) && (
        <p className="hint">
          The duration each employee’s review takes comes from the <Link to={POLICIES_PATH}>confirmation policies</Link>.
        </p>
      )}
      {can(MANAGE) && <AttentionPanel onOpenCase={canRead ? (id) => selectCase(id, true) : null} />}
      {can(MANAGE) && (
        <OpenCasePanel
          onOpened={(id) => {
            if (canRead) selectCase(id, false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-082 views: tabs with counts, and the cases in the chosen view.
// ---------------------------------------------------------------------------------------------------------

function CaseRegister({
  view,
  onView,
  selectedId,
  onSelect,
}: {
  view: TabView;
  onView: (view: TabView) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { can } = useSession();
  const keys = useKeys();
  const baseId = useId();
  const tabRefs = useRef(new Map<TabView, HTMLButtonElement>());
  // On the All tab both share one query (and one request).
  const all = useQuery({ queryKey: keys.cases('ALL'), queryFn: () => fetchCases('ALL'), retry: retryTransient });
  const list = useQuery({ queryKey: keys.cases(view), queryFn: () => fetchCases(view), retry: retryTransient });
  const counts = all.data ? countByView(all.data) : null;
  const tab = TABS.find((t) => t.view === view) ?? TABS[TABS.length - 1]!;
  // FR-093: the export holds this view's cases, with their planned and actual dates and decisions.
  const exportView = useMutation({ mutationFn: (chosen: TabView) => api<{ id: string }>('/v1/reports', { body: { reportCode: 'CONFIRMATION_DUE', filters: { view: chosen } } }) });

  const moveTab =(event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next]!.view;
    onView(target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <Section title="Confirmation cases">
      <p className="hint">
        Upcoming, due and overdue are worked out from the company business date. A passed due date never confirms anyone on its own. Extended lists the cases still open
        or under review whose probation was extended at least once; they also appear under their date view.
      </p>
      {can(DECIDE) && (
        <p className="hint">
          Recommendations waiting for your decision are in the <Link to="/tasks">Decision inbox</Link>.
        </p>
      )}
      <div role="tablist" aria-label="Confirmation views" className="row">
        {TABS.map((t, index) => {
          const selected = t.view === view;
          const count = counts?.[t.view];
          return (
            <button
              key={t.view}
              ref={(el) => {
                if (el) tabRefs.current.set(t.view, el);
                else tabRefs.current.delete(t.view);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.view}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              className={selected ? undefined : 'secondary'}
              onClick={() => onView(t.view)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {t.label}
              {count === undefined ? '' : ` (${count})`}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${view}`} style={PANEL}>
        {list.isPending && <p className="hint">Loading cases…</p>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot view confirmation cases.</NotPermitted> : <ErrorNote error={list.error} />}
        {list.data && list.data.items.length === 0 && <Empty>{tab.empty}</Empty>}
        {list.data && list.data.items.length > 0 && <CaseTable items={list.data.items} showTiming={MIXED_TIMING.has(view)} selectedId={selectedId} onSelect={onSelect} />}
      </div>
      {can(EXPORT) && (
        <div className="row">
          <button type="button" className="secondary" disabled={exportView.isPending} onClick={() => exportView.mutate(view)}>
            Export this view
          </button>
          {exportView.isSuccess && exportView.variables === view && <p className="ok">Export requested. Download it from Reports when it is ready.</p>}
          <ErrorNote error={exportView.error} />
        </div>
      )}
    </Section>
  );
}

function CaseTable({
  items,
  showTiming,
  selectedId,
  onSelect,
}: {
  items: ConfirmationCase[];
  showTiming: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={SCROLL}>
      <table>
        <thead>
          <tr>
            <th scope="col">Employee</th>
            <th scope="col">Start</th>
            <th scope="col">Initial due</th>
            <th scope="col">Current due</th>
            <th scope="col">Extensions</th>
            <th scope="col">State</th>
            <th scope="col">Last outcome</th>
            <th scope="col">
              <span style={SR_ONLY}>Case</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const selected = c.id === selectedId;
            return (
              <tr key={c.id} aria-current={selected ? 'true' : undefined}>
                <td>
                  {c.employeeName} <span className="hint">{c.employeeCode}</span>
                </td>
                <td>{formatDate(c.startDate)}</td>
                <td>{formatDate(c.initialDueDate)}</td>
                <td>
                  {formatDate(c.dueDate)}
                  {showTiming && (
                    <>
                      {' '}
                      <TimingBadge view={c.view} />
                    </>
                  )}
                </td>
                <td>{c.extensionCount}</td>
                <td>
                  <StateBadge state={c.state} />
                </td>
                <td>{c.lastOutcome ? outcomeLabel(c.lastOutcome) : '—'}</td>
                <td>
                  <button type="button" className="link" id={viewButtonId(c.id)} aria-label={`View case of ${c.employeeName} (${c.employeeCode})`} onClick={() => onSelect(c.id)}>
                    View case
                  </button>
                  {selected && <span className="hint"> · shown below</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One case: dates, state, decision history (CI17) and the direct manager's recommendation (FR-081, DF11).
// ---------------------------------------------------------------------------------------------------------

/** `focusRequest`: a new number each time the user picks this case, which moves focus to the panel; null otherwise. */
function CasePanel({ id, focusRequest, onClose }: { id: string; focusRequest: number | null; onClose: () => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const detail = useQuery({ queryKey: keys.case(id), queryFn: () => api<CaseDetail>(`/v1/confirmations/${encodeURIComponent(id)}`), retry: retryTransient });
  /** The case version a recommendation was sent against; the form stays hidden until the case has moved on. */
  const [sentVersion, setSentVersion] = useState<number | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.case(id) });
    void qc.invalidateQueries({ queryKey: keys.allCases });
  };
  const recommend = useMutation({
    mutationFn: (body: RecommendationBody) => api<{ caseId: string; taskId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(id)}/recommendation`, { body }),
    onSuccess: (_result, body) => {
      setSentVersion(body.expectedVersion);
      refresh();
      // The form and its focused button go away; keep a keyboard user in the case panel, unless they moved on.
      const active = document.activeElement;
      if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
    },
    // A stale version or a case that moved on: reload it so a retry uses the current version and state.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) refresh();
    },
  });

  useEffect(() => {
    if (focusRequest !== null) region.current?.focus();
  }, [focusRequest]);

  const c = detail.data;
  const title = c ? `Confirmation case: ${c.employeeName} (${c.employeeCode})` : 'Confirmation case';
  const withReasons = c?.actions.some((a) => typeof a.reason === 'string') ?? false;
  const awaitingReload = c !== undefined && sentVersion !== null && c.version === sentVersion;
  const showForm = c?.state === 'OPEN' && c.view !== 'NOT_ON_PROBATION' && can(RECOMMEND) && !awaitingReload;
  // Only while it is still true: once a reviewer has decided, the case shows its new state instead.
  const justSent = sentVersion !== null && (awaitingReload || c?.state === 'REVIEW_PENDING');
  // A background reload (after a conflict, for instance) is about to replace the version the form would send.
  const reloading = detail.isFetching && !detail.isPending;
  const conflict = recommend.error instanceof ApiError && recommend.error.status === 409;

  return (
    <div ref={region} role="region" aria-label={title} tabIndex={-1}>
      <Section
        title={title}
        actions={
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        }
      >
        {detail.isPending && <p className="hint">Loading the case…</p>}
        {isForbidden(detail.error) ? (
          <NotPermitted>The selected role cannot open this confirmation case.</NotPermitted>
        ) : isNotFound(detail.error) ? (
          <Empty>This case is not available in the selected role’s scope.</Empty>
        ) : (
          <ErrorNote error={detail.error} />
        )}
        {c && (
          <div className="stack">
            <dl className="kv">
              <Item term="Start date">{formatDate(c.startDate)}</Item>
              <Item term="Initial due date">{formatDate(c.initialDueDate)}</Item>
              <Item term="Current due date">
                {formatDate(c.dueDate)} <TimingBadge view={c.view} />
              </Item>
              <Item term="Extensions">{c.extensionCount}</Item>
              <Item term="State">
                <StateBadge state={c.state} />
              </Item>
              <Item term="Last outcome">{c.lastOutcome ? outcomeLabel(c.lastOutcome) : 'No decision yet'}</Item>
              <Item term="Actual confirmation date">{c.actualConfirmationDate ? formatDate(c.actualConfirmationDate) : 'Not confirmed'}</Item>
              {c.state === 'CANCELLED' && c.cancelledAt && <Item term="Cancelled on">{formatDate(c.cancelledAt)}</Item>}
              {c.state === 'CANCELLED' && typeof c.cancelReason === 'string' && <Item term="Reason for cancelling">{c.cancelReason}</Item>}
            </dl>
            {c.view === 'NOT_ON_PROBATION' && (
              <p role="note">
                <Badge tone="warn">not on probation</Badge> This employee is no longer on probation, so the review cannot be recommended or decided, and no reminders are sent.
                {can(MANAGE) && ' Cancel it below to close it.'}
              </p>
            )}
            {c.state === 'REVIEW_PENDING' && c.view !== 'NOT_ON_PROBATION' && (
              <p>
                A recommendation is waiting for an HR decision.
                {can(DECIDE) && (
                  <>
                    {' '}
                    Reviewers decide it in the <Link to="/tasks">Decision inbox</Link>.
                  </>
                )}
              </p>
            )}
            {c.state === 'OPEN' && !can(RECOMMEND) && c.view !== 'NOT_ON_PROBATION' && <p className="hint">Waiting for a recommendation from the employee’s direct manager.</p>}

            <h3 style={H3}>History</h3>
            {c.historyIncluded === false ? (
              <p className="hint">Earlier decisions are not shown: the selected role has no confirmation history grant.</p>
            ) : c.actions.length === 0 ? (
              <Empty>No decisions recorded yet.</Empty>
            ) : (
              <HistoryTable actions={c.actions} withReasons={withReasons} />
            )}

            {justSent && (
              <p className="ok" role="status">
                Recommendation sent for HR review.
              </p>
            )}
            {showForm && <RecommendationForm version={c.version} busy={recommend.isPending || reloading} onSubmit={(body) => recommend.mutate(body)} />}
            <ErrorNote error={recommend.error} />
            {conflict && showForm && (
              <p className="hint" role="status">
                {reloading ? 'Reloading the case…' : 'The case has been reloaded with its latest details; check them and send again.'}
              </p>
            )}

            <CaseExceptions kase={c} onCaseChanged={refresh} />
            {can(MANAGE) && (c.state === 'OPEN' || c.state === 'REVIEW_PENDING') && <CancelCaseForm kase={c} reloading={reloading} onChanged={refresh} />}
          </div>
        )}
      </Section>
    </div>
  );
}

/** FR-082, DF11: HR closes a live review with a reason; its pending decision task closes with it. */
function CancelCaseForm({ kase, reloading, onChanged }: { kase: CaseDetail; reloading: boolean; onChanged: () => void }) {
  const { me } = useSession();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { expectedVersion: number; reason: string }) => api<{ caseId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/cancel`, { body }),
    onSuccess: onChanged,
    // A stale version or a case that closed meanwhile: reload it so the panel shows where it stands.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onChanged();
    },
  });
  if (me?.employeeId && me.employeeId === kase.employeeId) return <p className="hint">You cannot cancel your own confirmation review.</p>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    setProblem(text ? null : 'Enter why the review is cancelled.');
    if (text && !reloading) cancel.mutate({ expectedVersion: kase.version, reason: text });
  };
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Cancel this review
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">
          The reason is confidential. Any decision waiting in the Decision inbox closes with the review and no more reminders are sent; the case and its history are kept. The employee’s status does not change.
        </p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" className="secondary" disabled={cancel.isPending || reloading}>
            Cancel review
          </button>
        </div>
      </form>
      <PlainRefusal error={cancel.error} />
    </>
  );
}

/** A refusal in the API's own plain words; anything else (a failure, a lost answer) as usual. */
function PlainRefusal({ error }: { error: unknown }) {
  if (!error) return null;
  if (!(error instanceof ApiError) || error.status >= 500) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {error.message}
    </p>
  );
}

function HistoryTable({ actions, withReasons }: { actions: CaseAction[]; withReasons: boolean }) {
  return (
    <div style={SCROLL}>
      <table>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Prior due date</th>
            <th scope="col">New due date</th>
            <th scope="col">Actual confirmation date</th>
            <th scope="col">Occurred at</th>
            {withReasons && <th scope="col">Reason</th>}
          </tr>
        </thead>
        <tbody>
          {actions.map((a, index) => (
            <tr key={`${a.occurredAt}-${index}`}>
              <td>{outcomeLabel(a.action)}</td>
              <td>{formatDate(a.priorDueDate)}</td>
              <td>{formatDate(a.newDueDate)}</td>
              <td>{formatDate(a.actualConfirmationDate)}</td>
              <td>
                <time dateTime={a.occurredAt}>{localDateTime(a.occurredAt)}</time>
              </td>
              {withReasons && <td>{a.reason}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `busy`: sending, or the case is reloading (its version is about to change), so nothing is sent meanwhile. */
function RecommendationForm({ version, busy, onSubmit }: { version: number; busy: boolean; onSubmit: (body: RecommendationBody) => void }) {
  const id = useId();
  const [kind, setKind] = useState<'' | 'CONFIRM' | 'EXTEND'>('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [months, setMonths] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  // Required-field checks only; every business rule (manager, state, version, extension limit) is the server's.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing =
      kind === ''
        ? 'Choose whether to recommend confirmation or an extension.'
        : kind === 'CONFIRM' && !effectiveDate
          ? 'Enter the effective date of the confirmation.'
          : kind === 'EXTEND' && !months
            ? 'Choose how many months to extend the probation by.'
            : !text
              ? 'Enter a reason.'
              : null;
    setProblem(missing);
    // The disabled button already blocks sending while busy; this guard keeps a version that is being replaced unsent.
    if (missing !== null || kind === '' || busy) return;
    onSubmit(
      kind === 'CONFIRM'
        ? { expectedVersion: version, recommendation: 'CONFIRM', effectiveDate, reason: text }
        : { expectedVersion: version, recommendation: 'EXTEND', extensionMonths: Number(months), reason: text },
    );
  };

  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Your recommendation
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <fieldset className="wide" style={GROUP}>
          <legend>Recommendation</legend>
          <div className="row">
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="CONFIRM" required checked={kind === 'CONFIRM'} onChange={() => setKind('CONFIRM')} /> Confirm
            </label>
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="EXTEND" required checked={kind === 'EXTEND'} onChange={() => setKind('EXTEND')} /> Extend probation
            </label>
          </div>
        </fieldset>
        {kind === 'CONFIRM' && (
          <label>
            Effective date
            <input type="date" required value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
        )}
        {kind === 'EXTEND' && (
          <label>
            Extend by (months)
            <select required value={months} onChange={(e) => setMonths(e.target.value)}>
              <option value="">Choose…</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">The reason is confidential. An HR reviewer decides the recommendation; the employee record changes only if it is approved.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        <div className="wide row">
          <button type="submit" disabled={busy}>
            Send recommendation
          </button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// DF11 exceptions of one case (I-19): their history, the proposer's withdrawal, and a new proposal.
// ---------------------------------------------------------------------------------------------------------

function CaseExceptions({ kase, onCaseChanged }: { kase: CaseDetail; onCaseChanged: () => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const userId = useUserId();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const tableBox = useRef<HTMLDivElement>(null);
  const canPropose = can(PROPOSE_EXCEPTION);
  const list = useQuery({
    queryKey: keys.exceptions(kase.id),
    queryFn: () => api<{ items: CaseException[] }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`),
    retry: retryTransient,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.exceptions(kase.id) });
    void qc.invalidateQueries({ queryKey: keys.pendingExceptions });
  };
  const withdraw = useMutation({
    mutationFn: (x: CaseException) => api<{ exceptionId: string; state: string }>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/withdraw`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      // The row's button goes away; keep a keyboard user in the case panel, unless they moved on.
      const active = document.activeElement;
      if (!active || active === document.body || tableBox.current?.contains(active)) heading.current?.focus();
    },
    // Decided or withdrawn meanwhile: reload, so the row shows where it stands now.
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) refresh();
    },
  });

  const items = list.data?.items ?? [];
  const mayWithdraw = (x: CaseException) => canPropose && userId !== null && x.state === 'PROPOSED' && x.proposedBy === userId;
  // Sending, and until the list shows the withdrawal, so it cannot be sent twice.
  const withdrawing = withdraw.isPending || (withdraw.isSuccess && list.isFetching);
  // DF11: an exception can be proposed while the case is open or under review, never once it is closed.
  const canStillChange = kase.state === 'OPEN' || kase.state === 'REVIEW_PENDING';
  const ownCase = !!me?.employeeId && me.employeeId === kase.employeeId;

  return (
    <>
      <h3 id={headingId} ref={heading} tabIndex={-1} style={H3}>
        Exceptions
      </h3>
      <p className="hint">An approved due date override replaces the case’s due date; an approved extra extension allows one extension beyond the policy limit.</p>
      {list.isPending && <p className="hint">Loading exceptions…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view this case’s exceptions.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No exceptions have been proposed for this case.</Empty>}
      {items.length > 0 && (
        <div ref={tableBox}>
          <ExceptionTable items={items} labelledBy={headingId} mayWithdraw={mayWithdraw} busy={withdrawing} onWithdraw={(x) => withdraw.mutate(x)} />
        </div>
      )}
      {withdraw.isSuccess && (
        <p className="ok" role="status">
          Proposal withdrawn.
        </p>
      )}
      <Refusal error={withdraw.error} action="withdraw" />
      {can(APPROVE_EXCEPTION) && items.some((x) => x.state === 'PROPOSED') && <p className="hint">Waiting proposals are decided under Pending exceptions on this page.</p>}
      {canPropose &&
        canStillChange &&
        (ownCase ? (
          <p className="hint">You cannot propose an exception for your own confirmation.</p>
        ) : (
          <ProposeExceptionForm
            kase={kase}
            onProposed={refresh}
            onConflict={() => {
              onCaseChanged();
              refresh();
            }}
          />
        ))}
    </>
  );
}

function ExceptionTable({
  items,
  labelledBy,
  mayWithdraw,
  busy,
  onWithdraw,
}: {
  items: CaseException[];
  labelledBy: string;
  mayWithdraw: (x: CaseException) => boolean;
  busy: boolean;
  onWithdraw: (x: CaseException) => void;
}) {
  // The private reasons arrive for every row or for none (the confirmation reason group).
  const withReasons = items.some((x) => typeof x.reason === 'string');
  const withAction = items.some(mayWithdraw);
  return (
    <div style={SCROLL}>
      <table aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">Exception</th>
            <th scope="col">Proposed due date</th>
            <th scope="col">State</th>
            <th scope="col">Proposed at</th>
            <th scope="col">Decided at</th>
            {withReasons && <th scope="col">Reason</th>}
            {withReasons && <th scope="col">Decision reason</th>}
            {withAction && (
              <th scope="col">
                <span style={SR_ONLY}>Action</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id}>
              <td>{kindLabel(x.kind)}</td>
              <td>{formatDate(x.proposedDueDate)}</td>
              <td>
                <StateBadge state={x.state} />
              </td>
              <td>
                <time dateTime={x.proposedAt}>{localDateTime(x.proposedAt)}</time>
              </td>
              <td>{x.decidedAt ? <time dateTime={x.decidedAt}>{localDateTime(x.decidedAt)}</time> : '—'}</td>
              {withReasons && <td>{x.reason}</td>}
              {withReasons && <td>{x.decisionReason ?? '—'}</td>}
              {withAction && (
                <td>
                  {mayWithdraw(x) && (
                    <button type="button" className="link" disabled={busy} aria-label={`Withdraw your ${kindLabel(x.kind).toLowerCase()} proposal`} onClick={() => onWithdraw(x)}>
                      Withdraw
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A new exception with its private reason; another HR user decides it. Required-field checks only: whether the case
 * allows it (state, extension limit, an open proposal of the kind, the employee's start date) is the server's call.
 */
function ProposeExceptionForm({ kase, onProposed, onConflict }: { kase: CaseDetail; onProposed: () => void; onConflict: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<'' | ExceptionKind>('');
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // DF11: the due date changes only while the case is open; a recommendation under review keeps the date it was made
  // for. A choice made before the case moved on no longer applies (what was typed is kept).
  const overrideOpen = kase.state === 'OPEN';
  const chosen = kind === 'DUE_DATE_OVERRIDE' && !overrideOpen ? '' : kind;
  const propose = useMutation({
    mutationFn: (body: ExceptionBody) => api<{ exceptionId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`, { body }),
    // A proposal sent starts the form clean; a refused one keeps what was typed.
    onSuccess: () => {
      setKind('');
      setDueDate('');
      setReason('');
      onProposed();
    },
    // The case moved on (a recommendation arrived, it closed, a proposal of this kind appeared): show it as it is now.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing =
      chosen === '' ? 'Choose the kind of exception.' : chosen === 'DUE_DATE_OVERRIDE' && !dueDate ? 'Enter the new due date.' : !text ? 'Enter a reason.' : null;
    setProblem(missing);
    if (missing !== null) {
      propose.reset();
      return;
    }
    if (chosen === '' || propose.isPending) return;
    propose.mutate(chosen === 'DUE_DATE_OVERRIDE' ? { kind: chosen, proposedDueDate: dueDate, reason: text } : { kind: chosen, reason: text });
  };

  const overrideHint = `${id}-override`;
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Propose an exception
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <fieldset className="wide" style={GROUP}>
          <legend>Exception</legend>
          <div className="row">
            <label className="check">
              <input
                type="radio"
                name={`${id}-kind`}
                value="DUE_DATE_OVERRIDE"
                required
                disabled={!overrideOpen}
                aria-describedby={overrideOpen ? undefined : overrideHint}
                checked={chosen === 'DUE_DATE_OVERRIDE'}
                onChange={() => setKind('DUE_DATE_OVERRIDE')}
              />{' '}
              Due date override
            </label>
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="EXTRA_EXTENSION" required checked={chosen === 'EXTRA_EXTENSION'} onChange={() => setKind('EXTRA_EXTENSION')} />{' '}
              Extra extension
            </label>
          </div>
          {!overrideOpen && (
            <p className="hint" id={overrideHint}>
              The due date cannot change while a recommendation is under review.
            </p>
          )}
        </fieldset>
        {chosen === 'DUE_DATE_OVERRIDE' && (
          <label>
            New due date
            <input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        )}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">The reason is confidential. Another HR user decides the exception; the case changes only if it is approved.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        {propose.error && (
          <div className="wide">
            <Refusal error={propose.error} action="propose" sent={{ kind: propose.variables?.kind, startDate: kase.startDate }} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Propose exception
          </button>
        </div>
        {propose.isSuccess && (
          <p className="ok wide" role="status">
            Exception proposed. Another HR user decides it; the case changes only if it is approved.
          </p>
        )}
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// DF11/C4: exception proposals waiting for a decision in the selected role's scope, oldest first. Each decision needs
// a reason and carries an idempotency key; a proposal is never decided by its proposer or by the employee concerned.
// ---------------------------------------------------------------------------------------------------------

function PendingExceptions({ onOpenCase }: { onOpenCase: ((caseId: string) => void) | null }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: keys.pendingExceptions,
    queryFn: () => api<{ items: PendingException[] }>('/v1/confirmation-exceptions/pending'),
    retry: retryTransient,
  });
  /** Proposals seen decided or withdrawn here: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = (list.data?.items ?? []).filter((x) => !gone.has(x.id));

  const refreshCase = (x: PendingException) => {
    void qc.invalidateQueries({ queryKey: keys.case(x.confirmationId) });
    void qc.invalidateQueries({ queryKey: keys.allCases });
  };
  const finished = (x: PendingException, text: string, ok: boolean, caseChanged: boolean) => {
    setGone((prev) => new Set(prev).add(x.id));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.pendingExceptions });
    void qc.invalidateQueries({ queryKey: keys.exceptions(x.confirmationId) });
    // An approved override is the case's new due date (and may change its view).
    if (caseChanged) refreshCase(x);
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };

  return (
    <div ref={region} role="region" aria-label="Pending exceptions" tabIndex={-1}>
      <Section title="Pending exceptions">
        <p className="hint">Due date overrides and extra extensions proposed by HR wait here for a decision by another HR user. Each decision needs a reason.</p>
        {list.isPending && <p className="hint">Loading the waiting proposals…</p>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot decide confirmation exceptions.</NotPermitted> : <ErrorNote error={list.error} />}
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {list.data && items.length === 0 && <Empty>No exceptions are waiting for a decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Exceptions waiting for a decision">
            {items.map((x) => (
              <PendingItem
                key={x.id}
                item={x}
                ownCase={!!me?.employeeId && me.employeeId === x.employeeId}
                canWithdraw={can(PROPOSE_EXCEPTION)}
                onOpenCase={onOpenCase}
                onFinished={finished}
                onCaseConflict={refreshCase}
              />
            ))}
          </ul>
        )}
        {list.data && list.data.items.length >= PENDING_LIMIT && <p className="hint">Showing the oldest {PENDING_LIMIT} waiting proposals; newer ones appear as these are decided.</p>}
      </Section>
    </div>
  );
}

function PendingItem({
  item: x,
  ownCase,
  canWithdraw,
  onOpenCase,
  onFinished,
  onCaseConflict,
}: {
  item: PendingException;
  /** The exception concerns the signed-in user's own confirmation. */
  ownCase: boolean;
  /** Withdrawing needs the propose permission. */
  canWithdraw: boolean;
  onOpenCase: ((caseId: string) => void) | null;
  /** Decided or withdrawn (`ok`), or found final already: the item leaves the queue with `text`. */
  onFinished: (x: PendingException, text: string, ok: boolean, caseChanged: boolean) => void;
  onCaseConflict: (x: PendingException) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = `${x.employeeName} (${x.employeeCode})`;
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers
   * from what it recorded instead of refusing it as decided already, and never applies it twice. Any other decision is
   * a new user action with a new key.
   */
  const attempt = useRef<{ decision: ExceptionDecision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: DecisionBody) => api<ExceptionDecided>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      onFinished(x, decidedText(x, result), true, result.state === 'APPROVED');
    },
    onError: (error) => {
      // The server refused the key as another decision's and recorded nothing: the next attempt gets a new key.
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided or withdrawn by someone else, or out of the role's scope now: nothing left to decide here.
      else if (error instanceof ApiError && (error.code === 'INVALID_STATE' || error.status === 404)) onFinished(x, refusalText(error, 'decide') ?? error.message, false, true);
      // The case moved on (a recommendation under review, or closed): show it as it is now.
      else if (error instanceof ApiError && error.status === 409) onCaseConflict(x);
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api<{ exceptionId: string; state: string }>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/withdraw`, { method: 'POST' }),
    onSuccess: () => onFinished(x, `Withdrew your ${kindLabel(x.kind).toLowerCase()} proposal for ${who}.`, true, false),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'INVALID_STATE') onFinished(x, refusalText(error, 'withdraw') ?? error.message, false, true);
    },
  });
  const busy = decide.isPending || withdraw.isPending;
  // C4: never by the proposer, never by the employee concerned (the server refuses both as well).
  const blocked = x.ownProposal
    ? 'You proposed this exception, so another HR user has to decide it.'
    : ownCase
      ? 'This exception is for your own confirmation, so another HR user has to decide it.'
      : null;

  const send = (decision: ExceptionDecision) => {
    if (blocked !== null || busy) return;
    const text = reason.trim();
    if (!text) {
      setProblem('Enter a reason for your decision.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('conf-exception');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, reason: text, idempotencyKey: key });
  };

  const titleId = `${id}-title`;
  const blockedId = `${id}-blocked`;
  const describedBy = blocked === null ? titleId : `${titleId} ${blockedId}`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {kindLabel(x.kind)}: {who}
      </h3>
      <dl className="kv">
        {x.kind === 'DUE_DATE_OVERRIDE' ? <Item term="Proposed due date">{formatDate(x.proposedDueDate)}</Item> : <Item term="Effect">One extension beyond the policy limit</Item>}
        <Item term="Proposed at">
          <time dateTime={x.proposedAt}>{localDateTime(x.proposedAt)}</time>
        </Item>
        {typeof x.reason === 'string' && <Item term="Reason">{x.reason}</Item>}
      </dl>
      {onOpenCase && (
        <div>
          <button type="button" className="link" onClick={() => onOpenCase(x.confirmationId)}>
            Open the case of {who}
          </button>
        </div>
      )}
      {blocked === null ? (
        <label>
          Decision reason (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
      ) : (
        <p className="hint" id={blockedId}>
          {blocked}
        </p>
      )}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={blocked !== null || busy} aria-describedby={describedBy} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="danger" disabled={blocked !== null || busy} aria-describedby={describedBy} onClick={() => send('REJECT')}>
          Reject
        </button>
        {x.ownProposal && canWithdraw && (
          <button type="button" className="secondary" disabled={busy} onClick={() => withdraw.mutate()}>
            Withdraw proposal
          </button>
        )}
      </div>
      <Refusal error={decide.error} action="decide" />
      <Refusal error={withdraw.error} action="withdraw" />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-080: open a case for an employee on probation (the server sets the planned due date from the policy).
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// FR-082 / DF11 attention list (I-36): missing policy, manager or reviewer, reported for HR review, never resolved here.
// ---------------------------------------------------------------------------------------------------------

/** `onOpenCase` is null when the selected role cannot read cases (no link to a case it could not open). */
function AttentionPanel({ onOpenCase }: { onOpenCase: ((caseId: string) => void) | null }) {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.attention, queryFn: () => api<AttentionList>('/v1/confirmations/attention'), retry: retryTransient });
  const items = list.data?.items ?? [];
  return (
    <Section title="Needs HR attention">
      <p className="hint">
        Employees on probation in the selected role’s scope whose confirmation cannot move: no case because no policy or more than one applies, or none was opened yet; or an
        open case without a direct manager or an eligible HR reviewer. Nothing is opened, assigned or changed here.
      </p>
      {list.isPending && <p className="hint">Checking…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot see the attention list.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No employee on probation in the selected role’s scope needs attention.</Empty>}
      {items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Needs HR attention">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Joined</th>
                <th scope="col">Case</th>
                <th scope="col">What needs attention</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.employeeId}>
                  <td>
                    {item.employeeName} <span className="hint">{item.employeeCode}</span>
                  </td>
                  <td>{formatDate(item.joiningDate)}</td>
                  <td>
                    {item.caseId ? (
                      <>
                        <StateBadge state={item.state} />
                        {onOpenCase && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link"
                              aria-label={`View case of ${item.employeeName} (${item.employeeCode}) from the attention list`}
                              onClick={() => onOpenCase(item.caseId!)}
                            >
                              View case
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      'No case'
                    )}
                  </td>
                  <td>
                    <ul style={ISSUES}>
                      {item.issues.map((issue) => (
                        <li key={issue}>
                          {ISSUE_TEXT[issue] ?? readable(issue)} <span className="hint">{issue}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.truncated && (
        <p className="hint" role="note">
          The check stopped before every employee on probation was examined, so more may need attention than are listed here.
        </p>
      )}
    </Section>
  );
}

function OpenCasePanel({ onOpened }: { onOpened: (caseId: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canSearch = can(LIST_EMPLOYEES);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [probationOnly, setProbationOnly] = useState(true);
  const [opened, setOpened] = useState<{ label: string; dueDate: string } | null>(null);
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const hits = useQuery({
    queryKey: keys.employees(term, probationOnly),
    enabled: canSearch && term !== '',
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${employeeSearch(term, probationOnly)}`),
    retry: retryTransient,
  });
  const open = useMutation({
    mutationFn: (employee: EmployeeHit) => api<{ caseId: string; dueDate: string }>('/v1/confirmations', { body: { employeeId: employee.id } }),
    onMutate: () => setOpened(null),
    onSuccess: (result, employee) => {
      setOpened({ label: `${employee.displayName} (${employee.employeeCode})`, dueDate: result.dueDate });
      setOpenedIds((prev) => new Set(prev).add(employee.id));
      void qc.invalidateQueries({ queryKey: keys.allCases });
      void qc.invalidateQueries({ queryKey: keys.attention });
      onOpened(result.caseId);
    },
  });
  const duplicate = open.error instanceof ApiError && open.error.code === 'DUPLICATE';

  return (
    <Section title="Open a confirmation case">
      <p className="hint">The planned due date comes from the confirmation policy that applies on the employee’s start date.</p>
      {canSearch ? (
        <>
          <div className="row">
            <label className="inline">
              Find employee{' '}
              <input type="search" value={search} maxLength={100} placeholder="Name, code or work email" onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="inline check">
              <input type="checkbox" checked={probationOnly} onChange={(e) => setProbationOnly(e.target.checked)} /> Only employees on probation
            </label>
          </div>
          {term === '' && <p className="hint">Type a name, employee code or work email to find the employee.</p>}
          {term !== '' && hits.isPending && <p className="hint">Searching…</p>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {hits.data && hits.data.items.length === 0 && <Empty>{probationOnly ? `No employees on probation match “${term}”.` : `No employees match “${term}”.`}</Empty>}
          {hits.data && hits.data.items.length > 0 && (
            <div style={SCROLL}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span style={SR_ONLY}>Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hits.data.items.map((e) => (
                    <tr key={e.id}>
                      <td>{e.employeeCode}</td>
                      <td>{e.displayName}</td>
                      <td>
                        <StateBadge state={e.status} />
                      </td>
                      <td>
                        {openedIds.has(e.id) ? (
                          <span className="ok">Case opened</span>
                        ) : (
                          <button type="button" disabled={open.isPending} aria-label={`Open case for ${e.displayName} (${e.employeeCode})`} onClick={() => open.mutate(e)}>
                            Open case
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hits.data.total > hits.data.items.length && (
                <p className="hint">
                  Showing the first {hits.data.items.length} of {hits.data.total}; refine the search to narrow it down.
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <NotPermitted>The selected role cannot search employees, so it cannot open a case from here.</NotPermitted>
      )}
      {opened && (
        <p className="ok" role="status">
          Case opened for {opened.label}; planned due date {formatDate(opened.dueDate)}.
        </p>
      )}
      <ErrorNote error={open.error} />
      {duplicate && <p className="hint">This employee already has an open or pending confirmation case{can(READ) ? '; find it in the list above' : ''}.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Confirmation policies (FR-080, BR-029, DF11): every dated revision, a new policy, a new revision, an end date.
// ---------------------------------------------------------------------------------------------------------

type DurationUnit = 'CALENDAR_MONTHS' | 'CALENDAR_DAYS';

/** A policy revision as GET /v1/confirmation-policies lists it, by code and revision. */
interface Policy {
  id: string;
  code: string;
  revision: number;
  duration: number;
  durationUnit: DurationUnit;
  startBasis: string;
  /** I-84 item 12: the joining day counts as day one, so the review falls due one day earlier. */
  startDayInclusive?: boolean;
  employmentType: string | null;
  gradeName: string | null;
  locationName: string | null;
  effectiveFrom: string;
  /** Exclusive: the policy no longer applies to an employee joining on this date. */
  effectiveTo: string | null;
  status: 'SCHEDULED' | 'IN_FORCE' | 'ENDED';
  latest: boolean;
  /** The latest start date of a case under this revision: a new revision or an end date must come after it. */
  latestCaseStart: string | null;
  version: number;
}

interface PolicyList {
  items: Policy[];
  /** The active values a new policy can apply to. */
  applicability: {
    employmentTypes: { code: string; label: string }[];
    grades: { id: string; code: string; name: string }[];
    locations: { id: string; code: string; name: string }[];
  };
}

const UNIT_LABEL: Record<DurationUnit, string> = { CALENDAR_MONTHS: 'calendar months', CALENDAR_DAYS: 'calendar days' };
const POLICY_STATUS_LABEL: Record<Policy['status'], string> = { SCHEDULED: 'scheduled', IN_FORCE: 'in force', ENDED: 'ended' };
const appliesTo = (p: Policy) => [p.employmentType, p.gradeName, p.locationName].filter(Boolean).join(' · ') || 'Every employee';
const policyLabel = (p: Pick<Policy, 'code' | 'revision'>) => `${p.code} revision ${p.revision}`;

type PolicyAction = { kind: 'revise' | 'retire'; id: string };

export function ConfirmationPoliciesPage() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canManage = can(MANAGE_POLICIES);
  const list = useQuery({ queryKey: keys.policies, enabled: canManage, queryFn: () => api<PolicyList>('/v1/confirmation-policies'), retry: retryTransient });
  const [action, setAction] = useState<PolicyAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policies });
    void qc.invalidateQueries({ queryKey: keys.attention });
  };
  const saved = (message: string) => {
    setAction(null);
    setDone(message);
    reload();
  };
  const selected = list.data?.items.find((p) => p.id === action?.id);

  return (
    <>
      <h1>Confirmation policies</h1>
      {!canManage ? (
        <Section title="Policies">
          <NotPermitted>The selected role cannot manage confirmation policies.</NotPermitted>
        </Section>
      ) : (
        <>
          <Section title="Policies">
            <p className="hint">
              A case takes the most specific policy that applies on the employee’s joining date and keeps it. A policy in use never changes: a change of terms is a new revision from a later date, and a policy
              is retired by ending it. Equally specific policies that could apply to the same employee on overlapping dates are refused. Due dates add the duration to the joining date; a month-end date is
              clamped to the end of the destination month.
            </p>
            {list.isPending && <p className="hint">Loading policies…</p>}
            {isForbidden(list.error) ? <NotPermitted>The selected role cannot manage confirmation policies.</NotPermitted> : <ErrorNote error={list.error} />}
            {list.data && list.data.items.length === 0 && <Empty>No confirmation policies yet.</Empty>}
            {list.data && list.data.items.length > 0 && (
              <PolicyTable
                items={list.data.items}
                onAction={(next) => {
                  setDone(null);
                  setAction(next);
                }}
              />
            )}
            {done && (
              <p className="ok" role="status">
                {done}
              </p>
            )}
          </Section>
          {action?.kind === 'revise' && selected && <RevisionForm key={selected.id} policy={selected} onSaved={saved} onConflict={reload} onClose={() => setAction(null)} />}
          {action?.kind === 'retire' && selected && <RetireForm key={selected.id} policy={selected} onSaved={saved} onConflict={reload} onClose={() => setAction(null)} />}
          {list.data && <CreatePolicyForm applicability={list.data.applicability} onSaved={saved} />}
        </>
      )}
    </>
  );
}

function PolicyTable({ items, onAction }: { items: Policy[]; onAction: (action: PolicyAction) => void }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Confirmation policies">
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Applies to</th>
            <th scope="col">Duration</th>
            <th scope="col">Counted from</th>
            <th scope="col">From</th>
            <th scope="col">Until</th>
            <th scope="col">Status</th>
            <th scope="col">Cases</th>
            <th scope="col">
              <span style={SR_ONLY}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>
                {p.code} <span className="hint">revision {p.revision}</span>
              </td>
              <td>{appliesTo(p)}</td>
              <td>
                {p.duration} {UNIT_LABEL[p.durationUnit]}
              </td>
              <td>
                {p.startBasis === 'JOINING_DATE' ? 'Joining date' : readable(p.startBasis)}
                {p.startDayInclusive ? ', counted as day one' : ''}
              </td>
              <td>{formatDate(p.effectiveFrom)}</td>
              <td>{p.effectiveTo ? formatDate(p.effectiveTo) : 'No end date'}</td>
              <td>
                <Badge tone={p.status === 'IN_FORCE' ? 'good' : 'neutral'}>{POLICY_STATUS_LABEL[p.status]}</Badge>
              </td>
              <td>{p.latestCaseStart ? `In use (latest start ${formatDate(p.latestCaseStart)})` : 'None'}</td>
              <td>
                <div className="row">
                  {p.latest && (
                    <button type="button" className="link" aria-label={`New revision of ${policyLabel(p)}`} onClick={() => onAction({ kind: 'revise', id: p.id })}>
                      New revision
                    </button>
                  )}
                  {p.status !== 'ENDED' && (
                    <button type="button" className="link" aria-label={`End ${policyLabel(p)}`} onClick={() => onAction({ kind: 'retire', id: p.id })}>
                      End policy
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TermsDraft {
  duration: string;
  unit: '' | DurationUnit;
  from: string;
  to: string;
}
const NO_TERMS: TermsDraft = { duration: '', unit: '', from: '', to: '' };

/** Required fields only; every rule on the values (positive duration, end after start, overlap, cases in use) is the server's. */
const missingTerm = (t: TermsDraft) => (!t.duration.trim() ? 'Enter the duration.' : !t.unit ? 'Choose whether the duration is in calendar months or days.' : !t.from ? 'Enter the date the policy takes effect.' : null);
const termsBody = (t: TermsDraft) => ({
  duration: Number(t.duration),
  durationUnit: t.unit,
  startBasis: 'JOINING_DATE',
  effectiveFrom: t.from,
  ...(t.to ? { effectiveTo: t.to } : {}),
});

function TermFields({ value, onChange }: { value: TermsDraft; onChange: (next: TermsDraft) => void }) {
  return (
    <>
      <label>
        Duration
        <input type="number" step="1" required value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} />
      </label>
      <label>
        Unit
        <select required value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as TermsDraft['unit'] })}>
          <option value="">Choose…</option>
          <option value="CALENDAR_MONTHS">Calendar months</option>
          <option value="CALENDAR_DAYS">Calendar days</option>
        </select>
      </label>
      <label>
        Takes effect on
        <input type="date" required value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      </label>
      <label>
        Ends on (optional)
        <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </label>
      <p className="hint wide">Counted from the employee’s joining date. An employee joining on the end date or later no longer gets this policy.</p>
    </>
  );
}

function FormProblem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}

function CreatePolicyForm({ applicability, onSaved }: { applicability: PolicyList['applicability']; onSaved: (message: string) => void }) {
  const [code, setCode] = useState('');
  const [terms, setTerms] = useState<TermsDraft>(NO_TERMS);
  const [employmentType, setEmploymentType] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: object) => api<Policy>('/v1/confirmation-policies', { body }),
    onSuccess: (policy) => {
      setCode('');
      setTerms(NO_TERMS);
      setEmploymentType('');
      setGradeId('');
      setLocationId('');
      setInclusive(false);
      onSaved(`Policy ${policy.code} created.`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = !code.trim() ? 'Enter the policy code.' : missingTerm(terms);
    setProblem(missing);
    if (missing !== null) return;
    create.mutate({
      code: code.trim(),
      ...termsBody(terms),
      ...(employmentType ? { employmentType } : {}),
      ...(gradeId ? { gradeId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(inclusive ? { startDayInclusive: true } : {}),
    });
  };
  return (
    <Section title="New policy">
      <form className="grid-form" aria-label="New policy" onSubmit={submit}>
        <label>
          Code
          <input required maxLength={40} value={code} placeholder="e.g. INTERN_SHORT" onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          Employment type
          <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
            <option value="">Any</option>
            {applicability.employmentTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Grade
          <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
            <option value="">Any</option>
            {applicability.grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Location
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Any</option>
            {applicability.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <TermFields value={terms} onChange={setTerms} />
        <label className="wide">
          <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Count the joining day as day one (the review falls due one day earlier; kept by every later
          revision)
        </label>
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Create policy
          </button>
        </div>
      </form>
      <PlainRefusal error={create.error} />
    </Section>
  );
}

function RevisionForm({ policy, onSaved, onConflict, onClose }: { policy: Policy; onSaved: (message: string) => void; onConflict: () => void; onClose: () => void }) {
  const [terms, setTerms] = useState<TermsDraft>({ ...NO_TERMS, duration: String(policy.duration), unit: policy.durationUnit });
  const [problem, setProblem] = useState<string | null>(null);
  const revise = useMutation({
    mutationFn: (body: object) => api<Policy>(`/v1/confirmation-policies/${encodeURIComponent(policy.id)}/revisions`, { body }),
    onSuccess: (next) => onSaved(`${policyLabel(next)} created; it applies from ${formatDate(next.effectiveFrom)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = missingTerm(terms);
    setProblem(missing);
    if (missing === null) revise.mutate({ ...termsBody(terms), expectedVersion: policy.version });
  };
  return (
    <Section
      title={`New revision of ${policy.code}`}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="hint">
        It applies to the same employees as revision {policy.revision} ({appliesTo(policy)}), which closes on the new date.
        {policy.latestCaseStart ? ` The date must come after ${formatDate(policy.latestCaseStart)}, the latest start of a case under it.` : ''} Cases already opened keep their policy and due date.
      </p>
      <form className="grid-form" aria-label={`New revision of ${policy.code}`} onSubmit={submit}>
        <TermFields value={terms} onChange={setTerms} />
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={revise.isPending}>
            Create revision
          </button>
        </div>
      </form>
      <PlainRefusal error={revise.error} />
    </Section>
  );
}

function RetireForm({ policy, onSaved, onConflict, onClose }: { policy: Policy; onSaved: (message: string) => void; onConflict: () => void; onClose: () => void }) {
  const [effectiveTo, setEffectiveTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (body: { effectiveTo: string; expectedVersion: number }) => api<Policy>(`/v1/confirmation-policies/${encodeURIComponent(policy.id)}/retire`, { body }),
    onSuccess: (ended) => onSaved(`${policyLabel(ended)} ends on ${formatDate(ended.effectiveTo)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = effectiveTo ? null : 'Enter the end date.';
    setProblem(missing);
    if (missing === null) retire.mutate({ effectiveTo, expectedVersion: policy.version });
  };
  return (
    <Section
      title={`End ${policyLabel(policy)}`}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="hint">
        An employee joining on this date or later no longer gets this policy; another policy applies, or HR is told that none does. Cases already opened keep it.
        {policy.latestCaseStart ? ` The date must come after ${formatDate(policy.latestCaseStart)}, the latest start of a case under it.` : ''}
      </p>
      <form className="grid-form" aria-label={`End ${policyLabel(policy)}`} onSubmit={submit}>
        <label>
          End date
          <input type="date" required value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
        </label>
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={retire.isPending}>
            End policy
          </button>
        </div>
      </form>
      <PlainRefusal error={retire.error} />
    </Section>
  );
}

export const CONFIRMATION_SCREENS: ScreenRoute[] = [{ path: POLICIES_PATH, title: 'Confirmation policies', permission: MANAGE_POLICIES, nav: true, component: ConfirmationPoliciesPage }];
