// Weekly-off patterns over HTTP and every day count that reads them: attendance evaluation and amendment, leave, outdoor
// duty and holiday work, timesheet utilisation (FR-005, FR-020, FR-024, FR-027, FR-028, F1; DF05). Payroll has its own file
// (payroll/calendar.api.test.ts). A location calendar holds dated whole-day patterns; without one the DF05 default applies,
// which the rest of the test suite proves unchanged. Synthetic data; 2026-03-02 is a Monday, 2026-03-07 a Saturday.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let shiftId: string;

const FRI = '2026-03-06';
const SAT = '2026-03-07';
const SUN = '2026-03-08';
const MON = '2026-03-09';
const SUNDAY_OFF = [7];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: string, n: number) => iso(new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000));
/** The given ISO weekday (1 Monday .. 7 Sunday) of a week at least `weeks` weeks ahead. */
const ahead = (weeks: number, isoDow: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + isoDow - 1);
  return iso(d);
};

const location = async () => (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, uniq('L').toUpperCase()])).id;
const worker = async (locationId: string): Promise<{ id: string; code: string }> => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  return { id: e.id, code: e.employeeCode };
};
const post = (locationId: string, body: object = {}, a = hr) =>
  h.call(a, 'POST', '/v1/weekly-off-patterns', { locationId, effectiveFrom: '2026-03-01', offDays: SUNDAY_OFF, reason: 'Six-day week at this site (synthetic)', expectedRevision: 0, ...body });
/** A location calendar working Monday to Saturday from 1 March 2026. */
const sixDaySite = async () => {
  const site = await location();
  expect((await post(site)).statusCode).toBe(201);
  return site;
};
const calendars = async () =>
  (await h.call(hr, 'GET', '/v1/weekly-off-patterns')).json() as {
    defaultOffDays: number[];
    items: { locationId: string; locationCode: string; inForce: { offDays: number[]; isDefault: boolean; revision: number | null; effectiveFrom: string | null }; latestRevision: number; entries: { revision: number; effectiveFrom: string; offDays: number[]; reason: string; createdBy: string }[] }[];
  };
const calendarOf = async (site: string) => (await calendars()).items.find((i) => i.locationId === site)!;
const processDay = async (workDate: string) => (await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).result;
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];
const amend = (r: { id: string; version: number }, status: string) => h.call(hr, 'POST', `/v1/attendance/records/${r.id}/amend`, { expectedVersion: r.version, status, reason: 'Synthetic amendment' });
const refusal = async (res: { statusCode: number; json(): { error?: string } }) => [res.statusCode, res.json().error];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('maintaining a pattern (FR-005, DF05, DF08)', () => {
  it('a location without a pattern shows the Monday-Friday default', async () => {
    const list = await calendars();
    expect(list.defaultOffDays).toEqual([6, 7]);
    expect(list.items.find((i) => i.locationId === A.loc)).toMatchObject({ inForce: { offDays: [6, 7], isDefault: true, revision: null, effectiveFrom: null }, latestRevision: 0, entries: [] });
  });

  it('keeps dated entries: in force from their date, a later entry on the same date corrects, nothing is rewritten', async () => {
    const site = await location();
    const first = await post(site, { effectiveFrom: '2026-03-01', offDays: [7] });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ locationId: site, revision: 1, effectiveFrom: '2026-03-01', offDays: [7], reprocess: { days: [], truncated: false } });
    expect(await calendarOf(site)).toMatchObject({ inForce: { offDays: [7], isDefault: false, revision: 1, effectiveFrom: '2026-03-01' }, latestRevision: 1 });

    // Sent in any order, stored ascending; a later-dated entry is listed but not yet in force.
    expect((await post(site, { effectiveFrom: '2099-01-01', offDays: [7, 5], expectedRevision: 1 })).json()).toMatchObject({ revision: 2, offDays: [5, 7] });
    expect(await calendarOf(site)).toMatchObject({ inForce: { offDays: [7], revision: 1 } });

    // The same date again: the higher number wins and the first entry stays.
    expect((await post(site, { effectiveFrom: '2026-03-01', offDays: [], reason: 'Corrected: seven-day site (synthetic)', expectedRevision: 2 })).statusCode).toBe(201);
    const c = await calendarOf(site);
    expect(c.inForce).toMatchObject({ offDays: [], revision: 3 });
    expect(c.entries.map((e) => [e.revision, e.effectiveFrom, e.offDays])).toEqual([
      [1, '2026-03-01', [7]],
      [2, '2099-01-01', [5, 7]],
      [3, '2026-03-01', []],
    ]);
    expect(c.entries[2]).toMatchObject({ reason: 'Corrected: seven-day site (synthetic)', createdBy: hr.user });

    const audit = await h.one<{ action: string; reason: string; after_values: { operational: { offDays: number[] } } }>(
      `select action, reason, after_values from audit_event where company_id = $1 and resource_code = 'weekly_off_pattern' and record_key = $2`,
      [A.id, first.json().id],
    );
    expect(audit).toMatchObject({ action: 'CREATE', reason: 'Six-day week at this site (synthetic)', after_values: { operational: { offDays: [7] } } });
  });

  it('whole days only: a half weekly-off cannot be expressed (I-48 item 6); a week needs a working day', async () => {
    const site = await location();
    expect((await post(site, { offDays: [6.5] })).statusCode).toBe(400);
    expect((await post(site, { offDays: [{ day: 6, half: true }] })).statusCode).toBe(400);
    expect((await post(site, { offDays: ['SATURDAY_HALF'] })).statusCode).toBe(400);
    expect((await post(site, { offDays: [0] })).statusCode).toBe(400);
    expect((await post(site, { offDays: [8] })).statusCode).toBe(400);
    expect((await post(site, { offDays: [6, 6] })).statusCode).toBe(400);
    expect(await refusal(await post(site, { offDays: [1, 2, 3, 4, 5, 6, 7] }))).toEqual([422, 'NO_WORKING_DAY']);
    expect((await calendarOf(site)).entries).toEqual([]);
  });

  it('needs a reason, the latest revision seen and a known location', async () => {
    const site = await location();
    expect((await post(site, { reason: undefined })).statusCode).toBe(400);
    expect((await post(site, { reason: '  ' })).statusCode).toBe(422);
    expect((await post(site, { expectedRevision: undefined })).statusCode).toBe(400);
    expect(await refusal(await post(site, { expectedRevision: 4 }))).toEqual([409, 'STALE_VERSION']);
    expect(await refusal(await post('00000000-0000-4000-8000-000000000001'))).toEqual([422, 'INVALID_REFERENCE']);
    expect((await post(site)).statusCode).toBe(201);
    expect(await refusal(await post(site))).toEqual([409, 'STALE_VERSION']);
  });

  it('needs the shift duties, company scope and that location; another company cannot write to this location', async () => {
    const site = await location();
    const other = await location();
    const employee = await h.actor(A, 'EMPLOYEE');
    expect((await h.call(employee, 'GET', '/v1/weekly-off-patterns')).statusCode).toBe(403);
    expect((await post(site, {}, employee)).statusCode).toBe(403);
    const byDepartment = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await post(site, {}, byDepartment)).statusCode).toBe(403);
    const otherSite = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: other });
    expect((await post(site, {}, otherSite)).statusCode).toBe(403);
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    expect(await refusal(await post(site, {}, bHr))).toEqual([422, 'INVALID_REFERENCE']);
    expect((await calendarOf(site)).entries).toEqual([]);
    const thisSite = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: site });
    expect((await post(site, {}, thisSite)).statusCode).toBe(201);
    // The read duty alone is not enough to write.
    const reader = await h.customActor(A, { scope: 'COMPANY', permissions: ['shift.read.operational'] });
    expect((await h.call(reader, 'GET', '/v1/weekly-off-patterns')).statusCode).toBe(200);
    expect((await post(site, { expectedRevision: 1 }, reader)).statusCode).toBe(403);
  });

  it('re-checks authority inside the transaction: a grant revoked after the route guard changes nothing', async () => {
    const site = await location();
    const late = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.db.query('begin');
    let pending: ReturnType<typeof post> | undefined;
    try {
      await h.db.query(`select 1 from role_assignment where company_id = $1 and id = $2 for update`, [A.id, late.assignment]);
      pending = post(site, {}, late);
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i++) {
        blocked = ((await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rowCount ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2`, [A.id, late.assignment]);
    } finally {
      await h.db.query('commit');
    }
    expect((await pending!).statusCode).toBe(403);
    expect((await calendarOf(site)).entries).toEqual([]);
  });

  it('the database refuses a rewrite and an impossible pattern', async () => {
    const site = await sixDaySite();
    const row = await h.one<{ id: string }>(`select id from weekly_off_pattern where location_id = $1`, [site]);
    await expect(h.db.query(`update weekly_off_pattern set off_days = '{6,7}' where id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from weekly_off_pattern where id = $1`, [row.id])).rejects.toThrow(/append-only/);
    const insert = (days: string) =>
      h.db.query(`insert into weekly_off_pattern (company_id, location_id, revision, effective_from, off_days, reason) values ($1, $2, 9, '2030-01-01', $3::smallint[], 'x')`, [A.id, site, days]);
    await expect(insert('{1,2,3,4,5,6,7}')).rejects.toThrow(/check/);
    await expect(insert('{7,6}')).rejects.toThrow(/check/);
    await expect(insert('{6,6}')).rejects.toThrow(/check/);
    await expect(insert('{8}')).rejects.toThrow(/check/);
  });
});

describe('attendance evaluates on the location calendar (FR-020, DF05)', () => {
  it('a Saturday-working location works Saturday and rests Sunday; another location keeps the default that day', async () => {
    const six = await sixDaySite();
    const absent = await worker(six);
    const present = await worker(six);
    const hq = await worker(A.loc);
    await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: [
        { employeeCode: present.code, occurredAt: `${SAT}T09:00:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') },
        { employeeCode: present.code, occurredAt: `${SAT}T18:00:00+05:30`, direction: 'OUT', externalEventKey: uniq('evt-') },
      ],
    });
    await processDay(SAT);
    expect(await recordOn(absent.id, SAT)).toMatchObject({ status: 'ABSENT', scheduledNetMinutes: 480 });
    expect(await recordOn(present.id, SAT)).toMatchObject({ status: 'PRESENT', workedMinutes: 480 });
    expect(await recordOn(hq.id, SAT)).toMatchObject({ status: 'WEEKLY_OFF' });
    await processDay(SUN);
    expect(await recordOn(absent.id, SUN)).toMatchObject({ status: 'WEEKLY_OFF' });
    expect(await recordOn(hq.id, SUN)).toMatchObject({ status: 'WEEKLY_OFF' });
    // A Saturday before the pattern's date keeps the default.
    await processDay('2026-02-28');
    expect(await recordOn(absent.id, '2026-02-28')).toMatchObject({ status: 'WEEKLY_OFF' });
  });

  it('a Friday-off location: Friday is the off day, Saturday and Sunday are worked', async () => {
    const site = await location();
    expect((await post(site, { offDays: [5] })).statusCode).toBe(201);
    const e = await worker(site);
    await processDay(FRI);
    await processDay(SAT);
    await processDay(SUN);
    expect(await recordOn(e.id, FRI)).toMatchObject({ status: 'WEEKLY_OFF' });
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'ABSENT' });
    expect(await recordOn(e.id, SUN)).toMatchObject({ status: 'ABSENT' });
  });

  it('a holiday outranks the pattern, as in evaluation before', async () => {
    const six = await sixDaySite();
    const e = await worker(six);
    expect((await h.call(hr, 'POST', '/v1/holidays', { locationId: six, holidayDate: '2026-03-14', name: 'Synthetic holiday' })).statusCode).toBe(201);
    await processDay('2026-03-14');
    expect(await recordOn(e.id, '2026-03-14')).toMatchObject({ status: 'HOLIDAY' });
  });

  it('a later entry on the same date corrects what evaluation and day counts read', async () => {
    const site = await location();
    const e = await worker(site);
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    expect((await post(site, { effectiveFrom: '2026-03-01', offDays: [7] })).statusCode).toBe(201);
    await processDay(SAT);
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'ABSENT' });
    // Entered wrongly: this location does rest on Saturdays.
    expect((await post(site, { effectiveFrom: '2026-03-01', offDays: [6, 7], reason: 'Corrected (synthetic)', expectedRevision: 1 })).statusCode).toBe(201);
    await processDay(SAT);
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'WEEKLY_OFF' });
    const sat = ahead(20, 6);
    expect(await refusal(await h.call(actor, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: sat, endDate: sat }))).toEqual([422, 'NO_WORKING_DAYS']);
  });

  it('an amended outcome rests on the same calendar', async () => {
    const six = await sixDaySite();
    const e = await worker(six);
    await processDay(SAT);
    await processDay(SUN);
    const sat = await recordOn(e.id, SAT);
    expect(await refusal(await amend(sat, 'WEEKLY_OFF'))).toEqual([422, 'NOT_A_WEEKLY_OFF']);
    // Saturday is a working day here, so leave is a question of the request, not of the day.
    expect(await refusal(await amend(sat, 'LEAVE'))).toEqual([422, 'NO_APPROVED_LEAVE']);
    const sun = await recordOn(e.id, SUN);
    expect((await amend(sun, 'PRESENT')).statusCode).toBe(200);
    const again = await recordOn(e.id, SUN);
    expect(await refusal(await amend(again, 'LEAVE'))).toEqual([422, 'NOT_A_WORKING_DAY']);
    expect((await amend(again, 'WEEKLY_OFF')).statusCode).toBe(200);
  });

  it('a back-dated pattern lists only the evaluated days whose status can change, up to the next entry, and changes none until HR reprocesses', async () => {
    const site = await location();
    const e = await worker(site);
    await processDay(SAT);
    await processDay(MON);
    await processDay('2026-03-14');
    await processDay('2026-03-21');
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'WEEKLY_OFF', calculationCount: 1 });

    // A later entry from 15 March bounds the back-dated one.
    expect((await post(site, { effectiveFrom: '2026-03-15', offDays: [6, 7] })).statusCode).toBe(201);
    const res = await post(site, { effectiveFrom: '2026-03-01', offDays: [7], expectedRevision: 1 });
    expect(res.statusCode, res.body).toBe(201);
    // Saturdays 7 and 14 March: Monday 9 March is unaffected, Saturday 21 March is after the next entry.
    expect(res.json().reprocess).toEqual({
      days: [
        { workDate: SAT, toReprocess: 1, amended: 0, locked: 0 },
        { workDate: '2026-03-14', toReprocess: 1, amended: 0, locked: 0 },
      ],
      truncated: false,
    });
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'WEEKLY_OFF', calculationCount: 1 });
    await processDay(SAT);
    expect(await recordOn(e.id, SAT)).toMatchObject({ status: 'ABSENT', calculationCount: 2 });
    expect((await h.call(hr, 'GET', `/v1/attendance/records/${(await recordOn(e.id, SAT)).id}/amendments`)).json().revisions).toMatchObject([{ status: 'WEEKLY_OFF', cause: 'PROCESSING' }]);
    // Identical pattern, nothing can change.
    expect((await post(site, { effectiveFrom: '2026-03-01', offDays: [7], expectedRevision: 2 })).json().reprocess).toEqual({ days: [], truncated: false });
  });
});

describe('leave days count on the location calendar (FR-024, FR-026, DF05)', () => {
  const employeeAt = async (site: string) => {
    const e = await worker(site);
    return { ...e, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
  };
  const request = (a: TestActor, startDate: string, endDate: string) => h.call(a, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate, endDate });

  it('Friday to Monday is three days on a Saturday-working location and two on the default', async () => {
    const six = await sixDaySite();
    const onSix = await employeeAt(six);
    const onDefault = await employeeAt(A.loc);
    const fri = ahead(4, 5);
    const mon = addDays(fri, 3);
    const res = await request(onSix.actor, fri, mon);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().units).toBe('3');
    expect((await request(onDefault.actor, fri, mon)).json().units).toBe('2');
  });

  it('a single off day has no working days; a Saturday on a Saturday-working location is one day', async () => {
    const six = await sixDaySite();
    const onSix = await employeeAt(six);
    const onDefault = await employeeAt(A.loc);
    const sat = ahead(6, 6);
    const sun = ahead(6, 7);
    expect(await refusal(await request(onSix.actor, sun, sun))).toEqual([422, 'NO_WORKING_DAYS']);
    expect(await refusal(await request(onDefault.actor, sat, sat))).toEqual([422, 'NO_WORKING_DAYS']);
    const res = await request(onSix.actor, sat, sat);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().units).toBe('1');
  });

  it('the pattern in force on each day counts: a pattern from mid-request applies from its date', async () => {
    const site = await location();
    const sat2 = ahead(9, 6);
    expect((await post(site, { effectiveFrom: sat2, offDays: [7] })).statusCode).toBe(201);
    const e = await employeeAt(site);
    // Saturday of the week before is off (default); the Saturday from the pattern's date is worked.
    const res = await request(e.actor, addDays(sat2, -7), sat2);
    expect(res.statusCode, res.body).toBe(201);
    // Mon-Fri of the week between, and the second Saturday: Sat(-7) off, Sun off.
    expect(res.json().units).toBe('6');
  });

  it('a location change mid-request counts each day on the calendar of that day', async () => {
    const six = await sixDaySite();
    const e = await employeeAt(A.loc);
    const sat1 = ahead(12, 6);
    const moveOn = addDays(sat1, 2); // The Monday after the first Saturday.
    await h.db.query(`update employment_assignment set effective_to = $2 where employee_id = $1 and effective_to is null`, [e.id, moveOn]);
    await h.db.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id, effective_from)
       select company_id, employee_id, department_id, $3, designation_id, grade_id, $2 from employment_assignment where employee_id = $1 and effective_to = $2`,
      [e.id, moveOn, six],
    );
    const res = await request(e.actor, sat1, addDays(sat1, 7));
    expect(res.statusCode, res.body).toBe(201);
    // First Saturday and Sunday off on the default; Monday to Saturday worked on the six-day calendar.
    expect(res.json().units).toBe('6');
  });

  it('a withdrawn holiday counts as a working day again; a corrected one counts on its new date', async () => {
    const site = await location();
    const e = await employeeAt(site);
    const tue = ahead(15, 2);
    const wed = addDays(tue, 1);
    const holiday = (await h.call(hr, 'POST', '/v1/holidays', { locationId: site, holidayDate: tue, name: 'Synthetic holiday' })).json();
    expect(await refusal(await request(e.actor, tue, tue))).toEqual([422, 'NO_WORKING_DAYS']);
    const fixed = await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/correct`, { expectedVersion: 1, reason: 'Wrong date (synthetic)', holidayDate: wed });
    expect(fixed.statusCode, fixed.body).toBe(201);
    expect(await refusal(await request(e.actor, wed, wed))).toEqual([422, 'NO_WORKING_DAYS']);
    const res = await request(e.actor, tue, tue);
    expect(res.statusCode, res.body).toBe(201);
    expect((await h.call(hr, 'POST', `/v1/holidays/${fixed.json().id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' })).statusCode).toBe(200);
    expect((await request(e.actor, wed, wed)).json().units).toBe('1');
  });

  it('a request already made keeps its units when the calendar changes later', async () => {
    const site = await location();
    const e = await employeeAt(site);
    const fri = ahead(18, 5);
    const made = await request(e.actor, fri, addDays(fri, 1));
    expect(made.json().units).toBe('1');
    expect((await post(site, { effectiveFrom: fri, offDays: [7] })).statusCode).toBe(201);
    const row = await h.one<{ requested_units: string }>(`select requested_units from leave_request where id = $1`, [made.json().requestId]);
    expect(Number(row.requested_units)).toBe(1);
  });
});

describe('work requests count on the location calendar (FR-027)', () => {
  const employeeAt = async (site: string) => h.actor(A, 'EMPLOYEE', { employeeId: (await worker(site)).id });
  const submit = (a: TestActor, kind: string, day: string) => h.call(a, 'POST', `/v1/work-requests/${kind}`, { purpose: 'Client site visit (synthetic)', startDate: day, endDate: day });

  it('Saturday is a working day for outdoor duty, not an off day for holiday work; Sunday is the reverse', async () => {
    const six = await sixDaySite();
    const onSix = await employeeAt(six);
    const onDefault = await employeeAt(A.loc);
    const sat = ahead(5, 6);
    const sun = ahead(5, 7);
    const duty = await submit(onSix, 'outdoor_duty', sat);
    expect(duty.statusCode, duty.body).toBe(201);
    expect(await refusal(await submit(onSix, 'holiday_work', ahead(7, 6)))).toEqual([422, 'NOT_AN_OFF_DAY']);
    expect((await submit(onSix, 'holiday_work', sun)).statusCode).toBe(201);
    expect(await refusal(await submit(onSix, 'outdoor_duty', ahead(8, 7)))).toEqual([422, 'NO_WORKING_DAYS']);
    // The default calendar on the same dates.
    expect(await refusal(await submit(onDefault, 'outdoor_duty', sat))).toEqual([422, 'NO_WORKING_DAYS']);
    expect((await submit(onDefault, 'holiday_work', sat)).statusCode).toBe(201);
  });
});

describe.runIf(isModuleActive('timesheet'))('timesheet utilisation counts on the location calendar (F1, I-30)', () => {
  const scheduled = async (employeeId: string, from: string, to: string) =>
    ((await h.call(hr, 'GET', `/v1/timesheet-reports/utilisation?from=${from}&to=${to}&employeeId=${employeeId}`)).json().items[0] as { scheduledMinutes: number }).scheduledMinutes;

  it('counts Saturdays of a six-day location, drops a withdrawn holiday and uses the shift revision in force each day', async () => {
    const six = await sixDaySite();
    const onSix = await worker(six);
    const onDefault = await worker(A.loc);
    // Monday 2 to Sunday 8 March.
    expect(await scheduled(onSix.id, '2026-03-02', SUN)).toBe(6 * 480);
    expect(await scheduled(onDefault.id, '2026-03-02', SUN)).toBe(5 * 480);
    const holiday = (await h.call(hr, 'POST', '/v1/holidays', { locationId: six, holidayDate: '2026-03-04', name: 'Synthetic holiday' })).json();
    expect(await scheduled(onSix.id, '2026-03-02', SUN)).toBe(5 * 480);
    await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' });
    expect(await scheduled(onSix.id, '2026-03-02', SUN)).toBe(6 * 480);

    const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: uniq('S').toUpperCase(), name: 'Revised', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json();
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: shift.id, effectiveFrom: '2026-01-05' });
    const revised = await h.call(hr, 'POST', `/v1/shifts/${shift.id}/revisions`, { expectedVersion: shift.version, effectiveFrom: '2026-03-04', inTime: '09:00', outTime: '17:00', breaks: [], reason: 'Shorter day (synthetic)' });
    expect(revised.statusCode, revised.body).toBe(201);
    // Monday and Tuesday at 480 net, Wednesday to Friday at 480 elapsed with no break: 5 x 480.
    expect(await scheduled(e.id, '2026-03-02', FRI)).toBe(5 * 480);
    const shorter = await h.call(hr, 'POST', `/v1/shifts/${shift.id}/revisions`, { expectedVersion: revised.json().version, effectiveFrom: '2026-03-05', inTime: '09:00', outTime: '16:00', breaks: [], reason: 'Shorter again (synthetic)' });
    expect(shorter.statusCode, shorter.body).toBe(201);
    // Thursday and Friday now at 420.
    expect(await scheduled(e.id, '2026-03-02', FRI)).toBe(3 * 480 + 2 * 420);
  });
});
