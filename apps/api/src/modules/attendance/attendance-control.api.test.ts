// Attendance control over HTTP: amended outcomes rest on facts (FR-021, FR-025 to FR-027; DF05), every changed result
// keeps its earlier values and cause (FR-021; DB026; DB027), and the list across the row scope with raw punches beside the
// derived result and the matching export (FR-021; E07). Synthetic data; fixed past dates (2026-03-02 is a Monday).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from '../report/csv.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let shiftId: string;

const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const THU = '2026-03-05';
const FRI = '2026-03-06';
const SAT = '2026-03-07';

async function worker(over: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  return { id: e.id, code: e.employeeCode };
}
const processDay = (workDate: string) => h.runBulkJob(hr, '/v1/attendance/processing', { workDate });
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];
const amend = (r: { id: string; version: number }, status: string) => h.call(hr, 'POST', `/v1/attendance/records/${r.id}/amend`, { expectedVersion: r.version, status, reason: 'Synthetic amendment' });
const punches = (code: string, list: [string, string, 'IN' | 'OUT'][]) =>
  h.call(hr, 'POST', '/v1/attendance/punches', { punches: list.map(([d, t, direction]) => ({ employeeCode: code, occurredAt: `${d}T${t}:00+05:30`, direction, externalEventKey: uniq('evt-') })) });

async function approvedLeave(employeeId: string, start: string, end: string, halfDay = false, approve = true) {
  const lr = await h.one<{ id: string }>(
    `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'leave_request', $2, 'SUBMITTED') returning id)
     insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, half_day, requested_units, state)
     select $1, $2, t.id, p.id, bt.id, $3, $4, $5, $6, 'SUBMITTED' from bt, leave_type t join leave_policy p on p.leave_type_id = t.id
      where t.company_id = $1 and t.code = 'UNPAID' limit 1 returning id`,
    [A.id, employeeId, start, end, halfDay, halfDay ? 0.5 : 1],
  );
  if (!approve) return;
  await h.db.query(
    `with t as (update business_transaction set state = 'APPROVED' where id = (select transaction_id from leave_request where id = $1) returning id)
     update leave_request set state = 'APPROVED' from t where leave_request.id = $1`,
    [lr.id],
  );
}
async function approvedDuty(employeeId: string, day: string, window?: [string, string]) {
  const { id } = await h.one<{ id: string }>(
    `with bt as (insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'outdoor_duty', $2, 'SUBMITTED') returning id)
     insert into outdoor_duty_request (company_id, employee_id, transaction_id, start_date, end_date, start_time, end_time, purpose, state)
     select $1, $2, bt.id, $3, $3, $4, $5, 'Client site visit (synthetic)', 'SUBMITTED' from bt returning id`,
    [A.id, employeeId, day, window?.[0] ?? null, window?.[1] ?? null],
  );
  await h.db.query(
    `with t as (update business_transaction set state = 'APPROVED' where id = (select transaction_id from outdoor_duty_request where id = $1) returning id)
     update outdoor_duty_request set state = 'APPROVED' where id = $1 and transaction_id in (select id from t)`,
    [id],
  );
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('an amended outcome rests on its fact (FR-021, FR-025 to FR-027, DF05)', () => {
  const refusal = async (r: { id: string; version: number }, status: string) => {
    const res = await amend(r, status);
    return [res.statusCode, res.json().error];
  };

  it('leave and half-day leave need an approved request of that kind on the date; nothing changes when refused', async () => {
    const e = await worker();
    await processDay(MON);
    const r = await recordOn(e.id, MON);
    expect(await refusal(r, 'LEAVE')).toEqual([422, 'NO_APPROVED_LEAVE']);
    expect(await refusal(r, 'HALF_DAY_LEAVE')).toEqual([422, 'NO_APPROVED_LEAVE']);
    expect(await recordOn(e.id, MON)).toMatchObject({ status: 'ABSENT', amended: false, version: r.version });

    // An approved half day backs half-day leave only.
    await approvedLeave(e.id, MON, MON, true);
    expect(await refusal(r, 'LEAVE')).toEqual([422, 'NO_APPROVED_LEAVE']);
    expect((await amend(r, 'HALF_DAY_LEAVE')).statusCode).toBe(200);
    expect(await recordOn(e.id, MON)).toMatchObject({ status: 'HALF_DAY_LEAVE', amended: true });

    const other = await worker();
    await processDay(TUE);
    const onTue = await recordOn(other.id, TUE);
    await approvedLeave(other.id, TUE, TUE);
    expect((await amend(onTue, 'LEAVE')).statusCode).toBe(200);
  });

  it('leave still waiting for its decision backs nothing', async () => {
    const e = await worker();
    await processDay(WED);
    const r = await recordOn(e.id, WED);
    await approvedLeave(e.id, WED, WED, false, false);
    expect(await refusal(r, 'LEAVE')).toEqual([422, 'NO_APPROVED_LEAVE']);
  });

  it('ON_DUTY needs an approved full-day outdoor duty; a timed window is worked time, not an on-duty day', async () => {
    const e = await worker();
    await processDay(THU);
    const r = await recordOn(e.id, THU);
    expect(await refusal(r, 'ON_DUTY')).toEqual([422, 'NO_APPROVED_OUTDOOR_DUTY']);
    await approvedDuty(e.id, THU, ['09:00', '11:00']);
    expect(await refusal(r, 'ON_DUTY')).toEqual([422, 'NO_APPROVED_OUTDOOR_DUTY']);
    const other = await worker();
    await processDay(FRI);
    const onFri = await recordOn(other.id, FRI);
    await approvedDuty(other.id, FRI);
    expect((await amend(onFri, 'ON_DUTY')).statusCode).toBe(200);
  });

  it('HOLIDAY needs a holiday of the location and WEEKLY_OFF a weekly off; leave and duty do not apply on an off day', async () => {
    const e = await worker();
    await processDay(TUE);
    const r = await recordOn(e.id, TUE);
    expect(await refusal(r, 'HOLIDAY')).toEqual([422, 'NOT_A_HOLIDAY']);
    expect(await refusal(r, 'WEEKLY_OFF')).toEqual([422, 'NOT_A_WEEKLY_OFF']);

    // A leave range over a weekend consumed nothing on Saturday.
    const f = await worker();
    await approvedLeave(f.id, FRI, SAT);
    await processDay(SAT);
    const sat = await recordOn(f.id, SAT);
    expect(sat.status).toBe('WEEKLY_OFF');
    expect((await amend(sat, 'PRESENT')).statusCode).toBe(200);
    const again = await recordOn(f.id, SAT);
    expect(await refusal(again, 'LEAVE')).toEqual([422, 'NOT_A_WORKING_DAY']);
    expect((await amend(again, 'WEEKLY_OFF')).statusCode).toBe(200);

    const dated = '2026-03-10';
    await h.call(hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate: dated, name: 'Synthetic holiday' });
    await processDay(dated);
    const holiday = await recordOn(f.id, dated);
    expect(holiday.status).toBe('HOLIDAY');
    expect((await amend(holiday, 'PRESENT')).statusCode).toBe(200);
    expect((await amend(await recordOn(f.id, dated), 'HOLIDAY')).statusCode).toBe(200);
  });
});

describe('why the daily status changed (FR-021, DB026, DB027)', () => {
  const history = async (recordId: string) => (await h.call(hr, 'GET', `/v1/attendance/records/${recordId}/amendments`)).json();

  it('a reprocessing keeps the replaced values and names its job; an unchanged rerun writes nothing', async () => {
    const day = '2026-03-11';
    const e = await worker();
    await punches(e.code, [[day, '09:00', 'IN']]);
    const first = await processDay(day);
    const r = await recordOn(e.id, day);
    expect(r).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH', version: 1 });
    expect((await history(r.id)).revisions).toEqual([]);

    await punches(e.code, [[day, '18:00', 'OUT']]);
    const second = await processDay(day);
    expect(second.result.UPDATED).toBe(1);
    expect(second.id).not.toBe(first.id);
    expect(await recordOn(e.id, day)).toMatchObject({ status: 'PRESENT', exceptionCode: null, version: 2 });
    expect((await history(r.id)).revisions).toMatchObject([
      { priorVersion: 1, cause: 'PROCESSING', processingJobId: second.id, amendmentId: null, actorUserId: hr.user, status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH', workedMinutes: 0, shiftCode: 'DAY', policyCode: 'DEFAULT', policyRevision: 1 },
    ]);

    await processDay(day);
    expect((await history(r.id)).revisions).toHaveLength(1);
    expect((await recordOn(e.id, day)).version).toBe(2);
  });

  it('an amendment keeps the exception code and the values it replaced, next to the amendment log', async () => {
    const day = '2026-03-12';
    const e = await worker();
    await punches(e.code, [[day, '09:00', 'IN']]);
    await processDay(day);
    const r = await recordOn(e.id, day);
    expect((await amend(r, 'PRESENT')).statusCode).toBe(200);
    expect(await recordOn(e.id, day)).toMatchObject({ status: 'PRESENT', exceptionCode: null, amended: true });
    const log = await history(r.id);
    const amendment = await h.one<{ id: string }>(`select id from attendance_amendment where attendance_record_id = $1`, [r.id]);
    expect(log.items).toMatchObject([{ oldStatus: 'EXCEPTION', newStatus: 'PRESENT', actorUserId: hr.user }]);
    expect(log.revisions).toMatchObject([{ priorVersion: 1, cause: 'AMENDMENT', amendmentId: amendment.id, processingJobId: null, actorUserId: hr.user, status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' }]);
    // Operational values only: the amendment's private reason stays in its own group.
    expect(JSON.stringify(log.revisions)).not.toContain('Synthetic amendment');
  });

  it('the database refuses a change of the result without its revision, and revisions are append-only', async () => {
    const day = '2026-03-13';
    const e = await worker();
    await punches(e.code, [[day, '09:00', 'IN']]);
    await processDay(day);
    const r = await recordOn(e.id, day);
    await expect(h.db.query(`update attendance_record set worked_minutes = 5 where id = $1`, [r.id])).rejects.toThrow(/revision/);
    await amend(r, 'PRESENT');
    await expect(h.db.query(`update attendance_record_revision set worked_minutes = 5 where attendance_record_id = $1`, [r.id])).rejects.toThrow();
    await expect(h.db.query(`delete from attendance_record_revision where attendance_record_id = $1`, [r.id])).rejects.toThrow();
  });
});

describe('attendance control (FR-021, E07)', () => {
  const day = '2026-03-16';
  let located: { id: string; code: string };
  let shortDay: { id: string; code: string };
  let otherLocation: string;

  const list = async (actor: TestActor, query: string) => {
    const res = await h.call(actor, 'GET', `/v1/attendance/records?from=${day}&to=${day}&${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: { employeeId: string; status: string; shiftCode: string; policyCode: string; policyRevision: number; locationCode: string; departmentCode: string; payrollLocked: boolean }[]; total: number; page: number; pageSize: number };
  };

  beforeAll(async () => {
    otherLocation = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'BRANCH', 'Branch', true) returning id`, [A.id])).id;
    located = await worker({ locationId: otherLocation, departmentId: A.financeDept });
    shortDay = await worker();
    await punches(shortDay.code, [
      [day, '09:00', 'IN'],
      [day, '13:00', 'OUT'],
    ]);
    await processDay(day);
  });

  it('filters by department, location, status, shift, employee and minutes, in pages with totals', async () => {
    const all = await list(hr, 'pageSize=25');
    expect(all).toMatchObject({ page: 1, pageSize: 25 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.items.find((i) => i.employeeId === located.id)).toMatchObject({ status: 'ABSENT', shiftCode: 'DAY', policyCode: 'DEFAULT', policyRevision: 1, locationCode: 'BRANCH', departmentCode: 'FIN', payrollLocked: false });

    const ids = (r: Awaited<ReturnType<typeof list>>) => r.items.map((i) => i.employeeId);
    expect(ids(await list(hr, `locationId=${otherLocation}`))).toEqual([located.id]);
    expect(ids(await list(hr, `departmentId=${A.financeDept}`))).toEqual([located.id]);
    expect(ids(await list(hr, `employeeId=${shortDay.id}`))).toEqual([shortDay.id]);
    expect(ids(await list(hr, `search=${shortDay.code}`))).toEqual([shortDay.id]);
    expect(ids(await list(hr, `status=HALF_DAY`))).toEqual([shortDay.id]); // 240 of 480 net minutes
    expect(ids(await list(hr, `status=ABSENT&employeeId=${shortDay.id}`))).toEqual([]);
    expect((await list(hr, `shiftId=${shiftId}`)).total).toBe(all.total);

    // Minutes: worked and the shortfall against the scheduled net minutes.
    expect(ids(await list(hr, `minuteField=WORKED&minuteOp=GTE&minuteValue=200`))).toEqual([shortDay.id]);
    expect(ids(await list(hr, `minuteField=WORKED&minuteOp=EQ&minuteValue=240&employeeId=${shortDay.id}`))).toEqual([shortDay.id]);
    expect(ids(await list(hr, `minuteField=SHORTFALL&minuteOp=LT&minuteValue=241&employeeId=${shortDay.id}`))).toEqual([shortDay.id]);
    expect(ids(await list(hr, `minuteField=WORKED&minuteOp=GT&minuteValue=240&employeeId=${shortDay.id}`))).toEqual([]);
    const incomplete = await h.call(hr, 'GET', `/v1/attendance/records?from=${day}&to=${day}&minuteField=WORKED`);
    expect([incomplete.statusCode, incomplete.json().error]).toEqual([422, 'MINUTE_FILTER_INCOMPLETE']);
  });

  it('pages stay within the totals; a department-filtered assignment and an employee see only their own rows', async () => {
    const whole = await list(hr, 'pageSize=25');
    const page1 = (await h.call(hr, 'GET', `/v1/attendance/records?from=${day}&to=${day}&pageSize=25&page=2`)).json();
    expect(page1.items.length).toBe(Math.max(whole.total - 25, 0));

    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const scoped = await list(finance, '');
    expect(scoped.items.map((i) => i.employeeId)).toEqual([located.id]);
    expect(scoped.total).toBe(1);

    const self = await h.actor(A, 'EMPLOYEE', { employeeId: shortDay.id });
    const own = await list(self, '');
    expect(own.items.map((i) => i.employeeId)).toEqual([shortDay.id]);
  });

  it('shows the untouched source punches beside the derived result, also after an amendment; out of scope is not found', async () => {
    const r = await recordOn(shortDay.id, day);
    const view = async () => (await h.call(hr, 'GET', `/v1/attendance/records/${r.id}/day`)).json();
    const before = await view();
    expect(before.derived).toMatchObject({ status: 'HALF_DAY', workedMinutes: 240, policyCode: 'DEFAULT', shiftCode: 'DAY' });
    const expected = [
      { occurredAt: `${day}T03:30:00.000Z`, direction: 'IN', sourceKind: 'MANUAL_IMPORT' },
      { occurredAt: `${day}T07:30:00.000Z`, direction: 'OUT', sourceKind: 'MANUAL_IMPORT' },
    ];
    expect(before.punches).toEqual(expected);
    expect((await amend(r, 'PRESENT')).statusCode).toBe(200);
    const after = await view();
    expect(after.derived).toMatchObject({ status: 'PRESENT', amended: true });
    expect(after.punches).toEqual(expected);

    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await h.call(finance, 'GET', `/v1/attendance/records/${r.id}/day`)).statusCode).toBe(404);
  });

  it('the attendance register takes the same filters; a filter it does not know is still refused', async () => {
    const generated = async (filters: Record<string, unknown>) => {
      const created = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'ATTENDANCE_REGISTER', filters: { from: day, to: day, ...filters } });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const { processReportQueue } = await import('../report/service.js');
      await processReportQueue(h.pool, 5);
      const body = (await h.call(hr, 'GET', `/v1/reports/${created.json().id}/download`)).body;
      return csvTable(body).split(/\r?\n/).filter((l) => l.trim() !== '').slice(1);
    };
    expect(await generated({ locationId: otherLocation })).toHaveLength(1);
    const lines = await generated({ employeeId: shortDay.id, minuteField: 'WORKED', minuteOp: 'EQ', minuteValue: 240 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(shortDay.code.toUpperCase());
    expect(await generated({ employeeId: shortDay.id, status: 'HALF_DAY' })).toHaveLength(0); // amended to PRESENT above
    const refused = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'ATTENDANCE_REGISTER', filters: { from: day, to: day, projectId: A.id } });
    expect([refused.statusCode, refused.json().error]).toEqual([422, 'FILTER_NOT_SUPPORTED']);
  });
});
