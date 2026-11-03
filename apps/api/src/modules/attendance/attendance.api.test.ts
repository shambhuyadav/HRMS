// Attendance over HTTP: import, daily processing with calendar/leave precedence, rerun determinism,
// amendment trail and scope (FR-019/020/021/022; DF05; DF09; ZT07/ZT16).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let shiftId: string;

// Fixed past dates (2026-03-02 is a Monday). Asia/Kolkata is UTC+05:30.
const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const SAT = '2026-03-07';
const local = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;

async function activeEmployee(): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
  return { id: e.id, code: e.employeeCode };
}

const punch = (employeeCode: string, d: string, hhmm: string, direction: 'IN' | 'OUT', key = uniq('evt-')) => ({
  employeeCode,
  occurredAt: local(d, hhmm),
  direction,
  externalEventKey: key,
});
const importPunches = (punches: object[]) => h.call(hr, 'POST', '/v1/attendance/punches', { punches });
// NFR-S09: processing is a queued bulk job; this enqueues it, runs the worker step and returns the job's result.
const processDay = async (workDate: string) => (await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).result;
const recordOn = async (actor: TestActor, employee: string, d: string) =>
  (await h.call(actor, 'GET', `/v1/employees/${employee}/attendance?from=${d}&to=${d}`)).json().items[0];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  shiftId = (
    await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })
  ).json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe('policy activation and processing (FR-020, FR-022)', () => {
  it('reports employees without an active policy instead of guessing', async () => {
    const e = await activeEmployee();
    const job = await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: MON });
    expect(job.result.NO_POLICY).toBeGreaterThan(0);
    // The result holds counts; the employees are the job's rows, read page by page (0058).
    expect(job.result).not.toHaveProperty('noPolicyEmployeeIds');
    const listed = (await h.call(hr, 'GET', `/v1/attendance/processing/${job.id}/no-policy-employees`)).json();
    expect(listed.items).toHaveLength(job.result.NO_POLICY);
    expect(listed.items).toContainEqual({ employeeId: e.id, employeeCode: e.code, employeeName: 'Synthetic Person' });
    const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
    expect(policy).toMatchObject({ code: 'DEFAULT', graceMinutes: 10, presentPercent: '75.00', halfDayPercent: '50.00', state: 'DRAFT' });
    expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  });

  it('evaluates present, late, half day, missing punch, weekly off and approved leave; reruns are stable', async () => {
    const present = await activeEmployee();
    const late = await activeEmployee();
    const half = await activeEmployee();
    const missing = await activeEmployee();
    const absent = await activeEmployee();

    const res = await importPunches([
      punch(present.code, MON, '09:00', 'IN'),
      punch(present.code, MON, '18:00', 'OUT'),
      punch(late.code, MON, '09:11', 'IN'),
      punch(late.code, MON, '18:00', 'OUT'),
      punch(half.code, MON, '14:00', 'IN'),
      punch(half.code, MON, '18:00', 'OUT'),
      punch(missing.code, MON, '09:00', 'IN'),
    ]);
    expect(res.json()).toMatchObject({ received: 7, accepted: 7, duplicates: 0, rejected: [] });

    const run = await processDay(MON);
    expect(run.CREATED).toBeGreaterThanOrEqual(5);
    expect(await recordOn(hr, present.id, MON)).toMatchObject({ status: 'PRESENT', workedMinutes: 480, late: false, policyCode: 'DEFAULT', shiftCode: 'DAY' });
    expect(await recordOn(hr, late.id, MON)).toMatchObject({ status: 'PRESENT', late: true });
    expect(await recordOn(hr, half.id, MON)).toMatchObject({ status: 'HALF_DAY', workedMinutes: 240 });
    expect(await recordOn(hr, missing.id, MON)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
    expect(await recordOn(hr, absent.id, MON)).toMatchObject({ status: 'ABSENT', workedMinutes: 0 });

    const rerun = await processDay(MON);
    expect(rerun.CREATED + rerun.UPDATED).toBe(0);
    expect((await recordOn(hr, present.id, MON)).calculationCount).toBe(1);

    // A late correction punch changes the result on rerun, keeping one record.
    await importPunches([punch(missing.code, MON, '18:00', 'OUT')]);
    expect((await processDay(MON)).UPDATED).toBe(1);
    expect(await recordOn(hr, missing.id, MON)).toMatchObject({ status: 'PRESENT', calculationCount: 2 });

    await processDay(SAT);
    expect((await recordOn(hr, present.id, SAT)).status).toBe('WEEKLY_OFF');
  });

  it('a location holiday beats punches; approved leave beats absence', async () => {
    const e = await activeEmployee();
    await h.call(hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate: WED, name: 'Synthetic holiday' });
    await processDay(WED);
    expect((await recordOn(hr, e.id, WED)).status).toBe('HOLIDAY');

    // Approved full-day leave on TUE, inserted directly to keep this test about attendance.
    const lr = await h.one<{ id: string }>(
      `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'leave_request', $2, 'SUBMITTED') returning id)
       insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, requested_units, state)
       select $1, $2, t.id, p.id, bt.id, $3, $3, 1, 'SUBMITTED' from bt, leave_type t join leave_policy p on p.leave_type_id = t.id
        where t.company_id = $1 and t.code = 'UNPAID' limit 1 returning id`,
      [A.id, e.id, TUE],
    );
    await h.db.query(`update business_transaction set state = 'APPROVED' where id = (select transaction_id from leave_request where id = $1)`, [lr.id]);
    await h.db.query(`update leave_request set state = 'APPROVED' where id = $1`, [lr.id]);
    await processDay(TUE);
    expect((await recordOn(hr, e.id, TUE)).status).toBe('LEAVE');
  });
});

describe('import validation and replay (FR-019, DF09, ZT07)', () => {
  it('reports unknown employees, offset-less timestamps and conflicting keys; duplicates add nothing', async () => {
    const e = await activeEmployee();
    const key = uniq('evt-');
    const first = await importPunches([punch(e.code, TUE, '09:00', 'IN', key)]);
    expect(first.json().accepted).toBe(1);
    const res = (
      await importPunches([
        punch(e.code, TUE, '09:00', 'IN', key), // identical replay
        punch(e.code, TUE, '09:05', 'IN', key), // same key, different content
        punch('NOPE-404', TUE, '09:00', 'IN'),
        { employeeCode: e.code, occurredAt: `${TUE}T09:00:00`, direction: 'IN', externalEventKey: uniq('evt-') },
      ])
    ).json();
    expect(res).toMatchObject({ received: 4, accepted: 0, duplicates: 1 });
    expect(res.rejected).toEqual([
      { index: 1, code: 'CONFLICTING_DUPLICATE_KEY' },
      { index: 2, code: 'UNKNOWN_EMPLOYEE' },
      { index: 3, code: 'INVALID_TIMESTAMP' },
    ]);
    const stored = await h.one<{ n: string }>(`select count(*) as n from attendance_punch where employee_id = $1`, [e.id]);
    expect(Number(stored.n)).toBe(1);
  });
});

describe('amendments and scope (FR-021)', () => {
  it('amends with a reason, keeps the punch and the trail, and later processing does not overwrite it', async () => {
    const e = await activeEmployee();
    await processDay(TUE);
    const before = await recordOn(hr, e.id, TUE);
    expect(before.status).toBe('ABSENT');

    expect((await h.call(hr, 'POST', `/v1/attendance/records/${before.id}/amend`, { expectedVersion: before.version, status: 'PRESENT' })).statusCode).toBe(400);
    expect((await h.call(hr, 'POST', `/v1/attendance/records/${before.id}/amend`, { expectedVersion: 99, status: 'PRESENT', reason: 'x' })).statusCode).toBe(409);
    const ok = await h.call(hr, 'POST', `/v1/attendance/records/${before.id}/amend`, {
      expectedVersion: before.version,
      status: 'PRESENT',
      reason: 'Client site visit confirmed (synthetic)',
    });
    expect(ok.statusCode).toBe(200);
    // The trail is operational; its reason is a private, separately granted group (DF02).
    const log = (await h.call(hr, 'GET', `/v1/attendance/records/${before.id}/amendments`)).json().items;
    expect(log).toMatchObject([{ oldStatus: 'ABSENT', newStatus: 'PRESENT' }]);
    expect(log[0]).not.toHaveProperty('reason');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    expect(JSON.stringify((await h.call(self, 'GET', `/v1/attendance/records/${before.id}/amendments`)).json())).not.toContain('Client site visit');
    const reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['attendance.read.reason'] });
    expect((await h.call(reasonReader, 'GET', `/v1/attendance/records/${before.id}/amendments`)).json().items).toMatchObject([
      { oldStatus: 'ABSENT', newStatus: 'PRESENT', reason: 'Client site visit confirmed (synthetic)' },
    ]);

    const rerun = await processDay(TUE);
    expect(rerun.SKIPPED_AMENDED).toBeGreaterThanOrEqual(1);
    expect(await recordOn(hr, e.id, TUE)).toMatchObject({ status: 'PRESENT', amended: true });
  });

  it('employees see only their own attendance and cannot process or amend', async () => {
    const own = await activeEmployee();
    const other = await activeEmployee();
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: own.id });
    expect((await h.call(self, 'GET', `/v1/employees/${own.id}/attendance?from=${MON}&to=${WED}`)).statusCode).toBe(200);
    expect((await h.call(self, 'GET', `/v1/employees/${other.id}/attendance?from=${MON}&to=${WED}`)).statusCode).toBe(404);
    expect((await h.call(self, 'POST', '/v1/attendance/processing', { workDate: MON })).statusCode).toBe(403);
    expect((await h.call(self, 'POST', '/v1/attendance/punches', { punches: [punch(own.code, MON, '09:00', 'IN')] })).statusCode).toBe(403);
  });
});

describe('the approved last working date (DF04, FR-051)', () => {
  // Another fixed week (2026-04-06 is a Monday), so the earlier runs do not interfere.
  const MON2 = '2026-04-06';
  const TUE2 = '2026-04-07';
  const WED2 = '2026-04-08';

  /** An approved exit (inclusive last working date), optionally already SEPARATED, written in one transaction. */
  async function exitOf(employeeId: string, lastWorkingDate: string, separated: boolean) {
    await h.db.query('begin');
    try {
      const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
      const x = await h.one<{ id: string }>(
        `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
         values ($1, $2, $3, 'RESIGNATION', '2026-03-16', $4, $4, 'SUBMITTED') returning id`,
        [A.id, employeeId, bt.id, lastWorkingDate],
      );
      await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, lastWorkingDate]);
      await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, lastWorkingDate]);
      if (separated) {
        await h.db.query(`update business_transaction set state = 'SEPARATED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'SEPARATED', separated_at = now() where id = $1`, [x.id]);
      }
      await h.db.query('commit');
    } catch (e) {
      await h.db.query('rollback');
      throw e;
    }
    await h.setStatus(A, employeeId, separated ? 'INACTIVE_SEPARATED' : 'NOTICE');
  }

  it('processes the days up to the last working date after separation, and never a later date', async () => {
    // Processed late: separated already, last working date Tuesday.
    const separated = await activeEmployee();
    await exitOf(separated.id, TUE2, true);
    // Still on notice (the daily separation has not run), last working date Monday.
    const onNotice = await activeEmployee();
    await exitOf(onNotice.id, MON2, false);
    // Separated without an approved exit: no service end is known, so nothing is processed (as before).
    const unknown = await activeEmployee();
    await h.setStatus(A, unknown.id, 'INACTIVE_SEPARATED');

    const mon = await processDay(MON2);
    const tue = await processDay(TUE2);
    const wed = await processDay(WED2);
    expect(await recordOn(hr, separated.id, MON2)).toMatchObject({ status: 'ABSENT' });
    expect(await recordOn(hr, separated.id, TUE2)).toMatchObject({ status: 'ABSENT' }); // on the inclusive date
    expect(await recordOn(hr, separated.id, WED2)).toBeUndefined();
    expect(await recordOn(hr, onNotice.id, MON2)).toMatchObject({ status: 'ABSENT' });
    expect(await recordOn(hr, onNotice.id, TUE2)).toBeUndefined();
    for (const d of [MON2, TUE2, WED2]) expect(await recordOn(hr, unknown.id, d)).toBeUndefined();
    // Every other employee is active on all three days: Monday counts both leavers, Tuesday one, Wednesday none.
    expect(mon.employees - wed.employees).toBe(2);
    expect(tue.employees - wed.employees).toBe(1);
    // Counts only, and a rerun changes nothing.
    expect(Object.keys(mon).sort()).toEqual(['CREATED', 'NO_POLICY', 'SKIPPED_AMENDED', 'SKIPPED_LOCKED', 'UNCHANGED', 'UPDATED', 'employees', 'workDate']);
    const again = await processDay(MON2);
    expect(again.CREATED + again.UPDATED).toBe(0);
    expect(again.employees).toBe(mon.employees);
  });
});
