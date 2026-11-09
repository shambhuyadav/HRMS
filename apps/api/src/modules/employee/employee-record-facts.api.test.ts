// What GET /v1/employees/:id says beyond the list (FR-006, FR-008; DF04; DF02; BR-043; I-52; I-64). The shift in force is an
// operational fact of the record. The grade's words follow the grade master's read duty and the no-manager reason the history
// duty, because neither may reach a reader who could not read it before: DF02 lists neither as non-confidential, keeps private
// reasons confidential, and BR-043 defaults the unlisted to confidential. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let admin: TestActor;
let payroll: TestActor;
let gradeId: string;
let dayShift: string;
let nightShift: string;

const create = async (overrides: Record<string, unknown> = {}) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const read = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'GET', `/v1/employees/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const setShift = (id: string, shiftId: string, effectiveFrom: string) => h.call(hr, 'POST', `/v1/employees/${id}/shift`, { shiftId, effectiveFrom });
const setManager = (id: string, body: object) => h.call(hr, 'POST', `/v1/employees/${id}/manager`, body);
const today = () => h.one<{ d: string }>(`select hrms_business_date($1, now())::text as d`, [A.id]).then((r) => r.d);
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  // Reads employee records company-wide, holding neither the grade master's read duty nor the history duty.
  payroll = await h.actor(A, 'PAYROLL_OPERATOR');
  const grade = await h.call(admin, 'POST', '/v1/org/grades', { code: uniq('GR').toUpperCase().slice(0, 30), name: 'Synthetic Grade' });
  expect(grade.statusCode, grade.body).toBe(201);
  gradeId = grade.json().id;
  const shift = async (name: string) => {
    const res = await h.call(hr, 'POST', '/v1/shifts', { code: uniq('SH').toUpperCase().slice(0, 30), name, inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [] });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  dayShift = await shift('Synthetic Day');
  nightShift = await shift('Synthetic Late');
});

afterAll(async () => {
  await h?.stop();
});

describe('the shift in force (DF04)', () => {
  it('is on the record for whoever reads it, by the business date; a later change is not in force yet, and none reads null', async () => {
    const id = await create();
    expect((await read(hr, id)).shift).toBeNull();

    expect((await setShift(id, dayShift, '2026-02-01')).statusCode).toBe(200);
    const now = await today();
    expect((await setShift(id, nightShift, plusDays(now, 30))).statusCode).toBe(200);

    const expected = { id: dayShift, name: 'Synthetic Day' };
    expect((await read(hr, id)).shift).toMatchObject(expected);
    expect((await read(hr, id)).shift.code).toEqual(expect.any(String));
    expect((await read(payroll, id)).shift).toMatchObject(expected);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    expect((await read(self, id)).shift).toMatchObject(expected);

    // The change that closes the period ends it, and a future joiner has nothing in force today.
    const later = await create({ joiningDate: plusDays(now, 60) });
    expect((await setShift(later, dayShift, plusDays(now, 60))).statusCode).toBe(200);
    expect((await read(hr, later)).shift).toBeNull();
  });

  it('stays off the list, which carries only what a row needs, and out of scope reads as not found', async () => {
    const id = await create();
    await setShift(id, dayShift, '2026-02-01');
    const managerEmp = await create();
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    expect((await h.call(manager, 'GET', `/v1/employees/${id}`)).statusCode).toBe(404);
    const list = (await h.call(hr, 'GET', `/v1/employees?search=${encodeURIComponent((await read(hr, id)).employeeCode)}`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('shift');
    expect(list.items[0]).not.toHaveProperty('noManagerReason');
    expect(list.items[0].assignment).not.toHaveProperty('gradeName');
  });
});

describe('the grade in words (FR-004, DF02, BR-043)', () => {
  it('reaches only a reader who may read the grade master in the same assignment; any other keeps the id, as before', async () => {
    const id = await create({ gradeId });
    const withMaster = (await read(hr, id)).assignment;
    expect(withMaster).toMatchObject({ gradeId, gradeName: 'Synthetic Grade' });
    expect(withMaster.gradeCode).toEqual(expect.any(String));

    const without = (await read(payroll, id)).assignment;
    expect(without.gradeId).toBe(gradeId);
    expect(without).not.toHaveProperty('gradeName');
    expect(without).not.toHaveProperty('gradeCode');

    const self = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    expect((await read(self, id)).assignment).not.toHaveProperty('gradeName');

    // A direct report's grade is not in DF16's team columns either.
    const managerEmp = await create();
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    expect((await setManager(id, { managerEmployeeId: managerEmp, effectiveFrom: '2026-02-01' })).statusCode).toBe(200);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    expect((await read(manager, id)).assignment).not.toHaveProperty('gradeName');

    // The grant in this assignment decides, not the role's title; a duty held under another assignment lends nothing (BR-006).
    const withDuty = await h.customActor(A, { scope: 'COMPANY', permissions: ['employee.read.operational', 'org_master.read.operational'] });
    expect((await read(withDuty, id)).assignment.gradeName).toBe('Synthetic Grade');
    const elsewhere = await h.actor(A, 'PAYROLL_OPERATOR', { user: hr.user });
    expect((await read(elsewhere, id)).assignment).not.toHaveProperty('gradeName');
  });

  it('an inactive grade still reads: history keeps it (BR-004)', async () => {
    const grade = await h.call(admin, 'POST', '/v1/org/grades', { code: uniq('OG').toUpperCase().slice(0, 30), name: 'Synthetic Old Grade' });
    const id = await create({ gradeId: grade.json().id });
    await h.setStatus(A, id, 'INACTIVE_SEPARATED');
    const closed = await h.call(admin, 'PATCH', `/v1/org/grades/${grade.json().id}`, { expectedVersion: grade.json().version, active: false });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await read(hr, id)).assignment.gradeName).toBe('Synthetic Old Grade');
  });

  it('no grade on the assignment reads null, with the duty', async () => {
    const id = await create();
    expect((await read(hr, id)).assignment).toMatchObject({ gradeId: null, gradeName: null, gradeCode: null });
  });
});

describe('the no-manager reason (DF04, DF02 private reasons, I-64)', () => {
  const ready = async () => {
    const id = await create();
    await setShift(id, dayShift, '2026-02-01');
    return id;
  };
  const activate = async (id: string, noManagerReason?: string) => {
    const { version } = await read(hr, id);
    const res = await h.call(hr, 'POST', `/v1/employees/${id}/activate`, { expectedVersion: version, ...(noManagerReason ? { noManagerReason } : {}) });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('the reason given at activation reads back with the history duty, and only with it', async () => {
    const id = await ready();
    expect((await read(hr, id)).noManagerReason).toBeNull();
    await activate(id, 'Top-level role (synthetic)');
    expect((await read(hr, id)).noManagerReason).toBe('Top-level role (synthetic)');

    expect(await read(payroll, id)).not.toHaveProperty('noManagerReason');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    expect(await read(self, id)).not.toHaveProperty('noManagerReason');
    // The grant in this assignment decides; the same person's history duty under another assignment lends nothing (BR-006).
    const withDuty = await h.customActor(A, { scope: 'COMPANY', permissions: ['employee.read.operational', 'employee.read_history.operational'] });
    expect((await read(withDuty, id)).noManagerReason).toBe('Top-level role (synthetic)');
    const elsewhere = await h.actor(A, 'PAYROLL_OPERATOR', { user: hr.user });
    expect(await read(elsewhere, id)).not.toHaveProperty('noManagerReason');
  });

  it('a later change behind a removal is refused, like any other: the closed period is not rewritten (DF08)', async () => {
    const managerEmp = await create();
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    const id = await ready();
    await setManager(id, { managerEmployeeId: managerEmp, effectiveFrom: '2026-02-01' });
    await setManager(id, { managerEmployeeId: null, effectiveFrom: '2026-03-01', reason: 'Removed (synthetic)' });

    const periods = async () => (await h.call(hr, 'GET', `/v1/employees/${id}/history`)).json().managers;
    const before = await periods();
    const earlierRemoval = await setManager(id, { managerEmployeeId: null, effectiveFrom: '2026-02-15', reason: 'Earlier (synthetic)' });
    expect([earlierRemoval.statusCode, earlierRemoval.json().error]).toEqual([409, 'CHANGE_NOT_LATEST']);
    const otherEmp = await create();
    await h.setStatus(A, otherEmp, 'ACTIVE_CONFIRMED');
    const earlierManager = await setManager(id, { managerEmployeeId: otherEmp, effectiveFrom: '2026-02-15' });
    expect([earlierManager.statusCode, earlierManager.json().error]).toEqual([409, 'CHANGE_NOT_LATEST']);
    expect(await periods()).toEqual(before);

    // On or after the date the period closed is the next change, and it is accepted.
    const next = await setManager(id, { managerEmployeeId: otherEmp, effectiveFrom: '2026-03-01' });
    expect(next.statusCode, next.body).toBe(200);
  });

  it('removing a manager records the reason on the record, so it reads the same way as one given at activation', async () => {
    const managerEmp = await create();
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    const id = await ready();
    expect((await setManager(id, { managerEmployeeId: managerEmp, effectiveFrom: '2026-02-01' })).statusCode).toBe(200);
    expect((await read(hr, id)).noManagerReason).toBeNull();

    const removed = await setManager(id, { managerEmployeeId: null, effectiveFrom: '2026-03-01', reason: '  Now reports to no one (synthetic)  ' });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().manager).toBeNull();
    expect(removed.json().noManagerReason).toBe('Now reports to no one (synthetic)');
    expect((await read(payroll, id))).not.toHaveProperty('noManagerReason');
    // A refused removal records nothing.
    const refused = await setManager(id, { managerEmployeeId: null, effectiveFrom: '2026-02-15', reason: 'Too early (synthetic)' });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'CHANGE_NOT_LATEST']);
    expect((await read(hr, id)).noManagerReason).toBe('Now reports to no one (synthetic)');
  });

  it('applies only while nobody manages the employee on the business date', async () => {
    const managerEmp = await create();
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    const id = await ready();
    await activate(id, 'Top-level role (synthetic)');
    const now = await today();

    // A manager from next month: still nobody today, so the reason still stands.
    expect((await setManager(id, { managerEmployeeId: managerEmp, effectiveFrom: plusDays(now, 30) })).statusCode).toBe(200);
    expect((await read(hr, id)).noManagerReason).toBe('Top-level role (synthetic)');

    // A manager in force: the reason no longer applies, though earlier ones stay in the timeline.
    const other = await ready();
    await activate(other, 'Top-level role (synthetic)');
    expect((await setManager(other, { managerEmployeeId: managerEmp, effectiveFrom: now })).statusCode).toBe(200);
    expect((await read(hr, other)).manager).toMatchObject({ id: managerEmp });
    expect((await read(hr, other)).noManagerReason).toBeNull();

    // A removal from next month: the manager is still in force today.
    const leaving = await ready();
    await setManager(leaving, { managerEmployeeId: managerEmp, effectiveFrom: '2026-02-01' });
    expect((await setManager(leaving, { managerEmployeeId: null, effectiveFrom: plusDays(now, 30), reason: 'Later (synthetic)' })).statusCode).toBe(200);
    expect((await read(hr, leaving)).manager).toMatchObject({ id: managerEmp });
    expect((await read(hr, leaving)).noManagerReason).toBeNull();
  });
});
