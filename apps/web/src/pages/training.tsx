// Training: plans, participants and feedback (FR-049, FR-050; F1 "Training"; H3 TN17; decision I-26; DF02; DF04; DF09).
//
// Plans are company records kept by a coordinator or HR Administrator in an unrestricted company-scope assignment: title,
// dates, mode and venue, trainer, capacity, cost (company spend, its own field group: shown only when the API returns it,
// zero distinct from no cost) and owner. The FUTURE / CURRENT / PAST view is worked out by the server from the company's
// business date, CANCELLED overriding it; these screens show the view exactly as returned. A cancellation records a reason.
// Participants are nominated (never twice for one session), confirmed within capacity (the server refuses a full plan),
// marked attended or no-show from the start date and completed from the end date, or cancelled with a reason, only by the
// coordinator role the API allows and never on one's own participation. No approval workflow exists, so the module has
// no decision queue. The feedback summary reconciles to the participants and shows missing responses distinctly; scores
// are counts only (no averages); comments and participation reasons are confidential and rendered only when returned.
// My ESS TN17 (Employee OWN context): own participations, self-nomination where a plan allows it, withdrawal of an own
// unconfirmed self-nomination, and own feedback (a score 1 to 5 per question, an optional confidential comment) only
// after completion. The employee never marks attendance or completion. The server authorises every call and decides
// every rule; these screens hide what the selected assignment cannot use and render only what the API returned.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, formatAmount, formatDate } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { type MeContext, useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/training/registration.ts, routes.ts; migration 0036_training.sql) and screen paths
// ---------------------------------------------------------------------------------------------------------
/** GET /v1/training-plans, /:id, /v1/training-modes, /v1/training-feedback-questions. */
const PLAN_READ = 'training_plan.read.operational';
/** POST /v1/training-plans, PATCH /:id, POST /:id/cancel (unrestricted company scope). */
const PLAN_MANAGE = 'training_plan.manage.operational';
/** GET /v1/training-plans/export. */
const PLAN_EXPORT = 'training_plan.export.operational';
/** A cost in a create or change request needs this group as well. */
const COST_MANAGE = 'training_plan.manage.cost';
/** GET /v1/training-plans/:id/participants, /v1/training-participants/:id, /v1/employees/:id/training. */
const PART_READ = 'training_participant.read.operational';
/** POST /v1/training-plans/:id/participants and /participant-actions. */
const PART_MANAGE = 'training_participant.manage.operational';
/** GET /v1/me/training-plans, POST /v1/me/training-nominations and its withdrawal (Employee OWN context). */
const PART_ENROL = 'training_participant.enrol.operational';
/** GET /v1/training-plans/:id/feedback-summary and /feedback; GET /v1/me/training-feedback. */
const FEEDBACK_READ = 'training_feedback.read.operational';
/** POST /v1/me/training-feedback. */
const FEEDBACK_SUBMIT = 'training_feedback.submit.operational';
/** A comment in the own feedback needs this confidential group as well. */
const COMMENT_SUBMIT = 'training_feedback.submit.comment';
/** GET /v1/training-plans/:id/feedback/export. */
const FEEDBACK_EXPORT = 'training_feedback.export.operational';
/** GET /v1/employees: whom to nominate, who owns a plan. */
const EMPLOYEE_LIST = 'employee.list.operational';
/** Own training is served only in the Employee OWN context (BR-055). */
const OWN_ESS_ROLE = 'EMPLOYEE';

const PATHS = {
  plans: '/training/plans',
  plan: (id: string) => `/training/plans/${id}`,
  feedback: (id: string) => `/training/plans/${id}/feedback`,
  participant: (id: string) => `/training/participants/${id}`,
  employee: (id: string) => `/training/employees/${id}`,
} as const;

const PAGE_SIZE = 25;
const VIEWS = ['FUTURE', 'CURRENT', 'PAST', 'CANCELLED'] as const;
const VIEW_LABEL: Record<string, string> = { FUTURE: 'Future', CURRENT: 'Current', PAST: 'Past', CANCELLED: 'Cancelled' };
const VIEW_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { FUTURE: 'neutral', CURRENT: 'good', PAST: 'neutral', CANCELLED: 'bad' };
const STATES = ['NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
const STATE_LABEL: Record<string, string> = {
  NOMINATED: 'Nominated, waiting for confirmation',
  CONFIRMED: 'Confirmed',
  ATTENDED: 'Attended',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
};
const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  NOMINATED: 'warn',
  CONFIRMED: 'good',
  ATTENDED: 'good',
  COMPLETED: 'good',
  NO_SHOW: 'bad',
  CANCELLED: 'neutral',
};
const FEEDBACK_LABEL: Record<string, string> = { RESPONDED: 'Responded', MISSING: 'Missing response', NOT_APPLICABLE: 'Not applicable (not completed)' };
const FEEDBACK_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { RESPONDED: 'good', MISSING: 'warn', NOT_APPLICABLE: 'neutral' };
const HISTORY_LABEL: Record<string, string> = {
  NOMINATE: 'Nominated by the coordinator',
  SELF_NOMINATE: 'Self-nominated',
  CONFIRM: 'Confirmed',
  MARK_ATTENDED: 'Marked attended',
  MARK_NO_SHOW: 'Marked no-show',
  COMPLETE: 'Completed',
  CANCEL: 'Cancelled',
  WITHDRAW: 'Withdrawn by the employee',
  PLAN_CANCELLED: 'Cancelled with the plan',
};
type TransitionAction = 'CONFIRM' | 'MARK_ATTENDED' | 'MARK_NO_SHOW' | 'COMPLETE' | 'CANCEL';
const TRANSITIONS: readonly (readonly [action: TransitionAction, label: string, done: string])[] = [
  ['CONFIRM', 'Confirm', 'confirmed'],
  ['MARK_ATTENDED', 'Mark attended', 'marked attended'],
  ['MARK_NO_SHOW', 'Mark no-show', 'marked no-show'],
  ['COMPLETE', 'Mark completed', 'marked completed'],
  ['CANCEL', 'Cancel participation', 'cancelled'],
];
const SCORES = ['1', '2', '3', '4', '5'] as const;

// ---------------------------------------------------------------------------------------------------------
// Types: exactly what the API returns (modules/training/plans.ts, participants.ts and feedback.ts)
// ---------------------------------------------------------------------------------------------------------
interface Choice {
  code: string;
  label: string;
}
interface Question extends Choice {
  position?: number;
}
interface Cost {
  amount: string;
  currency: string;
}
interface Plan {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  state: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  capacity: number;
  seatsTaken: number;
  seatsAvailable: number;
  nominationsPending: number;
  owner: { employeeId: string; employeeCode: string; name: string };
  selfNomination: boolean;
  cancellation: { cancelledAt: string; cancelledBy: string; reason: string | null; cancelledByName: string | null } | null;
  /** Present only for a caller holding the cost group; null is "no cost", distinct from a zero amount. */
  cost?: Cost | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface PlanDetail extends Plan {
  feedbackQuestions: Question[];
  feedbackRecorded: boolean;
}
interface PlanPage {
  items: Plan[];
  total: number;
  page: number;
  pageSize: number;
  businessDate: string;
}
interface Participant {
  id: string;
  planId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  selfNominated: boolean;
  nominatedAt: string | null;
  confirmedAt: string | null;
  attendanceRecordedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** The confidential reason group: present only for a caller holding the approved grant. */
  cancellationReason?: string | null;
  feedbackStatus: string;
  version: number;
}
interface ParticipantPage {
  items: Participant[];
  total: number;
  page: number;
  pageSize: number;
  scope: { kind: string; companyWide: boolean };
}
interface PlanSummary {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  ownerName: string | null;
}
interface HistoryEntry {
  action: string;
  fromState: string | null;
  toState: string;
  reason?: string | null;
  reasonRecorded: boolean;
  occurredAt: string;
  actorName: string | null;
}
interface ParticipantDetail extends Participant {
  plan: PlanSummary;
  history: HistoryEntry[];
}
interface EmployeeParticipation {
  id: string;
  state: string;
  selfNominated: boolean;
  nominatedAt: string | null;
  confirmedAt: string | null;
  attendanceRecordedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason?: string | null;
  feedbackStatus: string;
  plan: PlanSummary;
}
interface OpenPlan {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
  mode: Choice;
  venue: string | null;
  trainer: string | null;
  ownerName: string | null;
  myParticipation: { participantId: string; state: string; selfNominated: boolean } | null;
}
interface Answer {
  questionCode: string;
  score: number;
  /** The confidential comment: present only for a caller holding the comment group. */
  comment?: string | null;
}
interface OwnFeedback {
  participantId: string;
  completedAt: string | null;
  status: string;
  submittedAt: string | null;
  plan: { id: string; code: string; title: string; startDate: string; endDate: string; view: string };
  questions: Question[];
  answers: Answer[];
}
interface PlanHead {
  id: string;
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  view: string;
}
interface FeedbackSummary {
  plan: PlanHead;
  scope: { kind: string; companyWide: boolean };
  generatedAt: string;
  participants: { total: number; byState: Record<string, number> };
  feedback: { eligible: number; responded: number; missing: number; notApplicable: number };
  questions: { code: string; label: string; position: number; answered: number; scores: Record<string, number>; missing: number }[];
  reconciles: { participants: boolean; responses: boolean; questions: boolean };
}
interface FeedbackRow {
  participantId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  completedAt: string | null;
  feedbackStatus: string;
  submittedAt: string | null;
  answers: Answer[];
}
interface FeedbackRegister {
  plan: PlanHead;
  questions: Question[];
  scope: { kind: string; companyWide: boolean };
  commentsIncluded: boolean;
  items: FeedbackRow[];
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
 * answer given to one assignment (costs, reasons, comments) must never be shown under another.
 */
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['training', context] as const;
    return {
      all: base,
      modes: [...base, 'modes'] as const,
      questions: [...base, 'questions'] as const,
      plans: (query: string) => [...base, 'plans', query] as const,
      plan: (id: string) => [...base, 'plan', id] as const,
      participants: (id: string, query: string) => [...base, 'participants', id, query] as const,
      participant: (id: string) => [...base, 'participant', id] as const,
      employee: (id: string) => [...base, 'employee', id] as const,
      summary: (id: string) => [...base, 'summary', id] as const,
      register: (id: string, status: string) => [...base, 'register', id, status] as const,
      openPlans: [...base, 'open-plans'] as const,
      ownFeedback: [...base, 'own-feedback'] as const,
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

const SCROLL: CSSProperties = { overflowX: 'auto' };
const FLUSH: CSSProperties = { margin: 0 };
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;
const personLabel = (p: { displayName: string; employeeCode: string }) => `${p.displayName} (${p.employeeCode})`;
const participantLabel = (p: { employeeName: string; employeeCode: string }) => `${p.employeeName} (${p.employeeCode})`;
const optional = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
const has = <T extends object>(row: T, key: string) => Object.prototype.hasOwnProperty.call(row, key);

function ViewBadge({ view }: { view: string }) {
  return <Badge tone={VIEW_TONE[view] ?? 'neutral'}>{VIEW_LABEL[view] ?? readable(view)}</Badge>;
}
function ParticipationState({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{STATE_LABEL[state] ?? readable(state)}</Badge>;
}
function FeedbackState({ status }: { status: string }) {
  return <Badge tone={FEEDBACK_TONE[status] ?? 'neutral'}>{FEEDBACK_LABEL[status] ?? readable(status)}</Badge>;
}

/** The plan cost as returned: nothing when the caller has no cost group, "No cost" for null, else the exact amount. */
function CostText({ plan }: { plan: Pick<Plan, 'cost'> }) {
  if (!has(plan, 'cost') || plan.cost === undefined) return null;
  return <>{plan.cost === null ? 'No cost recorded' : formatAmount(plan.cost.amount, plan.cost.currency)}</>;
}

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'read' | 'create' | 'update' | 'cancel' | 'nominate' | 'transition' | 'enrol' | 'withdraw' | 'feedback' | 'export';

/** Actions the server recognises when sent again (same state, same answers, plan codes never reused): never applied twice. */
const REPEATABLE_ACTS: readonly Act[] = ['cancel', 'nominate', 'transition', 'enrol', 'withdraw', 'feedback', 'create'];

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act, nameOf?: (employeeId: string) => string | undefined): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    return REPEATABLE_ACTS.includes(action)
      ? 'No answer came back, so this may or may not have been recorded. Send it again unchanged: the server never applies it twice.'
      : 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';
  }
  const details = (error.details ?? {}) as { field?: string; employeeId?: string; state?: string; capacity?: number; seatsTaken?: number; requested?: number; limit?: number };
  const who = details.employeeId ? (nameOf?.(details.employeeId) ?? 'One of the chosen employees') : 'The employee';
  const stateWord = details.state ? (STATE_LABEL[details.state] ?? readable(details.state)).toLowerCase() : null;
  switch (error.code) {
    case 'FORBIDDEN':
      return action === 'create' || action === 'update' || action === 'cancel'
        ? 'The selected role is not permitted to do this. Training plans are maintained only in an unrestricted company-scope assignment, and a cost needs the cost permission as well.'
        : action === 'feedback'
          ? 'The selected role is not permitted to do this. A comment needs the comment permission; you can send the scores without one.'
          : 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (action === 'enrol') return 'This training is no longer open for self-nomination.';
      if (action === 'nominate' || action === 'transition') return 'A chosen employee or participation is not available in the selected role’s scope.';
      if (action === 'withdraw' || action === 'feedback') return 'This participation is not available.';
      return 'This training record is not available in the selected role’s scope.';
    case 'EMPLOYEE_CONTEXT_REQUIRED':
      return 'Select your Employee role to work on your own training.';
    case 'INVALID_PLAN_CODE':
      return 'Use 1 to 40 letters, digits, dots, dashes, slashes or underscores for the plan code.';
    case 'PLAN_CODE_EXISTS':
      return 'A plan with this code already exists. Plan codes are permanent and never reused.';
    case 'INVALID_TITLE':
      return 'Give the course title.';
    case 'END_BEFORE_START':
      return 'The end date cannot be before the start date.';
    case 'INVALID_DATE':
      return 'Enter a valid calendar date.';
    case 'INVALID_PERIOD':
      return 'The period end is before its start.';
    case 'INVALID_MODE':
      return 'Choose an active training mode from the list.';
    case 'INVALID_COST':
      return 'The cost is a non-negative amount with at most two decimals.';
    case 'INVALID_CURRENCY':
      return 'The cost currency is a three-letter code, such as INR.';
    case 'INVALID_OWNER':
      return 'The plan owner must be an active employee of the company.';
    case 'NO_FEEDBACK_QUESTIONS':
      return 'The company has no active training feedback question yet. Ask for the feedback question list to be configured first.';
    case 'INVALID_QUESTIONS':
    case 'INVALID_QUESTION':
      return 'Choose 1 to 20 active feedback questions, each once.';
    case 'PLAN_CANCELLED':
      return 'The plan is cancelled. A cancelled plan and its participations are final.';
    case 'STALE_VERSION':
      return 'The plan changed since it was loaded. Reload the page, check it and try again.';
    case 'DATES_FIXED':
      return 'Attendance was recorded for this plan, so its dates are fixed.';
    case 'CAPACITY_BELOW_SEATS':
      return `The capacity cannot be lower than the ${details.seatsTaken ?? 'confirmed'} places already taken.`;
    case 'QUESTIONS_FIXED':
      return 'Feedback was recorded for this plan, so its questions are fixed.';
    case 'NO_CHANGE':
      return 'Nothing differs from the plan.';
    case 'PLAN_HAS_ATTENDANCE':
      return 'Attendance was recorded for this plan: the session took place, so it cannot be cancelled.';
    case 'REASON_REQUIRED':
      if (action === 'cancel') return 'Record why the plan is cancelled.';
      if (action === 'withdraw') return 'Record why you withdraw.';
      return 'Record a reason: cancelling a participation, or correcting recorded attendance, needs one.';
    case 'PARTICIPANT_EXISTS':
      return action === 'enrol'
        ? `You already take part in this training${stateWord ? ` (${stateWord})` : ''}.`
        : `${who} already takes part in this training${stateWord ? ` (${stateWord})` : ''}. An employee is never added twice to one session.`;
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'enrol' ? 'Only active employees can nominate themselves.' : `${who} is not active. Only active employees are nominated and confirmed.`;
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot nominate, confirm or record your own participation: another coordinator does that.';
    case 'INVALID_TRANSITION':
      return `A participation that is ${stateWord ?? 'in its current state'} cannot take this action.`;
    case 'SESSION_NOT_STARTED':
      return 'Attendance is recorded from the start date of the session.';
    case 'SESSION_NOT_ENDED':
      return 'Completion is recorded from the end date of the session.';
    case 'PLAN_FULL':
      return `The plan is full: ${details.seatsTaken ?? '?'} of ${details.capacity ?? '?'} places are taken and ${details.requested ?? 'more'} confirmation${details.requested === 1 ? ' was' : 's were'} asked for. Confirm fewer or raise the capacity.`;
    case 'PLAN_ENDED':
      return 'The training session has ended.';
    case 'CANCELLED_BY_COORDINATOR':
      return 'Your participation was cancelled by the training coordinator. Ask them to nominate you again.';
    case 'NOT_WITHDRAWABLE':
      return 'Only a nomination waiting for confirmation can be withdrawn. Ask the training coordinator.';
    case 'NOT_SELF_NOMINATED':
      return 'You were nominated by the training coordinator. Ask them to cancel it.';
    case 'FEEDBACK_NOT_OPEN':
      return 'Feedback opens once your completion of the training is recorded.';
    case 'ANSWERS_MISMATCH':
      return 'Answer each question of the training once.';
    case 'SCORE_REQUIRED':
      return 'Give a score from 1 to 5 for each question.';
    case 'INVALID_SCORE':
      return 'A score is a whole number from 1 to 5.';
    case 'FEEDBACK_ALREADY_SUBMITTED':
      return 'Your feedback for this training was already recorded and cannot be changed.';
    case 'EXPORT_TOO_LARGE':
    case 'TOO_MANY_ROWS':
      return `At most ${details.limit ?? 10000} rows are produced at once. Narrow the selection with the filters.`;
    case 'RULE_VIOLATION':
      return action === 'transition' ? 'The change breaks a training rule (for example the plan capacity). Reload and check the participants.' : null;
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return details.field ? `Check the ${readable(details.field).toLowerCase()} field. ${error.message}` : null;
  }
}

function Refusal({ error, action, nameOf }: { error: unknown; action: Act; nameOf?: (employeeId: string) => string | undefined }) {
  if (!error) return null;
  const text = refusalText(error, action, nameOf);
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

function Pager({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager" role="navigation" aria-label={label}>
      <button type="button" className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous page
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button type="button" className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next page
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Lookups: training modes and feedback questions (DF04 controlled lists) and employees
// ---------------------------------------------------------------------------------------------------------
function useChoices(kind: 'modes' | 'questions', enabled: boolean) {
  const keys = useKeys();
  return useQuery({
    queryKey: kind === 'modes' ? keys.modes : keys.questions,
    queryFn: () => api<{ items: Choice[] }>(kind === 'modes' ? '/v1/training-modes' : '/v1/training-feedback-questions'),
    enabled,
    retry: retryTransient,
    staleTime: 60_000,
  });
}

/** Finds employees by search (the server checks row scope and status, and refuses one's own record). */
function EmployeeSearch({ label, onPick, exclude = [] }: { label: string; onPick: (e: EmployeeHit) => void; exclude?: string[] }) {
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
  if (!canSearch) return <NotPermitted>The selected role cannot search employees.</NotPermitted>;
  const found = term !== '' ? shown(hits) : undefined;
  const items = found?.items.filter((e) => !exclude.includes(e.id));
  return (
    <div className="wide">
      <label>
        {label}
        <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
      </label>
      {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
      <QueryProblem error={hits.error} forbidden="The selected role cannot search employees." />
      {items && items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {items && items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-label={`Choose ${personLabel(e)}`}
                onClick={() => {
                  onPick(e);
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

/** The plan owner: an employee found by search, or the signed-in user's own employee record. */
function OwnerPicker({ value, onChange }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void }) {
  const { me } = useSession();
  return (
    <div className="wide">
      <p style={FLUSH}>
        Plan owner: <strong>{value ? value.label : 'nobody chosen yet'}</strong>{' '}
        {value && (
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Clear the owner
          </button>
        )}{' '}
        {me?.employeeId && value?.id !== me.employeeId && (
          <button type="button" className="secondary" onClick={() => onChange({ id: me.employeeId!, label: me.displayName ?? 'Me' })}>
            Make me the owner
          </button>
        )}
      </p>
      <EmployeeSearch label="Find the owner" onPick={(e) => onChange({ id: e.id, label: personLabel(e) })} />
    </div>
  );
}

function QuestionChoice({ questions, chosen, onChange, legend }: { questions: Choice[] | undefined; chosen: string[]; onChange: (codes: string[]) => void; legend: string }) {
  if (!questions) return <p className="hint wide">Loading the feedback questions…</p>;
  if (questions.length === 0) return <p className="hint wide">The company has no active feedback question yet.</p>;
  return (
    <fieldset className="wide">
      <legend>{legend}</legend>
      {questions.map((q) => (
        <label key={q.code}>
          <input
            type="checkbox"
            checked={chosen.includes(q.code)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, q.code] : chosen.filter((c) => c !== q.code))}
          />{' '}
          {q.label}
        </label>
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Plans register (FR-049): views, search and date filters, export, new plans
// ---------------------------------------------------------------------------------------------------------
interface PlanFilters {
  view: string;
  search: string;
  from: string;
  to: string;
  page: number;
}

function planQuery(f: Omit<PlanFilters, 'page'>, page?: number): string {
  const q = new URLSearchParams();
  if (f.view) q.set('view', f.view);
  if (f.search.trim()) q.set('search', f.search.trim());
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (page !== undefined) {
    q.set('page', String(page));
    q.set('pageSize', String(PAGE_SIZE));
  }
  return q.toString();
}

function PlansScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PLAN_READ);
  const [filters, setFilters] = useState<PlanFilters>({ view: '', search: '', from: '', to: '', page: 1 });
  const [typed, setTyped] = useState('');
  const query = planQuery(filters, filters.page);
  const list = useQuery({ queryKey: keys.plans(query), queryFn: () => api<PlanPage>(`/v1/training-plans?${query}`), enabled: allowed, retry: retryTransient });
  const exporter = useMutation({ mutationFn: () => download(`/v1/training-plans/export${planQuery(filters) ? `?${planQuery(filters)}` : ''}`) });
  if (!allowed) return <NotPermitted>The selected role cannot read training plans.</NotPermitted>;
  const data = shown(list);
  const withCost = data?.items.some((p) => has(p, 'cost')) ?? false;
  return (
    <div className="stack">
      <Section
        title="Training plans"
        actions={
          can(PLAN_EXPORT) ? (
            <button type="button" className="secondary" disabled={exporter.isPending} onClick={() => exporter.mutate()}>
              {exporter.isPending ? 'Exporting…' : 'Export (CSV)'}
            </button>
          ) : undefined
        }
      >
        <form
          className="grid-form"
          aria-label="Filter the plans"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ ...filters, search: typed, page: 1 });
          }}
        >
          <label>
            View
            <select value={filters.view} onChange={(e) => setFilters({ ...filters, view: e.target.value, page: 1 })}>
              <option value="">All views</option>
              {VIEWS.map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input type="search" value={typed} maxLength={100} placeholder="Code, title, trainer or venue" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <label>
            From
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value, page: 1 })} />
          </label>
          <label>
            To
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value, page: 1 })} />
          </label>
          <div>
            <button type="submit">Search</button>
          </div>
        </form>
        <p className="hint">
          The view is worked out from the company’s business date{data ? ` (${formatDate(data.businessDate)})` : ''}: future before the start date, current from the start
          to the end date, past after it. A cancelled plan is shown as cancelled whatever its dates.
        </p>
        <Refusal error={exporter.error} action="export" />
        {list.isLoading && <p className="hint">Loading…</p>}
        <QueryProblem error={list.error} forbidden="The selected role cannot read training plans." />
        {data && data.items.length === 0 && <Empty>No training plans match.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Training plans">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Dates</th>
                  <th>View</th>
                  <th>Mode and venue</th>
                  <th>Trainer</th>
                  <th>Places</th>
                  <th>Owner</th>
                  {withCost && <th>Cost</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={PATHS.plan(p.id)}>{p.code}</Link>
                    </td>
                    <td>{p.title}</td>
                    <td>
                      {formatDate(p.startDate)} to {formatDate(p.endDate)}
                    </td>
                    <td>
                      <ViewBadge view={p.view} />
                    </td>
                    <td>
                      {p.mode.label}
                      {p.venue ? ` · ${p.venue}` : ''}
                    </td>
                    <td>{optional(p.trainer)}</td>
                    <td>
                      {p.seatsTaken} of {p.capacity} taken · {p.nominationsPending} waiting for confirmation
                    </td>
                    <td>{p.owner.name}</td>
                    {withCost && (
                      <td>
                        <CostText plan={p} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} label="Plan pages" onPage={(page) => setFilters({ ...filters, page })} />}
      </Section>
      {can(PLAN_MANAGE) && <CreatePlanForm />}
    </div>
  );
}

interface PlanDraft {
  code: string;
  title: string;
  startDate: string;
  endDate: string;
  modeCode: string;
  venue: string;
  trainer: string;
  capacity: string;
  owner: { id: string; label: string } | null;
  selfNomination: boolean;
  questionCodes: string[];
  costAmount: string;
  costCurrency: string;
}

const EMPTY_PLAN: PlanDraft = {
  code: '',
  title: '',
  startDate: '',
  endDate: '',
  modeCode: '',
  venue: '',
  trainer: '',
  capacity: '',
  owner: null,
  selfNomination: false,
  questionCodes: [],
  costAmount: '',
  costCurrency: 'INR',
};

const WHOLE = /^\d{1,9}$/;
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;

function CreatePlanForm() {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const modes = useChoices('modes', true);
  const questions = useChoices('questions', true);
  const withCost = can(COST_MANAGE);
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_PLAN);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<PlanDetail | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PlanDetail>('/v1/training-plans', { method: 'POST', body }),
    onSuccess: (plan) => {
      setCreated(plan);
      setDraft(EMPTY_PLAN);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    const code = draft.code.trim();
    const title = draft.title.trim();
    if (!code || !title || !draft.startDate || !draft.endDate || !draft.modeCode || !draft.capacity.trim() || !draft.owner) {
      setProblem('Enter the code, title, start and end dates, mode, capacity and owner.');
      return;
    }
    if (draft.endDate < draft.startDate) {
      setProblem('The end date cannot be before the start date.');
      return;
    }
    if (!WHOLE.test(draft.capacity.trim()) || Number(draft.capacity.trim()) < 1) {
      setProblem('The capacity is a whole number of places, at least 1.');
      return;
    }
    const amount = draft.costAmount.trim();
    if (withCost && amount && !AMOUNT.test(amount)) {
      setProblem('The cost is a non-negative amount with at most two decimals.');
      return;
    }
    setProblem(null);
    const venue = draft.venue.trim();
    const trainer = draft.trainer.trim();
    create.mutate({
      code,
      title,
      startDate: draft.startDate,
      endDate: draft.endDate,
      modeCode: draft.modeCode,
      ...(venue ? { venue } : {}),
      ...(trainer ? { trainer } : {}),
      capacity: Number(draft.capacity.trim()),
      ownerEmployeeId: draft.owner.id,
      selfNomination: draft.selfNomination,
      ...(draft.questionCodes.length > 0 ? { feedbackQuestionCodes: draft.questionCodes } : {}),
      ...(withCost && amount ? { cost: { amount, currency: draft.costCurrency.trim().toUpperCase() } } : {}),
    });
  };
  return (
    <Section title="New training plan">
      <form className="grid-form" aria-label="New training plan" onSubmit={submit} noValidate>
        <label>
          Plan code
          <input value={draft.code} maxLength={40} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        </label>
        <label className="wide">
          Course title
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label>
          Start date
          <input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
        </label>
        <label>
          End date
          <input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
        </label>
        <label>
          Mode
          <select value={draft.modeCode} onChange={(e) => setDraft({ ...draft, modeCode: e.target.value })}>
            <option value="">Choose a mode</option>
            {(shown(modes)?.items ?? []).map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Venue (optional)
          <input value={draft.venue} maxLength={300} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
        </label>
        <label>
          Trainer (optional)
          <input value={draft.trainer} maxLength={200} onChange={(e) => setDraft({ ...draft, trainer: e.target.value })} />
        </label>
        <label>
          Capacity (places)
          <input inputMode="numeric" value={draft.capacity} maxLength={9} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} />
        </label>
        {withCost && (
          <>
            <label>
              Cost (optional, company spend)
              <input inputMode="decimal" value={draft.costAmount} maxLength={18} placeholder="e.g. 1500.00" onChange={(e) => setDraft({ ...draft, costAmount: e.target.value })} />
            </label>
            <label>
              Cost currency
              <input value={draft.costCurrency} maxLength={3} onChange={(e) => setDraft({ ...draft, costCurrency: e.target.value })} />
            </label>
          </>
        )}
        <label className="wide">
          <input type="checkbox" checked={draft.selfNomination} onChange={(e) => setDraft({ ...draft, selfNomination: e.target.checked })} /> Employees may nominate
          themselves
        </label>
        <QuestionChoice
          legend="Feedback questions (when none is chosen, every active question is used)"
          questions={shown(questions)?.items}
          chosen={draft.questionCodes}
          onChange={(questionCodes) => setDraft({ ...draft, questionCodes })}
        />
        <OwnerPicker value={draft.owner} onChange={(owner) => setDraft({ ...draft, owner })} />
        <p className="hint wide">The plan code is permanent and never reused. A cost left empty means no cost; 0 is recorded as a zero cost.</p>
        <div className="wide">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create the plan'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={create.error} action="create" />
      <QueryProblem error={modes.error} forbidden="The selected role cannot read the training modes." />
      {created && (
        <p role="status" className="ok">
          The plan <Link to={PATHS.plan(created.id)}>{created.code}</Link> was created ({VIEW_LABEL[created.view] ?? readable(created.view)}).
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One plan: facts, changes, cancellation and participants (FR-049, FR-050)
// ---------------------------------------------------------------------------------------------------------
function PlanScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PLAN_READ);
  const detail = useQuery({ queryKey: keys.plan(id), queryFn: () => api<PlanDetail>(`/v1/training-plans/${id}`), enabled: allowed && id !== '', retry: retryTransient });
  if (!allowed) return <NotPermitted>The selected role cannot read training plans.</NotPermitted>;
  const plan = shown(detail);
  const active = plan?.state === 'ACTIVE';
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.plans}>Back to the training plans</Link>
      </p>
      {detail.isLoading && <p className="hint">Loading…</p>}
      <QueryProblem error={detail.error} forbidden="The selected role cannot read this plan." />
      {plan && (
        <>
          <PlanFacts plan={plan} />
          {can(PLAN_MANAGE) && active && <EditPlanForm plan={plan} />}
          {can(PLAN_MANAGE) && active && <CancelPlanForm plan={plan} />}
          {can(PART_READ) ? <Participants plan={plan} /> : <NotPermitted>The selected role cannot read the participants.</NotPermitted>}
        </>
      )}
    </div>
  );
}

function PlanFacts({ plan }: { plan: PlanDetail }) {
  const { can } = useSession();
  return (
    <Section title={`${plan.title} (${plan.code})`} actions={can(FEEDBACK_READ) ? <Link to={PATHS.feedback(plan.id)}>Feedback summary</Link> : undefined}>
      <dl className="kv">
        <Item term="View">
          <ViewBadge view={plan.view} />
        </Item>
        <Item term="Dates">
          {formatDate(plan.startDate)} to {formatDate(plan.endDate)}
        </Item>
        <Item term="Mode">{plan.mode.label}</Item>
        <Item term="Venue">{optional(plan.venue)}</Item>
        <Item term="Trainer">{optional(plan.trainer)}</Item>
        <Item term="Capacity">{plan.capacity} places</Item>
        <Item term="Places taken">
          {plan.seatsTaken} taken, {plan.seatsAvailable} available, {plan.nominationsPending} waiting for confirmation
        </Item>
        <Item term="Owner">
          {plan.owner.name} ({plan.owner.employeeCode})
        </Item>
        <Item term="Self-nomination">{plan.selfNomination ? 'Employees may nominate themselves' : 'Coordinator nominations only'}</Item>
        {has(plan, 'cost') && (
          <Item term="Cost">
            <CostText plan={plan} />
          </Item>
        )}
        <Item term="Feedback questions">{plan.feedbackQuestions.length ? plan.feedbackQuestions.map((q) => q.label).join('; ') : '—'}</Item>
        {plan.cancellation && (
          <Item term="Cancellation">
            Cancelled on <When at={plan.cancellation.cancelledAt} />
            {plan.cancellation.cancelledByName ? ` by ${plan.cancellation.cancelledByName}` : ''}
            {plan.cancellation.reason ? `. Reason: ${plan.cancellation.reason}` : ''}
          </Item>
        )}
      </dl>
      {plan.state === 'CANCELLED' && <p className="hint">A cancelled plan is final: it takes no changes, nominations or attendance.</p>}
    </Section>
  );
}

function EditPlanForm({ plan }: { plan: PlanDetail }) {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const modes = useChoices('modes', true);
  const questions = useChoices('questions', true);
  const costEditable = can(COST_MANAGE) && has(plan, 'cost');
  const original = useMemo(
    () => ({
      title: plan.title,
      startDate: plan.startDate,
      endDate: plan.endDate,
      modeCode: plan.mode.code,
      venue: plan.venue ?? '',
      trainer: plan.trainer ?? '',
      capacity: String(plan.capacity),
      selfNomination: plan.selfNomination,
      questionCodes: plan.feedbackQuestions.map((q) => q.code),
      noCost: plan.cost === null || plan.cost === undefined,
      costAmount: plan.cost?.amount ?? '',
      costCurrency: plan.cost?.currency ?? 'INR',
    }),
    [plan],
  );
  const [draft, setDraft] = useState(original);
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A new version of the plan (after a save) resets the form to what the server now holds.
  const version = plan.version;
  useEffect(() => {
    setDraft(original);
    setOwner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PlanDetail>(`/v1/training-plans/${plan.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setSaved(true);
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const changes: Record<string, unknown> = {};
    const title = draft.title.trim();
    if (!title) return setProblem('Give the course title.');
    if (draft.endDate < draft.startDate) return setProblem('The end date cannot be before the start date.');
    if (!WHOLE.test(draft.capacity.trim()) || Number(draft.capacity.trim()) < 1) return setProblem('The capacity is a whole number of places, at least 1.');
    if (title !== original.title) changes.title = title;
    if (draft.startDate !== original.startDate) changes.startDate = draft.startDate;
    if (draft.endDate !== original.endDate) changes.endDate = draft.endDate;
    if (draft.modeCode !== original.modeCode) changes.modeCode = draft.modeCode;
    if (draft.venue.trim() !== original.venue) changes.venue = draft.venue.trim() || null;
    if (draft.trainer.trim() !== original.trainer) changes.trainer = draft.trainer.trim() || null;
    if (draft.capacity.trim() !== original.capacity) changes.capacity = Number(draft.capacity.trim());
    if (draft.selfNomination !== original.selfNomination) changes.selfNomination = draft.selfNomination;
    if (draft.questionCodes.join(',') !== original.questionCodes.join(',')) {
      if (draft.questionCodes.length === 0) return setProblem('Keep at least one feedback question.');
      changes.feedbackQuestionCodes = draft.questionCodes;
    }
    if (owner && owner.id !== plan.owner.employeeId) changes.ownerEmployeeId = owner.id;
    if (costEditable) {
      const amount = draft.costAmount.trim();
      const currency = draft.costCurrency.trim().toUpperCase();
      if (draft.noCost) {
        if (!original.noCost) changes.cost = null;
      } else {
        if (!AMOUNT.test(amount)) return setProblem('The cost is a non-negative amount with at most two decimals.');
        if (original.noCost || amount !== original.costAmount || currency !== original.costCurrency) changes.cost = { amount, currency };
      }
    }
    if (Object.keys(changes).length === 0) return setProblem('Nothing was changed.');
    setProblem(null);
    save.mutate({ expectedVersion: plan.version, ...changes });
  };
  return (
    <Section title="Change the plan">
      <form className="grid-form" aria-label="Change the plan" onSubmit={submit} noValidate>
        <label className="wide">
          Course title
          <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label>
          Start date
          <input type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
        </label>
        <label>
          End date
          <input type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
        </label>
        <label>
          Mode
          <select value={draft.modeCode} onChange={(e) => setDraft({ ...draft, modeCode: e.target.value })}>
            {!(shown(modes)?.items ?? []).some((m) => m.code === original.modeCode) && <option value={original.modeCode}>{plan.mode.label}</option>}
            {(shown(modes)?.items ?? []).map((m) => (
              <option key={m.code} value={m.code}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Venue
          <input value={draft.venue} maxLength={300} onChange={(e) => setDraft({ ...draft, venue: e.target.value })} />
        </label>
        <label>
          Trainer
          <input value={draft.trainer} maxLength={200} onChange={(e) => setDraft({ ...draft, trainer: e.target.value })} />
        </label>
        <label>
          Capacity (places)
          <input inputMode="numeric" value={draft.capacity} maxLength={9} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} />
        </label>
        {costEditable && (
          <>
            <label>
              <input type="checkbox" checked={draft.noCost} onChange={(e) => setDraft({ ...draft, noCost: e.target.checked })} /> No cost
            </label>
            {!draft.noCost && (
              <>
                <label>
                  Cost
                  <input inputMode="decimal" value={draft.costAmount} maxLength={18} onChange={(e) => setDraft({ ...draft, costAmount: e.target.value })} />
                </label>
                <label>
                  Cost currency
                  <input value={draft.costCurrency} maxLength={3} onChange={(e) => setDraft({ ...draft, costCurrency: e.target.value })} />
                </label>
              </>
            )}
          </>
        )}
        <label className="wide">
          <input type="checkbox" checked={draft.selfNomination} onChange={(e) => setDraft({ ...draft, selfNomination: e.target.checked })} /> Employees may nominate
          themselves
        </label>
        {!plan.feedbackRecorded && (
          <QuestionChoice
            legend="Feedback questions"
            questions={shown(questions)?.items}
            chosen={draft.questionCodes}
            onChange={(questionCodes) => setDraft({ ...draft, questionCodes })}
          />
        )}
        <div className="wide">
          <p style={FLUSH}>
            New owner: <strong>{owner ? owner.label : 'unchanged'}</strong>{' '}
            {owner && (
              <button type="button" className="secondary" onClick={() => setOwner(null)}>
                Keep the current owner
              </button>
            )}
          </p>
          <EmployeeSearch label="Find a new owner" onPick={(e) => setOwner({ id: e.id, label: personLabel(e) })} exclude={[plan.owner.employeeId]} />
        </div>
        <div className="wide">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the changes'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={save.error} action="update" />
      {saved && (
        <p role="status" className="ok">
          The plan was saved.
        </p>
      )}
    </Section>
  );
}

function CancelPlanForm({ plan }: { plan: PlanDetail }) {
  const refetchAll = useRefetchAll();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { reason: string; expectedVersion: number }) =>
      api<PlanDetail & { cancelledParticipations: number; replayed: boolean }>(`/v1/training-plans/${plan.id}/cancel`, { method: 'POST', body }),
    onSuccess: (r) => {
      setReason('');
      setNotice({
        ok: true,
        text: r.replayed
          ? 'The plan was already cancelled.'
          : `The plan was cancelled. ${r.cancelledParticipations} nomination${r.cancelledParticipations === 1 ? '' : 's'} and confirmed place${r.cancelledParticipations === 1 ? ' was' : 's were'} cancelled with it.`,
      });
      void refetchAll();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    const text = reason.trim();
    if (!text) return setProblem('Record why the plan is cancelled.');
    setProblem(null);
    cancel.mutate({ reason: text, expectedVersion: plan.version });
  };
  return (
    <Section title="Cancel the plan">
      <form className="grid-form" aria-label="Cancel the plan" onSubmit={submit} noValidate>
        <label className="wide">
          Reason for cancelling
          <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="hint wide">Cancelling is final. Nominations and confirmed places are cancelled with the plan; a plan with recorded attendance cannot be cancelled.</p>
        <div className="wide">
          <button type="submit" disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel the plan'}
          </button>
        </div>
      </form>
      <Problem text={problem} />
      <Refusal error={cancel.error} action="cancel" />
      <Notice notice={notice} />
    </Section>
  );
}

function Participants({ plan }: { plan: PlanDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ ...(state ? { state } : {}), page: String(page), pageSize: String(PAGE_SIZE) }).toString();
  const list = useQuery({
    queryKey: keys.participants(plan.id, query),
    queryFn: () => api<ParticipantPage>(`/v1/training-plans/${plan.id}/participants?${query}`),
    retry: retryTransient,
  });
  const manage = can(PART_MANAGE) && plan.state === 'ACTIVE';
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(list);
  const names = useMemo(() => new Map((data?.items ?? []).map((t) => [t.employeeId, participantLabel(t)])), [data]);
  const act = useMutation({
    mutationFn: (body: { action: TransitionAction; participantIds: string[]; reason?: string }) =>
      api<{ action: string; items: Participant[]; changed: number; replayed: number }>(`/v1/training-plans/${plan.id}/participant-actions`, { method: 'POST', body }),
    onSuccess: (r) => {
      const done = TRANSITIONS.find(([a]) => a === r.action)?.[2] ?? 'updated';
      setSelected([]);
      setReason('');
      setNotice({ ok: true, text: `${r.changed} participation${r.changed === 1 ? '' : 's'} ${done}${r.replayed ? `; ${r.replayed} already were` : ''}.` });
      void refetchAll();
    },
  });
  const run = (action: TransitionAction) => {
    setNotice(null);
    if (selected.length === 0) return setProblem('Select the participations first.');
    const text = reason.trim();
    if (action === 'CANCEL' && !text) return setProblem('Record why the participation is cancelled.');
    setProblem(null);
    act.mutate({ action, participantIds: selected, ...(text ? { reason: text } : {}) });
  };
  const withReasons = data?.items.some((t) => has(t, 'cancellationReason')) ?? false;
  const toggle = (id: string, on: boolean) => setSelected(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <>
      <Section title="Participants">
        <form className="grid-form" aria-label="Filter the participants" onSubmit={(e) => e.preventDefault()}>
          <label>
            Participation state
            <select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
                // A selection is only of the rows on screen: an action never reaches a participation no longer shown.
                setSelected([]);
              }}
            >
              <option value="">All states</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </form>
        {data && !data.scope.companyWide && <p className="hint">Only the participants in the selected role’s scope are listed.</p>}
        {list.isLoading && <p className="hint">Loading…</p>}
        <QueryProblem error={list.error} forbidden="The selected role cannot read the participants." />
        {data && data.items.length === 0 && <Empty>No participants{state ? ' in this state' : ' yet'}.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Participants">
              <thead>
                <tr>
                  {manage && <th>Select</th>}
                  <th>Employee</th>
                  <th>State</th>
                  <th>Nominated</th>
                  <th>Confirmed</th>
                  <th>Attendance recorded</th>
                  <th>Completed</th>
                  <th>Cancelled</th>
                  <th>Feedback</th>
                  {withReasons && <th>Cancellation reason</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => {
                  const own = me?.employeeId === t.employeeId;
                  return (
                    <tr key={t.id}>
                      {manage && (
                        <td>
                          {own ? (
                            <span className="hint">Your own: another coordinator records it</span>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={`Select ${participantLabel(t)}`}
                              checked={selected.includes(t.id)}
                              onChange={(e) => toggle(t.id, e.target.checked)}
                            />
                          )}
                        </td>
                      )}
                      <td>{can(PART_READ) ? <Link to={PATHS.participant(t.id)}>{participantLabel(t)}</Link> : participantLabel(t)}</td>
                      <td>
                        <ParticipationState state={t.state} />
                      </td>
                      <td>
                        <When at={t.nominatedAt} /> {t.selfNominated ? '(self-nominated)' : ''}
                      </td>
                      <td>
                        <When at={t.confirmedAt} />
                      </td>
                      <td>
                        <When at={t.attendanceRecordedAt} />
                      </td>
                      <td>
                        <When at={t.completedAt} />
                      </td>
                      <td>
                        <When at={t.cancelledAt} />
                      </td>
                      <td>
                        <FeedbackState status={t.feedbackStatus} />
                      </td>
                      {withReasons && <td>{optional(t.cancellationReason)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            label="Participant pages"
            onPage={(next) => {
              setPage(next);
              setSelected([]);
            }}
          />
        )}
        {manage && data && data.items.length > 0 && (
          <div className="stack" role="group" aria-label="Participation actions">
            <label>
              Reason (needed to cancel, or to correct recorded attendance)
              <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              {TRANSITIONS.map(([action, label]) => (
                <button key={action} type="button" className={action === 'CANCEL' ? 'secondary' : undefined} disabled={act.isPending} onClick={() => run(action)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="hint" style={FLUSH}>
              {selected.length} selected. Confirmation is checked against the capacity; attendance is recorded from the start date and completion from the end date.
            </p>
            <Problem text={problem} />
            <Refusal error={act.error} action="transition" nameOf={(id) => names.get(id)} />
            <Notice notice={notice} />
          </div>
        )}
      </Section>
      {manage && <NominateForm plan={plan} />}
    </>
  );
}

function NominateForm({ plan }: { plan: PlanDetail }) {
  const refetchAll = useRefetchAll();
  const [chosen, setChosen] = useState<EmployeeHit[]>([]);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const nominate = useMutation({
    mutationFn: (body: { employeeIds: string[] }) => api<{ items: Participant[]; nominated: number }>(`/v1/training-plans/${plan.id}/participants`, { method: 'POST', body }),
    onSuccess: (r) => {
      setChosen([]);
      setNotice({ ok: true, text: `${r.nominated} employee${r.nominated === 1 ? ' was' : 's were'} nominated. Confirm each place separately.` });
      void refetchAll();
    },
  });
  const nameOf = (id: string) => {
    const e = chosen.find((x) => x.id === id);
    return e ? personLabel(e) : undefined;
  };
  return (
    <Section title="Nominate employees">
      <EmployeeSearch label="Find an employee to nominate" exclude={chosen.map((e) => e.id)} onPick={(e) => setChosen([...chosen, e])} />
      {chosen.length > 0 && (
        <ul aria-label="Chosen employees">
          {chosen.map((e) => (
            <li key={e.id}>
              {personLabel(e)}{' '}
              <button type="button" className="secondary" aria-label={`Remove ${personLabel(e)}`} onClick={() => setChosen(chosen.filter((x) => x.id !== e.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={chosen.length === 0 || nominate.isPending}
        onClick={() => {
          setNotice(null);
          nominate.mutate({ employeeIds: chosen.map((e) => e.id) });
        }}
      >
        {nominate.isPending ? 'Nominating…' : chosen.length === 0 ? 'Nominate' : `Nominate ${chosen.length} employee${chosen.length === 1 ? '' : 's'}`}
      </button>
      <Refusal error={nominate.error} action="nominate" nameOf={nameOf} />
      <Notice notice={notice} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Feedback summary and register (FR-050): counts reconciled to participants; comments only when returned
// ---------------------------------------------------------------------------------------------------------
function FeedbackScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  // Both routes check the plan read as well as the feedback read (routes.ts): an Employee holds only the latter.
  const allowed = can(FEEDBACK_READ) && can(PLAN_READ);
  const [status, setStatus] = useState('');
  const summary = useQuery({
    queryKey: keys.summary(id),
    queryFn: () => api<FeedbackSummary>(`/v1/training-plans/${id}/feedback-summary`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  const register = useQuery({
    queryKey: keys.register(id, status),
    queryFn: () => api<FeedbackRegister>(`/v1/training-plans/${id}/feedback${status ? `?status=${status}` : ''}`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  const exporter = useMutation({ mutationFn: () => download(`/v1/training-plans/${id}/feedback/export`) });
  if (!allowed) return <NotPermitted>The selected role cannot read training feedback.</NotPermitted>;
  const s = shown(summary);
  const r = shown(register);
  return (
    <div className="stack">
      <p style={FLUSH}>
        <Link to={PATHS.plan(id)}>Back to the plan</Link>
      </p>
      <Section
        title={s ? `Feedback summary: ${s.plan.title} (${s.plan.code})` : 'Feedback summary'}
        actions={
          can(FEEDBACK_EXPORT) ? (
            <button type="button" className="secondary" disabled={exporter.isPending} onClick={() => exporter.mutate()}>
              {exporter.isPending ? 'Exporting…' : 'Export scores (CSV)'}
            </button>
          ) : undefined
        }
      >
        <Refusal error={exporter.error} action="export" />
        {summary.isLoading && <p className="hint">Loading…</p>}
        <QueryProblem error={summary.error} forbidden="The selected role cannot read this feedback." />
        {s && <SummaryBody s={s} />}
      </Section>
      <Section title="Responses">
        <form className="grid-form" aria-label="Filter the responses" onSubmit={(e) => e.preventDefault()}>
          <label>
            Feedback status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All participants</option>
              <option value="RESPONDED">{FEEDBACK_LABEL.RESPONDED}</option>
              <option value="MISSING">{FEEDBACK_LABEL.MISSING}</option>
              <option value="NOT_APPLICABLE">{FEEDBACK_LABEL.NOT_APPLICABLE}</option>
            </select>
          </label>
        </form>
        {register.isLoading && <p className="hint">Loading…</p>}
        <QueryProblem error={register.error} forbidden="The selected role cannot read the responses." />
        {r && <RegisterBody r={r} />}
      </Section>
    </div>
  );
}

function SummaryBody({ s }: { s: FeedbackSummary }) {
  const reconciled = s.reconciles.participants && s.reconciles.responses && s.reconciles.questions;
  return (
    <>
      <p className="hint">
        {s.scope.companyWide ? 'All participants of the plan.' : 'Only the participants in the selected role’s scope.'} Counted on <When at={s.generatedAt} />. Counts only: no
        average score is worked out.
      </p>
      <dl className="kv" aria-label="Response counts">
        <Item term="Participants">{s.participants.total}</Item>
        <Item term="Completed (feedback expected)">{s.feedback.eligible}</Item>
        <Item term="Responded">{s.feedback.responded}</Item>
        <Item term="Missing responses">
          <Badge tone={s.feedback.missing > 0 ? 'warn' : 'neutral'}>{`${s.feedback.missing} missing`}</Badge>
        </Item>
        <Item term="Not applicable (not completed)">{s.feedback.notApplicable}</Item>
        <Item term="Reconciles to the participants">{reconciled ? 'Yes' : 'No: reload and report it'}</Item>
      </dl>
      <div style={SCROLL}>
        <table aria-label="Participants by state">
          <thead>
            <tr>
              {STATES.map((st) => (
                <th key={st}>{STATE_LABEL[st]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {STATES.map((st) => (
                <td key={st}>{s.participants.byState[st] ?? 0}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {s.questions.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Scores by question">
            <thead>
              <tr>
                <th>Question</th>
                <th>Answered</th>
                {SCORES.map((n) => (
                  <th key={n}>Score {n}</th>
                ))}
                <th>Missing</th>
              </tr>
            </thead>
            <tbody>
              {s.questions.map((q) => (
                <tr key={q.code}>
                  <td>{q.label}</td>
                  <td>{q.answered}</td>
                  {SCORES.map((n) => (
                    <td key={n}>{q.scores[n] ?? 0}</td>
                  ))}
                  <td>{q.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RegisterBody({ r }: { r: FeedbackRegister }) {
  return (
    <>
      {!r.commentsIncluded && <p className="hint">Comments are confidential and are not shown to the selected role.</p>}
      {r.items.length === 0 ? (
        <Empty>No participants match.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Feedback responses">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Participation</th>
                <th>Feedback</th>
                <th>Submitted</th>
                {r.questions.map((q) => (
                  <th key={q.code}>{q.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.items.map((row) => (
                <tr key={row.participantId}>
                  <td>{participantLabel(row)}</td>
                  <td>
                    <ParticipationState state={row.state} />
                  </td>
                  <td>
                    <FeedbackState status={row.feedbackStatus} />
                  </td>
                  <td>
                    <When at={row.submittedAt} />
                  </td>
                  {r.questions.map((q) => {
                    const a = row.answers.find((x) => x.questionCode === q.code);
                    return (
                      <td key={q.code}>
                        {a ? `Score ${a.score}` : '—'}
                        {a && typeof a.comment === 'string' && a.comment !== '' && (
                          <>
                            <br />
                            <span>Comment: {a.comment}</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One participation with its history, and an employee's participations (row scope; DF16 My Team)
// ---------------------------------------------------------------------------------------------------------
function ParticipantScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const allowed = can(PART_READ);
  const detail = useQuery({
    queryKey: keys.participant(id),
    queryFn: () => api<ParticipantDetail>(`/v1/training-participants/${id}`),
    enabled: allowed && id !== '',
    retry: retryTransient,
  });
  if (!allowed) return <NotPermitted>The selected role cannot read training participations.</NotPermitted>;
  const t = shown(detail);
  return (
    <div className="stack">
      {detail.isLoading && <p className="hint">Loading…</p>}
      <QueryProblem error={detail.error} forbidden="The selected role cannot read this participation." />
      {t && (
        <>
          <Section title={`${participantLabel(t)}: ${t.plan.title}`}>
            <dl className="kv">
              <Item term="Training">{can(PLAN_READ) ? <Link to={PATHS.plan(t.plan.id)}>{`${t.plan.title} (${t.plan.code})`}</Link> : `${t.plan.title} (${t.plan.code})`}</Item>
              <Item term="Dates">
                {formatDate(t.plan.startDate)} to {formatDate(t.plan.endDate)} <ViewBadge view={t.plan.view} />
              </Item>
              <Item term="State">
                <ParticipationState state={t.state} />
              </Item>
              <Item term="Nomination">{t.selfNominated ? 'Self-nominated' : 'Nominated by the coordinator'}</Item>
              <Item term="Feedback">
                <FeedbackState status={t.feedbackStatus} />
              </Item>
              {has(t, 'cancellationReason') && t.cancellationReason && <Item term="Cancellation reason">{t.cancellationReason}</Item>}
              <Item term="Employee’s training">
                <Link to={PATHS.employee(t.employeeId)}>All participations of {t.employeeName}</Link>
              </Item>
            </dl>
          </Section>
          <Section title="History">
            {t.history.length === 0 ? (
              <Empty>No changes recorded.</Empty>
            ) : (
              <div style={SCROLL}>
                <table aria-label="Participation history">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Change</th>
                      <th>From</th>
                      <th>To</th>
                      <th>By</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.history.map((h, i) => (
                      <tr key={`${h.occurredAt}-${i}`}>
                        <td>
                          <When at={h.occurredAt} />
                        </td>
                        <td>{HISTORY_LABEL[h.action] ?? readable(h.action)}</td>
                        <td>{h.fromState ? (STATE_LABEL[h.fromState] ?? readable(h.fromState)) : '—'}</td>
                        <td>{STATE_LABEL[h.toState] ?? readable(h.toState)}</td>
                        <td>{optional(h.actorName)}</td>
                        <td>{typeof h.reason === 'string' && h.reason !== '' ? h.reason : h.reasonRecorded ? 'A reason was recorded (confidential)' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function EmployeeTrainingScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  if (!can(PART_READ)) return <NotPermitted>The selected role cannot read training participations.</NotPermitted>;
  return (
    <Section title="Employee’s training">
      <ParticipationList employeeId={id} linked />
    </Section>
  );
}

/** An employee's participations (GET /v1/employees/:id/training), newest first, within the caller's row scope. */
function ParticipationList({ employeeId, linked, own }: { employeeId: string; linked?: boolean; own?: boolean }) {
  const { can } = useSession();
  const keys = useKeys();
  const list = useQuery({
    queryKey: keys.employee(employeeId),
    queryFn: () => api<{ items: EmployeeParticipation[]; businessDate: string }>(`/v1/employees/${employeeId}/training`),
    enabled: employeeId !== '',
    retry: retryTransient,
  });
  const data = shown(list);
  const withReasons = data?.items.some((t) => has(t, 'cancellationReason')) ?? false;
  return (
    <>
      {list.isLoading && <p className="hint">Loading…</p>}
      <QueryProblem error={list.error} forbidden="The selected role cannot read these participations." />
      {data && data.items.length === 0 && <Empty>{own ? 'You have no training enrolments or assigned sessions yet.' : 'No training participations.'}</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={own ? 'My training' : 'Training participations'}>
            <thead>
              <tr>
                <th>Training</th>
                <th>Dates</th>
                <th>Mode, venue and trainer</th>
                <th>Nomination</th>
                <th>State</th>
                <th>Attendance recorded</th>
                <th>Completed</th>
                <th>Feedback</th>
                {withReasons && <th>Cancellation reason</th>}
                {own && can(PART_ENROL) && <th>Withdraw</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    {linked && can(PART_READ) ? <Link to={PATHS.participant(t.id)}>{t.plan.title}</Link> : t.plan.title} ({t.plan.code})
                    {t.plan.ownerName ? <div className="hint">Owner: {t.plan.ownerName}</div> : null}
                  </td>
                  <td>
                    {formatDate(t.plan.startDate)} to {formatDate(t.plan.endDate)} <ViewBadge view={t.plan.view} />
                  </td>
                  <td>
                    {t.plan.mode.label}
                    {t.plan.venue ? ` · ${t.plan.venue}` : ''}
                    {t.plan.trainer ? ` · ${t.plan.trainer}` : ''}
                  </td>
                  <td>{t.selfNominated ? (own ? 'You nominated yourself' : 'Self-nominated') : 'Assigned by the coordinator'}</td>
                  <td>
                    <ParticipationState state={t.state} />
                  </td>
                  <td>
                    <When at={t.attendanceRecordedAt} />
                  </td>
                  <td>
                    <When at={t.completedAt} />
                  </td>
                  <td>
                    <FeedbackState status={t.feedbackStatus} />
                  </td>
                  {withReasons && <td>{optional(t.cancellationReason)}</td>}
                  {own && can(PART_ENROL) && <td>{t.state === 'NOMINATED' && t.selfNominated ? <WithdrawForm participation={t} /> : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// My ESS TN17 (Employee OWN context): own participations, self-nomination, withdrawal and feedback
// ---------------------------------------------------------------------------------------------------------
function MyTrainingPanel() {
  const { me, can } = useSession();
  if (!inOwnContext(me)) return <Empty>Select your Employee role to see your own training.</Empty>;
  return (
    <div className="stack">
      <Section title="My training">
        {can(PART_READ) ? <ParticipationList employeeId={me!.employeeId!} own /> : <NotPermitted>Your Employee role cannot read your training.</NotPermitted>}
        <p className="hint">Attendance and completion are recorded by the training coordinator, never by you.</p>
      </Section>
      {can(PART_ENROL) && <OpenPlans />}
      {can(FEEDBACK_READ) && <MyFeedback />}
    </div>
  );
}

function WithdrawForm({ participation }: { participation: EmployeeParticipation }) {
  const refetchAll = useRefetchAll();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const withdraw = useMutation({
    mutationFn: (body: { reason: string }) => api<Participant & { replayed: boolean }>(`/v1/me/training-nominations/${participation.id}/withdraw`, { method: 'POST', body }),
    onSuccess: () => {
      setReason('');
      setOpen(false);
      void refetchAll();
    },
  });
  if (!open) {
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)} aria-label={`Withdraw from ${participation.plan.title}`}>
        Withdraw
      </button>
    );
  }
  return (
    <form
      aria-label={`Withdraw from ${participation.plan.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        const text = reason.trim();
        if (!text) return setProblem('Record why you withdraw.');
        setProblem(null);
        withdraw.mutate({ reason: text });
      }}
      noValidate
    >
      <label>
        Why you withdraw
        <textarea style={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" disabled={withdraw.isPending}>
        {withdraw.isPending ? 'Withdrawing…' : 'Withdraw my nomination'}
      </button>{' '}
      <button type="button" className="secondary" onClick={() => setOpen(false)}>
        Keep it
      </button>
      <Problem text={problem} />
      <Refusal error={withdraw.error} action="withdraw" />
    </form>
  );
}

function OpenPlans() {
  const keys = useKeys();
  const refetchAll = useRefetchAll();
  const list = useQuery({ queryKey: keys.openPlans, queryFn: () => api<{ items: OpenPlan[]; businessDate: string }>('/v1/me/training-plans'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const enrol = useMutation({
    mutationFn: (plan: OpenPlan) => api<Participant>('/v1/me/training-nominations', { method: 'POST', body: { planId: plan.id } }),
    onSuccess: (_r, plan) => {
      setNotice({ ok: true, text: `You nominated yourself for ${plan.title}. The training coordinator confirms your place separately.` });
      void refetchAll();
    },
  });
  const data = shown(list);
  return (
    <Section title="Training open for self-nomination">
      {list.isLoading && <p className="hint">Loading…</p>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot see the training open for self-nomination." action="enrol" />
      {data && data.items.length === 0 && <Empty>No training is open for self-nomination at the moment.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Open training">
            <thead>
              <tr>
                <th>Training</th>
                <th>Dates</th>
                <th>Mode, venue and trainer</th>
                <th>My participation</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => {
                const mine = p.myParticipation;
                const canEnrol = mine === null || mine.state === 'CANCELLED';
                return (
                  <tr key={p.id}>
                    <td>
                      {p.title} ({p.code}){p.ownerName ? <div className="hint">Owner: {p.ownerName}</div> : null}
                    </td>
                    <td>
                      {formatDate(p.startDate)} to {formatDate(p.endDate)} <ViewBadge view={p.view} />
                    </td>
                    <td>
                      {p.mode.label}
                      {p.venue ? ` · ${p.venue}` : ''}
                      {p.trainer ? ` · ${p.trainer}` : ''}
                    </td>
                    <td>
                      {mine && <ParticipationState state={mine.state} />}{' '}
                      {canEnrol && (
                        <button
                          type="button"
                          disabled={enrol.isPending}
                          aria-label={`Nominate myself for ${p.title}`}
                          onClick={() => {
                            setNotice(null);
                            enrol.mutate(p);
                          }}
                        >
                          {mine ? 'Nominate myself again' : 'Nominate myself'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Refusal error={enrol.error} action="enrol" />
      <Notice notice={notice} />
    </Section>
  );
}

function MyFeedback() {
  const { can } = useSession();
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownFeedback, queryFn: () => api<{ items: OwnFeedback[] }>('/v1/me/training-feedback'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(list);
  return (
    <Section title="My training feedback">
      <p className="hint">Feedback opens once your completion is recorded. It is given once and cannot be changed afterwards. Your comment is confidential.</p>
      {list.isLoading && <p className="hint">Loading…</p>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot read your training feedback." action="feedback" />
      {data && data.items.length === 0 && <Empty>No completed training waits for feedback.</Empty>}
      <Notice notice={notice} />
      {data?.items.map((f) => (
        <article key={f.participantId} aria-label={`Feedback for ${f.plan.title}`} className="stack">
          <h3 style={FLUSH}>
            {f.plan.title} ({f.plan.code})
          </h3>
          <p style={FLUSH}>
            Completed on <When at={f.completedAt} />. <FeedbackState status={f.status} />
            {f.submittedAt ? (
              <>
                {' '}
                Submitted on <When at={f.submittedAt} />.
              </>
            ) : null}
          </p>
          {f.status === 'RESPONDED' && (
            <ul aria-label={`My answers for ${f.plan.title}`}>
              {f.answers.map((a) => (
                <li key={a.questionCode}>
                  {f.questions.find((q) => q.code === a.questionCode)?.label ?? a.questionCode}: score {a.score}
                  {typeof a.comment === 'string' && a.comment !== '' ? `. My comment: ${a.comment}` : ''}
                </li>
              ))}
            </ul>
          )}
          {f.status === 'MISSING' &&
            (can(FEEDBACK_SUBMIT) ? (
              <FeedbackForm item={f} onDone={(text) => setNotice({ ok: true, text })} />
            ) : (
              <NotPermitted>Your Employee role cannot give training feedback.</NotPermitted>
            ))}
        </article>
      ))}
    </Section>
  );
}

function FeedbackForm({ item, onDone }: { item: OwnFeedback; onDone: (text: string) => void }) {
  const { can } = useSession();
  const refetchAll = useRefetchAll();
  const withComment = can(COMMENT_SUBMIT);
  const empty = useMemo(() => Object.fromEntries(item.questions.map((q) => [q.code, { score: '', comment: '' }])) as Record<string, { score: string; comment: string }>, [item]);
  const [draft, setDraft] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (body: { participantId: string; answers: { questionCode: string; score: number; comment?: string }[] }) =>
      api<{ participantId: string; status: string; replayed: boolean }>('/v1/me/training-feedback', { method: 'POST', body }),
    onSuccess: () => {
      setDraft(empty);
      onDone(`Your feedback for ${item.plan.title} was recorded. It cannot be changed.`);
      void refetchAll();
    },
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (item.questions.some((q) => !SCORES.includes((draft[q.code]?.score ?? '') as (typeof SCORES)[number]))) {
      setProblem('Give a score from 1 to 5 for each question.');
      return;
    }
    setProblem(null);
    submit.mutate({
      participantId: item.participantId,
      answers: item.questions.map((q) => {
        const entry = draft[q.code] ?? { score: '', comment: '' };
        const comment = withComment ? entry.comment.trim() : '';
        return { questionCode: q.code, score: Number(entry.score), ...(comment ? { comment } : {}) };
      }),
    });
  };
  const set = (code: string, patch: Partial<{ score: string; comment: string }>) =>
    setDraft({ ...draft, [code]: { ...(draft[code] ?? { score: '', comment: '' }), ...patch } });
  return (
    <form className="grid-form" aria-label={`Give feedback for ${item.plan.title}`} onSubmit={send} noValidate>
      {item.questions.map((q) => (
        <fieldset key={q.code} className="wide">
          <legend>{q.label}</legend>
          <label>
            Score for {q.label} (1 lowest, 5 highest)
            <select value={draft[q.code]?.score ?? ''} onChange={(e) => set(q.code, { score: e.target.value })}>
              <option value="">Choose a score</option>
              {SCORES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {withComment && (
            <label>
              Comment on {q.label} (optional, confidential)
              <textarea style={TEXTAREA} rows={2} maxLength={2000} value={draft[q.code]?.comment ?? ''} onChange={(e) => set(q.code, { comment: e.target.value })} />
            </label>
          )}
        </fieldset>
      ))}
      <div className="wide">
        <button type="submit" disabled={submit.isPending}>
          {submit.isPending ? 'Sending…' : 'Send my feedback'}
        </button>
      </div>
      <Problem text={problem} />
      <Refusal error={submit.error} action="feedback" />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them later)
// ---------------------------------------------------------------------------------------------------------

/**
 * Screens of the training module; detail screens are reached through links (nav: false). The participation and
 * employee screens use the row scope (a reporting manager reads the direct team's training there).
 */
export const TRAINING_SCREENS: ScreenRoute[] = [
  { path: PATHS.plans, title: 'Training plans', permission: PLAN_READ, nav: true, component: PlansScreen },
  { path: '/training/plans/:id', title: 'Training plan', permission: PLAN_READ, nav: false, component: PlanScreen },
  { path: '/training/plans/:id/feedback', title: 'Training feedback', permission: FEEDBACK_READ, nav: false, component: FeedbackScreen },
  { path: '/training/participants/:id', title: 'Training participation', permission: PART_READ, nav: false, component: ParticipantScreen },
  { path: '/training/employees/:id', title: 'Employee’s training', permission: PART_READ, nav: false, component: EmployeeTrainingScreen },
];

/** H3 TN17 in the Employee OWN context (registration essTabs: participations, openPlans, enrol, feedback, submitFeedback). */
export const TRAINING_ESS_PANELS: EssPanel[] = [{ tabId: 'TN17', component: MyTrainingPanel }];

/**
 * The training module routes no decision to a reviewer (I-26: no approval workflow; the coordinator confirms
 * nominations on the plan's participants screen), so it has no task route and no decision queue.
 */
export const TRAINING_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [];
