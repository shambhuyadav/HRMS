// Effective periods of organisation masters and company maintenance (FR-004 "cannot be assigned to a new joiner outside its
// valid period"; BR-004; DF04; DF05 company timezone; DB001 "root deactivation cannot orphan active assignments"; 0102).
// Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { createEmployee } from '../employee/service.js';

let h: Harness;
let A: Company;
let admin: TestActor;
let hr: TestActor;
let codeSeq = 0;

const master = async (kind: string, body: Record<string, unknown> = {}) => {
  const res = await h.call(admin, 'POST', `/v1/org/${kind}`, { code: `M${++codeSeq}-${uniq('X').slice(-6).toUpperCase()}`, name: 'Synthetic master', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string; version: number; validFrom: string | null; validTo: string | null };
};
const patch = (kind: string, id: string, body: object) => h.call(admin, 'PATCH', `/v1/org/${kind}/${id}`, body);
const join = (overrides: Record<string, unknown>) => h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
const importBody = (kind: 'imports' | 'update-imports', csv: string) => ({ fileName: `${kind}.csv`, contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: uniq(`period-${kind}-`) });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('maintaining a period', () => {
  it('stores, returns, audits and validates the period; an existing master stays unlimited', async () => {
    const m = await master('departments', { validFrom: '2026-01-01', validTo: '2026-07-01' });
    expect(m).toMatchObject({ validFrom: '2026-01-01', validTo: '2026-07-01' });
    const seeded = (await h.call(hr, 'GET', '/v1/org/departments')).json().items.find((d: { id: string }) => d.id === A.dept);
    expect(seeded).toMatchObject({ validFrom: null, validTo: null });

    const reversed = await h.call(admin, 'POST', '/v1/org/grades', { code: uniq('G').toUpperCase().slice(0, 12), name: 'x', validFrom: '2026-07-01', validTo: '2026-07-01' });
    expect([reversed.statusCode, reversed.json().error]).toEqual([422, 'INVALID_PERIOD']);
    expect((await patch('departments', m.id, { expectedVersion: m.version, validFrom: '2026-08-01' })).json().error).toBe('INVALID_PERIOD');

    const changed = await patch('departments', m.id, { expectedVersion: m.version, validTo: null });
    expect(changed.json()).toMatchObject({ validFrom: '2026-01-01', validTo: null });
    const audit = await h.one<{ before_values: { operational: { validTo: string } }; after_values: { operational: { validTo: null } } }>(
      `select before_values, after_values from audit_event where record_key = $1 and action = 'UPDATE'`,
      [m.id],
    );
    expect(audit.before_values.operational.validTo).toBe('2026-07-01');
    expect(audit.after_values.operational.validTo).toBeNull();
  });

  it('offers only masters usable on a date when asked', async () => {
    const closing = await master('locations', { validTo: '2026-06-01' });
    const opening = await master('locations', { validFrom: '2026-06-01' });
    const on = async (date: string) => (await h.call(hr, 'GET', `/v1/org/locations?validOn=${date}`)).json().items.map((i: { id: string }) => i.id) as string[];
    expect(await on('2026-05-31')).toEqual(expect.arrayContaining([closing.id, A.loc]));
    expect(await on('2026-05-31')).not.toContain(opening.id);
    expect(await on('2026-06-01')).toEqual(expect.arrayContaining([opening.id, A.loc]));
    expect(await on('2026-06-01')).not.toContain(closing.id);
    expect((await h.call(hr, 'GET', '/v1/org/locations?validOn=June')).statusCode).toBe(400);
  });
});

describe('joining inside the period (FR-004 acceptance)', () => {
  it.each([
    ['departments', 'departmentId'],
    ['locations', 'locationId'],
    ['designations', 'designationId'],
    ['grades', 'gradeId'],
  ])('%s: a master closed before the joining date is refused; a back-dated joining before it closed is accepted', async (kind, field) => {
    const m = await master(kind, { validFrom: '2026-01-01', validTo: '2026-07-01' });
    const table = kind.replace(/s$/, '').toUpperCase();

    // The end is exclusive.
    const onEnd = await join({ joiningDate: '2026-07-01', [field]: m.id });
    expect([onEnd.statusCode, onEnd.json().error]).toEqual([422, `${table}_OUTSIDE_VALID_PERIOD`]);
    const before = await join({ joiningDate: '2025-12-31', [field]: m.id });
    expect([before.statusCode, before.json().error]).toEqual([422, `${table}_OUTSIDE_VALID_PERIOD`]);

    // The start is inclusive, and the last valid day counts: back-dated joinings inside the period stand.
    expect((await join({ joiningDate: '2026-01-01', [field]: m.id })).statusCode).toBe(201);
    expect((await join({ joiningDate: '2026-06-30', [field]: m.id })).statusCode).toBe(201);
  });

  it('a referenced master stays in history after it closes, and takes no new joiner', async () => {
    const m = await master('departments');
    const joined = await join({ departmentId: m.id, joiningDate: '2026-01-05' });
    expect(joined.statusCode, joined.body).toBe(201);
    const id = joined.json().id as string;
    const moved = await h.call(hr, 'POST', `/v1/employees/${id}/assignment`, { departmentId: A.dept, locationId: A.loc, designationId: A.desig, effectiveFrom: '2026-03-01' });
    expect(moved.statusCode, moved.body).toBe(200);

    // Nobody is on it from 1 March, so it may close then and be deactivated.
    const closed = await patch('departments', m.id, { expectedVersion: m.version, validTo: '2026-03-01' });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await patch('departments', m.id, { expectedVersion: closed.json().version, active: false })).statusCode).toBe(200);

    const history = (await h.call(hr, 'GET', `/v1/employees/${id}/history`)).json();
    expect(history.assignments[0]).toMatchObject({ departmentCode: m.code, effectiveTo: '2026-03-01' });
    expect((await join({ departmentId: m.id, joiningDate: '2026-02-01' })).statusCode).toBe(422);
  });
});

describe('transfer and imports', () => {
  it('a transfer is validated on its own effective date', async () => {
    const m = await master('departments', { validFrom: '2026-02-01', validTo: '2026-04-01' });
    const e = (await join({ joiningDate: '2026-01-05' })).json().id as string;
    const move = (effectiveFrom: string) => h.call(hr, 'POST', `/v1/employees/${e}/assignment`, { departmentId: m.id, locationId: A.loc, designationId: A.desig, effectiveFrom });
    expect((await move('2026-01-15')).json().error).toBe('DEPARTMENT_OUTSIDE_VALID_PERIOD');
    expect((await move('2026-04-01')).json().error).toBe('DEPARTMENT_OUTSIDE_VALID_PERIOD');
    expect((await move('2026-03-31')).statusCode).toBe(200);
  });

  it('the onboarding import reports the row and imports nothing; an in-period file commits', async () => {
    const m = await master('departments', { validTo: '2026-07-01' });
    const header = 'employeeCode,displayName,workEmail,joiningDate,employmentType,departmentCode,locationCode,designationCode,gradeCode';
    const row = (code: string, date: string) => `${code},Synthetic Person,${code.toLowerCase()}@example.test,${date},PERMANENT,${m.code},HQ,DEV,`;
    const bad = await h.call(hr, 'POST', '/v1/employees/imports', importBody('imports', [header, row(uniq('IMPA').toUpperCase(), '2026-06-01'), row(uniq('IMPB').toUpperCase(), '2026-07-01')].join('\n')));
    expect(bad.statusCode, bad.body).toBeLessThan(300);
    // All or nothing (DF09): the good row is rejected with the batch, and the bad row names its own reason.
    expect(bad.json().rows.map((r: { errorCode: string | null }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'DEPARTMENT_OUTSIDE_VALID_PERIOD']);
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${bad.json().id}/commit`)).statusCode).toBeGreaterThanOrEqual(400);

    const good = await h.call(hr, 'POST', '/v1/employees/imports', importBody('imports', [header, row(uniq('IMPC').toUpperCase(), '2026-06-30')].join('\n')));
    expect(good.json().rows[0].errorCode).toBeNull();
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${good.json().id}/commit`)).statusCode).toBe(200);
  });

  it('the update import reports the row on its effective date', async () => {
    const m = await master('departments', { validFrom: '2026-02-01', validTo: '2026-04-01' });
    const e = (await join({ joiningDate: '2026-01-05' })).json() as { employeeCode: string };
    const header = 'employeeCode,displayName,workEmail,effectiveFrom,departmentCode,locationCode,designationCode,gradeCode,managerEmployeeCode';
    const csv = (date: string) => [header, `${e.employeeCode},,,${date},${m.code},,,,`].join('\n');
    const bad = await h.call(hr, 'POST', '/v1/employees/update-imports', importBody('update-imports', csv('2026-04-01')));
    expect(bad.json().rows[0].errorCode).toBe('DEPARTMENT_OUTSIDE_VALID_PERIOD');
    const good = await h.call(hr, 'POST', '/v1/employees/update-imports', importBody('update-imports', csv('2026-03-01')));
    expect(good.json().rows[0].errorCode).toBeNull();
  });
});

describe('controlled deactivation and closing (BR-004, DB001)', () => {
  it('refuses to deactivate or end-date a master with live assignments, and allows it once they have moved or left', async () => {
    const m = await master('designations');
    const e = await join({ designationId: m.id, joiningDate: '2026-01-05' });
    const id = e.json().id as string;

    const off = await patch('designations', m.id, { expectedVersion: m.version, active: false });
    expect([off.statusCode, off.json().error]).toEqual([409, 'MASTER_IN_USE']);
    expect(off.json().details).toEqual({ assignments: 1 });
    const end = await patch('designations', m.id, { expectedVersion: m.version, validTo: '2026-06-01' });
    expect([end.statusCode, end.json().error]).toEqual([409, 'MASTER_IN_USE']);
    // Starting after an assignment began would put history outside the period, whoever it belongs to.
    const start = await patch('designations', m.id, { expectedVersion: m.version, validFrom: '2026-02-01' });
    expect([start.statusCode, start.json().error]).toEqual([409, 'MASTER_IN_USE']);
    // A rename is not a closure.
    const renamed = await patch('designations', m.id, { expectedVersion: m.version, name: 'Renamed (synthetic)' });
    expect(renamed.statusCode).toBe(200);

    // A separated employee no longer holds it: it closes, and their history keeps it.
    await h.setStatus(A, id, 'INACTIVE_SEPARATED');
    const v = renamed.json().version as number;
    const closed = await patch('designations', m.id, { expectedVersion: v, active: false });
    expect(closed.statusCode, closed.body).toBe(200);
    const again = await patch('designations', m.id, { expectedVersion: closed.json().version, active: true });
    expect(again.json().active).toBe(true);
    expect((await h.call(hr, 'GET', `/v1/employees/${id}/history`)).json().assignments[0]).toMatchObject({ designationCode: m.code });
  });

  it('a joining before the close date is accepted even after the master closed, and its assignment stays open (owner question)', async () => {
    const m = await master('departments');
    expect((await patch('departments', m.id, { expectedVersion: m.version, validTo: '2026-06-01' })).statusCode).toBe(200);
    const joined = await join({ departmentId: m.id, joiningDate: '2026-02-02' });
    expect(joined.statusCode, joined.body).toBe(201);
    expect((await h.call(hr, 'GET', `/v1/employees/${joined.json().id}/history`)).json().assignments[0]).toMatchObject({ effectiveFrom: '2026-02-02', effectiveTo: null });
  });

  it('closing a master and a joining after the close date at the same moment: one of them is refused', async () => {
    for (let i = 0; i < 4; i++) {
      const m = await master('departments');
      const [closed, joined] = await Promise.all([patch('departments', m.id, { expectedVersion: m.version, validTo: '2026-06-01' }), join({ departmentId: m.id, joiningDate: '2026-07-01' })]);
      const row = await h.one<{ valid_to: string | null; assignments: number }>(
        `select d.valid_to, (select count(*)::int from employment_assignment a where a.department_id = d.id) as assignments from department d where d.id = $1`,
        [m.id],
      );
      expect(row.valid_to !== null && row.assignments > 0, `close ${closed.statusCode}, join ${joined.statusCode}`).toBe(false);
      expect(row.valid_to !== null || row.assignments > 0).toBe(true);
    }
  });

  it('the database refuses an assignment outside the period, whatever path writes it (0102)', async () => {
    const m = await master('departments', { validFrom: '2026-02-01', validTo: '2026-04-01' });
    const e = (await join({ joiningDate: '2026-01-05' })).json().id as string;
    await expect(
      h.db.query(`insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from) values ($1, $2, $3, $4, $5, '2026-04-01')`, [A.id, e, m.id, A.loc, A.desig]),
    ).rejects.toThrow(/department is outside its valid period/);
    await expect(h.db.query(`update department set valid_from = '2026-05-01' where id = $1`, [m.id])).rejects.toMatchObject({ code: '23514' });

    // A second employee whose own assignment starts later, so these periods overlap nothing and the overlap constraint stays out of it.
    const later = (await join({ joiningDate: '2026-05-01' })).json().id as string;
    const insert = (values: { department: string; location: string; designation: string; grade: string | null }, from: string, to: string) =>
      h.db.query(
        `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id, effective_from, effective_to) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [A.id, later, values.department, values.location, values.designation, values.grade, from, to],
      );
    const own = { department: A.dept, location: A.loc, designation: A.desig, grade: null };

    // Inside the period the same insert stands, on the last valid day included.
    await expect(insert({ ...own, department: m.id }, '2026-03-31', '2026-04-15')).resolves.toMatchObject({ rowCount: 1 });

    // Another company's master is not a period question: the trigger lets it through and the foreign key refuses it (23503).
    const B = await h.makeCompany();
    const foreignGrade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, 'G1', 'G1', true) returning id`, [B.id])).id;
    for (const foreign of [{ department: B.dept }, { location: B.loc }, { designation: B.desig }, { grade: foreignGrade }]) {
      await expect(insert({ ...own, ...foreign }, '2026-01-10', '2026-01-20'), JSON.stringify(Object.keys(foreign))).rejects.toMatchObject({ code: '23503' });
    }
  });

  it('a filtered or non-administrator actor cannot change a period; authority is re-checked in the transaction', async () => {
    const m = await master('departments');
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await h.call(filtered, 'PATCH', `/v1/org/departments/${m.id}`, { expectedVersion: m.version, validTo: '2026-06-01' })).statusCode).toBe(403);
    expect((await h.call(hr, 'PATCH', `/v1/org/departments/${m.id}`, { expectedVersion: m.version, validTo: '2026-06-01' })).statusCode).toBe(403);

    // A grant revoked after the route guard: creating an employee is refused inside the transaction.
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: temp.user, companyId: A.id, assignmentId: temp.assignment, resource: 'employee', action: 'create', fieldGroups: ['operational'] })) as AccessGrant;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    const body = h.newEmployeeBody(A) as unknown as Parameters<typeof createEmployee>[2];
    await expect(withTransaction(h.pool, (tx) => createEmployee(tx, grant, body))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('company maintenance (FR-004, DF05, DB001)', () => {
  const company = async (by = admin) => (await h.call(by, 'GET', '/v1/org/company')).json() as { id: string; code: string; name: string; businessTimezone: string; active: boolean; version: number };
  const update = (by: TestActor, body: object) => h.call(by, 'PATCH', '/v1/org/company', body);

  it('changes the name and business timezone, audited; the code stays', async () => {
    const before = await company();
    const res = await update(admin, { expectedVersion: before.version, name: ' Renamed Co (synthetic) ', businessTimezone: 'Asia/Dubai' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ code: before.code, name: 'Renamed Co (synthetic)', businessTimezone: 'Asia/Dubai', version: before.version + 1 });
    // The business date follows the zone at once.
    const dates = await h.one<{ d: string; expected: string }>(`select hrms_business_date($1, now())::text as d, (now() at time zone 'Asia/Dubai')::date::text as expected`, [A.id]);
    expect(dates.d).toBe(dates.expected);
    const audit = await h.one<{ action: string; before_values: unknown; after_values: unknown }>(`select action, before_values, after_values from audit_event where company_id = $1 and resource_code = 'company' order by occurred_at desc limit 1`, [A.id]);
    expect(audit).toEqual({
      action: 'UPDATE',
      before_values: { operational: { name: before.name, businessTimezone: before.businessTimezone, active: true } },
      after_values: { operational: { name: 'Renamed Co (synthetic)', businessTimezone: 'Asia/Dubai', active: true } },
    });
    await update(admin, { expectedVersion: before.version + 1, businessTimezone: before.businessTimezone });
  });

  it('refuses an unknown timezone, a blank name, a stale version, a code in the body, and anyone without an unrestricted grant', async () => {
    const current = await company();
    const zone = await update(admin, { expectedVersion: current.version, businessTimezone: 'Mars/Olympus' });
    expect([zone.statusCode, zone.json().error]).toEqual([422, 'INVALID_TIMEZONE']);
    expect((await update(admin, { expectedVersion: current.version, name: '   ' })).json().error).toBe('INVALID_NAME');
    expect((await update(admin, { expectedVersion: 99, name: 'x' })).json().error).toBe('STALE_VERSION');
    // The schema strips an unknown property (the app's validator), so a code in the body changes nothing and records nothing.
    const audits = async () => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'company'`, [A.id])).n;
    const auditsBefore = await audits();
    const withCode = await update(admin, { expectedVersion: current.version, code: 'NEW' });
    expect(withCode.json()).toMatchObject({ code: current.code, version: current.version });
    const sameName = await update(admin, { expectedVersion: current.version, name: current.name });
    expect(sameName.json()).toMatchObject({ version: current.version });
    expect(await audits()).toBe(auditsBefore);
    expect((await update(hr, { expectedVersion: current.version, name: 'x' })).statusCode).toBe(403);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { locationFilter: A.loc });
    expect((await update(filtered, { expectedVersion: current.version, name: 'x' })).statusCode).toBe(403);
    expect((await company()).version).toBe(current.version);
  });

  it('refuses a deactivation that would orphan an employment or another role; only an emptied company can be deactivated', async () => {
    const C = await h.makeCompany();
    const cAdmin = await h.actor(C, 'SYSTEM_ADMINISTRATOR');
    const cHr = await h.actor(C, 'HR_ADMINISTRATOR');
    const emp = (await h.call(cHr, 'POST', '/v1/employees', h.newEmployeeBody(C))).json().id as string;
    const v = (await company(cAdmin)).version;

    const refused = await update(cAdmin, { expectedVersion: v, active: false });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'COMPANY_IN_USE']);
    expect(refused.json().details).toEqual({ employees: 1, roleAssignments: 1 });

    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [cHr.assignment]);
    await h.setStatus(C, emp, 'INACTIVE_SEPARATED');
    const res = await update(cAdmin, { expectedVersion: v, active: false });
    expect(res.statusCode, res.body).toBe(200);
    // Nobody acts in an inactive company, the deactivating administrator included.
    expect((await h.call(cAdmin, 'GET', '/v1/org/company')).statusCode).toBe(403);
    expect((await h.call(cAdmin, 'GET', '/v1/me/context')).statusCode).toBe(403);
    expect((await update(admin, { expectedVersion: 1, active: true })).statusCode).toBe(422);
  });
});
