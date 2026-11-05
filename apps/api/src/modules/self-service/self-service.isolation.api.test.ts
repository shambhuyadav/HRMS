// ZT01 / ZT39 for self-service: another company's profile changes and attendance corrections, their tasks and histories, by direct
// identifier. Synthetic data only; fixed past dates.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const TUE = '2026-03-03';

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const reviewer = await h.actor(company, 'HR_ADMINISTRATOR');
  expect((await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] })).statusCode).toBe(200);
  const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [] })).json().id as string;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
    await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: shift, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
    if (managerId) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return e;
  };
  const boss = await person();
  const manager = await h.actor(company, 'REPORTING_MANAGER', { employeeId: boss.id });
  const claimant = await person(boss.id);
  const other = await person(boss.id);
  const self = await h.actor(company, 'EMPLOYEE', { employeeId: claimant.id });
  const self2 = await h.actor(company, 'EMPLOYEE', { employeeId: other.id });
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });

  const recordOf = async (employeeId: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${TUE}&to=${TUE}`)).json().items[0].id as string;
  const change = async (a: typeof self) => {
    const res = await h.call(a, 'POST', '/v1/me/profile-changes', { displayName: `Renamed ${uniq('R')} (synthetic)` });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().requestId as string;
  };
  const correction = async (a: typeof self, attendanceRecordId: string) => {
    const res = await h.call(a, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId, status: 'PRESENT', reason: `Correction ${uniq('zq')} (synthetic)` });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().requestId as string;
  };
  const decideChange = await change(self);
  const withdrawChange = await change(self2);
  const decideCorrection = await correction(self, await recordOf(claimant.id));
  const withdrawCorrection = await correction(self2, await recordOf(other.id));
  const taskOf = async (a: typeof self, path: string, id: string) => {
    const items = (await h.call(a, 'GET', `/v1/${path}/tasks/mine`)).json().items as { taskId: string; transactionId: string; request?: { id?: string } }[];
    return items.find((t) => t.request?.id === id)!.taskId;
  };
  return {
    company,
    actors: { hr, reviewer, manager, self, self2 },
    ids: {
      claimant: claimant.id,
      code: claimant.employeeCode,
      decideChange,
      withdrawChange,
      decideCorrection,
      withdrawCorrection,
      recordOfOther: await recordOf(other.id),
      changeTask: await taskOf(reviewer, 'profile-changes', decideChange),
      correctionTask: await taskOf(manager, 'attendance-corrections', decideCorrection),
    },
    versions: {},
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign employee’s profile changes', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.claimant}/profile-changes` },
  { name: 'GET a foreign employee’s attendance corrections', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.claimant}/attendance-corrections` },
  { name: 'POST the withdrawal of a foreign profile change', as: 'self2', method: 'POST', path: (w) => `/v1/profile-changes/${w.ids.withdrawChange}/withdraw` },
  { name: 'POST the withdrawal of a foreign correction', as: 'self2', method: 'POST', path: (w) => `/v1/attendance-corrections/${w.ids.withdrawCorrection}/withdraw` },
  { name: 'POST a decision on a foreign profile change task', as: 'reviewer', method: 'POST', path: (w) => `/v1/profile-changes/tasks/${w.ids.changeTask}/decision`, body: () => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-ss-') }) },
  { name: 'POST a decision on a foreign correction task', as: 'manager', method: 'POST', path: (w) => `/v1/attendance-corrections/tasks/${w.ids.correctionTask}/decision`, body: () => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-ss-') }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('self-service across companies (ZT01; ZT39)', () => {
  // The lists run first: the table below decides the home company's tasks as its positive control.
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /profile-changes/tasks/mine holds only the company’s own', as: 'reviewer', path: '/v1/profile-changes/tasks/mine', holds: (w) => [w.ids.changeTask], never: (w) => [w.ids.changeTask, w.ids.code] },
    { name: 'GET /attendance-corrections/tasks/mine holds only the company’s own', as: 'manager', path: '/v1/attendance-corrections/tasks/mine', holds: (w) => [w.ids.correctionTask], never: (w) => [w.ids.correctionTask, w.ids.code] },
  ]);
  itRefusesForeignRecords(ctx, [
    ...PROBES,
    {
      name: 'POST a correction of a foreign attendance record',
      as: 'self2',
      method: 'POST',
      path: () => '/v1/me/attendance-corrections',
      body: (w) => ({ attendanceRecordId: w.ids.recordOfOther, status: 'PRESENT', reason: 'Isolation check (synthetic)' }),
      // Its own record is no longer open to correct only if a correction is still pending: it was withdrawn above, so this goes through.
      control: 201,
    },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES.filter((p) => p.as === 'hr'));
});
