// Shared synthetic fixture for tests that need a real pending approval task: an employee's leave request routed by the
// ordinary submission path. Dates are relative to today so the tests stay valid as time passes.
import { expect } from 'vitest';
import type { Company, Harness, TestActor } from '../../test/harness.js';

const addDays = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Monday on or after today + `days`. */
export const mondayAfter = (days: number) => {
  const d = new Date(`${addDays(new Date().toISOString().slice(0, 10), days)}T00:00:00Z`);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function leaveTasks(h: Harness, A: Company, hr: TestActor) {
  let nextMonday = 30;

  /** An active employee, optionally reporting to `managerId`. */
  async function employee(managerId?: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    if (managerId) await setManager(id, managerId);
    return id;
  }

  async function setManager(employeeId: string, managerEmployeeId: string, effectiveFrom = '2026-01-05') {
    const res = await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId, effectiveFrom });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function activatePolicies() {
    const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number; state: string }[];
    for (const p of policies.filter((x) => x.state === 'DRAFT')) {
      const res = await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
      expect(res.statusCode, res.body).toBe(200);
    }
  }

  /** The employee's own request for one working day, a week apart per call so requests never overlap. */
  async function submitLeave(self: TestActor): Promise<string> {
    nextMonday += 7;
    const start = mondayAfter(nextMonday);
    const res = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: start, endDate: start });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().requestId as string;
  }

  return { employee, setManager, activatePolicies, submitLeave };
}

export const leaveQueue = async (h: Harness, a: TestActor) => (await h.call(a, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; ownerEmployeeId: string; ownerName: string }[];
