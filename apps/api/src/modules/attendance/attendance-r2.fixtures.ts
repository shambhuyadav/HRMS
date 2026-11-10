// The constructed attendance scenario of the registers and the dashboard tests (not a test file; BRD coverage CL-047 to CL-053).
// Synthetic people, punches, shifts, leave, outdoor duty, a holiday and weekly offs in March 2026 (2026-03-02 is a Monday), on
// fixed past dates. Every day of 2-6 March is processed; 9-11 March are not, so both readings of a day are exercised.
//
//   ENG (A.dept), shift DAY 09:00-18:00 (break 13:00-14:00, buffer 240), the site policy with overtime rules:
//     P101  joined 5 Jan; Mon 2: 09:00 IN by terminal, 18:00 OUT by import; Thu 5: 09:00-18:00; Tue 10 (holiday): 10:00-14:00
//     L101  joined 5 Jan; Mon 2: 09:25 IN, 13:00 OUT, 14:00 IN, 17:40 OUT (late 25, early 20); Tue 3: 09:00-19:00 (overtime 60);
//           Thu 5: 09:30-18:00 (late 30); shift NIGHT 22:00-06:00 from Wed 11
//     EX01  joined 5 Mar; Thu 5: 09:00 IN only (exception); Mon 9: 09:05 IN only
//     NS01  joined 7 Mar; no shift
//   ABS (absence watch department), shift DAY:
//     MG01  joined 5 Jan; the manager of TM01; approved leave 2-11 March
//     TM01  joined 5 Jan; reports to MG01; never punches
//     AB01  joined 5 Jan; approved leave Thu 5; otherwise never punches
//     JN01  joined Thu 5; approved full-day outdoor duty Fri 6; Mon 9: 09:00-18:00
//     SU01  joined Mon 9; a biometric fetch failed for Mon 9 and nothing covers it since; never punches
//   Holiday at the location on Tue 10 March; Saturday and Sunday are the default weekly offs.
import { expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import type { Company, Harness, TestActor } from '../../test/harness.js';

export interface Scenario {
  hr: TestActor;
  /** A TEAM-scoped assignment of MG01's user with the attendance read and export duties. */
  manager: TestActor;
  abs: string;
  day: string;
  night: string;
  ids: Record<string, string>;
}

const PROCESSED_DAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];

export async function buildScenario(h: Harness, A: Company): Promise<Scenario> {
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const activator = await h.actor(A, 'HR_ADMINISTRATOR');
  const abs = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'ABS', 'Absence watch', true) returning id`, [A.id])).id;
  const shift = async (body: Record<string, unknown>) => {
    const res = await h.call(hr, 'POST', '/v1/shifts', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const day = await shift({ code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
  const night = await shift({ code: 'NIGHT', name: 'Night', inTime: '22:00', outTime: '06:00', bufferMinutes: 60, breaks: [] });

  // A site policy with overtime rules (synthetic values, not a proposal), activated by another person.
  const created = await h.call(hr, 'POST', '/v1/attendance/policies', {
    code: 'R2_SITE',
    effectiveFrom: '2026-01-01',
    graceMinutes: 10,
    presentPercent: '75',
    halfDayPercent: '50',
    overtimeEnabled: true,
    overtimeBasis: 'AFTER_SHIFT_END',
    overtimeMinimumMinutes: 30,
    overtimeRoundingMinutes: 15,
  });
  expect(created.statusCode, created.body).toBe(201);
  const mapped = await h.call(hr, 'POST', `/v1/attendance/policies/${created.json().id}/mappings`, { expectedVersion: created.json().version, locationId: A.loc });
  expect(mapped.statusCode, mapped.body).toBe(201);
  expect((await h.call(activator, 'POST', `/v1/attendance/policies/${created.json().id}/activate`, { expectedVersion: mapped.json().policyVersion })).statusCode).toBe(200);

  const ids: Record<string, string> = {};
  const person = async (code: string, joiningDate: string, departmentId: string, shiftId: string | null) => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: code, joiningDate, departmentId }));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    if (shiftId) expect((await h.call(hr, 'POST', `/v1/employees/${id}/shift`, { shiftId, effectiveFrom: joiningDate })).statusCode).toBeLessThan(300);
    ids[code] = id;
    return id;
  };
  await person('P101', '2026-01-05', A.dept, day);
  await person('L101', '2026-01-05', A.dept, day);
  await person('EX01', '2026-03-05', A.dept, day);
  await person('NS01', '2026-03-07', A.dept, null);
  await person('MG01', '2026-01-05', abs, day);
  await person('TM01', '2026-01-05', abs, day);
  await person('AB01', '2026-01-05', abs, day);
  await person('JN01', '2026-03-05', abs, day);
  await person('SU01', '2026-03-09', abs, day);
  expect((await h.call(hr, 'POST', `/v1/employees/${ids.TM01}/manager`, { managerEmployeeId: ids.MG01, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  expect((await h.call(hr, 'POST', `/v1/employees/${ids.L101}/shift`, { shiftId: night, effectiveFrom: '2026-03-11' })).statusCode).toBeLessThan(300);
  expect((await h.call(hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate: '2026-03-10', name: 'Synthetic holiday' })).statusCode).toBeLessThan(300);

  // Punches through the import (source Import) ...
  const imported = async (list: [string, string, string, 'IN' | 'OUT'][]) => {
    const res = await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: list.map(([code, d, t, direction]) => ({ employeeCode: code, occurredAt: `${d}T${t}:00+05:30`, direction, externalEventKey: uniq('evt-') })),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  };
  await imported([
    ['P101', '2026-03-02', '18:00', 'OUT'],
    ['L101', '2026-03-02', '09:25', 'IN'],
    ['L101', '2026-03-02', '13:00', 'OUT'],
    ['L101', '2026-03-02', '14:00', 'IN'],
    ['L101', '2026-03-02', '17:40', 'OUT'],
    ['L101', '2026-03-03', '09:00', 'IN'],
    ['L101', '2026-03-03', '19:00', 'OUT'],
    ['P101', '2026-03-05', '09:00', 'IN'],
    ['P101', '2026-03-05', '18:00', 'OUT'],
    ['L101', '2026-03-05', '09:30', 'IN'],
    ['L101', '2026-03-05', '18:00', 'OUT'],
    ['EX01', '2026-03-05', '09:00', 'IN'],
    ['EX01', '2026-03-09', '09:05', 'IN'],
    ['JN01', '2026-03-09', '09:00', 'IN'],
    ['JN01', '2026-03-09', '18:00', 'OUT'],
    ['P101', '2026-03-10', '10:00', 'IN'],
    ['P101', '2026-03-10', '14:00', 'OUT'],
  ]);
  // ... and one from a terminal (a biometric device feed), with SU01's failed fetch for Monday 9 March.
  const profile = (
    await h.one<{ id: string }>(
      `insert into biometric_profile (company_id, code, name, request_config_reference, auth_reference, provider_timezone, pagination_mode, schedule_reference, lookback_minutes, active)
       values ($1, 'R2_DEVICE', 'Synthetic device', 'synthetic-config', 'synthetic-auth', 'Asia/Kolkata', 'CURSOR', 'synthetic-schedule', 60, true) returning id`,
      [A.id],
    )
  ).id;
  await h.db.query(
    `insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, biometric_profile_id, source_identity_key)
     values ($1, $2, '2026-03-02T09:00:00+05:30', 'IN', 'BIOMETRIC_API', $3, $4, 'r2-device')`,
    [A.id, ids.P101, uniq('dev-evt-'), profile],
  );
  const mapping = (
    await h.one<{ id: string }>(
      `insert into biometric_mapping_revision (company_id, profile_id, revision, effective_from, dedupe_strategy, timestamp_rule, created_by)
       values ($1, $2, 1, '2026-01-01T00:00:00Z', 'PROVIDER_EVENT_KEY', 'ISO_WITH_OFFSET', $3) returning id`,
      [A.id, profile, SYSTEM_ACTOR_ID],
    )
  ).id;
  await h.db.query(`insert into biometric_employee_link (company_id, profile_id, external_employee_key, employee_id, effective_from) values ($1, $2, 'r2-badge-su', $3, '2026-01-01T00:00:00Z')`, [
    A.id,
    profile,
    ids.SU01,
  ]);
  await h.db.query(
    `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, failure_code, finished_at)
     values ($1, $2, $3, '2026-03-08T18:30:00Z', '2026-03-09T18:30:00Z', 'FAILED', 'SYNTHETIC_OUTAGE', now())`,
    [A.id, profile, mapping],
  );

  await approvedLeave(h, A, ids.MG01!, '2026-03-02', '2026-03-11');
  await approvedLeave(h, A, ids.AB01!, '2026-03-05', '2026-03-05');
  await approvedDuty(h, A, ids.JN01!, '2026-03-06');

  for (const d of PROCESSED_DAYS) await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: d });

  // MG01's user acts in a TEAM-scoped assignment holding the attendance read and export duties.
  const manager = await h.customActor(A, { scope: 'TEAM', permissions: ['attendance.read.operational', 'attendance.export.operational'] });
  await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, manager.user, ids.MG01]);
  return { hr, manager, abs, day, night, ids };
}

/** An approved unpaid leave, written directly (its workflow is tested elsewhere). */
export async function approvedLeave(h: Harness, A: Company, employeeId: string, start: string, end: string) {
  const lr = await h.one<{ id: string }>(
    `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'leave_request', $2, 'SUBMITTED') returning id)
     insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, half_day, requested_units, state)
     select $1, $2, t.id, p.id, bt.id, $3, $4, false, ($4::date - $3::date + 1), 'SUBMITTED' from bt, leave_type t join leave_policy p on p.leave_type_id = t.id
      where t.company_id = $1 and t.code = 'UNPAID' limit 1 returning id`,
    [A.id, employeeId, start, end],
  );
  await h.db.query(
    `with t as (update business_transaction set state = 'APPROVED' where id = (select transaction_id from leave_request where id = $1) returning id)
     update leave_request set state = 'APPROVED' from t where leave_request.id = $1`,
    [lr.id],
  );
}

/** An approved full-day outdoor duty, written directly. */
export async function approvedDuty(h: Harness, A: Company, employeeId: string, day: string) {
  const { id } = await h.one<{ id: string }>(
    `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'outdoor_duty', $2, 'SUBMITTED') returning id)
     insert into outdoor_duty_request (company_id, employee_id, transaction_id, start_date, end_date, purpose, state)
     select $1, $2, bt.id, $3, $3, 'Client site visit (synthetic)', 'SUBMITTED' from bt returning id`,
    [A.id, employeeId, day],
  );
  await h.db.query(
    `with t as (update business_transaction set state = 'APPROVED' where id = (select transaction_id from outdoor_duty_request where id = $1) returning id)
     update outdoor_duty_request set state = 'APPROVED' where id = $1 and transaction_id in (select id from t)`,
    [id],
  );
}
