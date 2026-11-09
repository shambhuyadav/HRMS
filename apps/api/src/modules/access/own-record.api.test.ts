// Direct Admin writes that would benefit the actor's own employee record are refused, in any assignment (RBAC instruction
// "Apply all C4 separation-of-duty rules even when a user holds multiple roles"; C4 self approval; DF02 "Admin status does
// not bypass these checks"; ZT04), through the service and, for a direct write, the database (migration 0089). Own means
// linked in any period. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { EMPLOYEE_UPDATE_COLUMNS } from '../employee/update-import.js';
import { adjustBalance } from '../leave/service.js';
import { leaveTasks } from '../workflow/leave-tasks.fixtures.js';
import { type AccessGrant, resolveAccess } from './authorize.js';
import type { PermissionKey } from './baseline.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let colleague: TestActor;
let self: TestActor;
let selfEmp: string;
let formerEmp: string;
let former: TestActor;
let otherEmp: string;
let world: ReturnType<typeof leaveTasks>;
let shiftId: string;

const SALARY: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary'];
const b64 = (s: string) => Buffer.from(s).toString('base64');
const codeOf = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;

const expectSelfRefusal = (res: { statusCode: number; body: string; json(): { error?: string } }) => {
  expect(res.statusCode, res.body).toBe(403);
  expect(res.json().error).toBe('SELF_ACTION_NOT_ALLOWED');
};

const adjust = (a: TestActor, employeeId: string, kind: 'OPENING' | 'ADJUSTMENT', units = '5') =>
  h.call(a, 'POST', '/v1/leave/adjustments', { employeeId, leaveType: 'ANNUAL', kind, units, effectiveDate: '2026-01-05', reason: 'Synthetic credit', idempotencyKey: uniq('own-key-') });
const movements = async (employeeId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from leave_movement where company_id = $1 and employee_id = $2`, [A.id, employeeId])).n;
const salary = (a: TestActor, employeeId: string) =>
  h.call(a, 'POST', `/v1/employees/${employeeId}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: '100000.00', annualCtc: '1200000.00', currency: 'INR' });
const arrangements = async (employeeId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from salary_arrangement where company_id = $1 and employee_id = $2`, [A.id, employeeId])).n;
const setManager = (a: TestActor, employeeId: string, managerEmployeeId: string | null, reason?: string) =>
  h.call(a, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId, effectiveFrom: '2026-06-01', ...(reason ? { reason } : {}) });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY });
  colleague = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  selfEmp = await world.employee();
  formerEmp = await world.employee();
  otherEmp = await world.employee();
  self = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: selfEmp, extra: SALARY });
  former = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY });
  // A self-link that has already ended still counts.
  await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2026-01-01', '2026-01-02')`, [A.id, former.user, formerEmp]);
  const shift = await h.call(hr, 'POST', '/v1/shifts', { code: 'OWNTEST', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
  expect(shift.statusCode, shift.body).toBe(201);
  shiftId = shift.json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('leave credits (FR-025)', () => {
  it('an HR Administrator cannot credit their own balance, with an opening or an adjustment, and nothing is posted', async () => {
    const before = await movements(selfEmp);
    expectSelfRefusal(await adjust(self, selfEmp, 'OPENING'));
    expectSelfRefusal(await adjust(self, selfEmp, 'ADJUSTMENT'));
    expect(await movements(selfEmp)).toBe(before);
  });

  it('counts a self-link from any period; a colleague posts the same credit (positive control)', async () => {
    expectSelfRefusal(await adjust(former, formerEmp, 'ADJUSTMENT'));
    expect((await adjust(colleague, selfEmp, 'OPENING')).statusCode).toBe(201);
    expect((await adjust(self, otherEmp, 'OPENING')).statusCode).toBe(201);
  });

  it('re-checks the duty inside the transaction', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: temp.user, companyId: A.id, assignmentId: temp.assignment, resource: 'leave', action: 'adjust', fieldGroups: ['operational'] })) as AccessGrant;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
    const before = await movements(otherEmp);
    await expect(
      withTransaction(h.pool, (tx) =>
        adjustBalance(tx, grant, { employeeId: otherEmp, leaveType: 'ANNUAL', kind: 'ADJUSTMENT', units: '1', effectiveDate: '2026-01-05', reason: 'Synthetic', idempotencyKey: uniq('recheck-') }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await movements(otherEmp)).toBe(before);
  });

  it('the database refuses a direct opening or adjustment by the linked user, in any period; other movements stay open', async () => {
    const type = (await h.one<{ id: string }>(`select id from leave_type where company_id = $1 and code = 'ANNUAL'`, [A.id])).id;
    const direct = (kind: string, user: string, employee: string) =>
      h.db.query(
        `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason, created_by, updated_by)
         values ($1, $2, $3, $4, 1, '2026-01-05', $5, 'Synthetic', $6, $6)`,
        [A.id, employee, type, kind, uniq('direct-move-'), user],
      );
    await expect(direct('ADJUSTMENT', self.user, selfEmp)).rejects.toThrow(/their own leave/);
    await expect(direct('OPENING', former.user, formerEmp)).rejects.toThrow(/their own leave/);
    await expect(direct('ACCRUAL', self.user, selfEmp)).resolves.toBeDefined();
    await expect(direct('ADJUSTMENT', colleague.user, selfEmp)).resolves.toBeDefined();
  });
});

describe('attendance amendments (FR-021)', () => {
  it('an HR Administrator cannot amend their own attendance, in any link period; a colleague can; the database refuses the direct write', async () => {
    const day = '2026-03-03';
    for (const e of [selfEmp, formerEmp]) {
      expect((await h.call(hr, 'POST', `/v1/employees/${e}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    }
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: day });
    const recordOf = async (e: string) => (await h.call(colleague, 'GET', `/v1/employees/${e}/attendance?from=${day}&to=${day}`)).json().items[0] as { id: string; version: number; status: string };
    const own = await recordOf(selfEmp);
    expect(own.status).toBe('ABSENT');
    const amend = (a: TestActor, r: { id: string; version: number }) => h.call(a, 'POST', `/v1/attendance/records/${r.id}/amend`, { expectedVersion: r.version, status: 'PRESENT', reason: 'Synthetic amendment' });
    const amendments = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from attendance_amendment where company_id = $1 and attendance_record_id = $2`, [A.id, id])).n;

    expectSelfRefusal(await amend(self, own));
    expect(await amendments(own.id)).toBe(0);
    expect((await recordOf(selfEmp)).status).toBe('ABSENT');
    expectSelfRefusal(await amend(former, await recordOf(formerEmp)));

    const status = async (code: string) => (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'ATTENDANCE_STATUS' and code = $2`, [A.id, code])).id;
    await expect(
      h.db.query(`insert into attendance_amendment (company_id, attendance_record_id, prior_version, old_status_id, new_status_id, reason, actor_id) values ($1, $2, 1, $3, $4, 'Synthetic', $5)`, [
        A.id,
        own.id,
        await status('ABSENT'),
        await status('PRESENT'),
        self.user,
      ]),
    ).rejects.toThrow(/their own attendance/);

    const ok = await amend(colleague, own);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await amendments(own.id)).toBe(1);
  });
});

describe('initial salary', () => {
  it('nobody records their own salary, singly or by upload; a colleague can; the database refuses the direct write', async () => {
    expectSelfRefusal(await salary(self, selfEmp));
    expectSelfRefusal(await salary(former, formerEmp));
    expect(await arrangements(selfEmp)).toBe(0);

    const file = ['employeeCode,effectiveFrom,annualCtc,monthlyGross,currency', `${await codeOf(selfEmp)},2026-01-05,1200000.00,100000.00,INR`].join('\r\n');
    const uploaded = await h.call(self, 'POST', '/v1/salary-master/imports', { fileName: 'salary.csv', contentBase64: b64(file), idempotencyKey: uniq('own-salary-') });
    expect(uploaded.json()).toMatchObject({ state: 'REJECTED', rows: [{ state: 'REJECTED', errorCode: 'SELF_ACTION_NOT_ALLOWED' }] });
    expect(await arrangements(selfEmp)).toBe(0);

    await expect(
      h.db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code, created_by, updated_by) values ($1, $2, '2026-01-05', 1, 1, 'INR', $3, $3)`, [
        A.id,
        selfEmp,
        self.user,
      ]),
    ).rejects.toThrow(/their own salary/);

    expect((await salary(colleague, selfEmp)).statusCode).toBe(201);
    expect(await arrangements(selfEmp)).toBe(1);
  });
});

describe('reporting lines', () => {
  it('nobody names themselves as a manager or changes their own reporting line, singly or by upload', async () => {
    const reportEmp = await world.employee();
    const lines = async (employeeId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from manager_assignment where company_id = $1 and employee_id = $2`, [A.id, employeeId])).n;

    expectSelfRefusal(await setManager(self, reportEmp, selfEmp));
    expectSelfRefusal(await setManager(former, reportEmp, formerEmp));
    expectSelfRefusal(await setManager(self, selfEmp, otherEmp));
    expectSelfRefusal(await setManager(self, selfEmp, null, 'Synthetic removal'));
    expect(await lines(reportEmp)).toBe(0);
    expect(await lines(selfEmp)).toBe(0);

    const file = [EMPLOYEE_UPDATE_COLUMNS.join(','), `${await codeOf(reportEmp)},,,2026-06-01,,,,,${await codeOf(selfEmp)}`].join('\r\n');
    const uploaded = await h.call(self, 'POST', '/v1/employees/update-imports', { fileName: 'updates.csv', contentBase64: b64(file), idempotencyKey: uniq('own-upd-') });
    expect(uploaded.json()).toMatchObject({ state: 'REJECTED', rows: [{ state: 'REJECTED', errorCode: 'SELF_ACTION_NOT_ALLOWED' }] });
    expect(await lines(reportEmp)).toBe(0);

    const direct = (employee: string, manager: string, actor: string) =>
      h.db.query(`insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from, created_by, updated_by) values ($1, $2, $3, '2026-06-01', $4, $4)`, [A.id, employee, manager, actor]);
    await expect(direct(reportEmp, selfEmp, self.user)).rejects.toThrow(/names themselves as a manager|reporting line of their own/);
    await expect(direct(selfEmp, otherEmp, self.user)).rejects.toThrow(/names themselves as a manager|reporting line of their own/);

    const ok = await setManager(colleague, reportEmp, selfEmp);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await lines(reportEmp)).toBe(1);
  });
});
