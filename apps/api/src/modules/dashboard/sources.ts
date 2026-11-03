// Each dashboard metric's source list (FR-097; BR-045; DF17 "Every widget links to source lists with the same filters;
// action button is shown only when the current assignment permits the destination action/state"; F2 "Only granted source
// lists/tasks"). A source names the list routes that hold the metric's records, with exactly the metric's filters, and the
// permissions those routes need. roleDashboard shows it only when every one of them is allowed in the selected assignment.
//
// A metric without a source here has no list its role may read: the role's ceiling holds no grant for the records (the
// Finance Reviewer's and Expense Finance Approver's expense counts, the Payroll Approver's review tasks), or the metric is
// not available at all. Such a widget shows its value with no link rather than a link that would be refused.
import type { AccessGrant } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { monthStart } from './tasks.js';

export interface SourceList {
  /** Names this list when a widget has several. */
  label?: string;
  /** The list route with the widget's filters, as the caller may request it. */
  api: string;
  /** The widget counts this field over the rows, not the rows themselves. */
  sumOf?: string;
}

/** How a widget's value follows from its lists' counts: their sum, '<a>/<b>' per list, or a state not derived from a count. */
export type SourceCombine = 'SUM' | 'PARTS' | 'NONE';

export interface MetricSource {
  permissions: readonly PermissionKey[];
  lists(g: AccessGrant): SourceList[];
  combine?: SourceCombine;
  /** A screen that applies the same filters itself; otherwise the widget opens its own records screen. */
  screen?(g: AccessGrant): string;
  /** The module screen to offer as a shortcut (the same permissions guard it). */
  shortcut?: { to: string; label: string };
  /** Further conditions of the destination, beyond its permissions. */
  available?(g: AccessGrant): boolean;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const withQuery = (path: string, query: Record<string, string>) => {
  const text = new URLSearchParams(query).toString();
  return text ? `${path}?${text}` : path;
};

// Further conditions of some routes: company scope, an unrestricted company scope, a linked employee.
const companyScoped = (g: AccessGrant) => g.scopeKind === 'COMPANY';
const companyWide = (g: AccessGrant) => g.scopeKind === 'COMPANY' && g.filters.departments.length + g.filters.locations.length + g.filters.employees.length === 0;
const linked = (g: AccessGrant) => g.linkedEmployeeId !== null;

const EMPLOYEES = { to: '/employees', label: 'Employees' };
const TEAM = { to: '/team', label: 'My team' };
const DECISIONS = { to: '/tasks', label: 'Decisions' };
const ACCESS = { to: '/access', label: 'User access' };
const RUNS = { to: '/payroll/runs', label: 'Payroll runs' };
const PAYMENTS = { to: '/payments', label: 'Payments' };
const TRAINING = { to: '/training/plans', label: 'Training plans' };
const AUDIT = { to: '/admin/audit', label: 'Audit trail' };
const APPRAISALS = { to: '/appraisal/appraisals', label: 'Appraisals' };

const employeesWith = (query: Record<string, string>): MetricSource => ({
  permissions: ['employee.list.operational'],
  lists: () => [{ api: withQuery('/v1/employees', query) }],
  screen: () => withQuery('/employees', query),
  shortcut: EMPLOYEES,
});

const teamWith = (query: (g: AccessGrant) => Record<string, string>): MetricSource => ({
  permissions: ['team.list.operational'],
  lists: (g) => [{ api: withQuery('/v1/my-team', query(g)) }],
  screen: (g) => withQuery('/team', query(g)),
  shortcut: TEAM,
});

const runsOf = (query: (g: AccessGrant) => Record<string, string>, extra: Partial<SourceList> = {}, combine?: SourceCombine): MetricSource => ({
  permissions: ['payroll_run.read.operational'],
  lists: (g) => [{ api: withQuery('/v1/payroll/runs', query(g)), ...extra }],
  shortcut: RUNS,
  ...(combine ? { combine } : {}),
});

const paymentsWith = (query: Record<string, string>): MetricSource => ({
  permissions: ['payment.read.operational'],
  lists: () => [{ api: withQuery('/v1/expense/payments', query) }],
  shortcut: PAYMENTS,
});

const auditWith = (query: Record<string, string>): MetricSource => ({
  permissions: ['audit.read.operational'],
  lists: (g) => [{ api: withQuery('/v1/audit/events', { from: monthStart(g.businessDate), to: g.businessDate, ...query }) }],
  available: companyWide,
  shortcut: AUDIT,
});

const participants = (query: Record<string, string>): SourceList => ({ api: withQuery('/v1/training-participants', query) });

/** Runs not yet processed whose unresolved exceptions a widget adds up (PAYROLL_UNRESOLVED_EXCEPTIONS). */
const UNPROCESSED_RUN_STATES = 'DRAFT,CALCULATED,IN_REVIEW,APPROVED';

export const METRIC_SOURCES: Readonly<Record<string, MetricSource>> = {
  ACTIVE_ACCOUNTS: { permissions: ['access.read_users.operational'], lists: () => [{ api: '/v1/access/users?holdingAccess=true' }], available: companyScoped, shortcut: ACCESS },
  PENDING_ACCESS_GRANTS: { permissions: ['access.read_users.operational'], lists: () => [{ api: '/v1/access/assignments?state=PENDING' }], available: companyScoped, shortcut: ACCESS },
  FAILED_NOTIFICATION_DELIVERIES: {
    permissions: ['notification.read_delivery.operational'],
    lists: () => [{ api: '/v1/notifications/delivery?state=FAILED' }],
    available: companyWide,
    shortcut: { to: '/notifications/delivery', label: 'Delivery log' },
  },
  FAILED_INTEGRATION_RUNS: {
    permissions: ['biometric.read.operational'],
    lists: (g) => [{ api: withQuery('/v1/biometric/runs', { failed: 'true', from: monthStart(g.businessDate), to: g.businessDate }) }],
    available: companyWide,
  },

  ACTIVE_EMPLOYEES: employeesWith({ statusGroup: 'ACTIVE' }),
  DRAFT_EMPLOYEES: employeesWith({ status: 'DRAFT' }),
  CONFIRMATIONS_DUE_30: { permissions: ['confirmation.read.operational'], lists: () => [{ api: '/v1/confirmations?view=DUE_WITHIN_30' }], shortcut: { to: '/confirmations', label: 'Confirmations' } },
  MY_OPEN_TASKS: { permissions: ['dashboard.read.operational'], lists: () => [{ api: '/v1/dashboard/tasks' }], shortcut: DECISIONS },
  // FR-060: the widget equals these two queues, so these are its source.
  LEAVE_EXPENSE_TASKS: {
    permissions: ['leave.approve.operational', 'expense.read.operational'],
    lists: () => [
      { label: 'Leave', api: '/v1/leave/tasks' },
      { label: 'Expense', api: '/v1/expense/tasks' },
    ],
    shortcut: DECISIONS,
  },

  TODAY_ATTENDANCE_STATUS: {
    permissions: ['attendance.read.operational'],
    lists: (g) => [{ api: withQuery(`/v1/employees/${g.linkedEmployeeId}/attendance`, { from: g.businessDate, to: g.businessDate }) }],
    combine: 'NONE',
    available: linked,
    shortcut: { to: '/me/attendance', label: 'My attendance' },
  },
  OWN_ANNUAL_LEAVE_BALANCE: {
    permissions: ['leave.read.operational'],
    lists: (g) => [{ api: `/v1/employees/${g.linkedEmployeeId}/leave-balances` }],
    combine: 'NONE',
    available: linked,
    shortcut: { to: '/leave', label: 'Leave' },
  },
  OWN_PENDING_REQUESTS: { permissions: ['dashboard.read.operational'], lists: () => [{ api: '/v1/me/pending-requests' }], available: linked },
  OWN_TRAINING_DUE: { permissions: ['training_participant.read.operational'], lists: (g) => [{ api: `/v1/employees/${g.linkedEmployeeId}/training?due=true` }], available: linked },

  TEAM_COUNT: teamWith(() => ({})),
  TEAM_ATTENDANCE_EXCEPTIONS: teamWith(() => ({ todayAttendance: 'EXCEPTION' })),
  TEAM_REVIEWS_DUE: teamWith((g) => ({ confirmationDueTo: addDays(g.businessDate, 30) })),

  PAYROLL_OPEN_PERIODS: {
    permissions: ['payroll_config.read.operational'],
    lists: () => [{ api: '/v1/payroll/periods?open=true' }],
    shortcut: { to: '/payroll/calendars', label: 'Payroll calendars' },
  },
  PAYROLL_UNRESOLVED_EXCEPTIONS: runsOf(() => ({ states: UNPROCESSED_RUN_STATES }), { sumOf: 'unresolvedExceptions' }),
  PAYROLL_RUNS_IN_PREPARATION: runsOf(() => ({ states: 'DRAFT,CALCULATED' })),
  PAYROLL_CURRENT_PERIOD_STATE: runsOf((g) => ({ coversDate: g.businessDate, states: `${UNPROCESSED_RUN_STATES},PROCESSED_LOCKED` }), {}, 'NONE'),
  PAYROLL_APPROVED_LOCKED_RUNS: {
    permissions: ['payroll_run.read.operational'],
    lists: (g) => [
      { label: 'Approved', api: withQuery('/v1/payroll/runs', { coversDate: g.businessDate, states: 'APPROVED' }) },
      { label: 'Locked', api: withQuery('/v1/payroll/runs', { coversDate: g.businessDate, states: 'PROCESSED_LOCKED' }) },
    ],
    combine: 'PARTS',
    shortcut: RUNS,
  },

  PAYMENTS_AWAITING_OUTCOME: paymentsWith({ state: 'RELEASED' }),
  PAYMENTS_FAILED: paymentsWith({ state: 'FAILED' }),
  PAYMENTS_AWAITING_RELEASE: paymentsWith({ state: 'PREPARED', releasableByMe: 'true' }),
  // Overdue is relative to today, so the filter names today (DF17 "overdue means pending with due date < company-local today").
  PAYMENTS_RELEASE_OVERDUE: {
    permissions: ['payment.read.operational'],
    lists: (g) => [{ api: withQuery('/v1/expense/payments', { state: 'PREPARED', releasableByMe: 'true', paymentDateBefore: g.businessDate }) }],
    shortcut: PAYMENTS,
  },
  PAYMENTS_CONFIRMED_REVERSED: {
    permissions: ['payment.read.operational'],
    lists: (g) => [
      { label: 'Confirmed', api: withQuery('/v1/expense/payments', { eventKind: 'CONFIRMED', eventFrom: monthStart(g.businessDate) }) },
      { label: 'Reversed', api: withQuery('/v1/expense/payments', { eventKind: 'REVERSED', eventFrom: monthStart(g.businessDate) }) },
    ],
    combine: 'PARTS',
    shortcut: PAYMENTS,
  },

  APPROVED_REQUISITIONS: { permissions: ['requisition.read.operational'], lists: () => [{ api: '/v1/hiring/requisitions?state=APPROVED' }], shortcut: { to: '/hiring/requisitions', label: 'Requisitions' } },
  OPEN_PIPELINE_APPLICATIONS: { permissions: ['application.read.operational'], lists: () => [{ api: '/v1/hiring/applications?open=true' }], shortcut: { to: '/hiring/tracker', label: 'Hiring tracker' } },
  OFFERS_AWAITING_APPROVAL: { permissions: ['offer.read.operational'], lists: () => [{ api: '/v1/hiring/offers?state=SUBMITTED' }], shortcut: { to: '/hiring/offers', label: 'Offers' } },

  APPRAISAL_ASSIGNED_TASKS: { permissions: ['appraisal.read.operational'], lists: () => [{ api: '/v1/appraisal-tasks/mine' }], shortcut: APPRAISALS },
  APPRAISAL_SUBMITTED_REVIEWED: {
    permissions: ['appraisal.read.operational'],
    lists: () => [
      { label: 'Submitted', api: '/v1/appraisals?stateGroup=AWAITING_DECISION' },
      { label: 'Reviewed', api: '/v1/appraisals?state=APPROVED' },
    ],
    combine: 'PARTS',
    shortcut: APPRAISALS,
  },
  APPRAISAL_RETURNED: { permissions: ['appraisal.read.operational'], lists: () => [{ api: '/v1/appraisals?state=RETURNED' }], shortcut: APPRAISALS },

  TRAINING_SESSIONS_CURRENT_FUTURE: {
    permissions: ['training_plan.read.operational'],
    lists: () => [
      { label: 'Current', api: '/v1/training-plans?view=CURRENT' },
      { label: 'Future', api: '/v1/training-plans?view=FUTURE' },
    ],
    shortcut: TRAINING,
  },
  // The shortcut's screen is the plan register, so these need its read grant too.
  TRAINING_CONFIRMED_PARTICIPATIONS: { permissions: ['training_participant.read.operational', 'training_plan.read.operational'], lists: () => [participants({ state: 'CONFIRMED' })], shortcut: TRAINING },
  TRAINING_COMPLETION_NO_SHOW: {
    permissions: ['training_participant.read.operational', 'training_plan.read.operational'],
    lists: () => [
      { label: 'Completed', ...participants({ state: 'COMPLETED' }) },
      { label: 'No-show', ...participants({ state: 'NO_SHOW' }) },
    ],
    combine: 'PARTS',
    shortcut: TRAINING,
  },
  TRAINING_FEEDBACK_PENDING: { permissions: ['training_participant.read.operational', 'training_plan.read.operational'], lists: () => [participants({ feedbackPending: 'true' })], shortcut: TRAINING },

  AUDIT_EVENTS_THIS_MONTH: auditWith({}),
  AUDIT_ACCESS_DENIED_THIS_MONTH: auditWith({ action: 'ACCESS_DENIED' }),
  AUDIT_CONFIGURATION_REVISIONS_THIS_MONTH: auditWith({ resourceGroup: 'CONFIGURATION' }),
};
