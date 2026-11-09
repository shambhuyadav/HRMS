// ZT11: simultaneous decisions on one self-service request (a profile change, an attendance correction) end in one result, one master
// or attendance change, one decision, and one withdrawal or decision between the two. Synthetic data; a past Tuesday for attendance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { footprintOf, raceOnTransaction, statusesOf, withoutRecipients } from '../../test/race.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let managerEmp: string;
let shiftId: string;
const TUE = '2026-03-03';
/** Attendance is processed once for the company, so the people who need a record exist by then. */
const withAttendance: { emp: string; name: string; actor: TestActor }[] = [];

const decide = (a: TestActor, path: string, taskId: string, decision: string, key = uniq('ss-key-')) =>
  h.call(a, 'POST', `/v1/${path}/tasks/${taskId}/decision`, { decision, idempotencyKey: key, ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic decision' }) });
const person = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  return { emp: e.id as string, name: e.displayName as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
};
type Person = Awaited<ReturnType<typeof person>>;
const taskOfRequest = async (a: TestActor, path: string, tx: string) => ((await h.call(a, 'GET', `/v1/${path}/tasks/mine`)).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
const footprint = async (tx: string, id: string) => withoutRecipients(await footprintOf(h, A.id, tx, id));

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, m.id, 'ACTIVE_CONFIRMED');
  managerEmp = m.id;
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  expect((await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version });
  for (let i = 0; i < 3; i++) withAttendance.push(await person());
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
});

afterAll(async () => {
  await h?.stop();
});

describe('a profile change', () => {
  const PATH = 'profile-changes';
  const requested = async (p: Person) => {
    const newName = `Renamed ${uniq('P')} (synthetic)`;
    const res = await h.call(p.actor, 'POST', '/v1/me/profile-changes', { displayName: newName });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().requestId as string;
    const tx = (await h.one<{ t: string }>(`select transaction_id as t from profile_change_request where id = $1`, [id])).t;
    return { id, tx, newName, taskId: await taskOfRequest(hr, PATH, tx) };
  };
  const displayName = async (emp: string) => (await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [emp])).n;
  const updates = async (emp: string) => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'employee' and record_key = $1 and action = 'UPDATE'`, [emp])).n;

  it('approval queued first: the master changes once, and the rejection finds the task closed', async () => {
    const aloneP = await person();
    const alone = await requested(aloneP);
    expect((await decide(hr, PATH, alone.taskId, 'APPROVE')).json().state).toBe('APPROVED');

    const p = await person();
    const r = await requested(p);
    const before = await updates(p.emp);
    const [approve, reject] = await raceOnTransaction(h, r.tx, [() => decide(hr, PATH, r.taskId, 'APPROVE'), () => decide(hr, PATH, r.taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect(await displayName(p.emp)).toBe(r.newName);
    expect((await updates(p.emp)) - before).toBe(1);
    expect(await footprint(r.tx, r.id)).toEqual(await footprint(alone.tx, alone.id));
  });

  it('rejection queued first: the master is untouched', async () => {
    const p = await person();
    const r = await requested(p);
    const [reject, approve] = await raceOnTransaction(h, r.tx, [() => decide(hr, PATH, r.taskId, 'REJECT'), () => decide(hr, PATH, r.taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await displayName(p.emp)).toBe(p.name);
  });

  it('a decision and a withdrawal: withdrawal queued first leaves the master untouched', async () => {
    const p = await person();
    const r = await requested(p);
    const [out, approve] = await raceOnTransaction(h, r.tx, [() => h.call(p.actor, 'POST', `/v1/${PATH}/${r.id}/withdraw`), () => decide(hr, PATH, r.taskId, 'APPROVE')]);
    expect(out!.statusCode, out!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await displayName(p.emp)).toBe(p.name);
    expect((await footprint(r.tx, r.id)).decisions).toBe(0);
  });

  it('a decision and a withdrawal: approval queued first stands', async () => {
    const p = await person();
    const r = await requested(p);
    const [approve, out] = await raceOnTransaction(h, r.tx, [() => decide(hr, PATH, r.taskId, 'APPROVE'), () => h.call(p.actor, 'POST', `/v1/${PATH}/${r.id}/withdraw`)]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(out!.statusCode).toBe(409);
    expect(await displayName(p.emp)).toBe(r.newName);
  });

  it('with no lock held, however the two interleave: one result', async () => {
    for (let round = 0; round < 3; round++) {
      const p = await person();
      const r = await requested(p);
      const results = await Promise.all([decide(hr, PATH, r.taskId, 'APPROVE'), decide(hr, PATH, r.taskId, 'REJECT')]);
      expect(statusesOf(results), results.map((x) => x.body).join(' ')).toEqual([200, 409]);
      expect(await displayName(p.emp)).toBe(results[0]!.statusCode === 200 ? r.newName : p.name);
    }
  });
});

describe('an attendance correction', () => {
  const PATH = 'attendance-corrections';
  const recordOf = async (p: Person) => (await h.call(p.actor, 'GET', `/v1/employees/${p.emp}/attendance?from=${TUE}&to=${TUE}`)).json().items[0] as { id: string; status: string };
  const requested = async (p: Person) => {
    const record = await recordOf(p);
    expect(record.status).toBe('ABSENT');
    const res = await h.call(p.actor, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'PRESENT', reason: 'Badge reader fault (synthetic)' });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().requestId as string;
    const tx = (await h.one<{ t: string }>(`select transaction_id as t from attendance_correction_request where id = $1`, [id])).t;
    return { id, tx, recordId: record.id, taskId: await taskOfRequest(manager, PATH, tx) };
  };
  const amendments = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from attendance_amendment where attendance_record_id = $1`, [id])).n;

  it('approval queued first: corrected once, one amendment, and the rejection finds the task closed', async () => {
    const p = withAttendance[0]!;
    const r = await requested(p);
    const before = await amendments(r.recordId);
    const [approve, reject] = await raceOnTransaction(h, r.tx, [() => decide(manager, PATH, r.taskId, 'APPROVE'), () => decide(manager, PATH, r.taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect((await recordOf(p)).status).toBe('PRESENT');
    expect((await amendments(r.recordId)) - before).toBe(1);
    expect((await footprint(r.tx, r.id)).decisions).toBe(1);
  });

  it('rejection queued first: the record is as it was', async () => {
    const p = withAttendance[1]!;
    const r = await requested(p);
    const before = await amendments(r.recordId);
    const [reject, approve] = await raceOnTransaction(h, r.tx, [() => decide(manager, PATH, r.taskId, 'REJECT'), () => decide(manager, PATH, r.taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect((await recordOf(p)).status).toBe('ABSENT');
    expect((await amendments(r.recordId)) - before).toBe(0);
  });

  it('a decision and a withdrawal: withdrawal queued first leaves the record as it was', async () => {
    const p = withAttendance[2]!;
    const r = await requested(p);
    const [out, approve] = await raceOnTransaction(h, r.tx, [() => h.call(p.actor, 'POST', `/v1/${PATH}/${r.id}/withdraw`), () => decide(manager, PATH, r.taskId, 'APPROVE')]);
    expect(out!.statusCode, out!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect((await recordOf(p)).status).toBe('ABSENT');
  });
});
