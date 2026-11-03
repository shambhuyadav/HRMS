// Shift-plan imports over HTTP (FR-023; DF09; C4). Synthetic CSV; all-or-nothing batches bound to the submitter, who
// lists their own and resumes one held for the malware scan (FR-106).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { approvedExit } from '../payroll/payroll.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let day: string;
const people: Record<string, { id: string; code: string }> = {};

const csv = (...rows: string[]) => ['employeeCode,shiftCode,effectiveFrom', ...rows].join('\r\n');
const upload = (a: TestActor, file: string, key = uniq('shift-plan-')) =>
  h.call(a, 'POST', '/v1/shifts/plan-imports', { fileName: 'plan.csv', contentBase64: Buffer.from(file).toString('base64'), idempotencyKey: key });
const shiftOf = async (employeeId: string, on: string) =>
  (
    await h.db.query<{ code: string }>(
      `select s.code from shift_assignment a join shift s on s.company_id = a.company_id and s.id = a.shift_id
        where a.employee_id = $1 and a.effective_from <= $2::date and (a.effective_to is null or a.effective_to > $2::date)`,
      [employeeId, on],
    )
  ).rows[0]?.code;
type Job = { id: string; state: string; template: string; acceptedCount: number; rejectedCount: number; rows: { rowNumber: number; state: string; errorCode: string | null }[] };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  day = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [] })).json().id;
  await h.call(hr, 'POST', '/v1/shifts', { code: 'NIGHT', name: 'Night', inTime: '22:00', outTime: '06:00', breaks: [] });
  for (const key of ['one', 'two', 'gone', 'fin']) {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, key === 'fin' ? { departmentId: A.financeDept } : {}))).json();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: day, effectiveFrom: '2026-01-05' });
    people[key] = { id: e.id, code: e.employeeCode };
  }
  await h.setStatus(A, people.gone!.id, 'INACTIVE_SEPARATED');
});

afterAll(async () => {
  await h?.stop();
});

describe('shift-plan import (FR-023, DF09)', () => {
  it('rejects a row after the approved last working date of an employee on notice; up to that date is fine', async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: day, effectiveFrom: '2026-01-05' });
    await approvedExit(h, A, e.id, '2026-08-01', '2026-08-31');
    await h.setStatus(A, e.id, 'NOTICE');
    const after = (await upload(hr, csv(`${e.employeeCode},NIGHT,2026-09-01`))).json() as Job;
    expect(after.state).toBe('REJECTED');
    expect(after.rows.map((r) => r.errorCode)).toEqual(['AFTER_LAST_WORKING_DATE']);
    const onTheDate = (await upload(hr, csv(`${e.employeeCode},NIGHT,2026-08-31`))).json() as Job;
    expect(onTheDate.rows.map((r) => r.errorCode)).toEqual([null]);
    expect(onTheDate.state).toBe('PREVIEWED');
  });

  it('previews without changing anything, then commits every row through the ordinary shift change', async () => {
    const res = await upload(hr, csv(`${people.one!.code},NIGHT,2026-02-02`, `${people.two!.code},night,2026-02-02`));
    expect(res.statusCode).toBe(201);
    const job = res.json() as Job;
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'SHIFT_PLAN_V1' });
    expect(job.rows.map((r) => r.state)).toEqual(['VALID', 'VALID']);
    expect(await shiftOf(people.one!.id, '2026-02-10')).toBe('DAY');

    const done = (await h.call(hr, 'POST', `/v1/shifts/plan-imports/${job.id}/commit`)).json() as Job;
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    expect(await shiftOf(people.one!.id, '2026-02-10')).toBe('NIGHT');
    expect(await shiftOf(people.one!.id, '2026-01-20')).toBe('DAY'); // history kept
    expect((await h.call(hr, 'POST', `/v1/shifts/plan-imports/${job.id}/commit`)).json().state).toBe('COMMITTED'); // idempotent
  });

  it('rejects the whole batch when any row is invalid, with row-level codes', async () => {
    const before = await shiftOf(people.two!.id, '2026-06-10');
    const job = (
      await upload(
        hr,
        csv(
          `${people.one!.code},DAY,2025-12-01`,
          `${people.gone!.code},DAY,2026-06-01`,
          `NOBODY,DAY,2026-06-01`,
          `${people.two!.code},EVENING,2026-06-01`,
          `${people.two!.code},DAY,2026-02-30`,
          `${people.two!.code},DAY,2026-06-01,extra`,
          `${people.two!.code},DAY,2026-06-01`,
        ),
      )
    ).json() as Job;
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual(['BEFORE_JOINING', 'EMPLOYMENT_ENDED', 'UNKNOWN_EMPLOYEE', 'UNKNOWN_SHIFT', 'INVALID_DATE', 'COLUMN_COUNT', 'BATCH_REJECTED']);
    expect(job.rows.every((r) => r.state === 'REJECTED')).toBe(true);
    expect(job.rejectedCount).toBe(7);
    expect((await h.call(hr, 'POST', `/v1/shifts/plan-imports/${job.id}/commit`)).statusCode).toBe(409);
    expect(await shiftOf(people.two!.id, '2026-06-10')).toBe(before);
  });

  it('a row that becomes invalid before commit rejects the batch and applies nothing', async () => {
    const job = (await upload(hr, csv(`${people.one!.code},DAY,2026-04-01`, `${people.two!.code},NIGHT,2026-04-01`))).json() as Job;
    expect(job.state).toBe('PREVIEWED');
    // Someone records a later change for the first employee meanwhile.
    expect((await h.call(hr, 'POST', `/v1/employees/${people.one!.id}/shift`, { shiftId: day, effectiveFrom: '2026-05-01' })).statusCode).toBe(200);
    const done = (await h.call(hr, 'POST', `/v1/shifts/plan-imports/${job.id}/commit`)).json() as Job;
    expect(done.state).toBe('REJECTED');
    expect(done.rows.map((r) => r.errorCode)).toEqual(['CHANGE_NOT_LATEST', 'BATCH_REJECTED']);
    expect(await shiftOf(people.two!.id, '2026-04-10')).toBe('NIGHT'); // still the February import, nothing new applied
    const assignments = await h.one<{ n: string }>(`select count(*) as n from shift_assignment where employee_id = $1 and effective_from = '2026-04-01'`, [people.two!.id]);
    expect(Number(assignments.n)).toBe(0);
  });

  it('jobs belong to their submitter; scope applies per row; employees cannot import', async () => {
    const key = uniq('shift-plan-');
    const job = (await upload(hr, csv(`${people.two!.code},DAY,2026-07-01`), key)).json() as Job;
    expect((await h.call(hr2, 'GET', `/v1/shifts/plan-imports/${job.id}`)).statusCode).toBe(404);
    expect((await h.call(hr2, 'POST', `/v1/shifts/plan-imports/${job.id}/commit`)).statusCode).toBe(404);
    expect((await h.call(hr2, 'POST', `/v1/shifts/plan-imports/${job.id}/cancel`)).statusCode).toBe(404);
    expect((await upload(hr2, csv(`${people.two!.code},NIGHT,2026-07-01`), key)).json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect((await upload(hr, csv(`${people.two!.code},DAY,2026-07-01`), key)).json().id).toBe(job.id); // same submitter: same job
    expect((await h.call(hr, 'POST', `/v1/shifts/plan-imports/${job.id}/cancel`)).json().state).toBe('CANCELLED');

    const finHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const scoped = (await upload(finHr, csv(`${people.fin!.code},NIGHT,2026-07-01`, `${people.two!.code},NIGHT,2026-07-01`))).json() as Job;
    expect(scoped.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'OUT_OF_SCOPE']);

    const self = await h.actor(A, 'EMPLOYEE', { employeeId: people.two!.id });
    expect((await upload(self, csv(`${people.two!.code},NIGHT,2026-07-01`))).statusCode).toBe(403);
    expect((await upload(hr, 'employeeCode,shift,effectiveFrom\r\nX,DAY,2026-07-01')).json().error).toBe('INVALID_HEADER');
  });
});

followUpSuite({
  path: '/v1/shifts/plan-imports',
  template: 'SHIFT_PLAN_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
  denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
  // A new employee on the day shift each time, moved to the night shift (nothing is committed).
  validFile: async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: day, effectiveFrom: '2026-01-05' });
    return { text: csv(`${e.employeeCode},NIGHT,2026-02-02`), rows: 1 };
  },
});
