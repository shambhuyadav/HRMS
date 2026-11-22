// Shared by the confirmation screens: permission keys, limits and views, the API's shapes, query keys and helpers.
import { useMemo } from 'react';
import { api, formatDate, readable } from '../../api';
import { useSession } from '../../session';
import { Badge } from '../../ui';

export const READ = 'confirmation.read.operational';
export const MANAGE = 'confirmation.manage.operational';
export const RECOMMEND = 'confirmation.recommend.operational';
export const DECIDE = 'confirmation.decide.operational';
export const EXPORT = 'confirmation.export.operational';
export const PROPOSE_EXCEPTION = 'confirmation.propose_exception.operational';
export const APPROVE_EXCEPTION = 'confirmation.approve_exception.operational';
export const LIST_EMPLOYEES = 'employee.list.operational';
export const MANAGE_POLICIES = 'confirmation_policy.manage.operational';
export const POLICIES_PATH = '/confirmations/policies';

/** GET /v1/confirmation-exceptions/pending answers with the oldest 200 waiting proposals at most. */
export const PENDING_LIMIT = 200;

/** GET /v1/employees accepts page sizes of 25, 50 or 100 only. */
const EMPLOYEE_PAGE_SIZE = 25;
/** The extension range the recommendation endpoint accepts. */
export const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1));

/**
 * The views GET /v1/confirmations accepts. Cases also carry LATER, CANCELLED and NOT_ON_PROBATION (a live case left over
 * for an employee who is no longer on probation, which is not due); those appear under All only.
 * EXTENDED is a filter of its own (I-36): live cases extended at least once, which also keep their date view.
 */
export type TabView = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'EXTENDED' | 'CONFIRMED' | 'ALL';
type CountedView = Exclude<TabView, 'ALL' | 'EXTENDED'>;

export const TABS: readonly { view: TabView; label: string; empty: string }[] = [
  { view: 'UPCOMING', label: 'Upcoming', empty: 'No confirmations are coming up.' },
  { view: 'DUE', label: 'Due', empty: 'No confirmations are due today.' },
  { view: 'OVERDUE', label: 'Overdue', empty: 'No confirmations are overdue.' },
  { view: 'EXTENDED', label: 'Extended', empty: 'No case still open or under review has been extended.' },
  { view: 'CONFIRMED', label: 'Confirmed', empty: 'No confirmed cases yet.' },
  { view: 'ALL', label: 'All', empty: 'No confirmation cases in the selected role’s scope yet.' },
];
const COUNTED: ReadonlySet<string> = new Set<CountedView>(['UPCOMING', 'DUE', 'OVERDUE', 'CONFIRMED']);
/** Views whose cases span several date views, so each row shows its own timing. */
export const MIXED_TIMING: ReadonlySet<TabView> = new Set<TabView>(['ALL', 'EXTENDED']);

export interface ConfirmationCase {
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

export interface CaseAction {
  action: string;
  priorDueDate: string | null;
  newDueDate: string | null;
  actualConfirmationDate: string | null;
  /** Confidential: present only when the selected assignment is granted confirmation.read.reason. */
  reason?: string;
  occurredAt: string;
}

export interface CaseDetail extends ConfirmationCase {
  actions: CaseAction[];
  /** False when the selected role has no confirmation history grant (C6): the actions are withheld, not absent. */
  historyIncluded?: boolean;
}

export type RecommendationBody =
  | { expectedVersion: number; recommendation: 'CONFIRM'; effectiveDate: string; reason: string }
  | { expectedVersion: number; recommendation: 'EXTEND'; extensionMonths: number; reason: string };

export type ExceptionKind = 'DUE_DATE_OVERRIDE' | 'EXTRA_EXTENSION';

/** A DF11 exception as GET /v1/confirmations/:id/exceptions lists it (oldest first). */
export interface CaseException {
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
export interface PendingException extends CaseException {
  ownProposal: boolean;
}

/** POST /v1/confirmations/:id/exceptions: an override carries its new due date, an extra extension has none. */
export type ExceptionBody = { kind: 'DUE_DATE_OVERRIDE'; proposedDueDate: string; reason: string } | { kind: 'EXTRA_EXTENSION'; reason: string };
export type ExceptionDecision = 'APPROVE' | 'REJECT';
/** POST /v1/confirmation-exceptions/:id/decision: the key lets a retry of this very decision be answered, not re-applied. */
export type DecisionBody = { decision: ExceptionDecision; reason: string; idempotencyKey: string };

export interface ExceptionDecided {
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

export interface AttentionList {
  items: AttentionItem[];
  total: number;
  /** The check stopped at its technical bound before every candidate was examined. */
  truncated: boolean;
}

/** What each attention issue (modules/confirmation/service.ts attentionList) means; any other code is shown as sent. */
export const ISSUE_TEXT: Record<string, string> = {
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
export function useKeys() {
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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asTabView(value: string | null): TabView {
  const upper = value?.toUpperCase();
  return TABS.find((t) => t.view === upper)?.view ?? 'ALL';
}

export const outcomeLabel = (code: string) => OUTCOME_LABEL[code] ?? readable(code);
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? readable(kind);

/** The signed-in user's id: GET /v1/me/context returns it with the role context, which the session keeps as `me`. */
export function useUserId(): string | null {
  const { me } = useSession();
  return me && 'userId' in me && typeof me.userId === 'string' ? me.userId : null;
}

export type ExceptionAction = 'propose' | 'decide' | 'withdraw';

/**
 * What a decision did, in the API's own terms: the state it recorded and the change it applied. A replayed answer (a
 * retry of a decision whose first answer was lost) carries no change; the case reloads to show where it stands.
 */
export function decidedText(x: PendingException, result: ExceptionDecided): string {
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

export const fetchCases = (view: TabView) => api<CaseList>(`/v1/confirmations?view=${view}`);

/** Tab counts come from the All list: every case carries the view the server derived for it, and its extended flag. */
export function countByView(all: CaseList): Record<TabView, number> {
  const counts: Record<TabView, number> = { UPCOMING: 0, DUE: 0, OVERDUE: 0, EXTENDED: 0, CONFIRMED: 0, ALL: all.total };
  for (const c of all.items) {
    if (COUNTED.has(c.view)) counts[c.view as CountedView] += 1;
    if (c.extended) counts.EXTENDED += 1;
  }
  return counts;
}

export function employeeSearch(term: string, probationOnly: boolean): string {
  const query = new URLSearchParams({ search: term, page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) });
  if (probationOnly) query.set('status', 'ACTIVE_PROBATION');
  return query.toString();
}

export const viewButtonId = (caseId: string) => `confirmation-view-${caseId}`;

/** The tone of a timing that needs attention: overdue is late, due (or no longer on probation) needs acting on now. */
const TIMING_TONE: Readonly<Record<string, 'bad' | 'warn'>> = { OVERDUE: 'bad', DUE: 'warn', NOT_ON_PROBATION: 'warn' };

/** The server-derived timing of a case that is still running; confirmed and cancelled cases say so in their state. */
export function TimingBadge({ view }: { view: string }) {
  if (view === 'CONFIRMED' || view === 'CANCELLED') return null;
  return <Badge tone={TIMING_TONE[view] ?? 'neutral'}>{view.replace(/_/g, ' ').toLowerCase()}</Badge>;
}
