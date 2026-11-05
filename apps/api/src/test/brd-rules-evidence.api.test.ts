// Cross-module BRD rules that no module's own test named: BR-003 status views (BRD line 1653; DF04), BR-007 sensitive decision changes
// (line 1677), FR-062 integrity and effective dates (line 1115) and the authorisation half of FR-063 (line 1127). Run against the real
// routes and database. Each database refusal is a direct write, so the database is saying no; a refusal over HTTP may come from the
// service in front of it. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionKey } from '../modules/access/baseline.js';
import { isModuleActive } from '../modules/registry.js';
import { uniq } from '../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from './harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;

const newEmployee = async (company: Company, by: TestActor, overrides: Record<string, unknown> = {}) => {
  const res = await h.call(by, 'POST', '/v1/employees', h.newEmployeeBody(company, overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; employeeCode: string; version: number };
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('employee status views (BR-003, DF04)', () => {
  it('BR-003 (Current, On Probation, On Notice and Left; there is no Offered or Offered Rejected view on this list): the views are filters that overlap, not one exclusive answer', async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'VIEWS', 'VIEWS', true) returning id`, [A.id])).id;
    const person = async (status: string) => {
      const e = await newEmployee(A, hr, { departmentId: dept });
      await h.setStatus(A, e.id, status);
      return e.id;
    };
    const [probation, confirmed, notice, left] = [await person('ACTIVE_PROBATION'), await person('ACTIVE_CONFIRMED'), await person('NOTICE'), await person('INACTIVE_SEPARATED')];
    const view = async (filter: string) => ((await h.call(hr, 'GET', `/v1/employees?departmentId=${dept}&${filter}`)).json().items as { id: string }[]).map((e) => e.id).sort();
    const current = await view('statusGroup=ACTIVE');
    expect(current).toEqual([probation, confirmed, notice].sort());
    expect(await view('status=ACTIVE_PROBATION')).toEqual([probation]);
    expect(await view('status=NOTICE')).toEqual([notice]);
    expect(await view('status=INACTIVE_SEPARATED')).toEqual([left]);
    // The point of the rule: one person is in two views at once, so a view is not the person's single status.
    expect(current).toContain(notice);
    expect(current).toContain(probation);
    // What DF04 stores for an employee is its six lifecycle states; an offer is a hiring fact and no employee state.
    const stored = await h.db.query<{ code: string }>(`select code from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' order by code`, [A.id]);
    expect(stored.rows.map((r) => r.code)).toEqual(['ACTIVE_CONFIRMED', 'ACTIVE_PROBATION', 'ARCHIVED', 'DRAFT', 'INACTIVE_SEPARATED', 'NOTICE']);
    expect(await view('status=OFFERED')).toEqual([]);
  });
});

describe('sensitive decision changes (BR-007)', () => {
  const SALARY_READ: PermissionKey = 'salary.read.salary';

  it('BR-007: a proposed salary grant gives no access until someone independent approves it, and that person is on record', async () => {
    const proposer = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const employee = await newEmployee(A, hr);
    const recipient = await h.makeUser();
    const proposed = await h.call(proposer, 'POST', '/v1/access/assignments', { userId: recipient, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z', permissions: [SALARY_READ], purpose: 'Synthetic payroll duty' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const grant = await h.one<{ id: string; version: number; state: string }>(`select id, version, state from role_assignment where id = $1`, [proposed.json().id]);
    expect(grant.state).toBe('PENDING');
    const asRecipient: TestActor = { user: recipient, assignment: grant.id, token: await h.tokenFor(recipient), company: A };
    // Not usable while it waits.
    expect((await h.call(asRecipient, 'GET', `/v1/employees/${employee.id}/salary`)).statusCode).toBe(403);
    // The requester does not approve it. Nor does the recipient, even as an administrator in their own right.
    const selfApproval = await h.call(proposer, 'POST', `/v1/access/assignments/${grant.id}/approve`, { expectedVersion: grant.version });
    expect([selfApproval.statusCode, selfApproval.json().error]).toEqual([403, 'SELF_APPROVAL']);
    const recipientAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { user: recipient });
    const ownApproval = await h.call(recipientAdmin, 'POST', `/v1/access/assignments/${grant.id}/approve`, { expectedVersion: grant.version });
    expect([ownApproval.statusCode, ownApproval.json().error]).toEqual([403, 'SELF_APPROVAL']);
    // The database refuses both too, whatever the path.
    await expect(h.pool.query(`update role_assignment set state = 'ACTIVE', approved_by = $2, approved_at = now() where id = $1`, [grant.id, proposer.user])).rejects.toMatchObject({ code: '23514' });
    await expect(h.pool.query(`update role_assignment set state = 'ACTIVE', approved_by = $2, approved_at = now() where id = $1`, [grant.id, recipient])).rejects.toMatchObject({ code: '23514' });
    expect((await h.one<{ state: string; approved_by: string | null }>(`select state, approved_by from role_assignment where id = $1`, [grant.id]))).toEqual({ state: 'PENDING', approved_by: null });

    const approved = await h.call(approver, 'POST', `/v1/access/assignments/${grant.id}/approve`, { expectedVersion: grant.version });
    expect(approved.statusCode, approved.body).toBe(200);
    // Recorded: who asked, who decided and when, on the grant and in the audit trail.
    expect(await h.one(`select state, created_by, approved_by, approved_at is not null as stamped from role_assignment where id = $1`, [grant.id])).toEqual({ state: 'ACTIVE', created_by: proposer.user, approved_by: approver.user, stamped: true });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and record_key = $2 and actor_user_id = $3`, [A.id, grant.id, approver.user])).n).toBeGreaterThan(0);
    expect((await h.call(asRecipient, 'GET', `/v1/employees/${employee.id}/salary`)).statusCode).toBe(200);
  });

  it('BR-007: a rejected salary grant never gives access', async () => {
    const proposer = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const employee = await newEmployee(A, hr);
    const recipient = await h.makeUser();
    const proposed = await h.call(proposer, 'POST', '/v1/access/assignments', { userId: recipient, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z', permissions: [SALARY_READ], purpose: 'Synthetic payroll duty' });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const grant = await h.one<{ id: string; version: number }>(`select id, version from role_assignment where id = $1`, [proposed.json().id]);
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${grant.id}/reject`, { expectedVersion: grant.version, reason: 'Not needed (synthetic)' })).statusCode).toBe(200);
    const asRecipient: TestActor = { user: recipient, assignment: grant.id, token: await h.tokenFor(recipient), company: A };
    expect((await h.call(asRecipient, 'GET', `/v1/employees/${employee.id}/salary`)).statusCode).toBe(403);
  });

  it('BR-007: a role name alone opens no salary, bank or medical information: the default duties of every administrative role are refused', async () => {
    const employee = await newEmployee(A, hr);
    await h.setStatus(A, employee.id, 'ACTIVE_CONFIRMED');
    for (const roleCode of ['SYSTEM_ADMINISTRATOR', 'HR_ADMINISTRATOR', 'PAYROLL_OPERATOR', 'PAYROLL_APPROVER', 'FINANCE_REVIEWER', 'TREASURY_OPERATOR', 'AUDITOR']) {
      const holder = await h.actor(A, roleCode, { scope: 'COMPANY' });
      expect((await h.call(holder, 'GET', `/v1/employees/${employee.id}/salary`)).statusCode, `${roleCode} salary`).toBe(403);
      expect((await h.call(holder, 'GET', `/v1/employees/${employee.id}/private-profile`)).statusCode, `${roleCode} bank`).toBe(403);
    }
    // The medical part: a sick-leave reason. A reader of the leave record sees the leave without it unless granted the reason group.
    const employeeActor = await h.actor(A, 'EMPLOYEE', { employeeId: employee.id });
    const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[];
    for (const p of policies) await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
    const opening = await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: employee.id, leaveType: 'SICK', kind: 'OPENING', units: '6', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-') });
    expect(opening.statusCode, opening.body).toBeLessThan(300);
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + 14);
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const day = monday.toISOString().slice(0, 10);
    const requested = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: day, endDate: day, reason: 'Synthetic private medical reason' });
    expect(requested.statusCode, requested.body).toBeLessThan(300);
    const requestsAs = async (a: TestActor) => JSON.stringify((await h.call(a, 'GET', `/v1/employees/${employee.id}/leave-requests`)).json());
    expect(await requestsAs(hr)).not.toContain('Synthetic private medical reason');
    const reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['leave.read.reason'] });
    expect(await requestsAs(reasonReader)).toContain('Synthetic private medical reason');
  });
});

describe('integrity and effective dates (FR-062)', () => {
  it('FR-062: a salary cannot name an employee of another company, by the route or by a direct write', async () => {
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const theirs = await newEmployee(B, hrB);
    const salaryAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.manage.salary', 'salary.read.salary'] });
    const res = await h.call(salaryAdmin, 'POST', `/v1/employees/${theirs.id}/salary`, { effectiveFrom: '2026-02-01', monthlyGross: '1000', annualCtc: '12000', currency: 'INR' });
    expect(res.statusCode).toBe(404);
    await expect(
      h.db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-02-01', 12000, 1000, 'INR')`, [A.id, theirs.id]),
    ).rejects.toMatchObject({ code: '23503' });
    // A component of company A cannot join an arrangement of company B either.
    const arrangementB = (await h.one<{ id: string }>(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-02-01', 12000, 1000, 'INR') returning id`, [B.id, theirs.id])).id;
    const componentA = (await h.one<{ id: string }>(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, $2, 'Synthetic', 'EARNING', true) returning id`, [A.id, uniq('INTEG_')])).id;
    await expect(h.db.query(`insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis) values ($1, $2, $3, 1, 'MONTHLY')`, [A.id, arrangementB, componentA])).rejects.toMatchObject({ code: '23503' });
    await expect(h.db.query(`insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis) values ($1, $2, $3, 1, 'MONTHLY')`, [B.id, arrangementB, componentA])).rejects.toMatchObject({ code: '23503' });
  });

  it('FR-062: competing updates fail clearly: the second writer is told, and the first writer’s value and history stand', async () => {
    const e = await newEmployee(A, hr, { displayName: 'Synthetic Original' });
    const patch = (displayName: string, expectedVersion = e.version) => h.call(hr, 'PATCH', `/v1/employees/${e.id}`, { expectedVersion, displayName });
    const [one, two] = await Promise.all([patch('Synthetic Writer One'), patch('Synthetic Writer Two')]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    const loser = one.statusCode === 409 ? one : two;
    const winnerName = one.statusCode === 200 ? 'Synthetic Writer One' : 'Synthetic Writer Two';
    expect(loser.json().error).toBe('STALE_VERSION');
    const stored = await h.one<{ display_name: string; version: number }>(`select display_name, version from employee where id = $1`, [e.id]);
    expect(stored).toEqual({ display_name: winnerName, version: e.version + 1 });
    // A later writer on the old version changes nothing either.
    const stale = await patch('Synthetic Too Late');
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    expect((await h.one<{ display_name: string }>(`select display_name from employee where id = $1`, [e.id])).display_name).toBe(winnerName);
    // One update on the audit trail, by the winner's write only.
    const updates = await h.db.query<{ after: unknown }>(`select after_values as after from audit_event where company_id = $1 and resource_code = 'employee' and record_key = $2 and action = 'UPDATE'`, [A.id, e.id]);
    expect(updates.rows).toHaveLength(1);
    expect(JSON.stringify(updates.rows)).not.toContain('Synthetic Too Late');
  });

  it('FR-062: dated validity: a second salary over the same days is refused; unique identifiers: a repeated employee code is refused and a code never changes', async () => {
    const e = await newEmployee(A, hr);
    await h.db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-03-01', 12000, 1000, 'INR')`, [A.id, e.id]);
    await expect(
      h.db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-04-01', 24000, 2000, 'INR')`, [A.id, e.id]),
    ).rejects.toMatchObject({ code: '23P01' });
    const repeat = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: e.employeeCode }));
    expect(repeat.statusCode).toBe(409);
    const rename = () => h.db.query(`update employee set employee_code = employee_code || 'X' where id = $1`, [e.id]);
    await expect(rename()).rejects.toThrow(/employee\.employee_code is fixed once written/);
    // It is this guard refusing: without it the same write goes through.
    await h.db.query('begin');
    try {
      await h.db.query(`alter table employee disable trigger employee_code_fixed`);
      expect((await rename()).rowCount).toBe(1);
    } finally {
      await h.db.query('rollback');
    }
  });

  it('FR-062: exact money and an explicit time zone, across the whole schema: no floating-point or money column, and no timestamp without a zone', async () => {
    const offending = await h.db.query<{ col: string }>(
      `select table_name || '.' || column_name || ' ' || data_type as col from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
        where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type in ('real', 'double precision', 'money', 'timestamp without time zone') order by 1`,
    );
    expect(offending.rows.map((r) => r.col)).toEqual([]);
    // The business date of an instant follows the company's own time zone (DF05: Asia/Kolkata by default), not the server's.
    expect((await h.one<{ d: string }>(`select to_char(hrms_business_date($1, '2026-03-01T20:00:00Z'), 'YYYY-MM-DD') as d`, [A.id])).d).toBe('2026-03-02');
    expect((await h.one<{ d: string }>(`select to_char(hrms_business_date($1, '2026-03-01T18:29:59Z'), 'YYYY-MM-DD') as d`, [A.id])).d).toBe('2026-03-01');
  });
});

describe('separately authorised services, and scope held by the service (FR-063)', () => {
  it('FR-063 (authorisation half): each of master maintenance, imports, approvals, processing and reports needs its own duty', async () => {
    const target = await newEmployee(A, hr);
    const fake = '00000000-0000-4000-8000-000000000321';
    const SERVICES: { name: string; duty: PermissionKey[]; call: (a: TestActor) => Promise<{ statusCode: number }> }[] = [
      { name: 'master maintenance', duty: ['employee.update.operational'], call: (a) => h.call(a, 'PATCH', `/v1/employees/${target.id}`, { expectedVersion: target.version + 99, displayName: 'Synthetic' }) },
      { name: 'imports', duty: ['employee.import.operational'], call: (a) => h.call(a, 'GET', '/v1/employees/imports') },
      { name: 'requests', duty: ['leave.submit.operational'], call: (a) => h.call(a, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: '2099-01-05', endDate: '2099-01-05' }) },
      { name: 'approvals', duty: ['leave.approve.operational'], call: (a) => h.call(a, 'GET', '/v1/leave/tasks') },
      { name: 'processing', duty: ['payroll_run.process.amount'], call: (a) => h.call(a, 'POST', `/v1/payroll/runs/${fake}/process`, { expectedVersion: 1 }) },
      { name: 'reports', duty: ['employee.export.operational'], call: (a) => h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER' }) },
    ];
    const relevant = SERVICES.filter((s) => (s.name === 'processing' ? isModuleActive('payroll') : true));
    for (const holder of relevant) {
      // A request is made for oneself, so its holder has the OWN scope and is linked to an employee record of their own. The others are
      // HR Administrators holding that one duty and nothing else (a custom role cannot hold a confidential group such as payroll amounts).
      const isRequest = holder.name === 'requests';
      const actor = isRequest ? await h.customActor(A, { scope: 'OWN', permissions: holder.duty }) : await h.actor(A, 'HR_ADMINISTRATOR', { duties: holder.duty });
      if (isRequest) await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, actor.user, target.id]);
      for (const service of relevant) {
        const { statusCode } = await service.call(actor);
        if (service === holder) expect(statusCode, `${holder.name} with its own duty`).not.toBe(403);
        else expect(statusCode, `${holder.name} duty on ${service.name}`).toBe(403);
      }
    }
  });

  it('FR-063: an unauthorised scope fails on the service even when the client sends no filter', async () => {
    const inEng = await newEmployee(A, hr, { departmentId: A.dept });
    const inFin = await newEmployee(A, hr, { departmentId: A.financeDept });
    const scoped = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, extra: ['salary.read.salary'] });
    // No filter in the request: the list still holds only the department of the grant.
    const listed = (await h.call(scoped, 'GET', '/v1/employees?pageSize=100')).json().items as { id: string }[];
    expect(listed.map((e) => e.id)).toContain(inEng.id);
    expect(listed.map((e) => e.id)).not.toContain(inFin.id);
    // Asking by id, or asking for the other department by name, reads as missing or empty.
    expect((await h.call(scoped, 'GET', `/v1/employees/${inFin.id}`)).statusCode).toBe(404);
    expect(((await h.call(scoped, 'GET', `/v1/employees?departmentId=${A.financeDept}`)).json().items as unknown[])).toEqual([]);
    expect((await h.call(scoped, 'GET', `/v1/employees/${inFin.id}/salary`)).statusCode).toBe(404);
    expect((await h.call(scoped, 'PATCH', `/v1/employees/${inFin.id}`, { expectedVersion: inFin.version, displayName: 'Synthetic Out Of Scope' })).statusCode).toBe(404);
    expect((await h.one<{ display_name: string }>(`select display_name from employee where id = $1`, [inFin.id])).display_name).not.toBe('Synthetic Out Of Scope');
    // Another company's administrator, with no filter, sees none of them.
    const other = await h.actor(B, 'HR_ADMINISTRATOR');
    const theirs = (await h.call(other, 'GET', '/v1/employees?pageSize=100')).json().items as { id: string }[];
    expect(theirs.map((e) => e.id)).not.toContain(inEng.id);
  });
});
