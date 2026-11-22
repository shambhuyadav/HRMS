// Shared by the requisition and budget screens: permission keys, paths and limits, the API shapes, query keys, layout classes and
// helpers.
import { useMemo } from 'react';
import { formatDate, isForbidden, isNotFound, readable } from '../../api';
import { useSession } from '../../session';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/hiring/registration.ts, routes.ts; migration 0034) and screen paths
// ---------------------------------------------------------------------------------------------------------
export const BUDGET_READ = 'manpower_budget.read.operational';
export const BUDGET_MANAGE = 'manpower_budget.manage.operational';
export const BUDGET_APPROVE = 'manpower_budget.approve.operational';
export const REQ_READ = 'requisition.read.operational';
export const REQ_CREATE = 'requisition.create.operational';
export const REQ_VALIDATE = 'requisition.validate.operational';
export const REQ_APPROVE = 'requisition.approve.operational';
export const REQ_CLOSE = 'requisition.close.operational';
/** GET /v1/org/:kind: the department, location and designation masters. */
export const ORG_READ = 'org_master.read.operational';
/** GET /v1/employees: the hiring manager search (a manager sees their direct reports). */
export const EMPLOYEE_LIST = 'employee.list.operational';

export const PATHS = {
  requisitions: '/hiring/requisitions',
  newRequisition: '/hiring/requisitions/new',
  requisition: (id: string) => `/hiring/requisitions/${id}`,
  budgets: '/hiring/budgets',
  budget: (id: string) => `/hiring/budgets/${id}`,
} as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the requisition routes accept as an employment type: the code of an active EMPLOYMENT_TYPE value. */
export const EMPLOYMENT_TYPE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const WHOLE = /^\d{1,10}$/;
const MAX_INT = 2147483647;
/** GET /v1/hiring/requisitions accepts these page sizes only. */
export const PAGE_SIZES = [25, 50, 100] as const;
/** The F1 requisition states the list filter accepts. */
export const REQUISITION_STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CLOSED'] as const;
/** GET /v1/hiring/budgets answers with the first 500 lines at most (no paging). */
export const BUDGET_LIST_LIMIT = 500;
/** The page the form reads to offer known masters when the role cannot list them (see useMasterOptions). */
export const KNOWN_QUERY = 'page=1&pageSize=100';
/**
 * The EMPLOYMENT_TYPE values every company starts with (DF04). No route lists a company's active values, so these are
 * suggestions only and any code may be typed; the server refuses one that is not active.
 */
export const EMPLOYMENT_TYPE_SUGGESTIONS: readonly (readonly [code: string, label: string])[] = [
  ['PERMANENT', 'Permanent'],
  ['FIXED_TERM', 'Fixed term'],
  ['INTERN', 'Intern'],
  ['CONTRACTOR', 'Contractor'],
];

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/hiring/requisition.ts, budget.ts, common.ts)
// ---------------------------------------------------------------------------------------------------------
export type MasterKind = 'departments' | 'locations' | 'designations';

interface Named {
  id: string;
  name: string;
}
export interface Person {
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

export interface BudgetCheck {
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}

export interface Requisition {
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
  /** DF03: the rejected requisition this one raises again. */
  predecessorRequestId?: string | null;
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
export interface RequisitionRevision {
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

export interface DecisionRecord {
  revision: number;
  step: number;
  action: string;
  decision: string;
  reason: string | null;
  decidedAt: string;
  decidedBy: UserRef;
  /** I-57 item 7: the delegator a delegate decided for (null when decided in the decider's own right). */
  onBehalfOf?: UserRef | null;
}

interface PendingWith {
  taskId: string;
  step: number;
  action: string;
  assignee: UserRef;
  assignedAt: string;
}

export interface RequisitionDetail extends Requisition {
  /** The budget check now; present while the requisition is a draft or waiting for a decision. */
  budgetCheck: BudgetCheck | null;
  revisions: RequisitionRevision[];
  decisions: DecisionRecord[];
  pendingWith: PendingWith | null;
}

export interface RequisitionPage {
  items: Requisition[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST and PUT /v1/hiring/requisitions (the FR-011 fields). */
export interface RequisitionInput {
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

export interface SubmitResult {
  requisitionId: string;
  state: string;
  revision: number;
  budgetStatus: string;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}

export interface RequisitionTask {
  taskId: string;
  transactionId: string;
  step: number;
  /** validate (step 1) or approve (step 2). */
  stepAction: string;
  assignedAt: string;
  requisition: RequisitionDetail | null;
}

export interface RequisitionDecisionBody {
  decision: 'APPROVE' | 'RETURN' | 'REJECT';
  reason?: string;
  approveBudgetException?: true;
  idempotencyKey: string;
}

export interface RequisitionDecided {
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

export interface Budget {
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

export interface BudgetDetail extends Budget {
  revisions: BudgetRevision[];
}

/** POST /v1/hiring/budgets and /v1/hiring/budgets/:id/revisions; PUT /v1/hiring/budget-revisions/:id. */
export interface RevisionSaved {
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

export interface BudgetTask {
  taskId: string;
  transactionId: string;
  assignedAt: string;
  revision: BudgetTaskRevision | null;
}

export interface BudgetDecided {
  revisionId: string;
  state: string;
  replayed: boolean;
}

export interface MasterItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
}

export interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
  assignment: { departmentId: string; departmentName: string; locationId: string; locationName: string; designationId: string; designationName: string } | null;
}

export interface Option {
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
export function useKeys() {
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

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

export const REASON_TYPE_LABEL: Record<string, string> = { NEW: 'New position', REPLACEMENT: 'Replacement' };
const BUDGET_STATUS_LABEL: Record<string, string> = { WITHIN_BUDGET: 'Within budget', EXCEEDS_BUDGET: 'Exceeds budget', NO_BUDGET: 'No budget' };
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', REJECT: 'Rejected', RETURN: 'Returned for changes' };
const STEP_LABEL: Record<string, string> = { validate: 'Validation', approve: 'Budget and headcount approval' };

export const stepText = (step: number, action: string) => `Step ${step}: ${STEP_LABEL[action] ?? readable(action)}`;
export const budgetStatusText = (status: string) => BUDGET_STATUS_LABEL[status] ?? readable(status);
export const personLabel = (p: Person) => `${p.displayName} (${p.employeeCode})`;
export const lineLabel = (b: Pick<Budget, 'departmentName' | 'locationName' | 'designationName'>) => `${b.departmentName}, ${b.locationName}, ${b.designationName}`;
export const periodText = (b: Pick<Budget, 'periodStart' | 'periodEnd'>) => `${formatDate(b.periodStart)} to ${formatDate(b.periodEnd)}`;

/** A decider or assignee by the identity the server returned; "You" for the signed-in user. */
export function userLabel(u: UserRef, myUserId: string | null): string {
  if (myUserId !== null && u.userId === myUserId) return 'You';
  if (u.displayName) return u.employeeCode ? `${u.displayName} (${u.employeeCode})` : u.displayName;
  return 'A user without an employee record';
}

/** The same, inside a sentence. */
export const userInSentence = (u: UserRef, myUserId: string | null) => (myUserId !== null && u.userId === myUserId ? 'you' : userLabel(u, null).replace(/^A user/, 'a user'));

/** Budget revisions name their preparer and decider by user id only: the signed-in user or another one. */
export function byWhom(userId: string | null, myUserId: string | null): string {
  if (userId === null) return '—';
  return myUserId !== null && userId === myUserId ? 'You' : 'Another user';
}

export function parseSkills(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export const wholeNumber = (text: string, min: number) => WHOLE.test(text) && Number(text) >= min && Number(text) <= MAX_INT;

