// Synthetic timesheet fixtures for the module's API tests (not a test file): an HR administrator who keeps the
// masters, an independent HR reviewer on both fallback lists, a manager with two direct reports, an employee of
// another manager, one project with two jobs and two activities (one productive), and helpers over the real API.
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';
import { addDays, mondayOf } from './common.js';

export interface TimesheetWorld {
  hr: TestActor;
  hrReviewer: TestActor;
  manager: TestActor;
  employee: TestActor;
  peer: TestActor;
  managerEmp: string;
  employeeEmp: string;
  employeeCode: string;
  peerEmp: string;
  outsiderEmp: string;
  projectId: string;
  jobId: string;
  job2Id: string;
  devId: string;
  meetId: string;
  today: string;
  thisMonday: string;
  lastMonday: string;
}

export const FAR_END = '2030-12-31';

export async function person(h: Harness, A: Company, hr: TestActor, managerId?: string): Promise<{ id: string; code: string }> {
  const created = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  expect(created.statusCode, created.body).toBe(201);
  const e = created.json() as { id: string; employeeCode: string };
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  if (managerId) {
    const m = await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBe(200);
  }
  return { id: e.id, code: e.employeeCode };
}

export async function timesheetWorld(h: Harness, A: Company): Promise<TimesheetWorld> {
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const hrReviewer = await h.actor(A, 'HR_ADMINISTRATOR');
  const managerEmp = (await person(h, A, hr)).id;
  const emp = await person(h, A, hr, managerEmp);
  const peerEmp = (await person(h, A, hr, managerEmp)).id;
  const otherManagerEmp = (await person(h, A, hr)).id;
  const outsiderEmp = (await person(h, A, hr, otherManagerEmp)).id;
  const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  const employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp.id });
  const peer = await h.actor(A, 'EMPLOYEE', { employeeId: peerEmp });
  for (const kind of ['timesheet', 'timesheet_reopen']) {
    const listed = await h.call(hr, 'PUT', `/v1/workflows/${kind}/fallback-reviewers`, { reviewers: [{ userId: hrReviewer.user, priority: 1 }] });
    expect(listed.statusCode, listed.body).toBe(200);
  }
  const master = async (path: string, body: Record<string, unknown>) => {
    const res = await h.call(hr, 'POST', path, { ownerEmployeeId: managerEmp, startDate: '2026-01-01', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const projectId = await master('/v1/timesheet/projects', { code: uniq('PRJ'), name: 'Synthetic platform project' });
  const jobId = await master(`/v1/timesheet/projects/${projectId}/jobs`, { code: 'BUILD', name: 'Build work' });
  const job2Id = await master(`/v1/timesheet/projects/${projectId}/jobs`, { code: 'SUPPORT', name: 'Support work' });
  const devId = await master('/v1/timesheet/activities', { code: uniq('DEV'), name: 'Development', productive: true });
  const meetId = await master('/v1/timesheet/activities', { code: uniq('MEET'), name: 'Internal meeting', productive: false });
  for (const j of [jobId, job2Id]) {
    for (const a of [devId, meetId]) {
      const linked = await h.call(hr, 'PUT', `/v1/timesheet/jobs/${j}/activities/${a}`, { active: true });
      expect(linked.statusCode, linked.body).toBe(200);
    }
  }
  const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  const thisMonday = mondayOf(today);
  return {
    hr,
    hrReviewer,
    manager,
    employee,
    peer,
    managerEmp,
    employeeEmp: emp.id,
    employeeCode: emp.code,
    peerEmp,
    outsiderEmp,
    projectId,
    jobId,
    job2Id,
    devId,
    meetId,
    today,
    thisMonday,
    lastMonday: addDays(thisMonday, -7),
  };
}

export async function allocate(h: Harness, a: TestActor, body: Record<string, unknown>) {
  return h.call(a, 'POST', '/v1/timesheet/allocations', { startDate: '2026-01-05', endDate: FAR_END, allocationPercent: '100', ...body });
}

export async function openWeek(h: Harness, a: TestActor, periodStart: string): Promise<{ id: string; version: number }> {
  const res = await h.call(a, 'POST', '/v1/me/timesheets', { periodStart });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number };
}

export async function addLine(h: Harness, a: TestActor, timesheetId: string, body: Record<string, unknown>) {
  return h.call(a, 'POST', `/v1/me/timesheets/${timesheetId}/lines`, body);
}

export async function sheet(h: Harness, a: TestActor, timesheetId: string, revision?: number) {
  return (await h.call(a, 'GET', `/v1/timesheets/${timesheetId}${revision ? `?revision=${revision}` : ''}`)).json() as {
    state: string;
    version: number;
    currentRevision: number;
    approvedRevision: number | null;
    late: boolean | null;
    lines: { id: string; workDate: string; minutes: number; source: string; version: number; activityId: string; jobId: string; productive: boolean }[];
    revisions: { revision: number; state: string; origin: string; decisionReason: string | null; supersededByRevision: number | null; late: boolean | null; totalMinutes: number }[];
    totalMinutes: number;
    dailyTotals: { workDate: string; minutes: number; hours: string }[];
    pendingWith: string | null;
    decisions: { revision: number; decision: string }[];
  };
}

export async function submit(h: Harness, a: TestActor, timesheetId: string) {
  const { version } = await sheet(h, a, timesheetId);
  return h.call(a, 'POST', `/v1/me/timesheets/${timesheetId}/submit`, { expectedVersion: version });
}

export async function taskFor(h: Harness, reviewer: TestActor, timesheetId: string): Promise<string | undefined> {
  const items = (await h.call(reviewer, 'GET', '/v1/timesheet-tasks')).json().items as { taskId: string; timesheet: { id: string } | null }[];
  return items.find((t) => t.timesheet?.id === timesheetId)?.taskId;
}

export async function decide(h: Harness, reviewer: TestActor, taskId: string, decision: 'APPROVE' | 'RETURN' | 'REJECT', extra: Record<string, unknown> = {}) {
  return h.call(reviewer, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, {
    decision,
    idempotencyKey: uniq('ts-key-'),
    ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic review note' }),
    ...extra,
  });
}

/** A week entered, submitted and approved by the direct manager through the real route. */
export async function approvedWeek(h: Harness, w: TimesheetWorld, employee: TestActor, periodStart: string, lines: Record<string, unknown>[]) {
  const ts = await openWeek(h, employee, periodStart);
  for (const l of lines) {
    const added = await addLine(h, employee, ts.id, l);
    expect(added.statusCode, added.body).toBe(201);
  }
  const submitted = await submit(h, employee, ts.id);
  expect(submitted.statusCode, submitted.body).toBe(200);
  const taskId = await taskFor(h, w.manager, ts.id);
  expect(taskId).toBeDefined();
  const decided = await decide(h, w.manager, taskId!, 'APPROVE');
  expect(decided.statusCode, decided.body).toBe(200);
  expect(decided.json().state).toBe('APPROVED');
  return ts.id;
}

export const csv = (rows: string[]) => Buffer.from(`${rows.join('\n')}\n`).toString('base64');
