// Hiring part 1: manpower budgets and requisitions (FR-011, FR-012 approval; F1 "Hiring"; DF02; DF03; DF08; C4).
//
// Manpower budgets (FR-011): an approved headcount per department, location, designation and inclusive period. Every
// change is a revision that its preparer saves as a draft, submits or withdraws; an independent HR Administrator approves
// or rejects it in the budget queue (whoever prepared or submitted it never decides it). The latest approved revision is
// the headcount in force; a rejected revision is final and a new revision follows.
// Requisitions (FR-011, FR-012, F1): the requester's own draft with the FR-011 fields. Submission pins a revision with
// its budget check and starts the F1 route: validation by the requester's direct manager (HR fallback list when the
// manager cannot), then budget and headcount approval by an independent HR Administrator. Either step approves, returns
// for changes (back to the draft, the decision and reason kept) or rejects (final, with approver, time and reason). A
// requisition beyond its budget, or with none, needs a recorded exception reason to be submitted, and the HR approver
// approves the exception explicitly. A copy gets a new reference and inherits no approval; a draft is discarded (kept as
// closed), never deleted; HR closes an approved requisition.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words. Hiring has no My ESS tab (H3).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/hiring/registration.ts, routes.ts; migration 0034) and screen paths
// ---------------------------------------------------------------------------------------------------------
const BUDGET_READ = 'manpower_budget.read.operational';
const BUDGET_MANAGE = 'manpower_budget.manage.operational';
const BUDGET_APPROVE = 'manpower_budget.approve.operational';
const REQ_READ = 'requisition.read.operational';
const REQ_CREATE = 'requisition.create.operational';
const REQ_VALIDATE = 'requisition.validate.operational';
const REQ_APPROVE = 'requisition.approve.operational';
const REQ_CLOSE = 'requisition.close.operational';
/** GET /v1/org/:kind: the department, location and designation masters. */
const ORG_READ = 'org_master.read.operational';
/** GET /v1/employees: the hiring manager search (a manager sees their direct reports). */
const EMPLOYEE_LIST = 'employee.list.operational';

const PATHS = {
  requisitions: '/hiring/requisitions',
  newRequisition: '/hiring/requisitions/new',
  requisition: (id: string) => `/hiring/requisitions/${id}`,
  budgets: '/hiring/budgets',
  budget: (id: string) => `/hiring/budgets/${id}`,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the requisition routes accept as an employment type: the code of an active EMPLOYMENT_TYPE value. */
const EMPLOYMENT_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const WHOLE = /^\d{1,10}$/;
const MAX_INT = 2147483647;
/** GET /v1/hiring/requisitions accepts these page sizes only. */
const PAGE_SIZES = [25, 50, 100] as const;
/** The F1 requisition states the list filter accepts. */
const REQUISITION_STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CLOSED'] as const;
/** GET /v1/hiring/budgets answers with the first 500 lines at most (no paging). */
const BUDGET_LIST_LIMIT = 500;
/** The page the form reads to offer known masters when the role cannot list them (see useMasterOptions). */
const KNOWN_QUERY = 'page=1&pageSize=100';
/**
 * The EMPLOYMENT_TYPE values every company starts with (DF04). No route lists a company's active values, so these are
 * suggestions only and any code may be typed; the server refuses one that is not active.
 */
const EMPLOYMENT_TYPE_SUGGESTIONS: readonly (readonly [code: string, label: string])[] = [
  ['PERMANENT', 'Permanent'],
  ['FIXED_TERM', 'Fixed term'],
  ['INTERN', 'Intern'],
  ['CONTRACTOR', 'Contractor'],
];

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/hiring/requisition.ts, budget.ts, common.ts)
// ---------------------------------------------------------------------------------------------------------
type MasterKind = 'departments' | 'locations' | 'designations';

interface Named {
  id: string;
  name: string;
}
interface Person {
  id: string;
  employeeCode: string;
  displayName: string;
}
/** A decider or assignee: the user, with the employee identity when the user is linked to one. */
interface UserRef {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}

interface BudgetCheck {
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}

interface Requisition {
  id: string;
  code: string;
  title: string;
  state: string;
  vacancies: number;
  reasonType: string;
  reason: string;
  skills: string[];
  targetDate: string;
  department: Named;
  location: Named;
  designation: Named;
  employmentType: string;
  requester: Person;
  hiringManager: Person;
  /** The FR-011 budget reference: the budget line the last submission (or the HR approval) was checked against. */
  budgetId: string | null;
  budgetExceptionReason: string | null;
  currentRevision: number;
  copiedFromRequisitionId: string | null;
  budgetExceptionApprovedBy: string | null;
  budgetExceptionApprovedAt: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  closedAt: string | null;
  closureReason: string | null;
  /** Accepted offers. */
  filled: number;
  createdAt: string;
  version: number;
}

/** A submission, pinned with the budget check made when it was submitted. */
interface RequisitionRevision {
  revision: number;
  vacancies: number;
  targetDate: string;
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number | null;
  budgetExceptionReason: string | null;
  submittedBy: string;
  submittedAt: string;
}

interface DecisionRecord {
  revision: number;
  step: number;
  action: string;
  decision: string;
  reason: string | null;
  decidedAt: string;
  decidedBy: UserRef;
}

interface PendingWith {
  taskId: string;
  step: number;
  action: string;
  assignee: UserRef;
  assignedAt: string;
}

interface RequisitionDetail extends Requisition {
  /** The budget check now; present while the requisition is a draft or waiting for a decision. */
  budgetCheck: BudgetCheck | null;
  revisions: RequisitionRevision[];
  decisions: DecisionRecord[];
  pendingWith: PendingWith | null;
}

interface RequisitionPage {
  items: Requisition[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST and PUT /v1/hiring/requisitions (the FR-011 fields). */
interface RequisitionInput {
  title: string;
  departmentId: string;
  locationId: string;
  designationId: string;
  employmentType: string;
  vacancies: number;
  reasonType: 'NEW' | 'REPLACEMENT';
  reason: string;
  skills: string[];
  targetDate: string;
  hiringManagerId: string;
  budgetExceptionReason: string | null;
}

interface SubmitResult {
  requisitionId: string;
  state: string;
  revision: number;
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}

interface RequisitionTask {
  taskId: string;
  transactionId: string;
  step: number;
  /** validate (step 1) or approve (step 2). */
  stepAction: string;
  assignedAt: string;
  requisition: RequisitionDetail | null;
}

interface RequisitionDecisionBody {
  decision: 'APPROVE' | 'RETURN' | 'REJECT';
  reason?: string;
  approveBudgetException?: true;
  idempotencyKey: string;
}

interface RequisitionDecided {
  requisitionId: string;
  state: string;
  /** 2 when a validation passed the requisition on to the HR budget and headcount approval. */
  pendingStep?: number;
  replayed: boolean;
}

interface OpenRevision {
  revisionId: string;
  revision: number;
  state: string;
  headcount: number;
}

interface Budget {
  id: string;
  departmentId: string;
  departmentName: string;
  locationId: string;
  locationName: string;
  designationId: string;
  designationName: string;
  periodStart: string;
  periodEnd: string;
  /** The latest approved revision's headcount; null until one is approved. */
  approvedHeadcount: number | null;
  committed: number;
  openRevision: OpenRevision | null;
}

interface BudgetRevision {
  revisionId: string;
  revision: number;
  headcount: number;
  reason: string;
  state: string;
  preparedBy: string;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  version: number;
  createdAt: string;
}

interface BudgetDetail extends Budget {
  revisions: BudgetRevision[];
}

/** POST /v1/hiring/budgets and /v1/hiring/budgets/:id/revisions; PUT /v1/hiring/budget-revisions/:id. */
interface RevisionSaved {
  revisionId: string;
  budgetId?: string;
  revision?: number;
  headcount: number;
  state: string;
  version: number;
}

interface BudgetTaskRevision extends Budget {
  revisionId: string;
  revision: number;
  headcount: number;
  reason: string;
  state: string;
  preparedBy: string;
  submittedAt: string | null;
}

interface BudgetTask {
  taskId: string;
  transactionId: string;
  assignedAt: string;
  revision: BudgetTaskRevision | null;
}

interface BudgetDecided {
  revisionId: string;
  state: string;
  replayed: boolean;
}

interface MasterItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
  assignment: { departmentId: string; departmentName: string; locationId: string; locationName: string; designationId: string; designationName: string } | null;
}

interface Option {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a scoped list, a reviewer's queue) must never be shown under another.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['hiring-requisitions', context] as const;
    return {
      /** Every requisition list and detail of the context. */
      requisitions: [...base, 'requisitions'] as const,
      requisitionList: (query: string) => [...base, 'requisitions', 'list', query] as const,
      requisition: (id: string) => [...base, 'requisitions', 'detail', id] as const,
      requisitionTasks: [...base, 'requisition-tasks'] as const,
      /** Every budget list and detail of the context. */
      budgets: [...base, 'budgets'] as const,
      budgetList: (query: string) => [...base, 'budgets', 'list', query] as const,
      budget: (id: string) => [...base, 'budgets', 'detail', id] as const,
      budgetTasks: [...base, 'budget-tasks'] as const,
      masters: (kind: MasterKind) => [...base, 'org', kind] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
      teamAssignments: [...base, 'team-assignments'] as const,
    };
  }, [context]);
}

const SCROLL: CSSProperties = { overflowX: 'auto' };
const FLUSH: CSSProperties = { margin: 0 };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const SPACED: CSSProperties = { marginTop: '0.75rem' };
const GROUP: CSSProperties = { border: 'none', margin: 0, padding: 0, minWidth: 0 };
const TEXTAREA: CSSProperties = {
  font: 'inherit',
  padding: '0.4rem 0.5rem',
  border: '1px solid var(--line)',
  borderRadius: 6,
  color: 'var(--text)',
  background: 'var(--surface)',
  resize: 'vertical',
};
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

const REASON_TYPE_LABEL: Record<string, string> = { NEW: 'New position', REPLACEMENT: 'Replacement' };
const BUDGET_STATUS_LABEL: Record<string, string> = { WITHIN_BUDGET: 'Within budget', EXCEEDS_BUDGET: 'Exceeds budget', NO_BUDGET: 'No budget' };
const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected', RETURN: 'Returned for changes' };
const STEP_LABEL: Record<string, string> = { validate: 'Validation', approve: 'Budget and headcount approval' };

const stepText = (step: number, action: string) => `Step ${step}: ${STEP_LABEL[action] ?? readable(action)}`;
const budgetStatusText = (status: string) => BUDGET_STATUS_LABEL[status] ?? readable(status);
const personLabel = (p: Person) => `${p.displayName} (${p.employeeCode})`;
const lineLabel = (b: Pick<Budget, 'departmentName' | 'locationName' | 'designationName'>) => `${b.departmentName}, ${b.locationName}, ${b.designationName}`;
const periodText = (b: Pick<Budget, 'periodStart' | 'periodEnd'>) => `${formatDate(b.periodStart)} to ${formatDate(b.periodEnd)}`;

/** A decider or assignee by the identity the server returned; "You" for the signed-in user. */
function userLabel(u: UserRef, myUserId: string | null): string {
  if (myUserId !== null && u.userId === myUserId) return 'You';
  if (u.displayName) return u.employeeCode ? `${u.displayName} (${u.employeeCode})` : u.displayName;
  return 'A user without an employee record';
}

/** The same, inside a sentence. */
const userInSentence = (u: UserRef, myUserId: string | null) => (myUserId !== null && u.userId === myUserId ? 'you' : userLabel(u, null).replace(/^A user/, 'a user'));

/** Budget revisions name their preparer and decider by user id only: the signed-in user or another one. */
const byWhom = (userId: string | null, myUserId: string | null) => (userId === null ? '—' : myUserId !== null && userId === myUserId ? 'You' : 'Another user');

function parseSkills(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const wholeNumber = (text: string, min: number) => WHOLE.test(text) && Number(text) >= min && Number(text) <= MAX_INT;

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------

type Act =
  | 'create'
  | 'update'
  | 'submit'
  | 'withdraw'
  | 'discard'
  | 'copy'
  | 'close'
  | 'decide'
  | 'budget-create'
  | 'revision-create'
  | 'revision-update'
  | 'revision-submit'
  | 'revision-withdraw'
  | 'budget-decide';

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  update: 'Only a draft can be changed, and this requisition has moved on. It has been reloaded.',
  submit: 'Only a draft can be submitted, and this requisition has moved on. It has been reloaded.',
  withdraw: 'Only a requisition waiting for a decision can be withdrawn. It has been reloaded.',
  discard: 'Only a draft can be discarded; withdraw a submitted requisition first. It has been reloaded.',
  close: 'Only an approved requisition can be closed. It has been reloaded.',
  decide: 'This requisition is no longer waiting for a decision.',
  'revision-update': 'Only a draft revision can be changed. The budget line has been reloaded.',
  'revision-submit': 'Only a draft revision can be submitted. The budget line has been reloaded.',
  'revision-withdraw': 'Only a draft or submitted revision can be withdrawn. The budget line has been reloaded.',
  'budget-decide': 'This revision is no longer waiting for a decision.',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'position title',
  reason: 'reason',
  targetDate: 'target date',
  periodStart: 'period start',
  periodEnd: 'period end',
  on: 'date',
};

const MASTER_FIELD: Record<string, string> = { departmentId: 'department', locationId: 'location', designationId: 'designation' };

/** The budget figures a refusal carries (the requisition's budget check when it was refused). */
function budgetFigures(details: unknown): string {
  const d = (details ?? {}) as { budgetStatus?: unknown; approvedHeadcount?: unknown; committed?: unknown; requested?: unknown };
  if (d.budgetStatus === 'NO_BUDGET') return 'No approved manpower budget covers its department, location and designation on the target date.';
  const parts: string[] = [];
  if (typeof d.approvedHeadcount === 'number') parts.push(`approved headcount ${d.approvedHeadcount}`);
  if (typeof d.committed === 'number') parts.push(`already committed ${d.committed}`);
  if (typeof d.requested === 'number') parts.push(`requested ${d.requested}`);
  return parts.length > 0 ? `The requisition exceeds its approved budget (${parts.join(', ')}).` : 'The requisition exceeds its approved budget.';
}

const isDecision = (action: Act) => action === 'decide' || action === 'budget-decide';
const isBudget = (action: Act) => action.startsWith('budget') || action.startsWith('revision');

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return isDecision(action)
      ? 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const d = (error.details ?? {}) as { field?: unknown; category?: unknown };
  const field = typeof d.field === 'string' ? d.field : '';
  switch (error.code) {
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      return isDecision(action)
        ? 'This task is no longer assigned to you.'
        : isBudget(action)
          ? 'This budget line is not available in the selected role’s scope.'
          : 'This requisition is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      return isBudget(action)
        ? 'The revision changed since it was loaded. It has been reloaded: check it and try again.'
        : 'The requisition changed since it was loaded. It has been reloaded: check it and try again.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    case 'NOT_REQUESTER':
      return 'Only the requester can change, submit, withdraw or discard this requisition.';
    case 'NOT_PREPARER':
      return 'Only the HR user who prepared this revision can change, submit or withdraw it.';
    case 'REQUESTER_NOT_LINKED':
      return 'A requisition is raised by an employee, and this account is not linked to an employee record.';
    case 'REQUESTER_NOT_ACTIVE':
      return 'Only an active employee can raise or submit a requisition.';
    case 'INVALID_HIRING_MANAGER':
      // A copy takes the source's values as they are, so there is nothing to choose on this screen.
      return action === 'copy'
        ? 'This requisition cannot be copied: its hiring manager is no longer an active employee of this company.'
        : 'The hiring manager must be an active employee of this company. Choose another hiring manager.';
    case 'INVALID_REFERENCE': {
      const master = MASTER_FIELD[field];
      if (action === 'copy') {
        const what = master ?? (d.category === 'EMPLOYMENT_TYPE' ? 'employment type' : 'department, location, designation or employment type');
        return `This requisition cannot be copied: its ${what} is no longer active in this company.`;
      }
      if (master) return `The ${master} is not active in this company. Choose another ${master}.`;
      if (d.category === 'EMPLOYMENT_TYPE') return 'That employment type is not an active value in this company. Check the code.';
      return 'A department, location, designation or employment type is no longer active. Check the choices, then try again.';
    }
    case 'FIELD_REQUIRED':
      return `Enter the ${FIELD_LABEL[field] ?? 'required details'}.`;
    case 'INVALID_DATE':
      return `Enter a valid ${FIELD_LABEL[field] ?? 'date'}.`;
    case 'TOO_MANY_SKILLS':
      return 'List at most 50 skills.';
    case 'INVALID_FIELD':
      return field === 'skills' ? 'A skill is at most 100 characters.' : null;
    case 'BUDGET_EXCEPTION_REASON_REQUIRED':
      return `${budgetFigures(error.details)} Edit the draft to record why an exception is needed, then submit it again.`;
    case 'BUDGET_EXCEPTION_REQUIRED':
      return `${budgetFigures(error.details)} It records no exception reason, so it cannot be approved: return it to the requester or reject it.`;
    case 'BUDGET_EXCEPTION_DECISION_REQUIRED':
      return `${budgetFigures(error.details)} Tick “Approve the budget exception” to approve it, or return or reject it.`;
    case 'NO_ELIGIBLE_REVIEWER':
      return action === 'decide'
        ? 'No eligible HR Administrator is left for the budget and headcount approval: neither the requester nor you may take that step. Ask HR to add a reviewer to the requisition reviewer list; your decision was not recorded.'
        : 'No eligible reviewer is set up for this approval. Ask HR to repair the reviewer list; nothing was submitted.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for this yet. Ask HR to configure it; nothing was submitted.';
    case 'OPEN_OFFERS':
      return 'Finish, withdraw or hand over the open offers before closing the requisition.';
    case 'REASON_REQUIRED':
      return isBudget(action) ? 'Enter a reason to reject the revision.' : 'Enter a reason to return or reject the requisition.';
    case 'TASK_CLOSED':
      return 'This task has already been decided or withdrawn.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'OVERLAPPING_PERIOD':
      return 'A budget line for this department, location and designation already covers part of that period. Add a revision to that line instead.';
    case 'INVALID_PERIOD':
      return 'The period ends before it starts.';
    case 'OPEN_REVISION_EXISTS':
      return 'This budget line already has a revision in progress. Finish or withdraw it first.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return null;
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

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Masters and people for the forms
// ---------------------------------------------------------------------------------------------------------

function useOrgList(kind: MasterKind, enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.masters(kind),
    queryFn: () => api<{ items: MasterItem[] }>(`/v1/org/${kind}`),
    enabled,
    retry: retryTransient,
    staleTime: 5 * 60_000,
  });
}

/**
 * The departments, locations and designations a requisition may name. A role that can list the masters chooses from
 * the active ones; a role that cannot (a Reporting Manager holds no org_master.read) is offered the values the server
 * returned to it elsewhere: its direct reports' assignments and the requisitions it can see. The value already on a
 * draft is always offered. The server checks every choice.
 */
function useMasterOptions(current: Pick<Requisition, 'department' | 'location' | 'designation'> | null) {
  const { can } = useSession();
  const keys = useKeys();
  const fromOrg = can(ORG_READ);
  const departments = useOrgList('departments', fromOrg);
  const locations = useOrgList('locations', fromOrg);
  const designations = useOrgList('designations', fromOrg);
  const team = useQuery({
    queryKey: keys.teamAssignments,
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${KNOWN_QUERY}`),
    enabled: !fromOrg && can(EMPLOYEE_LIST),
    retry: retryTransient,
  });
  const seen = useQuery({
    queryKey: keys.requisitionList(KNOWN_QUERY),
    queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${KNOWN_QUERY}`),
    enabled: !fromOrg && can(REQ_READ),
    retry: retryTransient,
  });
  const options = useMemo(() => {
    const out: Record<MasterKind, Option[]> = { departments: [], locations: [], designations: [] };
    const add = (kind: MasterKind, id: string | null | undefined, label: string | null | undefined) => {
      if (id && label && !out[kind].some((o) => o.id === id)) out[kind].push({ id, label });
    };
    if (fromOrg) {
      for (const m of departments.data?.items ?? []) add('departments', m.id, `${m.name} (${m.code})`);
      for (const m of locations.data?.items ?? []) add('locations', m.id, `${m.name} (${m.code})`);
      for (const m of designations.data?.items ?? []) add('designations', m.id, `${m.name} (${m.code})`);
    } else {
      for (const e of team.data?.items ?? []) {
        if (!e.assignment) continue;
        add('departments', e.assignment.departmentId, e.assignment.departmentName);
        add('locations', e.assignment.locationId, e.assignment.locationName);
        add('designations', e.assignment.designationId, e.assignment.designationName);
      }
      for (const r of seen.data?.items ?? []) {
        add('departments', r.department.id, r.department.name);
        add('locations', r.location.id, r.location.name);
        add('designations', r.designation.id, r.designation.name);
      }
    }
    if (current) {
      add('departments', current.department.id, current.department.name);
      add('locations', current.location.id, current.location.name);
      add('designations', current.designation.id, current.designation.name);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [fromOrg, departments.data, locations.data, designations.data, team.data, seen.data, current]);
  const loading = departments.isLoading || locations.isLoading || designations.isLoading || team.isLoading || seen.isLoading;
  const error = departments.error ?? locations.error ?? designations.error ?? team.error ?? seen.error ?? null;
  return { options, fromOrg, loading, error };
}

function MasterSelect({ label, value, options, loading, onChange }: { label: string; value: string; options: Option[]; loading: boolean; onChange: (id: string) => void }) {
  return (
    <label>
      {label}
      <select required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{loading ? 'Loading…' : 'Choose…'}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The hiring manager: the signed-in employee, the one already on the draft, or one found by an employee search. */
function HiringManagerField({ value, current, onChange }: { value: string; current: Person | null; onChange: (id: string) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [picked, setPicked] = useState<Option | null>(null);
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
  const choices: Option[] = [];
  const offer = (o: Option) => {
    if (!choices.some((c) => c.id === o.id)) choices.push(o);
  };
  if (me?.employeeId) offer({ id: me.employeeId, label: me.displayName ? `You (${me.displayName})` : 'You' });
  if (current) offer({ id: current.id, label: personLabel(current) });
  if (picked) offer(picked);
  const choose = (e: EmployeeHit) => {
    const option = { id: e.id, label: `${e.displayName} (${e.employeeCode})` };
    setPicked(option);
    onChange(option.id);
    setSearch('');
    setTerm('');
  };
  const found = term !== '' ? hits.data : undefined;
  return (
    <>
      <label>
        Hiring manager
        <select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {canSearch && (
        <div className="wide">
          <label>
            Find another hiring manager
            <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
          </label>
          {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
          {found && found.items.length > 0 && (
            <ul className="choices" aria-label="Matching employees">
              {found.items.map((e) => (
                <li key={e.id}>
                  <button type="button" aria-label={`Choose ${e.displayName} (${e.employeeCode}) as the hiring manager`} onClick={() => choose(e)}>
                    {e.displayName} ({e.employeeCode}) · {readable(e.status).toLowerCase()}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The requisition form (FR-011 fields): a new draft, or the requester's draft being changed
// ---------------------------------------------------------------------------------------------------------

function RequisitionForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: RequisitionDetail | null;
  /** Sending, or the requisition is reloading: nothing is sent meanwhile. */
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: RequisitionInput) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [departmentId, setDepartmentId] = useState(initial?.department.id ?? '');
  const [locationId, setLocationId] = useState(initial?.location.id ?? '');
  const [designationId, setDesignationId] = useState(initial?.designation.id ?? '');
  const [employmentType, setEmploymentType] = useState(initial?.employmentType ?? '');
  const [vacancies, setVacancies] = useState(initial ? String(initial.vacancies) : '');
  const [reasonType, setReasonType] = useState<'' | 'NEW' | 'REPLACEMENT'>(initial?.reasonType === 'NEW' || initial?.reasonType === 'REPLACEMENT' ? initial.reasonType : '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [skills, setSkills] = useState(initial ? initial.skills.join('\n') : '');
  const [targetDate, setTargetDate] = useState(initial?.targetDate ?? '');
  const [hiringManagerId, setHiringManagerId] = useState(initial?.hiringManager.id ?? '');
  const [exception, setException] = useState(initial?.budgetExceptionReason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const masters = useMasterOptions(initial);
  const exceeds = initial?.budgetCheck ? initial.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' : false;

  // Required-field and format checks only; whether the values are acceptable (active masters, an active hiring
  // manager, the budget) is the server's call.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = employmentType.trim().toUpperCase();
    const count = vacancies.trim();
    const list = parseSkills(skills);
    const missing = !title.trim()
      ? 'Enter the position title.'
      : !departmentId
        ? 'Choose the department.'
        : !locationId
          ? 'Choose the location.'
          : !designationId
            ? 'Choose the designation.'
            : !EMPLOYMENT_TYPE_CODE.test(code)
              ? 'Enter the employment type code, for example PERMANENT.'
              : !wholeNumber(count, 1)
                ? 'Enter the number of vacancies as a whole number of at least 1.'
                : reasonType === ''
                  ? 'Choose whether the position is new or a replacement.'
                  : !reason.trim()
                    ? 'Enter the reason for the requisition.'
                    : list.length > 50
                      ? 'List at most 50 skills.'
                      : list.some((s) => s.length > 100)
                        ? 'A skill is at most 100 characters.'
                        : !targetDate
                          ? 'Enter the target date.'
                          : !hiringManagerId
                            ? 'Choose the hiring manager.'
                            : null;
    setProblem(missing);
    if (missing !== null || reasonType === '' || busy) return;
    onSubmit({
      title: title.trim(),
      departmentId,
      locationId,
      designationId,
      employmentType: code,
      vacancies: Number(count),
      reasonType,
      reason: reason.trim(),
      skills: list,
      targetDate,
      hiringManagerId,
      budgetExceptionReason: exception.trim() || null,
    });
  };

  const typesId = `${id}-types`;
  const exceptionHint = `${id}-exception`;
  return (
    <form className="grid-form" aria-label={initial ? `Edit draft ${initial.code}` : 'New requisition'} onSubmit={submit} noValidate>
      <label className="wide">
        Position title
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {!masters.fromOrg && (
        <p className="hint wide">
          The selected role cannot list the company’s departments, locations and designations, so the choices come from your team and the requisitions you can see.
        </p>
      )}
      <MasterSelect label="Department" value={departmentId} options={masters.options.departments} loading={masters.loading} onChange={setDepartmentId} />
      <MasterSelect label="Location" value={locationId} options={masters.options.locations} loading={masters.loading} onChange={setLocationId} />
      <MasterSelect label="Designation" value={designationId} options={masters.options.designations} loading={masters.loading} onChange={setDesignationId} />
      {masters.error ? (
        <div className="wide">
          <ErrorNote error={masters.error} />
        </div>
      ) : null}
      <label>
        Employment type
        <input required list={typesId} maxLength={60} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)} />
      </label>
      {/* Outside the label, so the suggestions do not become part of the field's name. */}
      <datalist id={typesId}>
        {EMPLOYMENT_TYPE_SUGGESTIONS.map(([code, label]) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </datalist>
      <label>
        Vacancies
        <input type="number" required min={1} step={1} inputMode="numeric" value={vacancies} onChange={(e) => setVacancies(e.target.value)} />
      </label>
      <label>
        Target date
        <input type="date" required value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
      </label>
      <fieldset className="wide" style={GROUP}>
        <legend>New or replacement</legend>
        <div className="row">
          <label className="check">
            <input type="radio" name={`${id}-reason-type`} value="NEW" required checked={reasonType === 'NEW'} onChange={() => setReasonType('NEW')} /> New position
          </label>
          <label className="check">
            <input type="radio" name={`${id}-reason-type`} value="REPLACEMENT" required checked={reasonType === 'REPLACEMENT'} onChange={() => setReasonType('REPLACEMENT')} />{' '}
            Replacement
          </label>
        </div>
      </fieldset>
      <label className="wide">
        Reason for the requisition
        <textarea required maxLength={2000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <label className="wide">
        Skills (one per line, or separated by commas)
        <textarea maxLength={5200} rows={3} value={skills} onChange={(e) => setSkills(e.target.value)} style={TEXTAREA} />
      </label>
      <HiringManagerField value={hiringManagerId} current={initial?.hiringManager ?? null} onChange={setHiringManagerId} />
      <label className="wide">
        Budget exception reason
        <textarea maxLength={2000} rows={2} value={exception} aria-describedby={exceptionHint} onChange={(e) => setException(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint wide" id={exceptionHint}>
        {exceeds
          ? 'Required to submit: this requisition exceeds its approved budget or has none. The HR approver approves the exception explicitly.'
          : 'Needed only when the requisition exceeds its approved budget or no budget covers it; the budget check is shown once the draft is saved.'}
      </p>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** A reason-only form (discarding a draft, closing a requisition); it stays filled in after a refusal. */
function ReasonForm({
  title,
  label,
  hint,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  hint: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    setProblem(text ? null : 'Enter a reason.');
    if (!text || busy) return;
    onSubmit(text);
  };
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        {title}
      </h3>
      <label className="wide">
        {label}
        <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint wide">{hint}</p>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" className="danger" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Shared requisition views
// ---------------------------------------------------------------------------------------------------------

function RequisitionFacts({ r }: { r: Requisition }) {
  return (
    <dl className="kv">
      <Item term="Reference">{r.code}</Item>
      <Item term="State">
        <StateBadge state={r.state} />
      </Item>
      <Item term="Position">{r.title}</Item>
      <Item term="Department">{r.department.name}</Item>
      <Item term="Location">{r.location.name}</Item>
      <Item term="Designation">{r.designation.name}</Item>
      <Item term="Employment type">{readable(r.employmentType)}</Item>
      <Item term="Vacancies">{r.vacancies}</Item>
      <Item term="New or replacement">{REASON_TYPE_LABEL[r.reasonType] ?? readable(r.reasonType)}</Item>
      <Item term="Target date">{formatDate(r.targetDate)}</Item>
      <Item term="Hiring manager">{personLabel(r.hiringManager)}</Item>
      <Item term="Requester">{personLabel(r.requester)}</Item>
      <Item term="Skills">{r.skills.length > 0 ? r.skills.join(', ') : 'None listed'}</Item>
      <Item term="Reason">{r.reason}</Item>
    </dl>
  );
}

/**
 * The budget check as the server worked it out; the figures only when the server sent them. What an exception needs
 * depends on where the requisition is: a draft needs its reason to be submitted; a submitted one needs the HR
 * approver's explicit approval of the reason it recorded, and one that recorded none cannot be approved as it stands.
 */
function BudgetCheckText({ check, state, exceptionReason }: { check: BudgetCheck; state: string; exceptionReason: string | null }) {
  const status = check.budgetStatus;
  const within = status === 'WITHIN_BUDGET';
  const exception =
    state === 'DRAFT'
      ? 'an exception reason is needed to submit it, and the HR approver approves the exception explicitly.'
      : exceptionReason
        ? 'the HR approver approves its budget exception explicitly.'
        : 'it records no budget exception reason, so it cannot be approved as it stands: it can be returned to the requester or rejected.';
  const text = within
    ? 'Within the approved budget.'
    : status === 'EXCEEDS_BUDGET'
      ? `Exceeds the approved budget: ${exception}`
      : status === 'NO_BUDGET'
        ? `No approved manpower budget covers this department, location and designation on the target date: ${exception}`
        : '';
  const figures = check.approvedHeadcount === null ? '' : ` Approved headcount ${check.approvedHeadcount}, already committed ${check.committed}, this requisition ${check.requested}.`;
  return (
    <p>
      <Badge tone={within ? 'good' : 'warn'}>{budgetStatusText(status)}</Badge> {text}
      {figures}
    </p>
  );
}

function DecisionTable({ decisions, myUserId }: { decisions: DecisionRecord[]; myUserId: string | null }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Approval history">
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">Step</th>
            <th scope="col">Decision</th>
            <th scope="col">Decided by</th>
            <th scope="col">Decided at</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((d, index) => (
            <tr key={`${d.decidedAt}-${index}`}>
              <td>{d.revision}</td>
              <td>{stepText(d.step, d.action)}</td>
              <td>{DECISION_LABEL[d.decision] ?? readable(d.decision)}</td>
              <td>{userLabel(d.decidedBy, myUserId)}</td>
              <td>
                <When at={d.decidedAt} />
              </td>
              <td>{d.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevisionTable({ revisions }: { revisions: RequisitionRevision[] }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Submitted revisions">
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">Vacancies</th>
            <th scope="col">Target date</th>
            <th scope="col">Budget check</th>
            <th scope="col">Approved headcount</th>
            <th scope="col">Committed</th>
            <th scope="col">Exception reason</th>
            <th scope="col">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((v) => (
            <tr key={v.revision}>
              <td>{v.revision}</td>
              <td>{v.vacancies}</td>
              <td>{formatDate(v.targetDate)}</td>
              <td>{budgetStatusText(v.budgetStatus)}</td>
              <td>{v.approvedHeadcount ?? '—'}</td>
              <td>{v.committed ?? '—'}</td>
              <td>{v.budgetExceptionReason ?? '—'}</td>
              <td>
                <When at={v.submittedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: requisitions (register with the filters the API offers, and the decision queue)
// ---------------------------------------------------------------------------------------------------------

function RequisitionsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Requisitions</h1>
      <RequisitionValidationQueue />
      <RequisitionApprovalQueue />
      {can(REQ_READ) ? (
        <RequisitionRegister />
      ) : (
        <Section title="Requisition register">
          <NotPermitted>The selected role cannot view requisitions.</NotPermitted>
        </Section>
      )}
    </>
  );
}

interface ListFilters {
  state: string;
  departmentId: string;
  search: string;
  page: number;
  pageSize: number;
}

/** `withDepartment`: the department filter is offered (the role can list departments); otherwise none is applied unseen. */
function readFilters(params: URLSearchParams, withDepartment: boolean): ListFilters {
  const state = REQUISITION_STATES.find((s) => s === params.get('state')) ?? '';
  const department = withDepartment ? (params.get('department') ?? '') : '';
  const page = Number(params.get('page') ?? '1');
  return {
    state,
    departmentId: UUID.test(department) ? department : '',
    search: (params.get('search') ?? '').trim().slice(0, 100),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: PAGE_SIZES.find((n) => String(n) === params.get('pageSize')) ?? 25,
  };
}

function listQuery(f: ListFilters): string {
  const q = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) });
  if (f.state) q.set('state', f.state);
  if (f.departmentId) q.set('departmentId', f.departmentId);
  if (f.search) q.set('search', f.search);
  return q.toString();
}

function RequisitionRegister() {
  const { can, me } = useSession();
  const keys = useKeys();
  const [params, setParams] = useSearchParams();
  const canOrg = can(ORG_READ);
  const filters = readFilters(params, canOrg);
  const [typed, setTyped] = useState(filters.search);
  const applied = useRef(filters.search);
  applied.current = filters.search;
  const departments = useOrgList('departments', canOrg);

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  // The search is sent once typing pauses; any filter change starts again at the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      const term = typed.trim().slice(0, 100);
      if (term !== applied.current) update({ search: term || null, page: null });
    }, 300);
    return () => clearTimeout(t);
    // Only typing starts a search; the address changing (back/forward) does not resend what was typed.
  }, [typed]);

  const query = listQuery(filters);
  const list = useQuery({ queryKey: keys.requisitionList(query), queryFn: () => api<RequisitionPage>(`/v1/hiring/requisitions?${query}`), retry: retryTransient });
  const data = shown(list);
  const pages = data ? Math.max(1, Math.ceil(data.total / filters.pageSize)) : 1;
  const canCreate = can(REQ_CREATE);

  return (
    <Section
      title="Requisition register"
      actions={
        canCreate && me?.employeeId ? (
          <Link to={PATHS.newRequisition}>New requisition</Link>
        ) : undefined
      }
    >
      {canCreate && me && !me.employeeId && <p className="hint">A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</p>}
      <div className="row">
        <label className="inline">
          State
          <select value={filters.state} onChange={(e) => update({ state: e.target.value || null, page: null })}>
            <option value="">All states</option>
            {REQUISITION_STATES.map((s) => (
              <option key={s} value={s}>
                {readable(s)}
              </option>
            ))}
          </select>
        </label>
        {canOrg && (
          <label className="inline">
            Department
            <select value={filters.departmentId} onChange={(e) => update({ department: e.target.value || null, page: null })}>
              <option value="">All departments</option>
              {(departments.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="inline">
          Search
          <input type="search" value={typed} maxLength={100} placeholder="Reference or position title" onChange={(e) => setTyped(e.target.value)} />
        </label>
        <label className="inline">
          Rows per page
          <select value={String(filters.pageSize)} onChange={(e) => update({ pageSize: e.target.value === '25' ? null : e.target.value, page: null })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.isPending && <p className="hint">Loading requisitions…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view requisitions.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && data.total > 0 && (
        <p className="hint">
          This page is past the end of the list.{' '}
          <button type="button" className="link" onClick={() => update({ page: null })}>
            Go to the first page
          </button>
        </p>
      )}
      {data && data.total === 0 && (
        <Empty>{filters.state || filters.departmentId || filters.search ? 'No requisitions match these filters.' : 'No requisitions in the selected role’s scope yet.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <>
          <div style={SCROLL}>
            <table aria-label="Requisitions">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Position</th>
                  <th scope="col">Department</th>
                  <th scope="col">Location</th>
                  <th scope="col">Designation</th>
                  <th scope="col">Vacancies</th>
                  <th scope="col">Filled</th>
                  <th scope="col">Target date</th>
                  <th scope="col">Requester</th>
                  <th scope="col">Hiring manager</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={PATHS.requisition(r.id)}>{r.code}</Link>
                    </td>
                    <td>{r.title}</td>
                    <td>{r.department.name}</td>
                    <td>{r.location.name}</td>
                    <td>{r.designation.name}</td>
                    <td>{r.vacancies}</td>
                    <td>{r.filled}</td>
                    <td>{formatDate(r.targetDate)}</td>
                    <td>{personLabel(r.requester)}</td>
                    <td>{personLabel(r.hiringManager)}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button type="button" className="secondary" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 <= 1 ? null : String(filters.page - 1) })}>
              Previous
            </button>
            <span>
              Page {Math.min(filters.page, pages)} of {pages} · {data.total} requisitions
            </span>
            <button type="button" className="secondary" disabled={filters.page >= pages} onClick={() => update({ page: String(filters.page + 1) })}>
              Next
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: a new requisition (the caller's own draft)
// ---------------------------------------------------------------------------------------------------------

function NewRequisitionScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (body: RequisitionInput) => api<RequisitionDetail>('/v1/hiring/requisitions', { body }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: keys.requisitions });
      navigate(PATHS.requisition(created.id), { state: { notice: `Draft ${created.code} saved. Check its budget, then submit it for approval.` } });
    },
  });
  let body: ReactNode;
  if (!can(REQ_CREATE)) body = <NotPermitted>The selected role cannot raise requisitions.</NotPermitted>;
  else if (!me) body = <p className="hint">Loading your role…</p>;
  else if (!me.employeeId) body = <p className="hint">A requisition is raised by an employee; this account is not linked to an employee record, so it cannot raise one.</p>;
  else
    body = (
      <>
        <p className="hint">The draft is yours until you submit it: your direct manager validates it, then an HR Administrator approves its budget and headcount.</p>
        <RequisitionForm initial={null} busy={create.isPending} submitLabel="Save draft" onSubmit={(input) => create.mutate(input)} />
        <Refusal error={create.error} action="create" />
      </>
    );
  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.requisitions}>Back to requisitions</Link>
      </p>
      <h1>New requisition</h1>
      <Section title="Requisition details">{body}</Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: one requisition (details, budget, actions, approval history, submitted revisions)
// ---------------------------------------------------------------------------------------------------------

function RequisitionDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(REQ_READ)) {
    return (
      <>
        <h1>Requisition</h1>
        <NotPermitted>The selected role cannot view requisitions.</NotPermitted>
      </>
    );
  }
  if (!UUID.test(id)) {
    return (
      <>
        <p style={FLUSH}>
          <Link to={PATHS.requisitions}>Back to requisitions</Link>
        </p>
        <h1>Requisition</h1>
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      </>
    );
  }
  // A new requisition (a copy) starts with its own state.
  return <RequisitionDetailView key={id} id={id} />;
}

function RequisitionDetailView({ id }: { id: string }) {
  const { me } = useSession();
  const keys = useKeys();
  const location = useLocation();
  const [notice, setNotice] = useState<string | null>(() => {
    const arrived = (location.state as { notice?: unknown } | null)?.notice;
    return typeof arrived === 'string' ? arrived : null;
  });
  const detail = useQuery({ queryKey: keys.requisition(id), queryFn: () => api<RequisitionDetail>(`/v1/hiring/requisitions/${encodeURIComponent(id)}`), retry: retryTransient });
  const r = shown(detail);
  // A background reload (after a change or a conflict) is about to replace the version an action would send.
  const reloading = detail.isFetching && !detail.isPending;
  const myUserId = me?.userId ?? null;
  const returned = r && r.state === 'DRAFT' ? [...r.decisions].reverse().find((d) => d.decision === 'RETURN' && d.revision === r.currentRevision) : undefined;

  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.requisitions}>Back to requisitions</Link>
      </p>
      <h1>{r ? `Requisition ${r.code}` : 'Requisition'}</h1>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {detail.isPending && <p className="hint">Loading the requisition…</p>}
      {isForbidden(detail.error) ? (
        <NotPermitted>The selected role cannot view this requisition.</NotPermitted>
      ) : isNotFound(detail.error) ? (
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      ) : (
        <ErrorNote error={detail.error} />
      )}
      {r && (
        <>
          <Section title={r.title}>
            <RequisitionFacts r={r} />
            <dl className="kv" style={SPACED}>
              <Item term="Filled (accepted offers)">{r.filled}</Item>
              <Item term="Created">
                <When at={r.createdAt} />
              </Item>
              {r.submittedAt && (
                <Item term="Last submitted">
                  <When at={r.submittedAt} />
                </Item>
              )}
              {r.decidedAt && (
                <Item term="Decided">
                  <When at={r.decidedAt} />
                </Item>
              )}
              {r.closedAt && (
                <Item term="Closed">
                  <When at={r.closedAt} />
                </Item>
              )}
              {r.closureReason && <Item term="Closure reason">{r.closureReason}</Item>}
              {r.copiedFromRequisitionId && (
                <Item term="Copied from">
                  <Link to={PATHS.requisition(r.copiedFromRequisitionId)}>The requisition it was copied from</Link>
                </Item>
              )}
            </dl>
            {r.pendingWith && (
              <p>
                Waiting for {userInSentence(r.pendingWith.assignee, myUserId)}: {stepText(r.pendingWith.step, r.pendingWith.action)}, since <When at={r.pendingWith.assignedAt} />.
              </p>
            )}
            {returned && (
              <p role="note">
                Returned for changes by {userInSentence(returned.decidedBy, myUserId)} on <When at={returned.decidedAt} />
                {returned.reason ? `: ${returned.reason}` : '.'}
              </p>
            )}
          </Section>
          <BudgetSection r={r} />
          <RequisitionActions r={r} reloading={reloading} onNotice={setNotice} />
          <Section title="Approval history">
            {r.decisions.length === 0 ? <Empty>No decisions recorded yet.</Empty> : <DecisionTable decisions={r.decisions} myUserId={myUserId} />}
          </Section>
          <Section title="Submitted revisions">
            {r.revisions.length === 0 ? <Empty>Not submitted yet.</Empty> : <RevisionTable revisions={r.revisions} />}
          </Section>
        </>
      )}
    </>
  );
}

function BudgetSection({ r }: { r: RequisitionDetail }) {
  const { can } = useSession();
  // The budget reference (FR-011), once a submission recorded one: a link for roles that can view manpower budgets
  // (a draft's own check is the live one above; the reference it may carry belongs to an earlier submission).
  const line = r.state !== 'DRAFT' && r.budgetId && can(BUDGET_READ) ? r.budgetId : null;
  if (!r.budgetCheck && !r.budgetExceptionReason && !r.budgetExceptionApprovedAt && !line) return null;
  return (
    <Section title="Budget">
      {r.budgetCheck && <BudgetCheckText check={r.budgetCheck} state={r.state} exceptionReason={r.budgetExceptionReason} />}
      {r.budgetExceptionReason && <p>Budget exception reason: {r.budgetExceptionReason}</p>}
      {r.budgetExceptionApprovedAt && (
        <p>
          <Badge tone="good">exception approved</Badge> The HR approver approved the budget exception on <When at={r.budgetExceptionApprovedAt} />.
        </p>
      )}
      {line && (
        <p>
          Budget reference: <Link to={PATHS.budget(line)}>open the manpower budget line it was checked against</Link>
        </p>
      )}
      {!r.budgetCheck && r.revisions.length > 0 && <p className="hint">The budget check made at each submission is listed under Submitted revisions.</p>}
    </Section>
  );
}

type RequisitionCommand =
  | { kind: 'update'; body: RequisitionInput & { expectedVersion: number } }
  | { kind: 'submit'; expectedVersion: number }
  | { kind: 'withdraw' }
  | { kind: 'discard'; reason: string }
  | { kind: 'copy' }
  | { kind: 'close'; reason: string };

function RequisitionActions({ r, reloading, onNotice }: { r: RequisitionDetail; reloading: boolean; onNotice: (text: string | null) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState<'edit' | 'discard' | 'close' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.requisitions });
    void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
  };
  const run = useMutation({
    mutationFn: (c: RequisitionCommand): Promise<unknown> => {
      const base = `/v1/hiring/requisitions/${encodeURIComponent(r.id)}`;
      switch (c.kind) {
        case 'update':
          return api<RequisitionDetail>(base, { method: 'PUT', body: c.body });
        case 'submit':
          return api<SubmitResult>(`${base}/submit`, { body: { expectedVersion: c.expectedVersion } });
        case 'withdraw':
          return api(`${base}/withdraw`, { method: 'POST' });
        case 'discard':
          return api(`${base}/discard`, { body: { reason: c.reason } });
        case 'copy':
          return api<RequisitionDetail>(`${base}/copy`, { method: 'POST' });
        case 'close':
          return api(`${base}/close`, { body: { reason: c.reason } });
      }
    },
    onMutate: () => onNotice(null),
    onSuccess: (result, c) => {
      refresh();
      switch (c.kind) {
        case 'update':
          setOpen(null);
          onNotice('Draft saved.');
          break;
        case 'submit': {
          const s = result as SubmitResult;
          onNotice(`Submitted for approval as revision ${s.revision}${s.budgetStatus === 'WITHIN_BUDGET' ? '' : ', with its budget exception'}. It now waits for validation.`);
          break;
        }
        case 'withdraw':
          onNotice('Withdrawn. The requisition is a draft again, and its reviewer no longer needs to decide it.');
          break;
        case 'discard':
          setOpen(null);
          onNotice('Draft discarded. It is kept as a closed requisition with your reason.');
          break;
        case 'copy': {
          const copy = result as RequisitionDetail;
          navigate(PATHS.requisition(copy.id), { state: { notice: `Copied to ${copy.code}, a new draft with no approvals or decisions. Review it, then submit it for approval.` } });
          break;
        }
        case 'close':
          setOpen(null);
          onNotice('Requisition closed.');
          break;
      }
    },
    // A stale version or a requisition that moved on: reload it, so a retry uses its current version and state.
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });

  const isRequester = !!me?.employeeId && me.employeeId === r.requester.id;
  const canCreate = can(REQ_CREATE);
  const mayChange = canCreate && isRequester;
  const draft = r.state === 'DRAFT';
  const waiting = r.state === 'SUBMITTED';
  const mayCopy = canCreate && !!me?.employeeId;
  const mayClose = can(REQ_CLOSE) && r.state === 'APPROVED';
  const othersDraft = canCreate && !isRequester && (draft || waiting);
  // Nothing left to offer (the requisition moved on, perhaps by the refused action itself): the refusal stays shown.
  if (!mayChange && !mayCopy && !mayClose && !othersDraft) return <Refusal error={run.error} action={run.variables?.kind ?? 'update'} />;

  const busy = run.isPending || reloading;
  const needsException = draft && r.budgetCheck !== null && r.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' && !r.budgetExceptionReason;
  const toggle = (panel: 'edit' | 'discard' | 'close') => {
    run.reset();
    setOpen((current) => (current === panel ? null : panel));
  };

  return (
    <Section title="Actions">
      {othersDraft && (
        <p className="hint">
          Only the requester, {personLabel(r.requester)}, can {draft ? 'change, submit or discard this draft' : 'withdraw this requisition'}.
        </p>
      )}
      {mayChange && needsException && <p className="hint">Record a budget exception reason (Edit draft) before submitting: this requisition exceeds its approved budget or has none.</p>}
      <div className="row">
        {mayChange && draft && (
          <>
            <button type="button" className="secondary" aria-expanded={open === 'edit'} disabled={busy} onClick={() => toggle('edit')}>
              Edit draft
            </button>
            <button type="button" disabled={busy} onClick={() => run.mutate({ kind: 'submit', expectedVersion: r.version })}>
              Submit for approval
            </button>
            <button type="button" className="danger" aria-expanded={open === 'discard'} disabled={busy} onClick={() => toggle('discard')}>
              Discard draft
            </button>
          </>
        )}
        {mayChange && waiting && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run.mutate({ kind: 'withdraw' })}>
            Withdraw
          </button>
        )}
        {mayCopy && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run.mutate({ kind: 'copy' })}>
            Copy to a new requisition
          </button>
        )}
        {mayClose && (
          <button type="button" className="danger" aria-expanded={open === 'close'} disabled={busy} onClick={() => toggle('close')}>
            Close requisition
          </button>
        )}
      </div>
      {mayCopy && <p className="hint">A copy gets a new reference and keeps the job details only: no approvals, decisions, budget exception or candidates.</p>}
      {open === 'edit' && mayChange && draft && (
        <div style={SPACED}>
          <RequisitionForm
            initial={r}
            busy={busy}
            submitLabel="Save draft"
            onSubmit={(input) => run.mutate({ kind: 'update', body: { ...input, expectedVersion: r.version } })}
            onCancel={() => setOpen(null)}
          />
        </div>
      )}
      {open === 'discard' && mayChange && draft && (
        <ReasonForm
          title="Discard this draft"
          label="Reason for discarding (required)"
          hint="The draft is kept as a closed requisition with your reason; it cannot be submitted afterwards."
          submitLabel="Discard this draft"
          busy={busy}
          onSubmit={(reason) => run.mutate({ kind: 'discard', reason })}
          onCancel={() => setOpen(null)}
        />
      )}
      {open === 'close' && mayClose && (
        <ReasonForm
          title="Close this requisition"
          label="Reason for closing (required)"
          hint="Close it when its vacancies are filled or no longer needed. Open offers must be finished, withdrawn or handed over first."
          submitLabel="Close this requisition"
          busy={busy}
          onSubmit={(reason) => run.mutate({ kind: 'close', reason })}
          onCancel={() => setOpen(null)}
        />
      )}
      <Refusal error={run.error} action={run.variables?.kind ?? 'update'} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Decision queue: requisitions (F1: validation, then HR budget and headcount approval)
// ---------------------------------------------------------------------------------------------------------

type RequisitionStep = 'validate' | 'approve';

/**
 * F1's two requisition steps. Both are listed by GET /v1/hiring/requisition-tasks (requisition.read), but each is
 * decided with its own duty, so each step has its own queue, shown only with that duty.
 */
const REQUISITION_STEP_QUEUES: Record<RequisitionStep, { title: string; hint: string; list: string; empty: string }> = {
  validate: {
    title: 'Requisition validations',
    hint: 'Step 1: the requester’s direct manager (or HR when the manager cannot) validates the requisition; an independent HR Administrator then approves its budget and headcount. Returning or rejecting needs a reason.',
    list: 'Requisitions waiting for your validation',
    empty: 'No requisitions are waiting for your validation.',
  },
  approve: {
    title: 'Requisition budget and headcount approvals',
    hint: 'Step 2: an independent HR Administrator approves the budget and headcount of a validated requisition; one beyond its budget needs its exception approved explicitly. Returning or rejecting needs a reason.',
    list: 'Requisitions waiting for your budget and headcount approval',
    empty: 'No requisitions are waiting for your budget and headcount approval.',
  },
};

/** Step 1 tasks, for a role that reads requisitions and validates them. */
function RequisitionValidationQueue() {
  const { can } = useSession();
  return can(REQ_READ) && can(REQ_VALIDATE) ? <RequisitionQueue step="validate" /> : null;
}

/** Step 2 tasks, for a role that reads requisitions and approves their budget and headcount. */
function RequisitionApprovalQueue() {
  const { can } = useSession();
  return can(REQ_READ) && can(REQ_APPROVE) ? <RequisitionQueue step="approve" /> : null;
}

function RequisitionQueue({ step }: { step: RequisitionStep }) {
  const queue = REQUISITION_STEP_QUEUES[step];
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  // Both step queues read the same route under the same key: one request, each listing its own step's tasks.
  const tasks = useQuery({ queryKey: keys.requisitionTasks, queryFn: () => api<{ items: RequisitionTask[] }>('/v1/hiring/requisition-tasks'), retry: retryTransient });
  /** Tasks seen decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => t.stepAction === step && !gone.has(t.taskId));
  const finished = (t: RequisitionTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
    void qc.invalidateQueries({ queryKey: keys.requisitions });
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label={queue.title} tabIndex={-1}>
      <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
        <p className="hint">{queue.hint}</p>
        {tasks.isPending && <p className="hint">Loading the requisitions waiting for you…</p>}
        {isForbidden(tasks.error) ? <NotPermitted>The selected role cannot decide requisitions.</NotPermitted> : <ErrorNote error={tasks.error} />}
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={queue.list}>
            {items.map((t) => (
              <RequisitionTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function requisitionDecidedText(code: string, body: RequisitionDecisionBody, result: RequisitionDecided): string {
  if (result.replayed) return `Your earlier decision on ${code} had already been recorded, so nothing was applied twice. Its state is now: ${readable(result.state).toLowerCase()}.`;
  if (result.pendingStep === 2) return `Validated ${code}. It now waits for HR budget and headcount approval.`;
  if (result.state === 'APPROVED') return body.approveBudgetException ? `Approved ${code} and its budget exception.` : `Approved ${code}.`;
  if (result.state === 'REJECTED') return `Rejected ${code}.`;
  if (result.state === 'DRAFT') return `Returned ${code} to the requester for changes.`;
  return `${code} is now ${readable(result.state).toLowerCase()}.`;
}

function RequisitionTaskItem({ task: t, onFinished }: { task: RequisitionTask; onFinished: (t: RequisitionTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const r = t.requisition;
  const validating = t.stepAction === 'validate';
  const approving = t.stepAction === 'approve';
  const permitted = validating ? can(REQ_VALIDATE) : approving ? can(REQ_APPROVE) : false;
  const [reason, setReason] = useState('');
  const [exceptionApproved, setExceptionApproved] = useState(false);
  /** The server asked for an explicit exception decision (the budget moved since this queue was loaded). */
  const [askException, setAskException] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again after a failure, whose
   * answer may have been lost, carries the same key: the server answers from what it recorded and never applies it
   * twice. Any other decision (another choice, reason or exception approval) is a new action with a new key.
   */
  const attempt = useRef<{ decision: string; reason: string; exception: boolean; key: string } | null>(null);
  const exceeds = r?.budgetCheck ? r.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' : false;
  // Only a recorded exception (pinned with the submission) can be approved; without one the server refuses approval.
  const showException = approving && !!r?.budgetExceptionReason && (exceeds || askException);
  const code = r?.code ?? 'the requisition';
  const decide = useMutation({
    mutationFn: (body: RequisitionDecisionBody) => api<RequisitionDecided>(`/v1/hiring/requisition-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result, body) => {
      attempt.current = null;
      onFinished(t, requisitionDecidedText(code, body, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another decision's and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'BUDGET_EXCEPTION_DECISION_REQUIRED' || error.code === 'BUDGET_EXCEPTION_REQUIRED') {
        // The budget moved since the queue was loaded: show the check as it is now (what was typed is kept).
        if (error.code === 'BUDGET_EXCEPTION_DECISION_REQUIRED') setAskException(true);
        void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
      }
      // Decided, withdrawn or out of the role's reach meanwhile: nothing is left to decide here.
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
      // The requisition changed while the decision was recorded (nothing was): reload it, as the refusal says.
      else if (error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
    },
  });
  const busy = decide.isPending;

  const send = (decision: RequisitionDecisionBody['decision']) => {
    if (!permitted || busy || !r) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the requisition for changes.' : 'Enter a reason to reject the requisition.');
      decide.reset();
      return;
    }
    setProblem(null);
    const exception = decision === 'APPROVE' && showException && exceptionApproved;
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text && last.exception === exception ? last.key : idempotencyKey('hiring-requisition');
    attempt.current = { decision, reason: text, exception, key };
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}), ...(exception ? { approveBudgetException: true as const } : {}) });
  };

  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {r ? `${r.code}: ${r.title}` : 'Requisition'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        {stepText(t.step, t.stepAction)} · assigned <When at={t.assignedAt} />
      </p>
      {r ? (
        <>
          <RequisitionFacts r={r} />
          {r.budgetCheck && <BudgetCheckText check={r.budgetCheck} state={r.state} exceptionReason={r.budgetExceptionReason} />}
          {r.budgetExceptionReason && <p style={FLUSH}>Budget exception reason: {r.budgetExceptionReason}</p>}
          <div>
            <Link to={PATHS.requisition(r.id)}>Open {r.code}</Link>
          </div>
        </>
      ) : (
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      )}
      {r &&
        (permitted ? (
          <>
            <label>
              Decision reason (required to return or reject)
              <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
            </label>
            {showException && (
              <label className="check">
                <input type="checkbox" checked={exceptionApproved} onChange={(e) => setExceptionApproved(e.target.checked)} /> Approve the budget exception
              </label>
            )}
            {problem && (
              <p role="alert" className="error">
                {problem}
              </p>
            )}
            <div className="row">
              <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
                {validating ? 'Validate' : 'Approve'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => send('RETURN')}>
                Return for changes
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
                Reject
              </button>
            </div>
            <Refusal error={decide.error} action="decide" />
          </>
        ) : (
          <p className="hint">The selected role cannot {validating ? 'validate requisitions' : 'approve requisition budgets and headcount'}.</p>
        ))}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: manpower budgets (register with the filters the API offers, a new budget line, the decision queue)
// ---------------------------------------------------------------------------------------------------------

function BudgetsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Manpower budgets</h1>
      <BudgetDecisionQueue />
      {can(BUDGET_READ) ? (
        <BudgetRegister />
      ) : (
        <Section title="Budget lines">
          <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted>
        </Section>
      )}
      {can(BUDGET_MANAGE) && <NewBudgetLine />}
    </>
  );
}

function OrgFilter({ label, allLabel, kind, value, onChange }: { label: string; allLabel: string; kind: MasterKind; value: string; onChange: (id: string) => void }) {
  const list = useOrgList(kind, true);
  return (
    <label className="inline">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {(list.data?.items ?? []).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.code})
          </option>
        ))}
      </select>
    </label>
  );
}

function BudgetRegister() {
  const { can } = useSession();
  const keys = useKeys();
  const canOrg = can(ORG_READ);
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [on, setOn] = useState('');
  const q = new URLSearchParams();
  if (departmentId) q.set('departmentId', departmentId);
  if (locationId) q.set('locationId', locationId);
  if (designationId) q.set('designationId', designationId);
  if (/^\d{4}-\d{2}-\d{2}$/.test(on)) q.set('on', on);
  const query = q.toString();
  const list = useQuery({ queryKey: keys.budgetList(query), queryFn: () => api<{ items: Budget[] }>(`/v1/hiring/budgets${query ? `?${query}` : ''}`), retry: retryTransient });
  const data = shown(list);
  const filtered = query !== '';
  return (
    <Section title="Budget lines">
      <p className="hint">The headcount in force is the latest approved revision. Committed counts the vacancies of approved requisitions on the line, plus the placements of closed ones.</p>
      <div className="row">
        {canOrg && (
          <>
            <OrgFilter label="Department" allLabel="All departments" kind="departments" value={departmentId} onChange={setDepartmentId} />
            <OrgFilter label="Location" allLabel="All locations" kind="locations" value={locationId} onChange={setLocationId} />
            <OrgFilter label="Designation" allLabel="All designations" kind="designations" value={designationId} onChange={setDesignationId} />
          </>
        )}
        <label className="inline">
          In force on
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </label>
      </div>
      {list.isPending && <p className="hint">Loading budget lines…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>{filtered ? 'No budget lines match these filters.' : 'No budget lines in the selected role’s scope yet.'}</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Budget lines">
            <thead>
              <tr>
                <th scope="col">Department</th>
                <th scope="col">Location</th>
                <th scope="col">Designation</th>
                <th scope="col">Period</th>
                <th scope="col">Headcount in force</th>
                <th scope="col">Committed</th>
                <th scope="col">Revision in progress</th>
                <th scope="col">
                  <span style={SR_ONLY}>Budget line</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => (
                <tr key={b.id}>
                  <td>{b.departmentName}</td>
                  <td>{b.locationName}</td>
                  <td>{b.designationName}</td>
                  <td>{periodText(b)}</td>
                  <td>{b.approvedHeadcount ?? 'None approved yet'}</td>
                  <td>{b.committed}</td>
                  <td>{b.openRevision ? `Revision ${b.openRevision.revision}: headcount ${b.openRevision.headcount} (${readable(b.openRevision.state).toLowerCase()})` : '—'}</td>
                  <td>
                    <Link to={PATHS.budget(b.id)} aria-label={`Open the budget line ${lineLabel(b)} (${periodText(b)})`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.items.length >= BUDGET_LIST_LIMIT && <p className="hint">Showing the first {BUDGET_LIST_LIMIT} budget lines; filter to narrow them down.</p>}
    </Section>
  );
}

interface BudgetBody {
  departmentId: string;
  locationId: string;
  designationId: string;
  periodStart: string;
  periodEnd: string;
  headcount: number;
  reason: string;
}

/** A new budget line with its first revision as a draft; the preparer submits it from the line. */
function NewBudgetLine() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canOrg = can(ORG_READ);
  const departments = useOrgList('departments', canOrg);
  const locations = useOrgList('locations', canOrg);
  const designations = useOrgList('designations', canOrg);
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [headcount, setHeadcount] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{ budgetId: string; text: string } | null>(null);
  const nameOf = (items: MasterItem[] | undefined, id: string) => items?.find((m) => m.id === id)?.name;
  const create = useMutation({
    mutationFn: (body: BudgetBody) => api<RevisionSaved & { budgetId: string }>('/v1/hiring/budgets', { body }),
    onMutate: () => setCreated(null),
    onSuccess: (result, body) => {
      const names = [nameOf(departments.data?.items, body.departmentId), nameOf(locations.data?.items, body.locationId), nameOf(designations.data?.items, body.designationId)];
      const line = names.every((n) => n !== undefined) ? ` for ${names.join(', ')}` : '';
      setCreated({ budgetId: result.budgetId, text: `Budget line added${line}: draft revision ${result.revision ?? 1} with headcount ${result.headcount}.` });
      // A line added starts the form clean; a refused one keeps what was typed.
      setDepartmentId('');
      setLocationId('');
      setDesignationId('');
      setPeriodStart('');
      setPeriodEnd('');
      setHeadcount('');
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.budgets });
    },
  });
  const options = (items: MasterItem[] | undefined): Option[] => (items ?? []).map((m) => ({ id: m.id, label: `${m.name} (${m.code})` }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = headcount.trim();
    const text = reason.trim();
    const missing = !departmentId
      ? 'Choose the department.'
      : !locationId
        ? 'Choose the location.'
        : !designationId
          ? 'Choose the designation.'
          : !periodStart
            ? 'Enter the first day of the period.'
            : !periodEnd
              ? 'Enter the last day of the period.'
              : !wholeNumber(count, 0)
                ? 'Enter the headcount as a whole number (0 or more).'
                : !text
                  ? 'Enter the reason for the budget.'
                  : null;
    setProblem(missing);
    if (missing !== null) {
      create.reset();
      return;
    }
    if (create.isPending) return;
    create.mutate({ departmentId, locationId, designationId, periodStart, periodEnd, headcount: Number(count), reason: text });
  };

  return (
    <Section title="Add a budget line">
      {canOrg ? (
        <form className="grid-form" aria-label="Add a budget line" onSubmit={submit} noValidate>
          <p className="hint wide">One line per department, location and designation on any date. Its first revision is saved as a draft that you submit; another HR Administrator approves it.</p>
          <MasterSelect label="Department" value={departmentId} options={options(departments.data?.items)} loading={departments.isLoading} onChange={setDepartmentId} />
          <MasterSelect label="Location" value={locationId} options={options(locations.data?.items)} loading={locations.isLoading} onChange={setLocationId} />
          <MasterSelect label="Designation" value={designationId} options={options(designations.data?.items)} loading={designations.isLoading} onChange={setDesignationId} />
          <label>
            Period start
            <input type="date" required value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <label>
            Period end
            <input type="date" required value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
          <label>
            Headcount
            <input type="number" required min={0} step={1} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
          </label>
          <label className="wide">
            Reason (required)
            <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          {(departments.error || locations.error || designations.error) && (
            <div className="wide">
              <ErrorNote error={departments.error ?? locations.error ?? designations.error} />
            </div>
          )}
          {problem && (
            <p role="alert" className="error wide">
              {problem}
            </p>
          )}
          {create.error ? (
            <div className="wide">
              <Refusal error={create.error} action="budget-create" />
            </div>
          ) : null}
          <div className="wide row">
            <button type="submit" disabled={create.isPending}>
              Add budget line
            </button>
          </div>
          {created && (
            <p className="ok wide" role="status">
              {created.text} <Link to={PATHS.budget(created.budgetId)}>Open the line to submit the revision for approval</Link>.
            </p>
          )}
        </form>
      ) : (
        <NotPermitted>The selected role cannot list departments, locations and designations, so it cannot add a budget line here.</NotPermitted>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: one budget line (summary, the revision in progress, a new revision, the revision history)
// ---------------------------------------------------------------------------------------------------------

function BudgetDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(BUDGET_READ)) {
    return (
      <>
        <h1>Manpower budget</h1>
        <NotPermitted>The selected role cannot view manpower budgets.</NotPermitted>
      </>
    );
  }
  if (!UUID.test(id)) {
    return (
      <>
        <p style={FLUSH}>
          <Link to={PATHS.budgets}>Back to manpower budgets</Link>
        </p>
        <h1>Manpower budget</h1>
        <Empty>This budget line is not available in the selected role’s scope.</Empty>
      </>
    );
  }
  return <BudgetDetailView key={id} id={id} />;
}

type BudgetCommand =
  | { kind: 'revision-create'; body: { headcount: number; reason: string } }
  | { kind: 'revision-update'; revisionId: string; body: { headcount: number; reason: string; expectedVersion: number } }
  | { kind: 'revision-submit'; revisionId: string; expectedVersion: number }
  | { kind: 'revision-withdraw'; revisionId: string };

function BudgetDetailView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.budget(id), queryFn: () => api<BudgetDetail>(`/v1/hiring/budgets/${encodeURIComponent(id)}`), retry: retryTransient });
  const b = shown(detail);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** A new revision saved starts its form clean. */
  const [formKey, setFormKey] = useState(0);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.budgets });
    void qc.invalidateQueries({ queryKey: keys.budgetTasks });
  };
  const run = useMutation({
    mutationFn: (c: BudgetCommand): Promise<unknown> => {
      switch (c.kind) {
        case 'revision-create':
          return api<RevisionSaved>(`/v1/hiring/budgets/${encodeURIComponent(id)}/revisions`, { body: c.body });
        case 'revision-update':
          return api<RevisionSaved>(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}`, { method: 'PUT', body: c.body });
        case 'revision-submit':
          return api(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}/submit`, { body: { expectedVersion: c.expectedVersion } });
        case 'revision-withdraw':
          return api(`/v1/hiring/budget-revisions/${encodeURIComponent(c.revisionId)}/withdraw`, { method: 'POST' });
      }
    },
    onMutate: () => setNotice(null),
    onSuccess: (result, c) => {
      refresh();
      switch (c.kind) {
        case 'revision-create': {
          const saved = result as RevisionSaved;
          setFormKey((k) => k + 1);
          setNotice(`Draft revision${saved.revision === undefined ? '' : ` ${saved.revision}`} saved with headcount ${saved.headcount}. Submit it for approval when it is ready.`);
          break;
        }
        case 'revision-update':
          setEditing(false);
          setNotice(`Draft revision saved with headcount ${(result as RevisionSaved).headcount}.`);
          break;
        case 'revision-submit':
          setEditing(false);
          setNotice('Revision submitted. An independent HR Administrator approves or rejects it; the headcount in force changes only when it is approved.');
          break;
        case 'revision-withdraw':
          setEditing(false);
          setNotice('Revision withdrawn.');
          break;
      }
    },
    onError: (error) => {
      if (isConflict(error) || isNotFound(error)) refresh();
    },
  });

  const reloading = detail.isFetching && !detail.isPending;
  const busy = run.isPending || reloading;
  const myUserId = me?.userId ?? null;
  const open = b?.openRevision ?? null;
  const openRow = open ? b?.revisions.find((x) => x.revisionId === open.revisionId) : undefined;
  const mine = !!openRow && myUserId !== null && openRow.preparedBy === myUserId;
  const canManage = can(BUDGET_MANAGE);

  return (
    <>
      <p style={FLUSH}>
        <Link to={PATHS.budgets}>Back to manpower budgets</Link>
      </p>
      <h1>Manpower budget</h1>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {detail.isPending && <p className="hint">Loading the budget line…</p>}
      {isForbidden(detail.error) ? (
        <NotPermitted>The selected role cannot view this budget line.</NotPermitted>
      ) : isNotFound(detail.error) ? (
        <Empty>This budget line is not available in the selected role’s scope.</Empty>
      ) : (
        <ErrorNote error={detail.error} />
      )}
      {b && (
        <>
          <Section title={lineLabel(b)}>
            <dl className="kv">
              <Item term="Department">{b.departmentName}</Item>
              <Item term="Location">{b.locationName}</Item>
              <Item term="Designation">{b.designationName}</Item>
              <Item term="Period">{periodText(b)}</Item>
              <Item term="Headcount in force">{b.approvedHeadcount ?? 'None approved yet'}</Item>
              <Item term="Committed">{b.committed}</Item>
            </dl>
            <p className="hint">Committed counts the vacancies of approved requisitions on this line, plus the placements of closed ones.</p>
          </Section>

          {open && (
            <Section title={`Revision ${open.revision} in progress`}>
              <dl className="kv">
                <Item term="Headcount">{open.headcount}</Item>
                <Item term="State">
                  <StateBadge state={open.state} />
                </Item>
                {openRow && <Item term="Reason">{openRow.reason}</Item>}
                {openRow && <Item term="Prepared by">{byWhom(openRow.preparedBy, myUserId)}</Item>}
              </dl>
              {open.state === 'SUBMITTED' && <p className="hint">Waiting for an independent HR Administrator’s decision.</p>}
              {canManage && openRow && !mine && <p className="hint">Another HR user prepared this revision; only they can change, submit or withdraw it.</p>}
              {canManage && openRow && mine && (
                <>
                  <div className="row">
                    {open.state === 'DRAFT' && (
                      <>
                        <button type="button" className="secondary" aria-expanded={editing} disabled={busy} onClick={() => setEditing((v) => !v)}>
                          Change draft
                        </button>
                        <button type="button" disabled={busy} onClick={() => run.mutate({ kind: 'revision-submit', revisionId: openRow.revisionId, expectedVersion: openRow.version })}>
                          Submit for approval
                        </button>
                      </>
                    )}
                    <button type="button" className="danger" disabled={busy} onClick={() => run.mutate({ kind: 'revision-withdraw', revisionId: openRow.revisionId })}>
                      Withdraw revision
                    </button>
                  </div>
                  {editing && open.state === 'DRAFT' && (
                    <RevisionForm
                      label={`Change draft revision ${open.revision}`}
                      initial={{ headcount: openRow.headcount, reason: openRow.reason }}
                      submitLabel="Save draft"
                      busy={busy}
                      onSubmit={(body) => run.mutate({ kind: 'revision-update', revisionId: openRow.revisionId, body: { ...body, expectedVersion: openRow.version } })}
                      onCancel={() => setEditing(false)}
                    />
                  )}
                </>
              )}
            </Section>
          )}

          {!open && canManage && (
            <Section title="New revision">
              <p className="hint">A revision changes the headcount in force only once an independent HR Administrator approves it.</p>
              <RevisionForm
                key={formKey}
                label="New revision"
                initial={null}
                submitLabel="Save draft revision"
                busy={busy}
                onSubmit={(body) => run.mutate({ kind: 'revision-create', body })}
              />
            </Section>
          )}

          <Refusal error={run.error} action={run.variables?.kind ?? 'revision-update'} />

          <Section title="Revision history">
            {b.revisions.length === 0 ? (
              <Empty>No revisions recorded yet.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Revision history">
                  <thead>
                    <tr>
                      <th scope="col">Revision</th>
                      <th scope="col">Headcount</th>
                      <th scope="col">Reason</th>
                      <th scope="col">State</th>
                      <th scope="col">Prepared by</th>
                      <th scope="col">Submitted</th>
                      <th scope="col">Decided</th>
                      <th scope="col">Decided by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.revisions.map((v) => (
                      <tr key={v.revisionId}>
                        <td>{v.revision}</td>
                        <td>{v.headcount}</td>
                        <td>{v.reason}</td>
                        <td>
                          <StateBadge state={v.state} />
                        </td>
                        <td>{byWhom(v.preparedBy, myUserId)}</td>
                        <td>
                          <When at={v.submittedAt} />
                        </td>
                        <td>
                          <When at={v.decidedAt} />
                        </td>
                        <td>{byWhom(v.decidedBy, myUserId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function RevisionForm({
  label,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: { headcount: number; reason: string } | null;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: { headcount: number; reason: string }) => void;
  onCancel?: () => void;
}) {
  const [headcount, setHeadcount] = useState(initial ? String(initial.headcount) : '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = headcount.trim();
    const text = reason.trim();
    const missing = !wholeNumber(count, 0) ? 'Enter the headcount as a whole number (0 or more).' : !text ? 'Enter the reason for the revision.' : null;
    setProblem(missing);
    if (missing !== null || busy) return;
    onSubmit({ headcount: Number(count), reason: text });
  };
  return (
    <form className="grid-form" aria-label={label} onSubmit={submit} noValidate style={SPACED}>
      <label>
        Headcount
        <input type="number" required min={0} step={1} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
      </label>
      <label className="wide">
        Reason (required)
        <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide row">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Decision queue: manpower budget revisions (FR-011: an independent HR Administrator approves or rejects)
// ---------------------------------------------------------------------------------------------------------

function BudgetDecisionQueue() {
  const { can } = useSession();
  return can(BUDGET_APPROVE) ? <BudgetQueue /> : null;
}

function BudgetQueue() {
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.budgetTasks, queryFn: () => api<{ items: BudgetTask[] }>('/v1/hiring/budget-tasks'), retry: retryTransient });
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  const finished = (t: BudgetTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.budgetTasks });
    void qc.invalidateQueries({ queryKey: keys.budgets });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Manpower budget approvals" tabIndex={-1}>
      <Section title={`Manpower budget approvals${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Budget revisions prepared by other HR users wait here. Approving puts the revision’s headcount in force; rejecting is final and needs a reason.</p>
        {tasks.isPending && <p className="hint">Loading the revisions waiting for you…</p>}
        {isForbidden(tasks.error) ? <NotPermitted>The selected role cannot decide manpower budgets.</NotPermitted> : <ErrorNote error={tasks.error} />}
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {data && items.length === 0 && <Empty>No budget revisions are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Budget revisions waiting for your decision">
            {items.map((t) => (
              <BudgetTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function BudgetTaskItem({ task: t, onFinished }: { task: BudgetTask; onFinished: (t: BudgetTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const v = t.revision;
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = useRef<{ decision: string; reason: string; key: string } | null>(null);
  const subject = v ? `revision ${v.revision} for ${lineLabel(v)}` : 'the revision';
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }) =>
      api<BudgetDecided>(`/v1/hiring/budget-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      const text = result.replayed
        ? `Your earlier decision on ${subject} had already been recorded, so nothing was applied twice.`
        : result.state === 'APPROVED'
          ? v
            ? `Approved ${subject}: headcount ${v.headcount} is now in force.`
            : `Approved ${subject}.`
          : `Rejected ${subject}; the headcount in force is unchanged.`;
      onFinished(t, text, true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'budget-decide') ?? error.message, false);
      // The revision changed while the decision was recorded (nothing was): reload it, as the refusal says.
      else if (error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.budgetTasks });
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (busy || !v) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) {
      setProblem('Enter a reason to reject the revision.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('hiring-budget');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {v ? `Revision ${v.revision}: ${lineLabel(v)}` : 'Budget revision'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        Assigned <When at={t.assignedAt} />
      </p>
      {v ? (
        <>
          <dl className="kv">
            <Item term="Period">{periodText(v)}</Item>
            <Item term="Proposed headcount">{v.headcount}</Item>
            <Item term="Headcount in force">{v.approvedHeadcount ?? 'None approved yet'}</Item>
            <Item term="Committed">{v.committed}</Item>
            <Item term="Reason">{v.reason}</Item>
            <Item term="Submitted">
              <When at={v.submittedAt} />
            </Item>
          </dl>
          {can(BUDGET_READ) && (
            <div>
              <Link to={PATHS.budget(v.id)}>Open the budget line</Link>
            </div>
          )}
          <label>
            Decision reason (required to reject)
            <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject
            </button>
          </div>
          <Refusal error={decide.error} action="budget-decide" />
        </>
      ) : (
        <Empty>This revision is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/** Screens of hiring part 1; detail screens are reached through links (nav: false). */
export const HIRING_REQUISITIONS_SCREENS: ScreenRoute[] = [
  { path: PATHS.requisitions, title: 'Requisitions', permission: REQ_READ, nav: true, component: RequisitionsScreen },
  { path: PATHS.newRequisition, title: 'New requisition', permission: REQ_CREATE, nav: false, component: NewRequisitionScreen },
  { path: '/hiring/requisitions/:id', title: 'Requisition', permission: REQ_READ, nav: false, component: RequisitionDetailScreen },
  { path: PATHS.budgets, title: 'Manpower budgets', permission: BUDGET_READ, nav: true, component: BudgetsScreen },
  { path: '/hiring/budgets/:id', title: 'Manpower budget', permission: BUDGET_READ, nav: false, component: BudgetDetailScreen },
];

/** Hiring serves no H3 My ESS tab (TN01-TN18), and its registration declares no essTabs. */
export const HIRING_REQUISITIONS_ESS_PANELS: EssPanel[] = [];

/**
 * The decision queues, also shown on the budget and requisition screens. Requisition tasks are listed by
 * GET /v1/hiring/requisition-tasks (requisition.read) and decided with their F1 step's own duty, so each step has its
 * own queue gated by that duty: validation (requisition.validate) and budget and headcount approval
 * (requisition.approve). A role holding neither (a Recruiter) is offered no requisition queue.
 */
export const HIRING_REQUISITIONS_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: BUDGET_APPROVE, title: 'Manpower budget approvals', component: BudgetDecisionQueue },
  { permission: REQ_VALIDATE, title: 'Requisition validations', component: RequisitionValidationQueue },
  { permission: REQ_APPROVE, title: 'Requisition budget and headcount approvals', component: RequisitionApprovalQueue },
];
