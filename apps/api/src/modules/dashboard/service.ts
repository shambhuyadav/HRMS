// Role dashboards (FR-096, FR-097; BR-045; DF17; F2; CI23; ZT28).
// The selected assignment's role picks its active dashboard. Each widget is shown only when its permission is
// granted inside that same assignment; a denied widget is omitted (never shown as zero). Metrics use the same
// scope predicates as the source lists, so counts reconcile with drill-down pages. A metric whose module is not
// built yet is reported NOT_AVAILABLE rather than a misleading zero. A widget links to its source list and the page
// offers shortcuts only where the destination is permitted in the same assignment (sources.ts).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { countAccessGrants, listCompanyUsers } from '../access/admin.js';
import { parsePermissionKey } from '../access/baseline.js';
import { APPRAISAL_METRICS } from '../appraisal/metrics.js';
import { AUDIT_METRICS } from '../audit-trail/metrics.js';
import { isCompanyWide } from '../audit-trail/service.js';
import { RUNS_FROM, runCondition } from '../biometric/run-list.js';
import { EMPLOYEE_STATUS_GROUPS } from '../employee/service.js';
import { EXPENSE_METRICS } from '../expense/metrics.js';
import { HIRING_METRICS } from '../hiring/metrics.js';
import { PAYROLL_METRICS } from '../payroll/metrics.js';
import { isModuleActive, MODULE_REGISTRATIONS } from '../registry.js';
import { teamMemberPredicate } from '../team/service.js';
import { TRAINING_METRICS } from '../training/metrics.js';
import { METRIC_SOURCES, type MetricSource, type SourceCombine, type SourceList } from './sources.js';
import { assignmentPendingTasks, countOf, monthStart, myPendingTasks, notAvailable } from './tasks.js';

export type MetricResult = { status: 'OK'; value: number | string } | { status: 'NOT_CONFIGURED'; message: string } | { status: 'NOT_AVAILABLE' };

/** An operational record with no employee to scope cannot be counted for a filtered assignment: shown as such, never a whole-company count (FR-096). */
const NOT_COMPANY_WIDE: MetricResult = { status: 'NOT_CONFIGURED', message: 'This count needs an unrestricted company-scope assignment' };

type Metric = (db: Queryable, grant: AccessGrant) => Promise<MetricResult>;

const count = async (db: Queryable, sql: string, params: unknown[]): Promise<MetricResult> => ({
  status: 'OK',
  value: Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0),
});

const ACTIVE = EMPLOYEE_STATUS_GROUPS.ACTIVE;

/**
 * F2 "Own pending requests": the request kinds an employee submits, each with the states in which the request
 * still waits for a reviewer's decision, or for the employee after a return (correct and resubmit, or withdraw).
 * Not pending: a decided request (APPROVED, even where a cancellation can still follow; REJECTED, WITHDRAWN,
 * CANCELLED), an expense DRAFT that was never submitted, and processes about the employee that the employee did
 * not request (employee_confirmation, increment_case), which are never counted. A new request kind or state must
 * be classified here (dashboard.api.test.ts checks this list against the transaction state catalogue).
 */
export const OWN_REQUEST_PENDING_STATES: Readonly<Record<string, readonly string[]>> = {
  leave_request: ['SUBMITTED', 'RETURNED'],
  leave_cancellation: ['SUBMITTED'],
  outdoor_duty: ['SUBMITTED', 'RETURNED'],
  holiday_work: ['SUBMITTED', 'RETURNED'],
  expense_claim: ['MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING', 'RETURNED'],
  profile_change: ['SUBMITTED'],
  attendance_correction: ['SUBMITTED'],
  // Kinds added by registered business modules classify themselves (registry-types.ts transactionKinds).
  ...Object.fromEntries(
    MODULE_REGISTRATIONS.flatMap((m) => Object.entries(m.transactionKinds ?? {})).flatMap(([kind, states]) => (states ? [[kind, states] as const] : [])),
  ),
};

/** Kinds that are processes about an employee or company records, never the employee's own request. */
export const NOT_OWN_REQUEST_KINDS: readonly string[] = [
  'employee_confirmation',
  'increment_case',
  'payment_batch',
  ...MODULE_REGISTRATIONS.flatMap((m) => Object.entries(m.transactionKinds ?? {})).flatMap(([kind, states]) => (states ? [] : [kind])),
];
/**
 * F2 Reporting Manager "Assigned leave/expense tasks": the kinds of GET /leave/tasks and GET /expense/tasks, so the widget
 * equals those two queues (FR-060 "dashboard counts reconcile to the queue"). A manager's other duties (exit
 * recommendation, outdoor duty and holiday work, timesheets, appraisal, attendance corrections) have their own queues.
 */
export const LEAVE_EXPENSE_TASK_KINDS: readonly string[] = ['leave_request', 'leave_cancellation', 'expense_claim'];

export const OWN_REQUEST_PENDING_PAIRS = Object.entries(OWN_REQUEST_PENDING_STATES).flatMap(([kind, states]) => states.map((state) => [kind, state] as const));

export const METRICS: Record<string, Metric> = {
  // The user and grant lists' own predicates, so a filtered administrator counts only what those lists show them.
  ACTIVE_ACCOUNTS: async (db, g) => ({ status: 'OK', value: (await listCompanyUsers(db, g, { holdingAccess: true, page: 1, pageSize: 1 })).total }),
  PENDING_ACCESS_GRANTS: async (db, g) => ({ status: 'OK', value: await countAccessGrants(db, g, { state: 'PENDING' }) }),
  // Deliveries and integration runs belong to no employee, so a filtered assignment cannot be given a part of them.
  FAILED_NOTIFICATION_DELIVERIES: (db, g) =>
    isCompanyWide(g) ? count(db, `select count(*) as n from notification where company_id = $1 and state = 'FAILED'`, [g.companyId]) : Promise.resolve(NOT_COMPANY_WIDE),
  // F2 "Failed integration runs": this month's failed or partly failed biometric runs (DF17 operational counts default to the month).
  FAILED_INTEGRATION_RUNS: (db, g) => {
    if (!isCompanyWide(g)) return Promise.resolve(NOT_COMPANY_WIDE);
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${RUNS_FROM} where ${runCondition(g, p, { failed: true, from: monthStart(g.businessDate), to: g.businessDate })}`, p);
  },

  ACTIVE_EMPLOYEES: (db, g) => {
    const p = new SqlParams();
    const scope = employeeScopePredicate(g, { company: 'e.company_id', employee: 'e.id' }, p);
    return count(
      db,
      `select count(*) as n from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where ${scope} and st.code = any(${p.add(ACTIVE)}::text[])`,
      p.values,
    );
  },
  DRAFT_EMPLOYEES: (db, g) => {
    const p = new SqlParams();
    const scope = employeeScopePredicate(g, { company: 'e.company_id', employee: 'e.id' }, p);
    return count(
      db,
      `select count(*) as n from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where ${scope} and st.code = 'DRAFT'`,
      p.values,
    );
  },
  CONFIRMATIONS_DUE_30: (db, g) => {
    const p = new SqlParams();
    const scope = employeeScopePredicate(g, { company: 'c.company_id', employee: 'c.employee_id' }, p);
    return count(
      db,
      `select count(*) as n from employee_confirmation c
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code = 'ACTIVE_PROBATION'
        where ${scope} and c.state in ('OPEN', 'REVIEW_PENDING') and c.current_due_date <= ${p.add(g.businessDate)}::date + 30`,
      p.values,
    );
  },
  // F2 "Assigned HR tasks" and the like: the pending-task list of this assignment (DF17 "no merging across role assignments").
  MY_OPEN_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${assignmentPendingTasks(g, p)}`, p);
  },
  LEAVE_EXPENSE_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${myPendingTasks(g, p, LEAVE_EXPENSE_TASK_KINDS)}`, p);
  },

  TODAY_ATTENDANCE_STATUS: async (db, g) => {
    if (!g.linkedEmployeeId) return { status: 'NOT_CONFIGURED', message: 'No employee record is linked to this account' };
    const row = (
      await db.query<{ code: string }>(
        `select rv.code from attendance_record r join reference_value rv on rv.company_id = r.company_id and rv.id = r.status_id
          where r.company_id = $1 and r.employee_id = $2 and r.work_date = $3::date`,
        [g.companyId, g.linkedEmployeeId, g.businessDate],
      )
    ).rows[0];
    return { status: 'OK', value: row?.code ?? 'NOT_PROCESSED' };
  },
  OWN_ANNUAL_LEAVE_BALANCE: async (db, g) => {
    if (!g.linkedEmployeeId) return { status: 'NOT_CONFIGURED', message: 'No employee record is linked to this account' };
    const active = await db.query(
      `select 1 from leave_policy p join leave_type t on t.company_id = p.company_id and t.id = p.leave_type_id
        where p.company_id = $1 and t.code = 'ANNUAL'
          and (p.state = 'ACTIVE' or (p.state = 'RETIRED' and p.effective_to > hrms_business_date(p.company_id, now())))`,
      [g.companyId],
    );
    // F2: before the policy is active show "Policy not active", never a fabricated zero balance.
    if (!active.rowCount) return { status: 'NOT_CONFIGURED', message: 'Policy not active' };
    const row = (
      await db.query<{ v: string }>(
        `select coalesce(sum(m.units), 0)::numeric(12,4)::text as v from leave_movement m join leave_type t on t.company_id = m.company_id and t.id = m.leave_type_id
          where m.company_id = $1 and m.employee_id = $2 and t.code = 'ANNUAL'`,
        [g.companyId, g.linkedEmployeeId],
      )
    ).rows[0]!;
    return { status: 'OK', value: row.v };
  },
  OWN_PENDING_REQUESTS: async (db, g) => {
    if (!g.linkedEmployeeId) return { status: 'NOT_CONFIGURED', message: 'No employee record is linked to this account' };
    return count(
      db,
      `select count(*) as n from business_transaction bt
         join unnest($3::text[], $4::text[]) as p (kind, state) on p.kind = bt.kind and p.state = bt.state
        where bt.company_id = $1 and bt.owner_employee_id = $2`,
      [g.companyId, g.linkedEmployeeId, OWN_REQUEST_PENDING_PAIRS.map(([kind]) => kind), OWN_REQUEST_PENDING_PAIRS.map(([, state]) => state)],
    );
  },

  TEAM_COUNT: (db, g) => {
    const p = new SqlParams();
    return count(db, `select count(*) as n from employee e where ${teamMemberPredicate(g, p)}`, p.values);
  },
  TEAM_ATTENDANCE_EXCEPTIONS: (db, g) => {
    const p = new SqlParams();
    const member = teamMemberPredicate(g, p);
    return count(
      db,
      `select count(*) as n from attendance_record r join employee e on e.company_id = r.company_id and e.id = r.employee_id
         join reference_value rv on rv.company_id = r.company_id and rv.id = r.status_id
        where ${member} and rv.code = 'EXCEPTION' and r.work_date = ${p.add(g.businessDate)}::date`,
      p.values,
    );
  },
  TEAM_REVIEWS_DUE: (db, g) => {
    const p = new SqlParams();
    const member = teamMemberPredicate(g, p);
    return count(
      db,
      `select count(*) as n from employee_confirmation c join employee e on e.company_id = c.company_id and e.id = c.employee_id
         join reference_value case_status on case_status.company_id = e.company_id and case_status.id = e.status_id and case_status.code = 'ACTIVE_PROBATION'
        where ${member} and c.state in ('OPEN', 'REVIEW_PENDING') and c.current_due_date <= ${p.add(g.businessDate)}::date + 30`,
      p.values,
    );
  },

  NOT_YET_AVAILABLE: async () => ({ status: 'NOT_AVAILABLE' }),
  // F2 Finance Reviewer widgets whose source records the role cannot read in this build: no reconciliation workflow
  // exists, and the role's ceiling holds no expense or payment read grant (expense.read, payment.read and the payroll
  // bank ledger are finance-duty grants of eligible Admin assignments, DF02/DF07). A count would aggregate records
  // outside the role's grants (FR-097), so they are visibly unavailable until a grant decision is made.
  FINANCE_RECONCILIATION_TASKS: notAvailable,
  FINANCE_UNRECONCILED_OUTCOMES: notAvailable,
  FINANCE_EXPENSE_STATES: notAvailable,
  // F2 metrics of the core expense/payment and audit records (Treasury, Finance Reviewer, Expense Finance Approver,
  // Auditor).
  ...EXPENSE_METRICS,
  ...AUDIT_METRICS,
  // F2 metrics of business modules (Employee "Own training/tasks due", Recruiter, Training Coordinator, Payroll
  // Operator and Approver, Appraisal Reviewer).
  ...moduleMetrics('hiring', HIRING_METRICS),
  ...moduleMetrics('training', TRAINING_METRICS),
  ...moduleMetrics('payroll', PAYROLL_METRICS),
  ...moduleMetrics('appraisal', APPRAISAL_METRICS),
};

/** A module's metrics, reported NOT_AVAILABLE while that module is not active (never a misleading zero). */
function moduleMetrics(key: string, metrics: Readonly<Record<string, Metric>>): Record<string, Metric> {
  return Object.fromEntries(
    Object.entries(metrics).map(([code, metric]): [string, Metric] => [code, (db, g) => (isModuleActive(key) ? metric(db, g) : Promise.resolve({ status: 'NOT_AVAILABLE' }))]),
  );
}

/** A widget's link as the page receives it: where it opens, and the list routes that reconcile with its value. */
export interface WidgetSource {
  href: string;
  lists: SourceList[];
  combine: SourceCombine;
  /** The module screen with the records, for the actions the records screen does not offer. */
  shortcut?: { to: string; label: string };
}

/** The screen that shows a widget's records with its filters, when no module screen applies them itself. */
const sourceScreen = (widgetCode: string) => `/dashboard/sources/${widgetCode}`;

/**
 * Whether a destination is open in the selected assignment: every permission its routes need, and any further condition
 * it has. One decision per permission per request (FR-097 "A shortcut cannot perform an action denied on its destination").
 */
function destinationCheck(db: Queryable, grant: AccessGrant) {
  const decisions = new Map<string, Promise<boolean>>();
  const allowed = (key: string) => {
    let decision = decisions.get(key);
    if (!decision) {
      const { resource, action, fieldGroup } = parsePermissionKey(key as `${string}.${string}.${string}`);
      decision = resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [fieldGroup] }).then((d) => d.allowed);
      decisions.set(key, decision);
    }
    return decision;
  };
  return async (source: MetricSource): Promise<boolean> => {
    if (source.available && !source.available(grant)) return false;
    return (await Promise.all(source.permissions.map(allowed))).every(Boolean);
  };
}

export async function roleDashboard(db: Queryable, grant: AccessGrant) {
  const def = (
    await db.query<{ id: string; title: string; code: string }>(
      `select d.id, d.title, d.dashboard_code as code from role_dashboard_definition d join role_assignment ra on ra.company_id = d.company_id and ra.role_id = d.role_id
        where d.company_id = $1 and ra.id = $2 and d.state = 'ACTIVE' and d.dashboard_code = 'HOME'`,
      [grant.companyId, grant.assignmentId],
    )
  ).rows[0];
  const company = (await db.query<{ name: string }>(`select name from company where id = $1`, [grant.companyId])).rows[0];
  // DF17: selected role assignment, company and scope, reporting period and refreshed-at time. Attendance counts are of
  // today; operational counts are of the month or stated by the widget's own title.
  const header = {
    role: grant.roleCode,
    scope: grant.scopeKind,
    company: company?.name ?? null,
    businessDate: grant.businessDate,
    period: { from: monthStart(grant.businessDate), to: grant.businessDate },
    refreshedAt: new Date().toISOString(),
  };
  // A role without an eligible dashboard gets a neutral no-access state, never another role's view (FR-096).
  if (!def) return { ...header, title: null, state: 'NO_DASHBOARD', widgets: [], shortcuts: [] };

  const widgets = (
    await db.query<{ widget_code: string; title: string; metric_code: string; display_kind: string; resource: string; action: string; field_group: string; position: number }>(
      `select w.widget_code, w.title, w.metric_code, w.display_kind, p.resource, p.action, p.field_group, w.position
         from role_dashboard_widget w join permission p on p.id = w.permission_id
        where w.company_id = $1 and w.dashboard_id = $2 order by w.position`,
      [grant.companyId, def.id],
    )
  ).rows;

  const out = [];
  const shortcuts = new Map<string, string>();
  const destinationOpen = destinationCheck(db, grant);
  for (const w of widgets) {
    // Same assignment, the widget's own permission and field group; denied widgets are omitted (FR-097).
    const widgetGrant = await resolveAccess(db, {
      userId: grant.userId,
      companyId: grant.companyId,
      assignmentId: grant.assignmentId,
      resource: w.resource,
      action: w.action,
      fieldGroups: [w.field_group],
    });
    if (!widgetGrant.allowed) continue;
    const metric = METRICS[w.metric_code] ?? METRICS.NOT_YET_AVAILABLE!;
    let result: MetricResult;
    try {
      result = await metric(db, widgetGrant);
    } catch {
      result = { status: 'NOT_AVAILABLE' }; // retrieval failure is a visible unavailable state, never zero
    }
    const source = METRIC_SOURCES[w.metric_code];
    const open = source ? await destinationOpen(source) : false;
    if (source?.shortcut && open) shortcuts.set(source.shortcut.to, source.shortcut.label);
    const link: WidgetSource | null =
      source && open && result.status === 'OK'
        ? { href: source.screen?.(grant) ?? sourceScreen(w.widget_code), lists: source.lists(grant), combine: source.combine ?? 'SUM', ...(source.shortcut ? { shortcut: source.shortcut } : {}) }
        : null;
    out.push({ code: w.widget_code, title: w.title, kind: w.display_kind, ...result, ...(link ? { source: link } : {}) });
  }
  return { ...header, title: def.title, state: 'OK', widgets: out, shortcuts: [...shortcuts].map(([to, label]) => ({ to, label })) };
}

/** F2 initial catalogue: four widgets per baseline role, each tied to a permission the role can hold. */
export const BASELINE_DASHBOARDS: Record<string, { title: string; widgets: { code: string; title: string; metric: string; permission: string; kind: 'COUNT' | 'STATUS' | 'BALANCE' }[] }> = {
  SYSTEM_ADMINISTRATOR: {
    title: 'System administration',
    widgets: [
      { code: 'ACTIVE_ACCOUNTS', title: 'Active accounts', metric: 'ACTIVE_ACCOUNTS', permission: 'access.read_users.operational', kind: 'COUNT' },
      { code: 'PENDING_GRANTS', title: 'Pending access grants', metric: 'PENDING_ACCESS_GRANTS', permission: 'access.approve_role_grant.operational', kind: 'COUNT' },
      { code: 'FAILED_INTEGRATIONS', title: 'Failed integration runs', metric: 'FAILED_INTEGRATION_RUNS', permission: 'biometric.read.operational', kind: 'COUNT' },
      { code: 'FAILED_NOTIFICATIONS', title: 'Failed notification deliveries', metric: 'FAILED_NOTIFICATION_DELIVERIES', permission: 'notification.read_delivery.operational', kind: 'COUNT' },
    ],
  },
  HR_ADMINISTRATOR: {
    title: 'HR administration',
    widgets: [
      { code: 'ACTIVE_EMPLOYEES', title: 'Active employees', metric: 'ACTIVE_EMPLOYEES', permission: 'employee.list.operational', kind: 'COUNT' },
      { code: 'CONFIRMATIONS_DUE', title: 'Confirmations due within 30 days', metric: 'CONFIRMATIONS_DUE_30', permission: 'confirmation.read.operational', kind: 'COUNT' },
      { code: 'MISSING_ACTIVATION', title: 'Draft employees awaiting activation data', metric: 'DRAFT_EMPLOYEES', permission: 'employee.activate.operational', kind: 'COUNT' },
      { code: 'MY_TASKS', title: 'Assigned HR tasks', metric: 'MY_OPEN_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
    ],
  },
  EMPLOYEE: {
    title: 'My work',
    widgets: [
      { code: 'TODAY_ATTENDANCE', title: 'Today’s attendance', metric: 'TODAY_ATTENDANCE_STATUS', permission: 'attendance.read.operational', kind: 'STATUS' },
      { code: 'LEAVE_BALANCE', title: 'Annual leave balance (days)', metric: 'OWN_ANNUAL_LEAVE_BALANCE', permission: 'leave.read.operational', kind: 'BALANCE' },
      { code: 'MY_REQUESTS', title: 'My pending requests', metric: 'OWN_PENDING_REQUESTS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'MY_TRAINING', title: 'Training and tasks due', metric: 'OWN_TRAINING_DUE', permission: 'dashboard.read.operational', kind: 'COUNT' },
    ],
  },
  REPORTING_MANAGER: {
    title: 'My team',
    widgets: [
      { code: 'TEAM_COUNT', title: 'Current direct team', metric: 'TEAM_COUNT', permission: 'team.list.operational', kind: 'COUNT' },
      { code: 'TEAM_EXCEPTIONS', title: 'Unresolved attendance exceptions today', metric: 'TEAM_ATTENDANCE_EXCEPTIONS', permission: 'attendance.read.operational', kind: 'COUNT' },
      { code: 'MY_TASKS', title: 'Leave and expense decisions waiting', metric: 'LEAVE_EXPENSE_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'TEAM_REVIEWS', title: 'Team confirmations due', metric: 'TEAM_REVIEWS_DUE', permission: 'confirmation.read.operational', kind: 'COUNT' },
    ],
  },
  // F2 financial role dashboards: counts and states only, never salary, bank, tax or receipt contents. Every widget
  // permission is operational and in the role's ceiling (baseline duties or the module's role grants).
  PAYROLL_OPERATOR: {
    title: 'Payroll preparation',
    widgets: [
      { code: 'OPEN_PERIODS', title: 'Open payroll periods', metric: 'PAYROLL_OPEN_PERIODS', permission: 'payroll_config.read.operational', kind: 'COUNT' },
      { code: 'INPUT_EXCEPTIONS', title: 'Unresolved input-validation exceptions', metric: 'PAYROLL_UNRESOLVED_EXCEPTIONS', permission: 'payroll_run.read.operational', kind: 'COUNT' },
      { code: 'PREPARATION', title: 'Runs awaiting calculation or submission', metric: 'PAYROLL_RUNS_IN_PREPARATION', permission: 'payroll_run.read.operational', kind: 'COUNT' },
      { code: 'PERIOD_STATE', title: 'Current period calculation state', metric: 'PAYROLL_CURRENT_PERIOD_STATE', permission: 'payroll_run.read.operational', kind: 'STATUS' },
    ],
  },
  PAYROLL_APPROVER: {
    title: 'Payroll approval',
    widgets: [
      { code: 'REVIEW_TASKS', title: 'Assigned payroll review tasks', metric: 'PAYROLL_REVIEW_TASKS', permission: 'payroll_run.read.operational', kind: 'COUNT' },
      { code: 'OVERDUE_REVIEWS', title: 'Review tasks past the payment date', metric: 'PAYROLL_REVIEW_TASKS_OVERDUE', permission: 'payroll_run.read.operational', kind: 'COUNT' },
      // '<approved>/<locked>' runs of the current period, shown as text.
      { code: 'APPROVED_LOCKED', title: 'Approved / locked runs this period', metric: 'PAYROLL_APPROVED_LOCKED_RUNS', permission: 'payroll_run.read.operational', kind: 'STATUS' },
      { code: 'UNRESOLVED_EXCEPTIONS', title: 'Unresolved run exceptions', metric: 'PAYROLL_UNRESOLVED_EXCEPTIONS', permission: 'payroll_run.read.operational', kind: 'COUNT' },
    ],
  },
  FINANCE_REVIEWER: {
    title: 'Financial review',
    widgets: [
      { code: 'RECONCILIATION_TASKS', title: 'Reconciliation tasks', metric: 'FINANCE_RECONCILIATION_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'UNRECONCILED_OUTCOMES', title: 'Unreconciled payment outcomes', metric: 'FINANCE_UNRECONCILED_OUTCOMES', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'EXPENSE_REVIEW_TASKS', title: 'Assigned expense review tasks', metric: 'EXPENSE_REVIEW_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'EXPENSE_STATES', title: 'Operational expense states', metric: 'FINANCE_EXPENSE_STATES', permission: 'dashboard.read.operational', kind: 'STATUS' },
    ],
  },
  EXPENSE_FINANCE_APPROVER: {
    title: 'Expense final decisions',
    widgets: [
      { code: 'FINAL_DECISIONS', title: 'Assigned final expense decisions', metric: 'EXPENSE_FINAL_DECISION_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'LATE_RECEIPT', title: 'Late or missing-receipt claims awaiting decision', metric: 'EXPENSE_LATE_RECEIPT_EXCEPTIONS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'RETURNED', title: 'Claims returned, awaiting the claimant', metric: 'EXPENSE_RETURNED_BY_ME', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'DECISIONS_DUE', title: 'Decision due tasks', metric: 'EXPENSE_DECISION_DUE_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
    ],
  },
  TREASURY_OPERATOR: {
    title: 'Payment preparation',
    widgets: [
      // F2 "Assigned payment preparation tasks": payment preparation has no approval task in this build (a payment batch
      // runs no workflow), so there is no queue to reconcile with; counting the user's other tasks here would not be this.
      { code: 'MY_TASKS', title: 'Assigned payment preparation tasks', metric: 'NOT_YET_AVAILABLE', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'AWAITING_OUTCOME', title: 'Payments awaiting outcome', metric: 'PAYMENTS_AWAITING_OUTCOME', permission: 'payment.read.operational', kind: 'COUNT' },
      { code: 'FAILED', title: 'Failed payments', metric: 'PAYMENTS_FAILED', permission: 'payment.read.operational', kind: 'COUNT' },
      { code: 'RECONCILE', title: 'Reservations needing reconciliation', metric: 'NOT_YET_AVAILABLE', permission: 'dashboard.read.operational', kind: 'COUNT' },
    ],
  },
  TREASURY_APPROVER: {
    title: 'Payment release',
    widgets: [
      { code: 'RELEASE_TASKS', title: 'Payments awaiting independent release', metric: 'PAYMENTS_AWAITING_RELEASE', permission: 'payment.read.operational', kind: 'COUNT' },
      { code: 'OVERDUE_RELEASES', title: 'Releases past the payment date', metric: 'PAYMENTS_RELEASE_OVERDUE', permission: 'payment.read.operational', kind: 'COUNT' },
      // '<confirmed>/<reversed>' payments of the current month, shown as text.
      { code: 'CONFIRMED_REVERSED', title: 'Confirmed / reversed payments this month', metric: 'PAYMENTS_CONFIRMED_REVERSED', permission: 'payment.read.operational', kind: 'STATUS' },
      { code: 'AWAITING_OUTCOME', title: 'Payments awaiting outcome', metric: 'PAYMENTS_AWAITING_OUTCOME', permission: 'payment.read.operational', kind: 'COUNT' },
    ],
  },
  RECRUITER: {
    title: 'Recruitment',
    widgets: [
      { code: 'APPROVED_REQUISITIONS', title: 'Approved requisitions', metric: 'APPROVED_REQUISITIONS', permission: 'requisition.read.operational', kind: 'COUNT' },
      { code: 'PIPELINE', title: 'Applications in the pipeline', metric: 'OPEN_PIPELINE_APPLICATIONS', permission: 'application.read.operational', kind: 'COUNT' },
      { code: 'INTERVIEWS_DUE', title: 'Interview tasks due', metric: 'INTERVIEW_TASKS_DUE', permission: 'application.read.operational', kind: 'COUNT' },
      { code: 'OFFERS_AWAITING', title: 'Offers awaiting eligible Admin review', metric: 'OFFERS_AWAITING_APPROVAL', permission: 'offer.read.operational', kind: 'COUNT' },
    ],
  },
  APPRAISAL_REVIEWER: {
    title: 'Appraisal review',
    widgets: [
      { code: 'ASSIGNED_TASKS', title: 'Assigned appraisal tasks', metric: 'APPRAISAL_ASSIGNED_TASKS', permission: 'appraisal.read.operational', kind: 'COUNT' },
      // '<submitted>/<reviewed>' appraisals in scope, shown as text.
      { code: 'SUBMITTED_REVIEWED', title: 'Submitted / reviewed appraisals', metric: 'APPRAISAL_SUBMITTED_REVIEWED', permission: 'appraisal.read.operational', kind: 'STATUS' },
      { code: 'OVERDUE_REVIEWS', title: 'Overdue review tasks', metric: 'APPRAISAL_REVIEW_TASKS_OVERDUE', permission: 'appraisal.read.operational', kind: 'COUNT' },
      { code: 'RETURNED', title: 'Returned appraisals', metric: 'APPRAISAL_RETURNED', permission: 'appraisal.read.operational', kind: 'COUNT' },
    ],
  },
  TRAINING_COORDINATOR: {
    title: 'Training',
    widgets: [
      { code: 'SESSIONS', title: 'Current and future training sessions', metric: 'TRAINING_SESSIONS_CURRENT_FUTURE', permission: 'training_plan.read.operational', kind: 'COUNT' },
      { code: 'CONFIRMED', title: 'Confirmed participations', metric: 'TRAINING_CONFIRMED_PARTICIPATIONS', permission: 'training_participant.read.operational', kind: 'COUNT' },
      // The metric answers '<completed>/<no-show>', so it is shown as text.
      { code: 'COMPLETION_NO_SHOW', title: 'Completed / no-show participations', metric: 'TRAINING_COMPLETION_NO_SHOW', permission: 'training_participant.read.operational', kind: 'STATUS' },
      { code: 'FEEDBACK_PENDING', title: 'Feedback pending', metric: 'TRAINING_FEEDBACK_PENDING', permission: 'training_feedback.read.operational', kind: 'COUNT' },
    ],
  },
  AUDITOR: {
    title: 'Audit',
    widgets: [
      { code: 'AUDIT_EVENTS', title: 'Audit events this month (values redacted)', metric: 'AUDIT_EVENTS_THIS_MONTH', permission: 'audit.read.operational', kind: 'COUNT' },
      { code: 'ACCESS_DENIED', title: 'Refused access attempts this month', metric: 'AUDIT_ACCESS_DENIED_THIS_MONTH', permission: 'audit.read.operational', kind: 'COUNT' },
      { code: 'REVIEW_EVIDENCE', title: 'Review evidence tasks', metric: 'AUDIT_REVIEW_EVIDENCE_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' },
      { code: 'CONFIG_REVISIONS', title: 'Configuration revisions this month', metric: 'AUDIT_CONFIGURATION_REVISIONS_THIS_MONTH', permission: 'audit.read.operational', kind: 'COUNT' },
    ],
  },
};

/** Roles without a detailed F2 implementation yet get a tasks widget plus clearly unavailable placeholders. */
export function dashboardFor(roleCode: string, roleName: string) {
  return (
    BASELINE_DASHBOARDS[roleCode] ?? {
      title: roleName,
      widgets: [
        { code: 'MY_TASKS', title: 'Assigned tasks', metric: 'MY_OPEN_TASKS', permission: 'dashboard.read.operational', kind: 'COUNT' as const },
        { code: 'MODULE_STATUS', title: 'Role metrics', metric: 'NOT_YET_AVAILABLE', permission: 'dashboard.read.operational', kind: 'COUNT' as const },
      ],
    }
  );
}

export function widgetPermission(key: string) {
  return parsePermissionKey(key as `${string}.${string}.${string}`);
}
