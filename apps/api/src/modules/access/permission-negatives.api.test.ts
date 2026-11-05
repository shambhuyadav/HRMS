// A refusal for every permission the access matrix (BRD line 4813, docs/registers/access-matrix.md) had none for. An actor of the same
// company, holding the role's other duties but not this permission, is refused: a 403 that says nothing about the record, no table
// changed, and one denial audited against this exact permission, which is how we know no earlier check answered. The same request from
// the same role holding the permission shows the refusal came from the permission. Ids name no record, because each of these guards
// runs before any lookup, so a holder gets as far as the lookup and a 404. Permissions chosen by a task's own step need a real task.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { appraisalWorld, decide as decideAppraisal, enrol, openCycle, person, rate, selfAssess, taskOf as appraisalTaskOf } from '../appraisal/appraisal.fixtures.js';
import { addDays, hiringWorld } from '../hiring/test-fixtures.js';
import { stillEligible } from '../notification/dispatcher.js';
import { resolveAccess } from './authorize.js';
import { BASELINE_ROLES, type PermissionKey, parsePermissionKey } from './baseline.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
type RoleCode = 'HR_ADMINISTRATOR' | 'EMPLOYEE' | 'REPORTING_MANAGER';
/** Method, path (`:id` names no record), what a holder of the permission gets, and the body that passes the route's schema. */
type Route = readonly [Method, string, number, object?];
/** How the denial is audited: FIELD_GROUP_DENIED when the role's duties still hold another field group the route accepts. */
type RefusedAs = 'NO_PERMISSION' | 'FIELD_GROUP_DENIED';
interface Row {
  key: PermissionKey;
  role: RoleCode;
  refusedAs: RefusedAs;
  method: Method;
  url: string;
  holderGets: number;
  body?: object;
}

const NONE = '00000000-0000-4000-8000-000000000000';
const DAY = '2030-01-15';
const IDEMPOTENCY_KEY = 'permission-negative-key';
const REASON = 'Synthetic reason';
const version = { expectedVersion: 1 };
const reason = { reason: REASON };
const reasonVersion = { reason: REASON, expectedVersion: 1 };
const decision = { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY };
const decisionReason = { ...decision, reason: REASON };
const period = `from=${DAY}&to=${DAY}`;

const rows = (key: PermissionKey, role: RoleCode, routes: readonly Route[], refusedAs: RefusedAs = 'NO_PERMISSION'): Row[] =>
  routes.map(([method, url, holderGets, body]) => ({ key, role, refusedAs, method, url, holderGets, ...(body ? { body } : {}) }));

const SELF_SERVICE: Row[] = [
  ...rows('appraisal.self_assess.self', 'EMPLOYEE', [
    ['PUT', '/v1/me/appraisals/:id/self-entry', 404, { entries: [], expectedVersion: 1 }],
    ['POST', '/v1/me/appraisals/:id/submit', 404, version],
  ]),
  ...rows('asset_request.read.operational', 'EMPLOYEE', [
    ['GET', '/v1/asset-requests', 200],
    ['GET', '/v1/employees/:id/asset-requests', 404],
  ]),
  ...rows('attendance.request_correction.operational', 'EMPLOYEE', [
    ['POST', '/v1/me/attendance-corrections', 404, { attendanceRecordId: NONE, status: 'PRESENT', reason: REASON }],
    ['POST', '/v1/attendance-corrections/:id/withdraw', 404],
  ]),
  // A holder's 422 here and below is the route's own business answer (no leave policy, no payroll calendar, no reviewer): past the guard.
  ...rows('leave.submit.operational', 'EMPLOYEE', [['POST', '/v1/leave/requests', 422, { leaveType: 'ANNUAL', startDate: DAY, endDate: DAY }]]),
  ...rows('leave.withdraw.operational', 'EMPLOYEE', [['POST', '/v1/leave/requests/:id/withdraw', 404]]),
  ...rows('mobile_link.read.operational', 'EMPLOYEE', [['GET', '/v1/employees/:id/mobile-links', 404]]),
  ...rows('mobile_link.request.operational', 'EMPLOYEE', [['POST', '/v1/mobile-links', 201, { appAccountRef: 'synthetic.account' }]]),
  ...rows('own_loan.read.loan', 'EMPLOYEE', [['GET', '/v1/me/loans', 200]]),
  ...rows('own_loan.request.loan', 'EMPLOYEE', [
    ['POST', '/v1/me/loans', 422, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '1000', purpose: REASON }],
    ['POST', '/v1/me/loans/:id/withdraw', 404, reasonVersion],
  ]),
  ...rows('profile_change.read.operational', 'EMPLOYEE', [['GET', '/v1/employees/:id/profile-changes', 404]]),
  ...rows('profile_change.submit.operational', 'EMPLOYEE', [
    ['POST', '/v1/me/profile-changes', 422, { displayName: 'Synthetic Changed Name' }],
    ['POST', '/v1/profile-changes/:id/withdraw', 404],
  ]),
  ...rows('training_feedback.read.operational', 'EMPLOYEE', [['GET', '/v1/me/training-feedback', 200]], 'FIELD_GROUP_DENIED'),
  ...rows('work_request.read.operational', 'EMPLOYEE', [
    ['GET', '/v1/employees/:id/work-requests', 404],
    ['GET', `/v1/work-requests/outdoor_duty?${period}`, 200],
  ]),
  ...rows('work_request.submit.operational', 'EMPLOYEE', [
    ['POST', '/v1/work-requests/outdoor_duty', 422, { startDate: DAY, endDate: DAY, purpose: REASON }],
    ['PUT', '/v1/work-requests/outdoor_duty/:id', 404, { startDate: DAY, endDate: DAY, purpose: REASON, expectedVersion: 1 }],
  ]),
  ...rows('work_request.withdraw.operational', 'EMPLOYEE', [['POST', '/v1/work-requests/outdoor_duty/:id/withdraw', 404]]),
];

const MANAGER: Row[] = [
  ...rows('exit.recommend.operational', 'REPORTING_MANAGER', [['POST', '/v1/exit-cases/tasks/:id/recommend', 404, { recommendedLastWorkingDate: DAY, idempotencyKey: IDEMPOTENCY_KEY }]]),
  ...rows('team.read.operational', 'REPORTING_MANAGER', [['GET', '/v1/my-team/:id', 404]]),
];

const HR_OPERATIONS: Row[] = [
  ...rows('attendance.amend.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/attendance/records/:id/amend', 404, { expectedVersion: 1, status: 'PRESENT', reason: REASON }]]),
  ...rows('attendance.export.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/reports', 202, { reportCode: 'ATTENDANCE_REGISTER', filters: { from: DAY, to: DAY } }]]),
  ...rows('company_policy.read.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/company-policies', 200],
    ['GET', '/v1/company-policies/:id', 404],
  ]),
  ...rows('confirmation.decide.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/confirmations/tasks/mine', 200],
    ['POST', '/v1/confirmations/tasks/:id/decision', 404, decisionReason],
  ]),
  ...rows('confirmation.export.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/reports', 202, { reportCode: 'CONFIRMATION_DUE' }]]),
  ...rows('employee.create.operational', 'HR_ADMINISTRATOR', [
    [
      'POST',
      '/v1/employees',
      422,
      { employeeCode: 'SYN-NEG-1', displayName: 'Synthetic Person', workEmail: 'negative@example.test', joiningDate: '2026-01-05', employmentType: 'PERMANENT', departmentId: NONE, locationId: NONE, designationId: NONE },
    ],
  ]),
  ...rows('exit.read.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/exit-cases', 200],
    ['GET', '/v1/exit-cases/tasks/mine', 200],
    ['GET', '/v1/exit-cases/:id', 404],
    ['GET', '/v1/employees/:id/exit-cases', 404],
  ]),
  ...rows('increment.approve.salary', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/increment-cases/tasks/mine', 200],
    ['POST', '/v1/increment-cases/tasks/:id/decision', 404, decisionReason],
  ]),
  ...rows('leave.adjust.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/leave/adjustments', 404, { employeeId: NONE, leaveType: 'ANNUAL', kind: 'ADJUSTMENT', units: '1', effectiveDate: DAY, reason: REASON, idempotencyKey: IDEMPOTENCY_KEY }],
  ]),
  ...rows('leave.export.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/reports', 202, { reportCode: 'LEAVE_REGISTER', filters: { from: DAY, to: DAY } }]]),
  ...rows('shift.assign.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/employees/:id/shift', 404, { shiftId: NONE, effectiveFrom: DAY }]]),
  ...rows('timesheet.read.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/timesheets', 200],
    ['GET', '/v1/timesheets/:id', 404],
    ['GET', '/v1/timesheet-exceptions', 200],
  ]),
  ...rows('timesheet.request_reopen.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/timesheets/:id/reopen-requests', 404, reason]]),
  ...rows('timesheet_allocation.manage.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/timesheet/allocations', 404, { employeeId: NONE, jobId: NONE, startDate: DAY, endDate: DAY, allocationPercent: '50' }],
    ['PATCH', '/v1/timesheet/allocations/:id', 404, { expectedVersion: 1, endDate: DAY }],
    ['POST', '/v1/timesheet/allocations/:id/cancel', 404, reasonVersion],
  ]),
  ...rows('training_feedback.read.operational', 'HR_ADMINISTRATOR', [['GET', '/v1/training-plans/:id/feedback-summary', 404]]),
];

const HIRING: Row[] = [
  ...rows('manpower_budget.approve.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/hiring/budget-tasks', 200],
    ['POST', '/v1/hiring/budget-tasks/:id/decision', 404, decision],
  ]),
  ...rows('manpower_budget.manage.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/hiring/budgets', 422, { departmentId: NONE, locationId: NONE, designationId: NONE, periodStart: DAY, periodEnd: DAY, headcount: 1, reason: REASON }],
    ['POST', '/v1/hiring/budgets/:id/revisions', 404, { headcount: 1, reason: REASON }],
    ['PUT', '/v1/hiring/budget-revisions/:id', 404, { headcount: 1, reason: REASON, expectedVersion: 1 }],
    ['POST', '/v1/hiring/budget-revisions/:id/submit', 404, version],
    ['POST', '/v1/hiring/budget-revisions/:id/withdraw', 404],
  ]),
  ...rows('offer.manage.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/hiring/applications/:id/offers', 404, { proposedJoiningDate: DAY }],
    ['PUT', '/v1/hiring/offers/:id', 404, { proposedJoiningDate: DAY, expectedVersion: 1 }],
    ['POST', '/v1/hiring/offers/:id/submit', 404, version],
    ['POST', '/v1/hiring/offers/:id/withdraw', 404, reason],
  ]),
  // hiring/routes.ts checks a task that is unknown or someone else's as a validation, so the guard answers before any lookup.
  ...rows('requisition.validate.operational', 'REPORTING_MANAGER', [['POST', '/v1/hiring/requisition-tasks/:id/decision', 404, decision]]),
];

const MONEY: Row[] = [
  ...rows('payment.reverse.operational', 'HR_ADMINISTRATOR', [['POST', '/v1/expense/payments/:id/reversal', 404, { amount: '1.00', evidenceKey: IDEMPOTENCY_KEY, reason: REASON }]]),
  ...rows('payroll_bank_template.manage.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll-outputs/bank-templates', 422, { templateCode: 'SYN', name: 'Synthetic', currencyCode: 'INR', bankSpecificationReference: 'SYN-REF', testOnly: true, formatDefinition: {} }],
    ['POST', '/v1/payroll-outputs/bank-templates/:id/retire', 404, reasonVersion],
  ]),
  ...rows('payroll_bank_template.read.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/payroll-outputs/bank-templates', 200],
    ['GET', '/v1/payroll-outputs/bank-templates/:id', 404],
    ['GET', '/v1/payroll-outputs/bank-templates/:id/sample', 404],
  ]),
  ...rows('payroll_bank_template.validate.operational', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll-outputs/bank-templates/:id/sample-validation', 404, { sampleHash: 'a'.repeat(64), validationReference: 'SYN-REF', expectedVersion: 1 }],
  ]),
  ...rows('payroll_hold.activate_criterion.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/hold-criteria/:id/activate', 404, version],
    ['POST', '/v1/payroll/hold-criteria/:id/retire', 404, reasonVersion],
  ]),
  ...rows('payroll_hold.decide.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/holds/:id/renew-review', 404, { reviewDueOn: DAY, reason: REASON, expectedVersion: 1 }],
    ['POST', '/v1/payroll/hold-tasks/:id/decision', 404, decision],
  ]),
  ...rows('payroll_hold.define_criterion.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/hold-criteria', 201, { code: 'SYN_CRITERION', category: 'CONTRACTUAL', applicability: 'Synthetic', scopeMode: 'FULL_ONLY', maxReviewDays: 30, evidenceReference: 'SYN-REF', validationReference: 'SYN-REF' }],
  ]),
  ...rows('payroll_hold.propose.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/records/:id/holds', 404, { criterionId: NONE, scope: 'FULL', reason: REASON, effectiveDate: DAY, reviewDueOn: DAY, releaseCriterion: REASON, evidenceReference: 'SYN-REF', evidenceDocumentIds: [NONE], idempotencyKey: IDEMPOTENCY_KEY }],
    ['POST', '/v1/payroll/holds/:id/withdraw', 404, reason],
  ]),
  ...rows('payroll_hold.read.hold', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/payroll/hold-criteria', 200],
    ['GET', '/v1/payroll/records/:id/hold-balance', 404],
    ['GET', '/v1/payroll/holds', 200],
    ['GET', '/v1/payroll/holds/tasks/mine', 200],
    ['GET', '/v1/payroll/holds/:id', 404],
  ]),
  ...rows('payroll_input.read.amount', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/payroll/input-batches', 200],
    ['GET', '/v1/payroll/input-batches/tasks/mine', 200],
    ['GET', '/v1/payroll/input-batches/:id', 404],
  ]),
  ...rows('payroll_loan.disburse.loan', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll-outputs/loans/:id/disbursement', 404, { disbursementDate: DAY, evidenceKey: IDEMPOTENCY_KEY, evidenceReference: 'SYN-REF', evidenceDocumentIds: [NONE], expectedVersion: 1 }],
  ]),
  ...rows('payroll_loan.recover.loan', 'HR_ADMINISTRATOR', [['POST', '/v1/payroll-outputs/runs/:id/loan-recoveries', 404]]),
  ...rows('payroll_run.approve.amount', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/run-tasks/:id/approve', 404, decision],
    ['POST', '/v1/payroll/run-tasks/:id/cover', 404, decision],
  ]),
  ...rows('payroll_run.review.amount', 'HR_ADMINISTRATOR', [['POST', '/v1/payroll/run-tasks/:id/review', 404, decision]]),
  ...rows('payroll_statutory.read.operational', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/payroll-outputs/statutory-outputs', 200],
    ['GET', '/v1/payroll-outputs/statutory-outputs/SYN_CODE', 404],
  ]),
  ...rows('payroll_stop.decide.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/salary-stops/:id/revoke', 404, reasonVersion],
    ['POST', '/v1/payroll/stop-tasks/:id/decision', 404, decision],
  ]),
  ...rows('payroll_stop.propose.hold', 'HR_ADMINISTRATOR', [
    ['POST', '/v1/payroll/periods/:id/salary-stops', 404, { employeeId: NONE, reason: REASON, evidenceReference: 'SYN-REF', evidenceDocumentIds: [NONE], idempotencyKey: IDEMPOTENCY_KEY }],
    ['POST', '/v1/payroll/salary-stops/:id/withdraw', 404, reason],
  ]),
  ...rows('payroll_stop.read.hold', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/payroll/salary-stops', 200],
    ['GET', '/v1/payroll/salary-stops/tasks/mine', 200],
    ['GET', '/v1/payroll/salary-stops/:id', 404],
  ]),
  ...rows('settlement.approve.amount', 'HR_ADMINISTRATOR', [['POST', '/v1/settlements/tasks/:id/approve', 404, decision]]),
  // The refusal and its audit row for the amount group of an export happen here, before the transaction of lifecycle/settlement.ts.
  ...rows('settlement.export.amount', 'HR_ADMINISTRATOR', [
    ['GET', '/v1/settlements/:id/export', 404],
    ['GET', `/v1/settlements/export-archive?ids=${NONE}`, 404],
  ]),
  ...rows('settlement.review.amount', 'HR_ADMINISTRATOR', [['POST', '/v1/settlements/tasks/:id/review', 404, decision]]),
];

let h: Harness;
let A: Company;
let hr: TestActor;
/** One statement giving every table's row count and row versions, but for the audit trail, which a refusal writes to. Any insert, update or delete moves them. */
let everyTableState: string;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const tables = await h.db.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and c.relname <> 'audit_event' order by 1`,
  );
  everyTableState = tables.rows.map(({ name }) => `select '${name}' as name, count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) as state from "${name}"`).join(' union all ');
});

afterAll(async () => {
  await h?.stop();
});

// Named, so the plan of a union over every table is made once and not for each of the file's two hundred checks.
const tableStates = async () => Object.fromEntries((await h.db.query<{ name: string; state: string }>({ name: 'every-table-state', text: everyTableState })).rows.map((r) => [r.name, r.state]));

const denialsOf = async (a: TestActor) =>
  (
    await h.db.query<{ id: string; resource_code: string; after_values: Record<string, unknown> }>(
      `select id, resource_code, after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED'`,
      [A.id, a.user],
    )
  ).rows;

/** The whole of what a refusal may do: answer a bare 403, change no table and leave one denial, about this permission, with no request values. */
async function expectRefused(a: TestActor, key: PermissionKey, method: Method, url: string, body?: object, refusedAs: RefusedAs = 'NO_PERMISSION') {
  const { resource, action, fieldGroup } = parsePermissionKey(key);
  const tablesBefore = await tableStates();
  const earlier = new Set((await denialsOf(a)).map((d) => d.id));
  const res = await h.call(a, method, url, body);
  expect(res.statusCode, res.body).toBe(403);
  expect(res.json()).toEqual({ error: 'FORBIDDEN', message: 'Not permitted' });
  expect(await tableStates()).toEqual(tablesBefore);
  const denials = (await denialsOf(a)).filter((d) => !earlier.has(d.id));
  expect(denials).toHaveLength(1);
  expect(denials[0]).toMatchObject({ resource_code: resource, after_values: { action, reason: refusedAs, fieldGroups: expect.arrayContaining([fieldGroup]) } });
  expect(Object.keys(denials[0]!.after_values).sort()).toEqual(['action', 'fieldGroups', 'reason', 'requestId']);
}

const employeeOf = async (managerId?: string) => {
  const e = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  expect(e.statusCode, e.body).toBe(201);
  const id = e.json().id as string;
  await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
  if (managerId) expect((await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  return id;
};

/** Takes a grant from an assignment, or gives it back. A task already routed to the user stays theirs. */
const setGrant = async (a: TestActor, key: PermissionKey, active: boolean) => {
  const { resource, action, fieldGroup } = parsePermissionKey(key);
  const changed = await h.db.query(
    `update role_assignment_permission set active = $2
      where role_assignment_id = $1 and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
    [a.assignment, active, resource, action, fieldGroup],
  );
  expect(changed.rowCount).toBe(1);
};

// Actors are costly (a role's duties are many rows), so the routes of one permission share them.
const actorsByKey = new Map<string, { without: TestActor; holding: TestActor }>();
async function actorsFor(row: Row) {
  const cacheKey = `${row.key}|${row.role}`;
  const known = actorsByKey.get(cacheKey);
  if (known) return known;
  const role = BASELINE_ROLES.find((r) => r.code === row.role)!;
  const duties = role.defaultDuties.filter((k) => k !== row.key);
  const linked = async () => (row.role === 'HR_ADMINISTRATOR' ? {} : { employeeId: await employeeOf() });
  const actors = {
    without: await h.actor(A, row.role, { duties, ...(await linked()) }),
    holding: await h.actor(A, row.role, { duties: [...duties, row.key], ...(await linked()) }),
  };
  actorsByKey.set(cacheKey, actors);
  return actors;
}

describe.each([
  ['self-service', SELF_SERVICE],
  ['a manager', MANAGER],
  ['HR operations', HR_OPERATIONS],
  ['hiring', HIRING],
  ['payroll and payments', MONEY],
] as const)('%s: refused without the permission', (_group, table) => {
  // %s, because $key would cut a long permission short in the test's name, which the access matrix cites.
  it.each(table.map((row) => [`${row.key} at ${row.method} ${row.url}`, row] as const))('%s', async (_name, row) => {
    const { without, holding } = await actorsFor(row);
    const url = row.url.replace(':id', NONE);
    await expectRefused(without, row.key, row.method, url, row.body, row.refusedAs);
    const held = await h.call(holding, row.method, url, row.body);
    expect(held.statusCode, held.body).toBe(row.holderGets);
  });
});

describe('the check that a refusal changed nothing', () => {
  it('sees a row rewritten, even with the values it already had', async () => {
    const before = await tableStates();
    expect(Object.keys(before).length).toBeGreaterThan(100);
    expect(before).not.toHaveProperty('audit_event');
    expect(await tableStates()).toEqual(before);
    await h.db.query(`update department set name = name where company_id = $1 and id = $2`, [A.id, A.dept]);
    expect((await tableStates()).department).not.toBe(before.department);
  });
});

// The guard opens a read on any one of its groups, so these routes also name the group they cannot do without (GuardOptions.requireGroups).
describe('a read that needs its operational group, for someone holding only another of its groups', () => {
  const PARTIAL: readonly { key: PermissionKey; other: PermissionKey; url: string; holderGets: number }[] = [
    { key: 'exit.read.operational', other: 'exit.read.reason', url: '/v1/exit-cases', holderGets: 200 },
    { key: 'employee_process.read.operational', other: 'employee_process.read.note', url: '/v1/employee-processes/:id', holderGets: 404 },
    { key: 'settlement.read.operational', other: 'settlement.read.amount', url: '/v1/settlements/:id', holderGets: 404 },
    { key: 'increment.read.operational', other: 'increment.read.reason', url: '/v1/employees/:id/increment-plan', holderGets: 404 },
  ];

  it.each(PARTIAL.map((p) => [`${p.key} with only ${p.other}: refused and audited at ${p.url}`, p] as const))('%s', async (_name, { key, other, url, holderGets }) => {
    const duties = BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!.defaultDuties.filter((k) => k !== key && k !== other);
    const path = url.replace(':id', NONE);
    await expectRefused(await h.actor(A, 'HR_ADMINISTRATOR', { duties: [...duties, other] }), key, 'GET', path, undefined, 'FIELD_GROUP_DENIED');
    const held = await h.call(await h.actor(A, 'HR_ADMINISTRATOR', { duties: [...duties, other, key] }), 'GET', path);
    expect(held.statusCode, held.body).toBe(holderGets);
  });
});

// The task's own step names the permission, so only the person a real task went to reaches the guard for it: anyone else gets a 404
// (expense) or is checked for the step before (requisition, appraisal). The grant goes after routing and comes back for the control.
describe('a permission chosen by the step of a real task', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  describe('an expense claim', () => {
    const DECIDER: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
    let manager: TestActor;
    let employee: TestActor;
    let finance: TestActor;
    let highValue: TestActor;

    const receipt = async () => {
      const res = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
      expect(res.statusCode, res.body).toBe(201);
      return { receiptId: res.json().receiptId as string };
    };
    const submittedClaim = async (amounts: (readonly [category: string, amount: string])[]) => {
      const lines = await Promise.all(
        amounts.map(async ([category, amount]) => ({ category, expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: await receipt() })),
      );
      const created = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Client visit (synthetic)', currency: 'INR', lines });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().claimId as string;
      const view = (await h.call(employee, 'GET', `/v1/expense/claims/${id}`)).json();
      const sent = await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: view.version });
      expect(sent.statusCode, sent.body).toBe(200);
      return id;
    };
    const taskOf = async (a: TestActor, claimId: string) => {
      const { transaction_id: tx } = await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId]);
      const items = (await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[];
      return items.find((t) => t.transactionId === tx)!.taskId;
    };
    const decide = (a: TestActor, taskId: string, body: object = {}) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('exp-key-'), ...body });

    beforeAll(async () => {
      finance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDER });
      highValue = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDER });
      await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [A.id, finance.user, highValue.user]);
      const managerEmp = await employeeOf();
      manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
      employee = await h.actor(A, 'EMPLOYEE', { employeeId: await employeeOf(managerEmp) });
      const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
      expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
    });

    it('expense.manager_decide.operational at the manager step', async () => {
      const key: PermissionKey = 'expense.manager_decide.operational';
      const claim = await submittedClaim([['OTHER', '100']]);
      const task = await taskOf(manager, claim);
      await setGrant(manager, key, false);
      await expectRefused(manager, key, 'POST', `/v1/expense/tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY });
      await setGrant(manager, key, true);
      expect((await decide(manager, task)).json()).toMatchObject({ state: 'FINANCE_PENDING' });
    });

    it('expense.high_value_decide.operational at the high-value step', async () => {
      const key: PermissionKey = 'expense.high_value_decide.operational';
      const claim = await submittedClaim([...Array.from({ length: 10 }, () => ['TRAVEL', '5000'] as const), ['OTHER', '100']]);
      expect((await decide(manager, await taskOf(manager, claim))).statusCode).toBe(200);
      const lines = (await h.call(finance, 'GET', `/v1/expense/claims/${claim}`)).json().lines as { id: string; claimedAmount: string }[];
      const reviewed = await decide(finance, await taskOf(finance, claim), { lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
      expect(reviewed.json()).toMatchObject({ state: 'HIGH_VALUE_PENDING' });
      const task = await taskOf(highValue, claim);
      await setGrant(highValue, key, false);
      await expectRefused(highValue, key, 'POST', `/v1/expense/tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY });
      await setGrant(highValue, key, true);
      expect((await decide(highValue, task)).json()).toMatchObject({ state: 'APPROVED' });
    });
  });

  describe('a requisition', () => {
    const submitted = async () => {
      const w = await hiringWorld(h, A);
      const created = await h.call(w.requester, 'POST', '/v1/hiring/requisitions', {
        title: 'Synthetic role',
        departmentId: A.dept,
        locationId: A.loc,
        designationId: A.desig,
        employmentType: 'PERMANENT',
        vacancies: 1,
        reasonType: 'NEW',
        reason: REASON,
        targetDate: addDays(w.today, 45),
        hiringManagerId: w.requesterEmp,
        budgetExceptionReason: 'Synthetic, without a budget line',
      });
      expect(created.statusCode, created.body).toBe(201);
      const r = created.json() as { id: string; version: number };
      expect((await h.call(w.requester, 'POST', `/v1/hiring/requisitions/${r.id}/submit`, { expectedVersion: r.version })).json().state).toBe('SUBMITTED');
      const taskOf = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/hiring/requisition-tasks')).json().items as { taskId: string; stepAction: string; requisition: { id: string } | null }[]).find((t) => t.requisition?.id === r.id)!;
      const decide = (a: TestActor, taskId: string, body: object = {}) => h.call(a, 'POST', `/v1/hiring/requisition-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('req-key-'), ...body });
      return { w, taskOf, decide };
    };

    it('requisition.validate.operational at the manager step', async () => {
      const key: PermissionKey = 'requisition.validate.operational';
      const { w, taskOf, decide } = await submitted();
      const task = await taskOf(w.manager);
      expect(task.stepAction).toBe('validate');
      await setGrant(w.manager, key, false);
      await expectRefused(w.manager, key, 'POST', `/v1/hiring/requisition-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY });
      await setGrant(w.manager, key, true);
      expect((await decide(w.manager, task.taskId)).json().pendingStep).toBe(2);
    });

    it('requisition.approve.operational at the approval step', async () => {
      const key: PermissionKey = 'requisition.approve.operational';
      const { w, taskOf, decide } = await submitted();
      expect((await decide(w.manager, (await taskOf(w.manager)).taskId)).json().pendingStep).toBe(2);
      const task = await taskOf(w.hrApprover);
      expect(task.stepAction).toBe('approve');
      await setGrant(w.hrApprover, key, false);
      await expectRefused(w.hrApprover, key, 'POST', `/v1/hiring/requisition-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY, approveBudgetException: true });
      await setGrant(w.hrApprover, key, true);
      expect((await decide(w.hrApprover, task.taskId, { approveBudgetException: true })).json().state).toBe('APPROVED');
    });
  });

  it('appraisal.confirm.rating at the review step', async () => {
    const key: PermissionKey = 'appraisal.confirm.rating';
    const w = await appraisalWorld(h, A);
    const cycle = await openCycle(h, w);
    const person1 = await person(h, A, w.hr, { managerId: w.managerEmp });
    const appraisee = await h.actor(A, 'EMPLOYEE', { employeeId: person1 });
    const { id } = await enrol(h, w.hr, cycle.id, person1);
    await selfAssess(h, appraisee, id, [5, 5, 5]);
    await rate(h, w.manager, id, [3, 3, 3]);
    const task = (await appraisalTaskOf(h, w.rev1, id))!;
    await setGrant(w.rev1, key, false);
    await expectRefused(w.rev1, key, 'POST', `/v1/appraisal-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: IDEMPOTENCY_KEY });
    await setGrant(w.rev1, key, true);
    expect((await decideAppraisal(h, w.rev1, task.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
  });
});

// No route asks for celebration.read: the notice dispatcher reads the grant in SQL (notification/dispatcher.ts celebrationAudience), which
// says it reads it as resolveAccess does. This is not a refusal at a route, and it is not the enforcement: that is proved in
// notification.api.test.ts ("recheck the audience at delivery"). This only holds the two answers together.
describe('celebration.read.operational: an agreement test, because no route asks for this permission', () => {
  it('the notice audience and resolveAccess agree for a holder and an actor without it; notification.api.test.ts holds the real enforcement', async () => {
    const key: PermissionKey = 'celebration.read.operational';
    const { resource, action, fieldGroup } = parsePermissionKey(key);
    const holding = await h.actor(A, 'EMPLOYEE', { employeeId: await employeeOf() });
    const without = await h.actor(A, 'EMPLOYEE', { employeeId: await employeeOf(), duties: BASELINE_ROLES.find((r) => r.code === 'EMPLOYEE')!.defaultDuties.filter((k) => k !== key) });
    const inAudience = (a: TestActor) =>
      withTransaction(h.pool, (tx) => stillEligible(tx, A.id, a.user, 'COMPANY_CELEBRATION_AUDIENCE', { eventType: 'BIRTHDAY', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, data: {} } as never));
    const decisionFor = (a: TestActor) => resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource, action, fieldGroups: [fieldGroup] });
    expect(await inAudience(holding)).toBe(true);
    expect((await decisionFor(holding)).allowed).toBe(true);
    expect(await inAudience(without)).toBe(false);
    expect(await decisionFor(without)).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });
});
