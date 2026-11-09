// Employee status history, joining-date correction, closing a draft and prior employment (FR-006 "joining and status changes
// retain effective-dated history"; BR-002; CI15; DF04; DF08; 0101). Every status change writes a row, whichever path makes it;
// GET /employees/:id/history returns it with the leaving date. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { separateDueExits } from '../lifecycle/exit.js';
import { addDays, key, today as businessDate } from '../lifecycle/lifecycle.fixtures.js';
import { isModuleActive } from '../registry.js';
import { closeDraftEmployee, correctJoiningDate } from './changes.js';
import { assertStatusTransition, EMPLOYEE_STATUS_TRANSITIONS } from './status.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let shiftId: string;
let today: string;

interface StatusRow {
  status: string;
  priorStatus: string | null;
  effectiveDate: string;
  sourceKind: string;
  sourceId: string | null;
  actorUserId: string | null;
}

const create = async (overrides: Record<string, unknown> = {}) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number; joiningDate: string };
};
const history = async (id: string, by = hr) => {
  const res = await h.call(by, 'GET', `/v1/employees/${id}/history`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { statuses: StatusRow[]; leavingDate: string | null; joiningDate: string; confirmationDate: string | null; joiningDateChanges: { priorDate: string; newDate: string; actorUserId: string }[]; priorEmployment: { employeeId: string } | null; nextEmployment: { employeeId: string } | null; assignments: { effectiveFrom: string }[] };
};
const readyToActivate = async (id: string, joiningDate: string) => {
  expect((await h.call(hr, 'POST', `/v1/employees/${id}/shift`, { shiftId, effectiveFrom: joiningDate })).statusCode).toBe(200);
  return (await h.call(hr, 'GET', `/v1/employees/${id}`)).json().version as number;
};
const activate = async (id: string, joiningDate: string) =>
  h.call(hr, 'POST', `/v1/employees/${id}/activate`, { expectedVersion: await readyToActivate(id, joiningDate), noManagerReason: 'Top-level role (synthetic)' });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  today = await businessDate(h, A);
  const shift = await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '17:00', bufferMinutes: 240, breaks: [] });
  expect(shift.statusCode, shift.body).toBe(201);
  shiftId = shift.json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe('status history (FR-006, BR-002)', () => {
  it('creation and activation each write a row, dated, sourced and with the actor; the history route returns them', async () => {
    const e = await create({ joiningDate: '2026-01-05' });
    expect((await history(e.id)).statuses).toMatchObject([{ status: 'DRAFT', priorStatus: null, sourceKind: 'CREATE', effectiveDate: '2026-01-05', actorUserId: hr.user }]);

    const res = await activate(e.id, e.joiningDate);
    expect(res.statusCode, res.body).toBe(200);
    const h2 = await history(e.id);
    expect(h2.statuses).toHaveLength(2);
    // Probation runs from the joining date, even though the activation was recorded later.
    expect(h2.statuses[1]).toMatchObject({ status: 'ACTIVE_PROBATION', priorStatus: 'DRAFT', sourceKind: 'ACTIVATION', effectiveDate: '2026-01-05', actorUserId: hr.user });
    expect(h2).toMatchObject({ joiningDate: '2026-01-05', confirmationDate: null, leavingDate: null });
  });

  it('a draft created ahead of a future joining date is dated by the day it was created, and activates to the joining date', async () => {
    const joining = addDays(today, 40);
    const e = await create({ joiningDate: joining });
    expect((await history(e.id)).statuses[0]).toMatchObject({ status: 'DRAFT', effectiveDate: today });
    expect((await activate(e.id, joining)).statusCode).toBe(200);
    expect((await history(e.id)).statuses[1]).toMatchObject({ status: 'ACTIVE_PROBATION', effectiveDate: joining });
  });

  it('any other write of the status is recorded too: the row cannot be skipped, rewritten or deleted', async () => {
    const e = await create();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    const statuses = (await history(e.id)).statuses;
    expect(statuses[1]).toMatchObject({ status: 'ACTIVE_CONFIRMED', priorStatus: 'DRAFT', sourceKind: 'DIRECT', effectiveDate: today });
    // An update that leaves the status alone writes nothing.
    await h.db.query(`update employee set display_name = 'Renamed (synthetic)' where id = $1`, [e.id]);
    expect((await history(e.id)).statuses).toHaveLength(2);

    await expect(h.db.query(`update employee_status_history set effective_date = '2020-01-01' where employee_id = $1`, [e.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from employee_status_history where employee_id = $1`, [e.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`truncate employee_status_history`)).rejects.toMatchObject({ code: '23514' });
  });

  it('a status write rolled back leaves no row, and the source does not leak into the next status change', async () => {
    const e = await create();
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query(`select set_config('hrms.employee_status_source', $1, true)`, [JSON.stringify({ kind: 'ACTIVATION', effectiveDate: '2026-02-02' })]);
        await tx.query(`update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'ACTIVE_PROBATION') where id = $2`, [A.id, e.id]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await history(e.id)).statuses).toHaveLength(1);
    await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
    expect((await history(e.id)).statuses[1]).toMatchObject({ sourceKind: 'DIRECT' });
  });

  it('history needs its own permission and stays inside row scope', async () => {
    const e = await create();
    const outside = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await h.call(outside, 'GET', `/v1/employees/${e.id}/history`)).statusCode).toBe(404);
    const reader = await h.actor(A, 'AUDITOR');
    expect((await h.call(reader, 'GET', `/v1/employees/${e.id}/history`)).statusCode).toBe(403);
  });

  it('the transition catalogue allows what the services do and refuses the rest (CI15)', () => {
    assertStatusTransition('DRAFT', 'ACTIVE_PROBATION');
    assertStatusTransition('DRAFT', 'ARCHIVED');
    assertStatusTransition('NOTICE', 'ACTIVE_CONFIRMED');
    for (const [from, to] of [
      ['DRAFT', 'ACTIVE_CONFIRMED'],
      ['ACTIVE_CONFIRMED', 'ACTIVE_PROBATION'],
      ['INACTIVE_SEPARATED', 'ACTIVE_CONFIRMED'],
      ['ARCHIVED', 'DRAFT'],
    ] as const) {
      expect(() => assertStatusTransition(from, to), `${from} -> ${to}`).toThrow(expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }));
    }
    expect(Object.keys(EMPLOYEE_STATUS_TRANSITIONS).sort()).toEqual(['ACTIVE_CONFIRMED', 'ACTIVE_PROBATION', 'ARCHIVED', 'DRAFT', 'INACTIVE_SEPARATED', 'NOTICE']);
  });
});

describe('confirmation writes the history (FR-081)', () => {
  it('the approved decision records ACTIVE_CONFIRMED from its confirmation date, with the case as its source', async () => {
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [A.id, hr.user]);
    const managerRecord = await create();
    await h.setStatus(A, managerRecord.id, 'ACTIVE_CONFIRMED');
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerRecord.id });
    const e = await create({ joiningDate: '2026-01-31' });
    await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerRecord.id, effectiveFrom: '2026-01-31' })).statusCode).toBe(200);
    const caseId = (await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e.id })).json().caseId as string;
    const expectedVersion = (await h.call(hr, 'GET', `/v1/confirmations/${caseId}`)).json().version;
    const recommended = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion, reason: 'Manager review (synthetic)', recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
    expect(recommended.statusCode, recommended.body).toBeLessThan(300);
    const task = ((await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === e.id)!;
    const decided = await h.call(hr, 'POST', `/v1/confirmations/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'HR decision (synthetic)', idempotencyKey: uniq('conf-key-') });
    expect(decided.json()).toMatchObject({ state: 'CONFIRMED', actualConfirmationDate: '2026-06-01' });

    const h2 = await history(e.id);
    expect(h2.statuses.at(-1)).toMatchObject({ status: 'ACTIVE_CONFIRMED', priorStatus: 'ACTIVE_PROBATION', sourceKind: 'CONFIRMATION', sourceId: caseId, effectiveDate: '2026-06-01', actorUserId: hr.user });
    expect(h2.confirmationDate).toBe('2026-06-01');
  });
});

describe.runIf(isModuleActive('lifecycle'))('notice, withdrawal and separation write the history (FR-051, FR-055)', () => {
  let manager: TestActor;

  const staff = async () => {
    const e = await create({ displayName: 'Exit person (synthetic)' });
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return { id: e.id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
  };
  let managerEmp: string;
  const taskFor = async (a: TestActor, exitCaseId: string, kind = 'exit_case') =>
    ((await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; exitCase: { id: string } | null }[]).find((t) => t.kind === kind && t.exitCase?.id === exitCaseId)!;
  const approvedExit = async (s: { id: string; actor: TestActor }, lwd: string) => {
    const id = (await h.call(s.actor, 'POST', '/v1/me/resignation', { reason: 'Synthetic personal reason', proposedLastWorkingDate: lwd })).json().exitCaseId as string;
    const mt = await taskFor(manager, id);
    expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: lwd, idempotencyKey: key() })).statusCode).toBeLessThan(300);
    const ht = (await taskFor(hr, id)) ?? (await taskFor(hr2, id));
    const approver = (await taskFor(hr, id)) ? hr : hr2;
    const decided = await h.call(approver, 'POST', `/v1/exit-cases/tasks/${ht.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() });
    expect(decided.json().state, decided.body).toBe('APPROVED');
    return { id, approver };
  };

  beforeAll(async () => {
    const m = await create({ displayName: 'Manager (synthetic)' });
    managerEmp = m.id;
    await h.setStatus(A, m.id, 'ACTIVE_CONFIRMED');
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m.id });
    expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }, { userId: hr2.user, priority: 2 }] })).statusCode).toBe(200);
  });

  it('an approved exit gives NOTICE from the approval date with the leaving date; separation is dated the day after it', async () => {
    const s = await staff();
    const lwd = addDays(today, 20);
    const { id, approver } = await approvedExit(s, lwd);
    const onNotice = await history(s.id);
    expect(onNotice.statuses.at(-1)).toMatchObject({ status: 'NOTICE', priorStatus: 'ACTIVE_CONFIRMED', sourceKind: 'EXIT_APPROVED', sourceId: id, effectiveDate: today, actorUserId: approver.user });
    expect(onNotice.leavingDate).toBe(lwd);

    const system = await h.makeUser();
    expect(await separateDueExits(h.pool, A.id, addDays(lwd, 1), system)).toMatchObject({ separated: 1 });
    const separated = await history(s.id);
    expect(separated.statuses.at(-1)).toMatchObject({ status: 'INACTIVE_SEPARATED', priorStatus: 'NOTICE', sourceKind: 'SEPARATION', sourceId: id, effectiveDate: addDays(lwd, 1), actorUserId: system });
    expect(separated.leavingDate).toBe(lwd);

    // BR-002, DF04: a rehire links to it and starts after its last working date, never on it.
    const onIt = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: lwd, priorEmployeeId: s.id }));
    expect([onIt.statusCode, onIt.json().error]).toEqual([422, 'CHRONOLOGY_CONFLICT']);
    const after = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: addDays(lwd, 1), priorEmployeeId: s.id }));
    expect(after.statusCode, after.body).toBe(201);
    expect((await history(s.id)).nextEmployment).toMatchObject({ employeeId: after.json().id });
  });

  it('an approved withdrawal restores the prior status, and the leaving date goes away', async () => {
    const s = await staff();
    const lwd = addDays(today, 25);
    const { id } = await approvedExit(s, lwd);
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'Synthetic change of plans' })).statusCode).toBeLessThan(300);
    const wt = (await taskFor(hr, id, 'exit_withdrawal')) ?? (await taskFor(hr2, id, 'exit_withdrawal'));
    const decider = (await taskFor(hr, id, 'exit_withdrawal')) ? hr : hr2;
    const decided = await h.call(decider, 'POST', `/v1/exit-withdrawals/tasks/${wt.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: key() });
    expect(decided.statusCode, decided.body).toBeLessThan(300);
    const after = await history(s.id);
    expect(after.statuses.at(-1)).toMatchObject({ status: 'ACTIVE_CONFIRMED', priorStatus: 'NOTICE', sourceKind: 'EXIT_WITHDRAWN', sourceId: id, effectiveDate: today });
    expect(after.leavingDate).toBeNull();
  });
});

describe('joining date correction (BR-002)', () => {
  const correct = (by: TestActor, id: string, body: object) => h.call(by, 'POST', `/v1/employees/${id}/joining-date`, { reason: 'Offer moved (synthetic)', ...body });

  it('moves the date and the joining assignment of a draft, keeps the prior date and audits the change', async () => {
    const e = await create({ joiningDate: '2026-03-02' });
    const res = await correct(hr, e.id, { expectedVersion: e.version, joiningDate: '2026-03-16' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ joiningDate: '2026-03-16', status: 'DRAFT' });
    const h2 = await history(e.id);
    expect(h2.joiningDateChanges).toMatchObject([{ priorDate: '2026-03-02', newDate: '2026-03-16', actorUserId: hr.user }]);
    expect(h2.assignments).toMatchObject([{ effectiveFrom: '2026-03-16' }]);
    const audit = await h.one<{ reason: string; before_values: unknown; after_values: unknown }>(`select reason, before_values, after_values from audit_event where record_key = $1 and action = 'CORRECT_JOINING_DATE'`, [e.id]);
    expect(audit).toEqual({ reason: 'Offer moved (synthetic)', before_values: { operational: { joiningDate: '2026-03-02' } }, after_values: { operational: { joiningDate: '2026-03-16' } } });
  });

  it('refuses a stale version, the same date, a non-draft, and dates out of order with what follows', async () => {
    const e = await create({ joiningDate: '2026-03-02' });
    const hrPersonal = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal'] });
    const withBirth = await h.call(hrPersonal, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: '2026-03-02', dateOfBirth: '1990-05-01' }));
    expect(withBirth.statusCode, withBirth.body).toBe(201);
    const born = withBirth.json().id as string;
    const version = async (id: string) => (await h.one<{ version: number }>(`select version from employee where id = $1`, [id])).version;
    const birth = await correct(hr, born, { expectedVersion: await version(born), joiningDate: '1990-05-01' });
    expect([birth.statusCode, birth.json().error, birth.json().details?.conflict]).toEqual([422, 'CHRONOLOGY_CONFLICT', 'BIRTH_DATE']);

    expect((await correct(hr, e.id, { expectedVersion: 99, joiningDate: '2026-03-16' })).json().error).toBe('STALE_VERSION');
    expect((await correct(hr, e.id, { expectedVersion: await version(e.id), joiningDate: '2026-03-02' })).json().error).toBe('NO_CHANGE');

    // A later transfer, manager or shift period bounds the new date.
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: '2026-04-01' })).statusCode).toBe(200);
    const pastTransfer = await correct(hr, e.id, { expectedVersion: await version(e.id), joiningDate: '2026-04-01' });
    expect([pastTransfer.statusCode, pastTransfer.json().error, pastTransfer.json().details?.conflict]).toEqual([422, 'CHRONOLOGY_CONFLICT', 'ASSIGNMENT']);

    const s = await create({ joiningDate: '2026-03-02' });
    expect((await h.call(hr, 'POST', `/v1/employees/${s.id}/shift`, { shiftId, effectiveFrom: '2026-03-02' })).statusCode).toBe(200);
    const pastShift = await correct(hr, s.id, { expectedVersion: await version(s.id), joiningDate: '2026-03-16' });
    expect([pastShift.json().error, pastShift.json().details?.conflict]).toEqual(['CHRONOLOGY_CONFLICT', 'SHIFT']);
    // Moving earlier stays in order.
    expect((await correct(hr, s.id, { expectedVersion: await version(s.id), joiningDate: '2026-02-16' })).statusCode).toBe(200);

    await h.setStatus(A, s.id, 'ACTIVE_PROBATION');
    const active = await correct(hr, s.id, { expectedVersion: await version(s.id), joiningDate: '2026-02-20' });
    expect([active.statusCode, active.json().error]).toEqual([409, 'INVALID_STATE']);
    expect((await history(s.id)).joiningDateChanges).toHaveLength(1);
  });

  it('never on the actor own record or outside row scope, and re-checks authority inside the transaction', async () => {
    const own = await create({ joiningDate: '2026-03-02' });
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: own.id });
    const res = await correct(self, own.id, { expectedVersion: own.version, joiningDate: '2026-03-03' });
    expect([res.statusCode, res.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);
    const outside = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await correct(outside, own.id, { expectedVersion: own.version, joiningDate: '2026-03-03' })).statusCode).toBe(404);

    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: temp.user, companyId: A.id, assignmentId: temp.assignment, resource: 'employee', action: 'update', fieldGroups: ['operational'] })) as AccessGrant;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    await expect(withTransaction(h.pool, (tx) => correctJoiningDate(tx, grant, own.id, { expectedVersion: own.version, joiningDate: '2026-03-03', reason: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await history(own.id)).joiningDate).toBe('2026-03-02');
  });

  it('two simultaneous corrections: one wins, one is stale', async () => {
    const e = await create({ joiningDate: '2026-03-02' });
    const results = await Promise.all(['2026-03-03', '2026-03-04'].map((joiningDate) => correct(hr, e.id, { expectedVersion: e.version, joiningDate })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await history(e.id)).joiningDateChanges).toHaveLength(1);
  });
});

describe('closing a draft who never joined (DF08, employee.deactivate)', () => {
  const close = (by: TestActor, id: string, expectedVersion: number) => h.call(by, 'POST', `/v1/employees/${id}/close-draft`, { expectedVersion, reason: 'Declined to join (synthetic)' });

  it('keeps the record as ARCHIVED, with history and audit', async () => {
    const e = await create();
    const res = await close(hr, e.id, e.version);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
    expect((await history(e.id)).statuses.at(-1)).toMatchObject({ status: 'ARCHIVED', priorStatus: 'DRAFT', sourceKind: 'DRAFT_CLOSED', effectiveDate: today, actorUserId: hr.user });
    expect(await h.one<{ reason: string }>(`select reason from audit_event where record_key = $1 and action = 'CLOSE_DRAFT'`, [e.id])).toEqual({ reason: 'Declined to join (synthetic)' });
    // A closed draft cannot be activated.
    const again = await h.call(hr, 'POST', `/v1/employees/${e.id}/activate`, { expectedVersion: res.json().version, noManagerReason: 'x' });
    expect(again.json().error).toBe('INVALID_STATE');
  });

  it('refuses a non-draft, a stale version, an open user link, the actor own record, and needs employee.deactivate', async () => {
    const active = await create();
    await h.setStatus(A, active.id, 'ACTIVE_PROBATION');
    const v = (await h.one<{ version: number }>(`select version from employee where id = $1`, [active.id])).version;
    expect((await close(hr, active.id, v)).json().error).toBe('INVALID_STATE');

    const e = await create();
    expect((await close(hr, e.id, 99)).json().error).toBe('STALE_VERSION');

    const reader = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    expect((await close(reader, e.id, e.version)).statusCode).toBe(403);

    const linkedRecord = await create();
    const linked = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: linkedRecord.id });
    const own = await close(linked, linkedRecord.id, linkedRecord.version);
    expect([own.statusCode, own.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);
    const openLink = await close(hr, linkedRecord.id, linkedRecord.version);
    expect([openLink.statusCode, openLink.json().error]).toEqual([409, 'USER_LINK_OPEN']);

    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: temp.user, companyId: A.id, assignmentId: temp.assignment, resource: 'employee', action: 'deactivate', fieldGroups: ['operational'] })) as AccessGrant;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    await expect(withTransaction(h.pool, (tx) => closeDraftEmployee(tx, grant, e.id, { expectedVersion: e.version, reason: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('racing a user link never leaves a closed draft with a live link', async () => {
    const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    for (let i = 0; i < 4; i++) {
      const e = await create();
      const accountKey = uniq('race.');
      await h.db.query(`insert into user_account (account_key, active) values ($1, true)`, [accountKey]);
      await Promise.all([close(hr, e.id, e.version), h.call(admin, 'POST', '/v1/access/user-links', { accountKey, employeeId: e.id, effectiveFrom: '2026-01-05' })]);
      const row = await h.one<{ status: string; links: number }>(
        `select st.code as status, (select count(*)::int from user_employee_link l where l.employee_id = e.id) as links
           from employee e join reference_value st on st.id = e.status_id where e.id = $1`,
        [e.id],
      );
      expect(row.status === 'ARCHIVED' && row.links > 0, JSON.stringify(row)).toBe(false);
    }
  });
});

describe('a new employment links to the prior one (DF04)', () => {
  it('links to an ended employment, both ways, and to only one successor', async () => {
    const prior = await create({ joiningDate: '2025-01-06' });
    await h.setStatus(A, prior.id, 'INACTIVE_SEPARATED');
    const rehire = await create({ joiningDate: '2026-02-02', priorEmployeeId: prior.id });
    expect((await history(rehire.id)).priorEmployment).toMatchObject({ employeeId: prior.id });
    expect((await history(prior.id)).nextEmployment).toMatchObject({ employeeId: rehire.id });

    const second = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { priorEmployeeId: prior.id }));
    expect([second.statusCode, second.json().error]).toEqual([409, 'DUPLICATE']);
    await expect(h.db.query(`update employee set prior_employee_id = null where id = $1`, [rehire.id])).rejects.toThrow(/set when the record is created/);
  });

  it('refuses an employment still running or another company, and a start before the prior one ended', async () => {
    const running = await create();
    await h.setStatus(A, running.id, 'ACTIVE_CONFIRMED');
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { priorEmployeeId: running.id }));
    expect([res.statusCode, res.json().error]).toEqual([422, 'PRIOR_EMPLOYMENT_NOT_ENDED']);

    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const across = await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B, { priorEmployeeId: running.id }));
    expect([across.statusCode, across.json().error]).toEqual([422, 'INVALID_REFERENCE']);

    // A closed draft never was an employment.
    const draft = await create();
    expect((await h.call(hr, 'POST', `/v1/employees/${draft.id}/close-draft`, { expectedVersion: draft.version, reason: 'Never joined (synthetic)' })).statusCode).toBe(200);
    const closed = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { priorEmployeeId: draft.id }));
    expect([closed.statusCode, closed.json().error]).toEqual([422, 'PRIOR_EMPLOYMENT_NOT_ENDED']);
  });
});
