// Test fixtures of the training module (synthetic data only: example.test addresses, obviously fake names and codes).
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function businessDate(h: Harness, company: Company): Promise<string> {
  return (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [company.id])).d;
}

/** An active employee created through the API by an HR actor, optionally in a department and reporting to a manager. */
export async function person(h: Harness, company: Company, hr: TestActor, opts: { name?: string; departmentId?: string; status?: string; managerId?: string } = {}): Promise<string> {
  const res = await h.call(
    hr,
    'POST',
    '/v1/employees',
    h.newEmployeeBody(company, { displayName: opts.name ?? 'Synthetic Person', ...(opts.departmentId ? { departmentId: opts.departmentId } : {}) }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(company, id, opts.status ?? 'ACTIVE_CONFIRMED');
  if (opts.managerId) {
    const m = await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: opts.managerId, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
  }
  return id;
}

export interface Plan {
  id: string;
  code: string;
  version: number;
  view: string;
  state: string;
  [key: string]: unknown;
}

/** Creates a plan (synthetic title and trainer); the dates default to a future session. */
export async function newPlan(h: Harness, a: TestActor, body: Record<string, unknown>): Promise<Plan> {
  const res = await h.call(a, 'POST', '/v1/training-plans', {
    code: uniq('TRN-'),
    title: 'Synthetic safety induction',
    modeCode: 'IN_PERSON',
    venue: 'Room 1 (synthetic)',
    trainer: 'Tess Trainer (synthetic)',
    capacity: 10,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Plan;
}

export const nominate = (h: Harness, a: TestActor, planId: string, employeeIds: string[]) => h.call(a, 'POST', `/v1/training-plans/${planId}/participants`, { employeeIds });

/** Nominates employees and returns their participant ids in the given order. */
export async function nominated(h: Harness, a: TestActor, planId: string, employeeIds: string[]): Promise<string[]> {
  const res = await nominate(h, a, planId, employeeIds);
  expect(res.statusCode, res.body).toBe(201);
  const items = res.json().items as { id: string; employeeId: string }[];
  return employeeIds.map((e) => items.find((i) => i.employeeId === e)!.id);
}

export const act = (h: Harness, a: TestActor, planId: string, action: string, participantIds: string[], reason?: string) =>
  h.call(a, 'POST', `/v1/training-plans/${planId}/participant-actions`, { action, participantIds, ...(reason ? { reason } : {}) });

/** Applies actions in order and expects each to succeed. */
export async function advance(h: Harness, a: TestActor, planId: string, participantIds: string[], actions: string[]): Promise<void> {
  for (const action of actions) {
    const res = await act(h, a, planId, action, participantIds);
    expect(res.statusCode, `${action}: ${res.body}`).toBe(200);
  }
}

export const inbox = async (h: Harness, a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
