// Module paths that act on "my task" without passing the decision check: a delegation that ended must stop them too (C1; ZT05),
// including for a company-scope delegate, whose own row scope still covers the employee. Synthetic data only: a fictitious
// bank, made-up account identifiers and goals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { appraisalWorld, enrol, openCycle, person, RATER, REVIEWER, selfAssess, taskOf } from '../appraisal/appraisal.fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { isModuleActive } from '../registry.js';

let h: Harness;
const DELEGATE: PermissionKey = 'access.delegate.operational';
const pdf = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`, 'latin1').toString('base64');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function delegation(admin: TestActor, from: TestActor, to: TestActor, permission: PermissionKey): Promise<string> {
  const asked = await h.call(from, 'POST', '/v1/access/delegations', { delegateUserId: to.user, permission, effectiveFrom: iso(-60_000), effectiveTo: iso(5 * 86_400_000) });
  expect(asked.statusCode, asked.body).toBe(201);
  const id = asked.json().id as string;
  const approved = await h.call(admin, 'POST', `/v1/access/delegations/${id}/approve`, { expectedVersion: 1 });
  expect(approved.statusCode, approved.body).toBe(200);
  return id;
}
const endIt = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'POST', `/v1/access/delegations/${id}/end`, { expectedVersion: 2, reason: 'Synthetic end' });
  expect(res.statusCode, res.body).toBe(200);
};

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('supporting evidence of a request (FR-106; employee/evidence.ts)', () => {
  it('the delegate reads it while the delegation is live, and not after, though their own scope still covers the employee', async () => {
    const A: Company = await h.makeCompany();
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id as string;
    const person_ = async (managerId?: string) => {
      const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
      if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
      return e.id as string;
    };
    const managerEmp = await person_();
    const employeeEmp = await person_(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp, extra: [DELEGATE] });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = await delegation(admin, manager, delegate, 'leave.approve.operational');

    const doc = (await h.call(employee, 'POST', `/v1/employees/${employeeEmp}/documents`, { documentType: 'GENERAL', fileName: 'order.pdf', contentBase64: pdf(`synthetic ${uniq('e')}`) })).json().id as string;
    const day = new Date(Date.now() + 21 * 86_400_000);
    while (day.getUTCDay() !== 2) day.setUTCDate(day.getUTCDate() + 1);
    const date = day.toISOString().slice(0, 10);
    const created = await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { purpose: 'Client site visit (synthetic)', startDate: date, endDate: date, evidenceDocumentIds: [doc] });
    expect(created.statusCode, created.body).toBe(201);
    const url = `/v1/work-requests/outdoor_duty/${created.json().requestId}/evidence/${doc}/content`;

    expect((await h.call(delegate, 'GET', url)).statusCode).toBe(200);
    await endIt(admin, id);
    expect((await h.call(delegate, 'GET', url)).statusCode).toBe(404);
    expect((await h.call(employee, 'GET', url)).statusCode).toBe(200);
  });
});

describe.runIf(isModuleActive('sensitive-change'))('a sensitive change under review (sensitive-change/service.ts)', () => {
  it('after the end the former delegate cannot start the review and sees the proposed account masked', async () => {
    const A: Company = await h.makeCompany();
    const REVIEW: PermissionKey[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'];
    const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REVIEW, DELEGATE] });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    expect((await h.call(reviewer, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] })).statusCode).toBe(200);
    const id = await delegation(admin, reviewer, delegate, 'sensitive_change.review.private');

    const e = (await h.call(reviewer, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const account = '000123456789';
    const submitBank = async () => {
      const doc = (await h.call(employee, 'POST', `/v1/employees/${e.id}/documents`, { documentType: 'GENERAL', fileName: 'bank-letter.pdf', contentBase64: pdf(`synthetic ${uniq('b')}`) })).json().id as string;
      expect((await h.call(reviewer, 'POST', `/v1/documents/${doc}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
      const created = await h.call(employee, 'POST', '/v1/me/sensitive-changes', {
        category: 'BANK',
        values: { holderName: 'Synthetic Person', accountIdentifier: account, routingReference: 'SYNT0000001', countryCode: 'IN' },
        reason: 'New synthetic account',
        evidenceDocumentIds: [doc],
      });
      expect(created.statusCode, created.body).toBe(201);
      const requestId = created.json().requestId as string;
      expect((await h.call(employee, 'POST', `/v1/me/sensitive-changes/${requestId}/submit`, { expectedVersion: 1 })).statusCode).toBe(200);
      return requestId;
    };
    const requestId = await submitBank();
    const task = ((await h.call(delegate, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } | null }[]).find((t) => t.request?.id === requestId)!;
    expect(task).toBeDefined();
    const history = () => h.call(delegate, 'GET', `/v1/employees/${e.id}/sensitive-changes`);
    expect((await history()).body).toContain(account);

    await endIt(admin, id);

    const refused = await h.call(delegate, 'POST', `/v1/sensitive-changes/tasks/${task.taskId}/start-review`);
    expect(refused.statusCode).toBe(409);
    expect((await h.one<{ state: string }>(`select state from employee_sensitive_change_request where id = $1`, [requestId])).state).toBe('SUBMITTED');
    const after = await history();
    expect(after.statusCode).toBe(200);
    expect(after.body).not.toContain(account);
    expect(((await h.call(delegate, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string }[]).map((t) => t.taskId)).not.toContain(task.taskId);
  });
});

describe.runIf(isModuleActive('appraisal'))('a manager rating in progress (appraisal/common.ts)', () => {
  it('the delegate saves a rating while the delegation is live, and not after', async () => {
    const A: Company = await h.makeCompany();
    const w = await appraisalWorld(h, A);
    const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, w.hr), extra: [...RATER, DELEGATE] });
    const managerEmp = (await h.one<{ employee_id: string }>(`select employee_id from user_employee_link where user_id = $1`, [manager.user])).employee_id;
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
    const id = await delegation(admin, manager, delegate, 'appraisal.rate.rating');

    const cycle = await openCycle(h, w);
    const employeeId = await person(h, A, w.hr, { managerId: managerEmp });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId });
    const created = await enrol(h, w.hr, cycle.id, employeeId);
    await selfAssess(h, employee, created.id, [4, 3, 5]);
    const task = (await taskOf(h, delegate, created.id))!;
    expect(task, 'the rating task reached the delegate').toBeDefined();
    const save = (expectedVersion: number) =>
      h.call(delegate, 'PUT', `/v1/appraisal-tasks/${task.taskId}/rating`, { entries: [{ goalId: task.appraisal!.goals[0]!.id, score: 3, comment: 'Synthetic note' }], expectedVersion });
    const saved = await save(task.appraisal!.version);
    expect(saved.statusCode, saved.body).toBe(200);

    await endIt(admin, id);
    const version = (await h.one<{ version: number }>(`select version from appraisal where id = $1`, [created.id])).version;
    const refused = await save(version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('TASK_CLOSED');
    expect((await h.one<{ version: number }>(`select version from appraisal where id = $1`, [created.id])).version).toBe(version);
    expect(await taskOf(h, delegate, created.id)).toBeUndefined();
  });
});
