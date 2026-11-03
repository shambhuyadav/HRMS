// Synthetic hiring fixtures for the module's API tests (not a test file): a requester with a direct manager, HR
// reviewers on the requisition route and approved requisitions reached through the real F1 route.
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

export interface HiringWorld {
  hr: TestActor;
  hrApprover: TestActor;
  requester: TestActor;
  manager: TestActor;
  requesterEmp: string;
  today: string;
}

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function hiringWorld(h: Harness, A: Company, hrExtra: PermissionKey[] = []): Promise<HiringWorld> {
  const hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: hrExtra });
  const hrApprover = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    if (managerId) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return e.id as string;
  };
  const managerEmp = await person();
  const requesterEmp = await person(managerEmp);
  const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  const requester = await h.actor(A, 'REPORTING_MANAGER', { employeeId: requesterEmp });
  const listed = await h.call(hr, 'PUT', '/v1/workflows/requisition/fallback-reviewers', { reviewers: [{ userId: hrApprover.user, priority: 1 }] });
  expect(listed.statusCode, listed.body).toBe(200);
  const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  return { hr, hrApprover, requester, manager, requesterEmp, today };
}

/** A requisition taken through the F1 route (no budget line: an exception the HR approver approves explicitly). */
export async function approvedRequisition(h: Harness, A: Company, w: HiringWorld, overrides: Record<string, unknown> = {}) {
  const created = await h.call(w.requester, 'POST', '/v1/hiring/requisitions', {
    title: 'Synthetic fixture role',
    departmentId: A.dept,
    locationId: A.loc,
    designationId: A.desig,
    employmentType: 'PERMANENT',
    vacancies: 1,
    reasonType: 'NEW',
    reason: 'Synthetic fixture',
    targetDate: addDays(w.today, 45),
    hiringManagerId: w.requesterEmp,
    budgetExceptionReason: 'Synthetic fixture without a budget line',
    ...overrides,
  });
  expect(created.statusCode, created.body).toBe(201);
  const r = created.json() as { id: string; code: string; version: number };
  expect((await h.call(w.requester, 'POST', `/v1/hiring/requisitions/${r.id}/submit`, { expectedVersion: r.version })).json().state).toBe('SUBMITTED');
  const task = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/hiring/requisition-tasks')).json().items as { taskId: string; requisition: { id: string } | null }[]).find((t) => t.requisition?.id === r.id)!;
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/hiring/requisition-tasks/${taskId}/decision`, { idempotencyKey: uniq('fixture-key-'), ...body });
  expect((await decide(w.manager, (await task(w.manager)).taskId, { decision: 'APPROVE' })).json().pendingStep).toBe(2);
  expect((await decide(w.hrApprover, (await task(w.hrApprover)).taskId, { decision: 'APPROVE', approveBudgetException: true })).json().state).toBe('APPROVED');
  return r;
}

/** A synthetic PDF; uploads are scanned on arrival, and the development scanner releases it (FR-106). */
export const PDF = Buffer.from('%PDF-1.4\n% synthetic curriculum vitae\n%%EOF\n');
