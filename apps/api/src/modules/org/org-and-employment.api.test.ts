// Organisation masters and effective-dated employment changes over HTTP (FR-003/004/006/089; BR-002/004/005; CI13).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let sysAdmin: TestActor;
let hr: TestActor;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('organisation masters (FR-004, BR-004)', () => {
  it('creates, rejects duplicates, deactivates without deleting, and hides inactive by default', async () => {
    const created = await h.call(sysAdmin, 'POST', '/v1/org/departments', { code: ' ops ', name: 'Operations' });
    expect(created.statusCode).toBe(201);
    const dept = created.json();
    expect(dept).toMatchObject({ code: 'OPS', active: true });
    expect((await h.call(sysAdmin, 'POST', '/v1/org/departments', { code: 'OPS', name: 'Again' })).statusCode).toBe(409);

    const stale = await h.call(sysAdmin, 'PATCH', `/v1/org/departments/${dept.id}`, { expectedVersion: 9, active: false });
    expect(stale.statusCode).toBe(409);
    const off = await h.call(sysAdmin, 'PATCH', `/v1/org/departments/${dept.id}`, { expectedVersion: dept.version, active: false });
    expect(off.json()).toMatchObject({ active: false });

    const visible = (await h.call(hr, 'GET', '/v1/org/departments')).json().items.map((d: { code: string }) => d.code);
    expect(visible).not.toContain('OPS');
    const all = (await h.call(hr, 'GET', '/v1/org/departments?includeInactive=true')).json().items.map((d: { code: string }) => d.code);
    expect(all).toContain('OPS');

    expect((await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: dept.id }))).statusCode).toBe(422);
  });

  it('HR can read but not maintain masters; filtered administrators cannot maintain masters', async () => {
    expect((await h.call(hr, 'POST', '/v1/org/locations', { code: 'BLR', name: 'Bengaluru' })).statusCode).toBe(403);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await h.call(filtered, 'POST', '/v1/org/locations', { code: 'BLR', name: 'Bengaluru' })).statusCode).toBe(403);
    expect((await h.call(sysAdmin, 'POST', '/v1/org/locations', { code: 'BLR', name: 'Bengaluru' })).statusCode).toBe(201);
  });
});

describe('effective-dated manager and assignment changes (FR-003, BR-002, BR-005, CI13)', () => {
  let employee: string;
  let m1: string;
  let m2: string;

  beforeAll(async () => {
    const create = async () => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    employee = await create();
    m1 = await create();
    m2 = await create();
    await h.setStatus(A, m1, 'ACTIVE_CONFIRMED');
    await h.setStatus(A, m2, 'ACTIVE_CONFIRMED');
  });

  const setManager = (target: string, body: object) => h.call(hr, 'POST', `/v1/employees/${target}/manager`, body);

  it('changes the manager forward in time and keeps history', async () => {
    expect((await setManager(employee, { managerEmployeeId: m1, effectiveFrom: '2026-02-01' })).statusCode).toBe(200);
    const res = await setManager(employee, { managerEmployeeId: m2, effectiveFrom: '2026-03-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().manager).toMatchObject({ id: m2 });

    const history = (await h.call(hr, 'GET', `/v1/employees/${employee}/history`)).json();
    expect(history.managers).toMatchObject([
      { managerId: m1, effectiveFrom: '2026-02-01', effectiveTo: '2026-03-01' },
      { managerId: m2, effectiveFrom: '2026-03-01', effectiveTo: null },
    ]);
  });

  it('refuses back-dating behind the latest change, cycles, inactive managers and silent removal', async () => {
    const backdated = await setManager(employee, { managerEmployeeId: m1, effectiveFrom: '2026-02-15' });
    expect(backdated.statusCode).toBe(409);
    expect(backdated.json().error).toBe('CHANGE_NOT_LATEST');
    // The refusal names what to do, not a correction route: none exists for these histories (DF08; owner question).
    expect(backdated.json().message).toMatch(/must start after the latest/);
    expect(backdated.json().message).not.toMatch(/correction/i);

    await h.setStatus(A, employee, 'ACTIVE_CONFIRMED');
    const cycle = await setManager(m2, { managerEmployeeId: employee, effectiveFrom: '2026-04-01' });
    expect(cycle.statusCode).toBe(422);

    const draft = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
    expect((await setManager(m1, { managerEmployeeId: draft, effectiveFrom: '2026-04-01' })).statusCode).toBe(422);

    expect((await setManager(employee, { managerEmployeeId: null, effectiveFrom: '2026-05-01' })).statusCode).toBe(422);
    const removed = await setManager(employee, { managerEmployeeId: null, effectiveFrom: '2026-05-01', reason: 'Top-level role (synthetic)' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().manager).toBeNull();
  });

  it('transfers an employee and records both periods', async () => {
    const before = await h.call(hr, 'POST', `/v1/employees/${employee}/assignment`, {
      departmentId: A.financeDept,
      locationId: A.loc,
      designationId: A.desig,
      effectiveFrom: '2025-12-01',
    });
    expect(before.statusCode).toBe(422); // before joining date

    const res = await h.call(hr, 'POST', `/v1/employees/${employee}/assignment`, {
      departmentId: A.financeDept,
      locationId: A.loc,
      designationId: A.desig,
      effectiveFrom: '2026-04-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignment).toMatchObject({ departmentId: A.financeDept });
    const history = (await h.call(hr, 'GET', `/v1/employees/${employee}/history`)).json();
    expect(history.assignments).toMatchObject([
      { departmentCode: 'ENG', effectiveTo: '2026-04-01' },
      { departmentCode: 'FIN', effectiveTo: null },
    ]);
  });

  it('history needs its own permission', async () => {
    const managerActor = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m1 });
    expect((await h.call(managerActor, 'GET', `/v1/employees/${employee}/history`)).statusCode).toBe(403);
  });
});
