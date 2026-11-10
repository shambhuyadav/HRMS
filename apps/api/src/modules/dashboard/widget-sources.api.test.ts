// Dashboard widgets, their source lists, shortcuts and the pending-task list over HTTP (FR-096, FR-097; BR-045; DF17; F2;
// additions-8). Every metric's count is compared with the list it links to, under the same actor and filters, on populated
// records; a link or shortcut appears only when the destination answers in the selected assignment. Synthetic data only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { appraisalWorld, enrol, GOALS, openCycle, selfAssess } from '../appraisal/appraisal.fixtures.js';
import { approvedRequisition, hiringWorld } from '../hiring/test-fixtures.js';
import { CONFIG, attendance, calendar, createRun, months, PREPARE, today as payrollToday } from '../payroll/payroll.fixtures.js';
import { addDays, advance, newPlan, nominated } from '../training/training.fixtures.js';
import { leaveQueue, leaveTasks } from '../workflow/leave-tasks.fixtures.js';
import { METRICS } from './service.js';
import { METRIC_SOURCES, type SourceList } from './sources.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let world: ReturnType<typeof leaveTasks>;
let day: string;
/** A company-scope assignment holding every source list's permission and linked to an employee with a team, so every metric can be walked. */
let walker: TestActor;
let walkerEmp: string;
let member: string;
let memberSelf: TestActor;

const UNION = [...new Set(Object.values(METRIC_SOURCES).flatMap((s) => s.permissions))] as PermissionKey[];

type Widget = { code: string; kind: string; status: string; value?: number | string; message?: string; source?: { href: string; combine: string; lists: SourceList[]; shortcut?: { to: string; label: string } } };
const dashboardOf = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/dashboard');
  expect(res.statusCode, res.body).toBe(200);
  const d = res.json() as { role: string; scope: string; company: string; period: { from: string; to: string }; state: string; widgets: Widget[]; shortcuts: { to: string; label: string }[] };
  return { ...d, byCode: Object.fromEntries(d.widgets.map((w) => [w.code, w])) as Record<string, Widget> };
};

async function listCount(a: TestActor, list: SourceList): Promise<number> {
  const res = await h.call(a, 'GET', list.api);
  expect(res.statusCode, `${list.api}: ${res.body}`).toBe(200);
  const body = res.json() as { items: Record<string, unknown>[]; total?: number };
  return list.sumOf ? body.items.reduce((n, r) => n + Number(r[list.sumOf!] ?? 0), 0) : (body.total ?? body.items.length);
}

/** The value a widget should show from its lists' counts. */
async function fromLists(a: TestActor, lists: readonly SourceList[], combine: string | undefined): Promise<number | string> {
  const counts: number[] = [];
  for (const list of lists) counts.push(await listCount(a, list));
  return combine === 'PARTS' ? counts.join('/') : counts.reduce((x, y) => x + y, 0);
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...CONFIG, ...PREPARE] });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  day = await payrollToday(h, A);

  const bossEmp = await world.employee();
  await h.actor(A, 'REPORTING_MANAGER', { employeeId: bossEmp });
  walkerEmp = await world.employee(bossEmp);
  walker = await h.customActor(A, { scope: 'COMPANY', permissions: UNION });
  await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, walker.user, walkerEmp]);

  // The team: on probation, a confirmation due, an attendance exception today and a pending leave request.
  member = await world.employee(undefined, { joiningDate: addDays(day, -70) });
  await world.setManager(member, walkerEmp, addDays(day, -70));
  await h.setStatus(A, member, 'ACTIVE_PROBATION');
  expect((await h.call(hr, 'POST', '/v1/confirmations', { employeeId: member })).statusCode).toBe(201);
  await attendance(h, A, member, day, 'EXCEPTION');
  await world.employee(walkerEmp);
  memberSelf = await h.actor(A, 'EMPLOYEE', { employeeId: member });
  await world.submitLeave(memberSelf);
  // The walker's own pending request.
  await world.submitLeave(await h.actor(A, 'EMPLOYEE', { user: walker.user }));
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('every metric reconciles with the list it links to (BR-045; FR-097)', () => {
  beforeAll(async () => {
    // A draft employee, grants, runs and deliveries.
    const draft = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
    expect(draft.statusCode).toBe(201);
    const pendingUser = await h.makeUser();
    await h.db.query(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by)
       select $1, $2, r.id, 'OWN', now(), 'PENDING', $3 from role r where r.company_id = $1 and r.code = 'EMPLOYEE'`,
      [A.id, pendingUser, SYSTEM_ACTOR_ID],
    );
    await h.db.query(`insert into notification (company_id, recipient_user_id, category, state, channel, idempotency_key, body) values ($1, $2, 'SYNTHETIC', 'FAILED', 'IN_APP', $3, null), ($1, $2, 'SYNTHETIC', 'DELIVERED', 'IN_APP', $4, 'Synthetic')`, [
      A.id,
      walker.user,
      uniq('failed-'),
      uniq('delivered-'),
    ]);
    const biometric = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.profile_manage.operational', 'biometric.mapping_manage.operational'] });
    const code = uniq('BIO').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const profile = await h.call(biometric, 'POST', '/v1/biometric/profiles', {
      code,
      name: 'Synthetic devices',
      requestConfigReference: `secret-store://biometric/${code}/request`,
      authReference: `secret-store://biometric/${code}/credential`,
      providerTimezone: 'Asia/Kolkata',
      paginationMode: 'CURSOR',
      scheduleReference: 'every-15-minutes',
      lookbackMinutes: 10080,
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const mapping = await h.call(biometric, 'POST', `/v1/biometric/profiles/${profile.json().id}/mappings`, {
      dedupeStrategy: 'PROVIDER_EVENT_KEY',
      timestampRule: 'ISO_WITH_OFFSET',
      effectiveFrom: '2026-01-01T00:00:00Z',
      fields: [
        { sourcePath: 'emp', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
        { sourcePath: 'ts', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
        { sourcePath: 'dir', targetField: 'DIRECTION', transformCode: 'ENUM_MAP', enumConfig: { '0': 'IN', '1': 'OUT' }, required: true },
        { sourcePath: 'id', targetField: 'EVENT_KEY', transformCode: 'IDENTITY', required: true },
      ],
    });
    expect(mapping.statusCode, mapping.body).toBe(201);
    const run = (state: string, startedAt: string) =>
      h.db.query(
        `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, started_at, finished_at, failure_code)
         values ($1, $2, $3, now() - interval '1 hour', now(), $4, $5::timestamptz, now(), $6)`,
        [A.id, profile.json().id, mapping.json().mappingRevisionId, state, startedAt, state === 'COMPLETED' ? null : 'SYNTHETIC'],
      );
    const noon = `${day}T06:00:00Z`;
    await run('FAILED', noon);
    await run('PARTIAL', noon);
    await run('COMPLETED', noon);
    await run('FAILED', '2020-01-15T06:00:00Z'); // an earlier month is outside the widget and its list

    // Payroll: an active calendar with the year's periods and a run in preparation.
    const activator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const specs = months(Number(day.slice(0, 4)));
    const { periods } = await calendar(h, hr, activator, specs);
    await createRun(h, hr, periods[specs.find((p) => p.start <= day && p.end >= day)!.code]!);

    // Training: a session running, one finished with a completion and a no-show, and the walker's own nomination.
    const coordinator = await h.actor(A, 'TRAINING_COORDINATOR');
    const running = await newPlan(h, coordinator, { startDate: addDays(day, -1), endDate: addDays(day, 5), ownerEmployeeId: walkerEmp });
    await newPlan(h, coordinator, { startDate: addDays(day, 10), endDate: addDays(day, 11), ownerEmployeeId: walkerEmp });
    const finished = await newPlan(h, coordinator, { startDate: addDays(day, -5), endDate: addDays(day, -2), ownerEmployeeId: walkerEmp });
    const [confirmed, own] = await nominated(h, coordinator, running.id, [member, walkerEmp]);
    await advance(h, coordinator, running.id, [confirmed!], ['CONFIRM']);
    expect(own).toBeTruthy();
    const [completed, noShow] = await nominated(h, coordinator, finished.id, [member, await world.employee()]);
    await advance(h, coordinator, finished.id, [completed!], ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
    await advance(h, coordinator, finished.id, [noShow!], ['CONFIRM', 'MARK_NO_SHOW']);

    // Appraisals: one submitted, one still in draft.
    const w = await appraisalWorld(h, A);
    const cycle = await openCycle(h, w);
    const submitted = await world.employee(w.managerEmp);
    const view = await enrol(h, w.hr, cycle.id, submitted);
    await selfAssess(h, await h.actor(A, 'EMPLOYEE', { employeeId: submitted }), view.id, GOALS.map(() => 4));
    await enrol(h, w.hr, cycle.id, await world.employee(w.managerEmp));

    // Hiring: an approved requisition with an open application and a rejected one.
    const hiring = await hiringWorld(h, A);
    const requisition = await approvedRequisition(h, A, hiring);
    const recruiter = await h.actor(A, 'RECRUITER');
    const candidate = async () => (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName: 'Synthetic Candidate', sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: day })).json().id as string;
    const apply = (candidateId: string) => h.call(recruiter, 'POST', `/v1/hiring/requisitions/${requisition.id}/applications`, { candidateId });
    const open = await apply(await candidate());
    expect(open.statusCode, open.body).toBe(201);
    const rejected = await apply(await candidate());
    const moved = await h.call(recruiter, 'POST', `/v1/hiring/applications/${rejected.json().id}/stage`, { toStage: 'REJECTED', note: 'Synthetic', expectedVersion: rejected.json().version });
    expect(moved.statusCode, moved.body).toBeLessThan(300);

    // Audit: a refusal, recorded as ACCESS_DENIED.
    expect((await h.call(await h.actor(A, 'EMPLOYEE'), 'GET', '/v1/audit/events')).statusCode).toBe(403);
  }, 180_000);

  it('every source’s lists answer and sum to the metric, under a company-scope assignment holding them all', async () => {
    const grant = await resolveAccess(h.db, { userId: walker.user, companyId: A.id, assignmentId: walker.assignment, resource: 'dashboard', action: 'read', fieldGroups: ['operational'] });
    if (!grant.allowed) throw new Error(grant.reason);
    const nonZero: string[] = [];
    for (const [code, source] of Object.entries(METRIC_SOURCES)) {
      const result = await METRICS[code]!(h.db, grant);
      if (result.status !== 'OK') {
        // A state with no count; the link's lists must still answer.
        expect(source.combine === 'NONE' || code === 'PAYROLL_APPROVED_LOCKED_RUNS' || code === 'OWN_ANNUAL_LEAVE_BALANCE', `${code}: ${JSON.stringify(result)}`).toBe(true);
        continue;
      }
      if (source.combine === 'NONE') {
        for (const list of source.lists(grant)) await listCount(walker, list);
        continue;
      }
      const lists = await fromLists(walker, source.lists(grant), source.combine);
      expect(result.value, `${code} against ${source.lists(grant).map((l) => l.api).join(' + ')}`).toEqual(lists);
      if (result.value !== 0 && result.value !== '0/0') nonZero.push(code);
    }
    // These have records, so a filter that lost its way cannot pass as 0 = 0.
    expect(nonZero.sort()).toEqual(
      [
        'ACTIVE_ACCOUNTS',
        'ACTIVE_EMPLOYEES',
        'APPROVED_REQUISITIONS',
        'APPRAISAL_SUBMITTED_REVIEWED',
        'AUDIT_ACCESS_DENIED_THIS_MONTH',
        'AUDIT_CONFIGURATION_REVISIONS_THIS_MONTH',
        'AUDIT_EVENTS_THIS_MONTH',
        'CONFIRMATIONS_DUE_30',
        'DRAFT_EMPLOYEES',
        'FAILED_INTEGRATION_RUNS',
        'FAILED_NOTIFICATION_DELIVERIES',
        'LEAVE_EXPENSE_TASKS',
        'MY_OPEN_TASKS',
        'OPEN_PIPELINE_APPLICATIONS',
        'OWN_PENDING_REQUESTS',
        'OWN_TRAINING_DUE',
        'PAYROLL_OPEN_PERIODS',
        'PAYROLL_RUNS_IN_PREPARATION',
        'PENDING_ACCESS_GRANTS',
        'TEAM_ATTENDANCE_EXCEPTIONS',
        'TEAM_COUNT',
        'TEAM_REVIEWS_DUE',
        'TRAINING_COMPLETION_NO_SHOW',
        'TRAINING_CONFIRMED_PARTICIPATIONS',
        'TRAINING_FEEDBACK_PENDING',
        'TRAINING_SESSIONS_CURRENT_FUTURE',
      ].sort(),
    );
  });

  it('active employees are the three working statuses, not a draft (DF17), against the list status by status', async () => {
    const { byCode } = await dashboardOf(hr);
    const total = async (status: string) => (await h.call(hr, 'GET', `/v1/employees?status=${status}`)).json().total as number;
    expect(await total('DRAFT')).toBeGreaterThan(0);
    expect(byCode.ACTIVE_EMPLOYEES!.value).toBe((await total('ACTIVE_PROBATION')) + (await total('ACTIVE_CONFIRMED')) + (await total('NOTICE')));
  });

  it('the failed runs are this month’s failed and partial ones only', async () => {
    const sa = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational'] });
    const { byCode } = await dashboardOf(sa);
    expect(byCode.FAILED_INTEGRATIONS).toMatchObject({ status: 'OK', value: 2 });
    const rows = (await h.call(sa, 'GET', byCode.FAILED_INTEGRATIONS!.source!.lists[0]!.api)).json().items as Record<string, unknown>[];
    expect(rows.map((r) => r.state).sort()).toEqual(['FAILED', 'PARTIAL']);
    expect(JSON.stringify(rows)).not.toContain('secret-store');
    expect((await h.call(sa, 'GET', '/v1/biometric/runs')).json().total).toBe(4);
  });
});

describe('a link or shortcut appears only when the destination is permitted in the selected assignment (FR-097; DF17; F2)', () => {
  it('every baseline role: each link answers, each list is its role’s own, and no refused link is offered', async () => {
    for (const role of BASELINE_ROLES) {
      const a = await h.actor(A, role.code);
      const d = await dashboardOf(a);
      expect(d.state, role.code).toBe('OK');
      expect(d.role).toBe(role.code);
      expect(d.scope).toBe(role.defaultScope);
      expect(d.company).toBeTruthy();
      expect(d.period).toEqual({ from: `${day.slice(0, 8)}01`, to: day });
      for (const w of d.widgets) {
        if (!w.source) continue;
        expect(w.status, `${role.code}.${w.code}`).toBe('OK');
        for (const list of w.source.lists) await listCount(a, list);
        if (w.source.combine === 'NONE') continue;
        // On this role's own records too, not only under the walker's.
        expect(w.value, `${role.code}.${w.code}`).toEqual(await fromLists(a, w.source.lists, w.source.combine));
      }
    }
  }, 120_000);

  it('a manager’s widget loses its link and shortcut when the destination’s permission is withdrawn, and keeps showing its value', async () => {
    const managerEmp = await world.employee();
    await world.employee(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const open = await dashboardOf(manager);
    expect(open.byCode.TEAM_EXCEPTIONS!.source).toMatchObject({ href: '/team?todayAttendance=EXCEPTION', lists: [{ api: '/v1/my-team?todayAttendance=EXCEPTION' }] });
    expect(open.byCode.TEAM_COUNT!.source!.href).toBe('/team');
    expect(open.shortcuts).toContainEqual({ to: '/team', label: 'My team' });
    expect(open.shortcuts).toContainEqual({ to: '/tasks', label: 'Decisions' });

    const noList = await h.actor(A, 'REPORTING_MANAGER', {
      user: manager.user,
      duties: (BASELINE_ROLES.find((r) => r.code === 'REPORTING_MANAGER')!.defaultDuties as PermissionKey[]).filter((k) => k !== 'team.list.operational'),
    });
    const closed = await dashboardOf(noList);
    expect(closed.byCode).not.toHaveProperty('TEAM_COUNT'); // its own permission
    expect(closed.byCode.TEAM_EXCEPTIONS).toMatchObject({ status: 'OK', value: 0 }); // attendance grant: value without a link
    expect(closed.byCode.TEAM_EXCEPTIONS).not.toHaveProperty('source');
    expect(closed.shortcuts).not.toContainEqual({ to: '/team', label: 'My team' });
    expect((await h.call(noList, 'GET', '/v1/my-team?todayAttendance=EXCEPTION')).statusCode).toBe(403);
  });

  it('a task widget needs both queues: without the leave decision duty it links nowhere', async () => {
    const managerEmp = await world.employee();
    const manager = await h.actor(A, 'REPORTING_MANAGER', {
      employeeId: managerEmp,
      duties: (BASELINE_ROLES.find((r) => r.code === 'REPORTING_MANAGER')!.defaultDuties as PermissionKey[]).filter((k) => k !== 'leave.approve.operational'),
    });
    const { byCode } = await dashboardOf(manager);
    expect(byCode.MY_TASKS).toMatchObject({ status: 'OK' });
    expect(byCode.MY_TASKS).not.toHaveProperty('source');
  });

  it('I-62 item 4 (I-83): the Finance Reviewer, Expense Finance Approver and Payroll Approver figures now link to a list the role reads; the overdue runs figure has none', async () => {
    const finance = await dashboardOf(await h.actor(A, 'FINANCE_REVIEWER'));
    expect(finance.byCode.EXPENSE_REVIEW_TASKS).toMatchObject({ status: 'OK', source: { lists: [{ api: '/v1/expense/claim-states?states=MANAGER_PENDING%2CFINANCE_PENDING%2CHIGH_VALUE_PENDING' }] } });
    const approver = await dashboardOf(await h.actor(A, 'EXPENSE_FINANCE_APPROVER'));
    for (const code of ['FINAL_DECISIONS', 'LATE_RECEIPT', 'RETURNED']) expect(approver.byCode[code]!.source, code).toBeTruthy();
    // I-92 (0245): "Decision due" is now a figure of its own and links to the claim-state list of the claims whose decision is due.
    expect(approver.byCode.DECISIONS_DUE).toMatchObject({ status: 'OK', source: { lists: [{ api: '/v1/expense/claim-states?states=FINANCE_PENDING%2CHIGH_VALUE_PENDING&decision=DUE' }] } });
    const payroll = await dashboardOf(await h.actor(A, 'PAYROLL_APPROVER'));
    expect(payroll.byCode.REVIEW_TASKS).toMatchObject({ status: 'OK', source: { lists: [{ api: '/v1/payroll/runs?states=IN_REVIEW' }] } });
    expect(payroll.byCode.OVERDUE_REVIEWS).toMatchObject({ status: 'OK' });
    expect(payroll.byCode.OVERDUE_REVIEWS).not.toHaveProperty('source');
    expect(payroll.byCode.UNRESOLVED_EXCEPTIONS!.source).toBeTruthy();
  });

  it('a widget that is not available has no link, and a role without a dashboard gets the neutral state with no shortcuts', async () => {
    // I-92 (0245): the Auditor's "Review evidence tasks" is the one figure left unavailable (no evidence-review process exists to
    // count); the Treasury Operator's RECONCILE is now counted and links to its two payment lists.
    const auditor = await dashboardOf(await h.actor(A, 'AUDITOR'));
    expect(auditor.byCode.REVIEW_EVIDENCE).toMatchObject({ status: 'NOT_AVAILABLE' });
    expect(auditor.byCode.REVIEW_EVIDENCE).not.toHaveProperty('source');
    const operator = await dashboardOf(await h.actor(A, 'TREASURY_OPERATOR'));
    expect(operator.byCode.RECONCILE).toMatchObject({ status: 'OK' });
    expect(operator.byCode.RECONCILE!.source!.lists).toHaveLength(2);
    // I-89 item 2: the payment preparation figure links to the two lists it counts.
    expect(operator.byCode.MY_TASKS).toMatchObject({
      status: 'OK',
      source: {
        combine: 'SUM',
        lists: [
          { label: 'Claims awaiting preparation', api: '/v1/expense/payables?awaitingPreparation=true' },
          { label: 'Draft payments not yet ready', api: '/v1/expense/payments?state=PREPARED&batchState=DRAFT' },
        ],
      },
    });
    // A state with no figure has nothing to reconcile, though the list itself is open to this role.
    const payroll = await dashboardOf(await h.actor(await h.makeCompany(), 'PAYROLL_OPERATOR'));
    expect(payroll.byCode.PERIOD_STATE).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(payroll.byCode.PERIOD_STATE).not.toHaveProperty('source');
    expect(payroll.byCode.PREPARATION!.source).toBeTruthy();
    const custom = await h.customActor(A, { scope: 'OWN', permissions: ['dashboard.read.operational'] });
    expect(await dashboardOf(custom)).toMatchObject({ state: 'NO_DASHBOARD', widgets: [], shortcuts: [], title: null });
  });
});

describe('counts respect the assignment’s filters (FR-096 "No widget defaults to whole-company scope"; BR-045)', () => {
  it('a department-filtered System Administrator counts what the user and grant lists show them', async () => {
    const eng = await world.employee();
    const fin = await world.employee(undefined, { departmentId: A.financeDept });
    const engUser = await h.actor(A, 'EMPLOYEE', { employeeId: eng });
    const finUser = await h.actor(A, 'EMPLOYEE', { employeeId: fin });
    const pending = (user: string) =>
      h.db.query(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by)
         select $1, $2, r.id, 'TEAM', now(), 'PENDING', $3 from role r where r.company_id = $1 and r.code = 'REPORTING_MANAGER'`,
        [A.id, user, SYSTEM_ACTOR_ID],
      );
    await pending(engUser.user);
    await pending(finUser.user);

    const whole = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const wholeD = await dashboardOf(whole);
    const filteredD = await dashboardOf(filtered);
    expect(Number(filteredD.byCode.PENDING_GRANTS!.value)).toBeLessThan(Number(wholeD.byCode.PENDING_GRANTS!.value));
    expect(filteredD.byCode.PENDING_GRANTS!.value).toBe(1);
    expect(Number(filteredD.byCode.ACTIVE_ACCOUNTS!.value)).toBeLessThan(Number(wholeD.byCode.ACTIVE_ACCOUNTS!.value));
    expect(filteredD.byCode.ACTIVE_ACCOUNTS!.value).toBe(1);
    for (const code of ['PENDING_GRANTS', 'ACTIVE_ACCOUNTS']) {
      expect(filteredD.byCode[code]!.value, code).toBe(await fromLists(filtered, filteredD.byCode[code]!.source!.lists, 'SUM'));
      expect(wholeD.byCode[code]!.value, code).toBe(await fromLists(whole, wholeD.byCode[code]!.source!.lists, 'SUM'));
    }
  });

  it('records that belong to no employee are not counted for a filtered assignment; the state says why and offers no link', async () => {
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept, extra: ['biometric.read.operational'] });
    const { byCode } = await dashboardOf(filtered);
    for (const code of ['FAILED_NOTIFICATIONS', 'FAILED_INTEGRATIONS']) {
      expect(byCode[code], code).toMatchObject({ status: 'NOT_CONFIGURED', message: 'This count needs an unrestricted company-scope assignment' });
      expect(byCode[code], code).not.toHaveProperty('value');
      expect(byCode[code], code).not.toHaveProperty('source');
    }
    expect((await h.call(filtered, 'GET', '/v1/biometric/runs')).statusCode).toBe(403);
  });

  it('a filtered HR assignment: active, draft and due counts equal its own filtered lists', async () => {
    const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const { byCode } = await dashboardOf(filtered);
    const whole = await dashboardOf(hr);
    expect(Number(byCode.ACTIVE_EMPLOYEES!.value)).toBeLessThan(Number(whole.byCode.ACTIVE_EMPLOYEES!.value));
    for (const code of ['ACTIVE_EMPLOYEES', 'CONFIRMATIONS_DUE', 'MISSING_ACTIVATION']) {
      expect(byCode[code]!.value, code).toBe(await fromLists(filtered, byCode[code]!.source!.lists, 'SUM'));
    }
    expect(byCode.CONFIRMATIONS_DUE!.value).toBe(0);
    expect(Number(whole.byCode.CONFIRMATIONS_DUE!.value)).toBeGreaterThan(0);
  });
});

describe('the pending-task list (FR-096 "pending tasks"; DF17 "priority task list", "no merging across role assignments")', () => {
  it('lists what the selected assignment may decide, reconciles with its widget, and shows no amounts or reasons', async () => {
    const hrActor = await h.actor(A, 'HR_ADMINISTRATOR');
    const empty = (await h.call(hrActor, 'GET', '/v1/dashboard/tasks')).json();
    expect(empty).toMatchObject({ items: [], total: 0 });

    const res = await h.call(walker, 'GET', '/v1/dashboard/tasks');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ kind: 'leave_request', ownerName: 'Synthetic Person', delegated: false, overdue: false, dueAt: null, step: 1 });
    expect(Object.keys(body.items[0]!).sort()).toEqual(['assignedAt', 'delegated', 'dueAt', 'kind', 'overdue', 'ownerEmployeeCode', 'ownerName', 'step', 'taskId']);
  });

  it('a task from another assignment of the same user is not merged in, though the same person holds both', async () => {
    const managerEmp = await world.employee();
    const report = await world.employee(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const asHr = await h.actor(A, 'HR_ADMINISTRATOR', { user: manager.user, duties: ['dashboard.read.operational'] });
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: report }));
    expect((await leaveQueue(h, manager)).map((t) => t.ownerEmployeeId)).toEqual([report]);

    expect((await h.call(manager, 'GET', '/v1/dashboard/tasks')).json().total).toBe(1);
    const other = await dashboardOf(asHr);
    expect(other.byCode.MY_TASKS).toMatchObject({ status: 'OK', value: 0 });
    expect((await h.call(asHr, 'GET', '/v1/dashboard/tasks')).json()).toMatchObject({ items: [], total: 0 });
  });

  it('a task whose owner left the assignment’s row scope drops out; a dashboard permission is needed', async () => {
    const managerEmp = await world.employee();
    const report = await world.employee(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: report }));
    expect((await h.call(manager, 'GET', '/v1/dashboard/tasks')).json().total).toBe(1);
    await world.setManager(report, await world.employee(), addDays(day, -1));
    expect((await h.call(manager, 'GET', '/v1/dashboard/tasks')).json().total).toBe(0);

    const noDashboard = await h.customActor(A, { scope: 'COMPANY', permissions: ['team.list.operational'] });
    expect((await h.call(noDashboard, 'GET', '/v1/dashboard/tasks')).statusCode).toBe(403);
    expect((await h.call(noDashboard, 'GET', '/v1/me/pending-requests')).statusCode).toBe(403);
  });

  it('an employee’s own pending requests are the rows of the widget, for the linked employee only', async () => {
    const self = memberSelf;
    const d = await dashboardOf(self);
    const rows = (await h.call(self, 'GET', d.byCode.MY_REQUESTS!.source!.lists[0]!.api)).json() as { items: { kind: string; state: string }[]; total: number };
    expect(d.byCode.MY_REQUESTS!.value).toBe(rows.total);
    expect(rows.items.map((r) => [r.kind, r.state])).toEqual([['leave_request', 'SUBMITTED']]);
    expect((await h.call(await h.customActor(A, { scope: 'OWN', permissions: ['dashboard.read.operational'] }), 'GET', '/v1/me/pending-requests')).json()).toEqual({ items: [], total: 0 });
  });
});

describe('0093 moves what existing companies hold', () => {
  it('adds the ceilings and the widget’s permission; no assignment changes; a widget pointed elsewhere is left alone', async () => {
    const managerRole = (await h.one<{ id: string }>(`select id from role where company_id = $1 and code = 'REPORTING_MANAGER'`, [A.id])).id;
    const keys = [
      ['team', 'export', 'operational'],
      ['team', 'read_history', 'operational'],
      ['salary', 'read', 'salary'],
      ['document', 'read', 'document'],
    ] as const;
    const ceilingHas = async () => {
      const out: boolean[] = [];
      for (const [resource, action, group] of keys) {
        out.push(
          (
            await h.db.query(
              `select 1 from role_permission rp join permission p on p.id = rp.permission_id where rp.company_id = $1 and rp.role_id = $2 and p.resource = $3 and p.action = $4 and p.field_group = $5`,
              [A.id, managerRole, resource, action, group],
            )
          ).rowCount === 1,
        );
      }
      return out;
    };
    expect(await ceilingHas()).toEqual([true, true, true, true]);
    await h.db.query(
      `delete from role_permission where company_id = $1 and role_id = $2 and permission_id in
         (select id from permission where (resource, action, field_group) in (('team','export','operational'), ('team','read_history','operational'), ('salary','read','salary'), ('document','read','document')))
         and not exists (select 1 from role_assignment_permission rap join role_assignment ra on ra.company_id = rap.company_id and ra.id = rap.role_assignment_id
                          where ra.role_id = role_permission.role_id and rap.permission_id = role_permission.permission_id)`,
      [A.id, managerRole],
    );

    const widget = async () =>
      (
        await h.one<{ key: string }>(
          `select p.resource || '.' || p.action as key from role_dashboard_widget w join permission p on p.id = w.permission_id
             join role_dashboard_definition d on d.company_id = w.company_id and d.id = w.dashboard_id join role r on r.company_id = d.company_id and r.id = d.role_id
            where w.company_id = $1 and r.code = 'SYSTEM_ADMINISTRATOR' and w.widget_code = 'FAILED_INTEGRATIONS'`,
          [A.id],
        )
      ).key;
    expect(await widget()).toBe('biometric.read');
    const setWidgetPermission = (resource: string, action: string) =>
      h.db.query(
        `update role_dashboard_widget w set permission_id = (select id from permission where resource = $2 and action = $3 and field_group = 'operational')
           from role_dashboard_definition d join role r on r.company_id = d.company_id and r.id = d.role_id
          where d.company_id = w.company_id and d.id = w.dashboard_id and w.company_id = $1 and r.code = 'SYSTEM_ADMINISTRATOR' and w.widget_code = 'FAILED_INTEGRATIONS'`,
        [A.id, resource, action],
      );
    await setWidgetPermission('access', 'read_users');
    const sql = readFileSync(new URL('../../../../../db/migrations/0093_my_team_export_and_ceilings.sql', import.meta.url), 'utf8');
    // The catalogue row exists already here: everything after it is what an existing company receives.
    const companies = sql.slice(sql.indexOf('insert into role_permission'));
    await h.db.query(companies);
    expect(await ceilingHas()).toEqual([true, true, true, true]);
    expect(await widget()).toBe('biometric.read');

    await setWidgetPermission('audit', 'read');
    await h.db.query(companies);
    expect(await widget()).toBe('audit.read');
    await setWidgetPermission('biometric', 'read');
  });
});
