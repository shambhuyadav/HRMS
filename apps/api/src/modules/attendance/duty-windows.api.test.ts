// Approved outdoor duty in daily attendance over HTTP (FR-020, FR-021, FR-027; DF05; DF09; I-05; migration 0025).
// A timed duty window is requested on its start date and ends on the next calendar day when its end time is not
// after its start time. Like punches, a window belongs to the shift whose capture window (shift -4 h .. +4 h) it
// overlaps, so an overnight shift gets its after-midnight duty time (DF05: the shift belongs to its start date).
// Synthetic data; fixed past dates (2026-03-02 is a Monday; Asia/Kolkata is UTC+05:30).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let dayShift: string;
let nightShift: string;

const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const THU = '2026-03-05';
const FRI = '2026-03-06';

async function worker(shiftId: string): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  return { id: e.id, code: e.employeeCode };
}

async function punches(employeeCode: string, list: [string, string, 'IN' | 'OUT'][]) {
  const res = await h.call(hr, 'POST', '/v1/attendance/punches', {
    punches: list.map(([d, hhmm, direction]) => ({ employeeCode, occurredAt: `${d}T${hhmm}:00+05:30`, direction, externalEventKey: uniq('evt-') })),
  });
  expect(res.json()).toMatchObject({ accepted: list.length, rejected: [] });
}

/** An approved outdoor-duty request, inserted directly so the test stays about attendance (the request flow is covered in work-request). */
async function approvedDuty(employeeId: string, startDate: string, window?: [string, string]) {
  const { id } = await h.one<{ id: string }>(
    `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'outdoor_duty', $2, 'SUBMITTED') returning id)
     insert into outdoor_duty_request (company_id, employee_id, transaction_id, start_date, end_date, start_time, end_time, purpose, state)
     select $1, $2, bt.id, $3, $3, $4, $5, 'Client site visit (synthetic)', 'SUBMITTED' from bt returning id`,
    [A.id, employeeId, startDate, window?.[0] ?? null, window?.[1] ?? null],
  );
  await h.db.query(
    `with t as (update business_transaction set state = 'APPROVED' where id = (select transaction_id from outdoor_duty_request where id = $1) returning id)
     update outdoor_duty_request set state = 'APPROVED' where id = $1 and transaction_id in (select id from t)`,
    [id],
  );
}

// NFR-S09: processing is a queued bulk job; the helper enqueues it (202) and runs the worker step to completion.
const processDay = async (workDate: string) => expect((await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).state).toBe('COMPLETED');
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  dayShift = (
    await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })
  ).json().id;
  // 22:00-06:00 with a 30-minute break at 02:00: 450 net minutes.
  nightShift = (
    await h.call(hr, 'POST', '/v1/shifts', { code: 'NIGHT', name: 'Night', inTime: '22:00', outTime: '06:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] })
  ).json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('timed duty windows follow the shift, not the calendar date (FR-027; DF05)', () => {
  it('a duty after midnight belongs to the night shift that started the evening before', async () => {
    const night = await worker(nightShift);
    // Monday's night shift: in the office 22:00-00:00, then on approved duty Tuesday 00:00-06:00.
    await punches(night.code, [
      [MON, '22:00', 'IN'],
      [TUE, '00:00', 'OUT'],
    ]);
    await approvedDuty(night.id, TUE, ['00:00', '06:00']);
    await processDay(MON);
    await processDay(TUE);
    // 120 in the office + 360 on duty - 30 break = 450 = the whole net shift.
    expect.soft(await recordOn(night.id, MON)).toMatchObject({ status: 'PRESENT', workedMinutes: 450, late: false, earlyDeparture: false });
    // Tuesday's own night shift (Tuesday 22:00 - Wednesday 06:00) has neither punches nor duty.
    expect.soft(await recordOn(night.id, TUE)).toMatchObject({ status: 'ABSENT', workedMinutes: 0 });
  });

  it('a window whose end time is before its start time ends the next day (23:00-03:00)', async () => {
    const night = await worker(nightShift);
    await punches(night.code, [
      [MON, '22:00', 'IN'],
      [MON, '23:00', 'OUT'],
      [TUE, '03:00', 'IN'],
      [TUE, '06:00', 'OUT'],
    ]);
    await approvedDuty(night.id, MON, ['23:00', '03:00']);
    await processDay(MON);
    expect(await recordOn(night.id, MON)).toMatchObject({ status: 'PRESENT', workedMinutes: 450, late: false, earlyDeparture: false });
  });

  it('duty time outside the capture window is not attributed to the day', async () => {
    const day = await worker(dayShift);
    // Friday's day shift captures 05:00-22:00; a 00:00-06:00 duty contributes only 05:00-06:00.
    await punches(day.code, [
      [FRI, '09:00', 'IN'],
      [FRI, '18:00', 'OUT'],
    ]);
    await approvedDuty(day.id, FRI, ['00:00', '06:00']);
    await processDay(FRI);
    expect(await recordOn(day.id, FRI)).toMatchObject({ status: 'PRESENT', workedMinutes: 60 + 480 });
  });

  it('a day-shift duty before the office punches counts as attended time for the late flag', async () => {
    const day = await worker(dayShift);
    await punches(day.code, [
      [WED, '14:00', 'IN'],
      [WED, '18:00', 'OUT'],
    ]);
    await approvedDuty(day.id, WED, ['09:00', '13:00']);
    await processDay(WED);
    expect(await recordOn(day.id, WED)).toMatchObject({ status: 'PRESENT', workedMinutes: 480, late: false, earlyDeparture: false });
  });
});

describe('timed duty while the biometric source failed (DF09)', () => {
  it('a short duty does not turn a failed fetch into absence', async () => {
    const day = await worker(dayShift);
    const profile = await h.one<{ id: string }>(
      `insert into biometric_profile (company_id, code, name, request_config_reference, auth_reference, provider_timezone, pagination_mode, schedule_reference, lookback_minutes, active)
       values ($1, $2, 'Synthetic device', 'synthetic-config', 'synthetic-auth', 'Asia/Kolkata', 'CURSOR', 'synthetic-schedule', 60, true) returning id`,
      [A.id, uniq('DEVICE')],
    );
    const mapping = await h.one<{ id: string }>(
      `insert into biometric_mapping_revision (company_id, profile_id, revision, effective_from, dedupe_strategy, timestamp_rule)
       values ($1, $2, 1, '2026-01-01T00:00:00Z', 'PROVIDER_EVENT_KEY', 'ISO_WITH_OFFSET') returning id`,
      [A.id, profile.id],
    );
    await h.db.query(
      `insert into biometric_employee_link (company_id, profile_id, external_employee_key, employee_id, effective_from) values ($1, $2, $3, $4, '2026-01-01T00:00:00Z')`,
      [A.id, profile.id, uniq('badge-'), day.id],
    );
    // The fetch for Thursday failed (capture window 05:00-22:00 IST is inside this run's window).
    await h.db.query(
      `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, failure_code, finished_at)
       values ($1, $2, $3, '2026-03-04T12:00:00Z', '2026-03-06T00:00:00Z', 'FAILED', 'SYNTHETIC_OUTAGE', now())`,
      [A.id, profile.id, mapping.id],
    );
    await approvedDuty(day.id, THU, ['09:00', '11:00']);
    await processDay(THU);
    expect(await recordOn(day.id, THU)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE', late: false, earlyDeparture: false });
  });
});

describe('amending a day to ON_DUTY (FR-021, FR-027)', () => {
  it('HR can record an outdoor-duty outcome by a reasoned amendment', async () => {
    const day = await worker(dayShift);
    await processDay(FRI);
    const before = await recordOn(day.id, FRI);
    expect(before.status).toBe('ABSENT');
    await approvedDuty(day.id, FRI); // approved after the day was evaluated
    const res = await h.call(hr, 'POST', `/v1/attendance/records/${before.id}/amend`, {
      expectedVersion: before.version,
      status: 'ON_DUTY',
      reason: 'Outdoor duty confirmed by the client (synthetic)',
    });
    expect(res.statusCode).toBe(200);
    expect(await recordOn(day.id, FRI)).toMatchObject({ status: 'ON_DUTY', amended: true, exceptionCode: null });
    expect((await h.call(hr, 'GET', `/v1/attendance/records/${before.id}/amendments`)).json().items).toMatchObject([{ oldStatus: 'ABSENT', newStatus: 'ON_DUTY' }]);
  });

  it('an outcome not measured against the shift drops the late and early flags, and the audit keeps the old ones', async () => {
    // In 10:00-17:00: 360 net minutes is PRESENT, started late and left early.
    const late = await worker(dayShift);
    await punches(late.code, [
      [MON, '10:00', 'IN'],
      [MON, '17:00', 'OUT'],
    ]);
    await processDay(MON);
    const before = await recordOn(late.id, MON);
    expect(before).toMatchObject({ status: 'PRESENT', late: true, earlyDeparture: true });
    await approvedDuty(late.id, MON);
    const amended = await h.call(hr, 'POST', `/v1/attendance/records/${before.id}/amend`, {
      expectedVersion: before.version,
      status: 'ON_DUTY',
      reason: 'Outdoor duty all day, confirmed afterwards (synthetic)',
    });
    expect(amended.statusCode).toBe(200);
    // ON_DUTY, like leave and off days, is never late or early (the evaluation rule), amended or not.
    expect(await recordOn(late.id, MON)).toMatchObject({ status: 'ON_DUTY', amended: true, late: false, earlyDeparture: false });
    const audit = await h.one<{ before_values: { operational: Record<string, unknown> }; after_values: { operational: Record<string, unknown> } }>(
      `select before_values, after_values from audit_event where company_id = $1 and resource_code = 'attendance_record' and record_key = $2 and action = 'AMEND'`,
      [A.id, before.id],
    );
    expect(audit.before_values.operational).toMatchObject({ late: true, earlyDeparture: true });
    expect(audit.after_values.operational).toMatchObject({ status: 'ON_DUTY', late: false, earlyDeparture: false });

    // An outcome measured against the shift keeps the flags it was evaluated with.
    const halfDay = await worker(dayShift);
    await punches(halfDay.code, [
      [MON, '10:00', 'IN'],
      [MON, '17:00', 'OUT'],
    ]);
    await processDay(MON);
    const evaluated = await recordOn(halfDay.id, MON);
    const kept = await h.call(hr, 'POST', `/v1/attendance/records/${evaluated.id}/amend`, {
      expectedVersion: evaluated.version,
      status: 'HALF_DAY',
      reason: 'Half day agreed with the manager (synthetic)',
    });
    expect(kept.statusCode).toBe(200);
    expect(await recordOn(halfDay.id, MON)).toMatchObject({ status: 'HALF_DAY', amended: true, late: true, earlyDeparture: true });
  });
});
