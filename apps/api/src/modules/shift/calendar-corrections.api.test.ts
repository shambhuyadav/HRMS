// Holiday correction and withdrawal, and effective-dated shift revisions, over HTTP (FR-005, FR-020, FR-021; DF05 "Shift and
// holiday calendars are editable and effective-dated"; DF08 "Corrections append attributable superseding entries"; I-04's
// rule: an evaluated day changes only when HR processes it again). Synthetic data; fixed past dates (2026-03-02 is a Monday).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let dayShift: string;

const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const THU = '2026-03-05';
const FRI = '2026-03-06';

const location = async () => (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, uniq('L').toUpperCase()])).id;
const worker = async (locationId = A.loc, shiftId = dayShift): Promise<{ id: string; code: string }> => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  return { id: e.id, code: e.employeeCode };
};
const processDay = async (workDate: string) => (await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).result;
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];
const dayView = async (recordId: string) => (await h.call(hr, 'GET', `/v1/attendance/records/${recordId}/day`)).json();
const revisionsOf = async (recordId: string) => (await h.call(hr, 'GET', `/v1/attendance/records/${recordId}/amendments`)).json().revisions as { status: string; cause: string; scheduledNetMinutes: number }[];
const punch = (code: string, d: string, inAt: string, outAt: string) =>
  h.call(hr, 'POST', '/v1/attendance/punches', {
    punches: [
      { employeeCode: code, occurredAt: `${d}T${inAt}:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') },
      { employeeCode: code, occurredAt: `${d}T${outAt}:00+05:30`, direction: 'OUT', externalEventKey: uniq('evt-') },
    ],
  });

const addHoliday = (locationId: string, holidayDate: string, extra: object = {}) => h.call(hr, 'POST', '/v1/holidays', { locationId, holidayDate, name: 'Synthetic holiday', ...extra });
const listHolidays = async (locationId: string, state?: string) =>
  (await h.call(hr, 'GET', `/v1/holidays?locationId=${locationId}&year=2026${state ? `&state=${state}` : ''}`)).json().items as { id: string; holidayDate: string; name: string; state: string; version: number; supersedesId: string | null; supersededById: string | null; closedBy: string | null; closedReason: string | null }[];
const correct = (id: string, body: object, a = hr) => h.call(a, 'POST', `/v1/holidays/${id}/correct`, { expectedVersion: 1, reason: 'Entered wrongly (synthetic)', ...body });
const withdraw = (id: string, a = hr, body: object = {}) => h.call(a, 'POST', `/v1/holidays/${id}/withdraw`, { expectedVersion: 1, reason: 'Declared by mistake (synthetic)', ...body });

const newShift = async (over: object = {}) => {
  const res = await h.call(hr, 'POST', '/v1/shifts', { code: uniq('S').toUpperCase(), name: 'Synthetic shift', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }], ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number };
};
const revise = (id: string, version: number, body: object, a = hr) =>
  h.call(a, 'POST', `/v1/shifts/${id}/revisions`, { expectedVersion: version, effectiveFrom: THU, inTime: '10:00', outTime: '19:00', breaks: [{ startOffsetMinutes: 180, endOffsetMinutes: 210 }], reason: 'Site hours moved (synthetic)', ...body });
const shiftOf = async (id: string) => ((await h.call(hr, 'GET', '/v1/shifts')).json().items as { id: string; version: number }[]).find((s) => s.id === id)!;

/**
 * Fires a request that passes the route guard and then, inside its transaction, waits for the assignment row this helper
 * holds (reassertAccess share-locks it). The grant is revoked meanwhile, so only that check can refuse the request.
 */
async function revokedAfterGuard(a: TestActor, fire: () => ReturnType<typeof h.call>) {
  await h.db.query('begin');
  let pending: ReturnType<typeof h.call> | undefined;
  try {
    await h.db.query(`select 1 from role_assignment where company_id = $1 and id = $2 for update`, [A.id, a.assignment]);
    pending = fire();
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      const waiting = await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
      blocked = (waiting.rowCount ?? 0) > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2`, [A.id, a.assignment]);
  } finally {
    await h.db.query('commit');
  }
  return pending!;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  dayShift = (await newShift()).id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('holiday withdrawal keeps the record (FR-005, DF08, I-04)', () => {
  it('stops applying, stays readable and attributed, and re-evaluates nothing until HR processes the date', async () => {
    const site = await location();
    const e = await worker(site);
    const elsewhere = await worker(); // Another calendar: FR-005 "a location holiday applies only to employees assigned to that calendar".
    const id = (await addHoliday(site, TUE)).json().id as string;
    await processDay(TUE);
    expect(await recordOn(e.id, TUE)).toMatchObject({ status: 'HOLIDAY', calculationCount: 1 });
    expect(await recordOn(elsewhere.id, TUE)).toMatchObject({ status: 'ABSENT' });

    const res = await withdraw(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, state: 'WITHDRAWN', reprocess: { days: [{ workDate: TUE, toReprocess: 1, amended: 0, locked: 0 }], truncated: false } });

    // The calendar in force no longer has it; the entry is still there, with who and why.
    expect(await listHolidays(site)).toEqual([]);
    expect(await listHolidays(site, 'WITHDRAWN')).toMatchObject([{ id, holidayDate: TUE, state: 'WITHDRAWN', closedBy: hr.user, closedReason: 'Declared by mistake (synthetic)' }]);
    expect(await listHolidays(site, 'ALL')).toHaveLength(1);
    const audit = await h.one<{ reason: string; actor_user_id: string; before_values: { operational: { state: string } }; after_values: { operational: { evaluatedDays: { toReprocess: number } } } }>(
      `select reason, actor_user_id, before_values, after_values from audit_event where company_id = $1 and resource_code = 'holiday' and record_key = $2 and action = 'WITHDRAW'`,
      [A.id, id],
    );
    expect(audit).toMatchObject({ reason: 'Declared by mistake (synthetic)', actor_user_id: hr.user, before_values: { operational: { state: 'ACTIVE' } }, after_values: { operational: { evaluatedDays: { toReprocess: 1 } } } });

    // Evaluated before: unchanged until HR reprocesses, and then the earlier values stay as history.
    const before = await recordOn(e.id, TUE);
    expect(before).toMatchObject({ status: 'HOLIDAY', calculationCount: 1 });
    expect((await processDay(TUE)).UPDATED).toBeGreaterThanOrEqual(1);
    const after = await recordOn(e.id, TUE);
    expect(after).toMatchObject({ status: 'ABSENT', calculationCount: 2 });
    expect(await revisionsOf(after.id)).toMatchObject([{ status: 'HOLIDAY', cause: 'PROCESSING' }]);
    // The withdrawn date is not a holiday fact any more.
    const refused = await h.call(hr, 'POST', `/v1/attendance/records/${after.id}/amend`, { expectedVersion: after.version, status: 'HOLIDAY', reason: 'Synthetic' });
    expect([refused.statusCode, refused.json().error]).toEqual([422, 'NOT_A_HOLIDAY']);

    // A withdrawn date can be declared again; only one active entry per date and type.
    expect((await addHoliday(site, TUE)).statusCode).toBe(201);
    expect((await addHoliday(site, TUE)).statusCode).toBe(409);
  });

  it('needs a reason and the current version; a closed entry cannot change again', async () => {
    const site = await location();
    const id = (await addHoliday(site, WED)).json().id as string;
    expect((await h.call(hr, 'POST', `/v1/holidays/${id}/withdraw`, { expectedVersion: 1 })).statusCode).toBe(400);
    expect((await withdraw(id, hr, { reason: '   ' })).statusCode).toBe(422);
    const stale = await withdraw(id, hr, { expectedVersion: 7 });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    expect(await listHolidays(site)).toHaveLength(1);
    expect((await withdraw(id)).statusCode).toBe(200);
    const again = await withdraw(id, hr, { expectedVersion: 2 });
    expect([again.statusCode, again.json().error]).toEqual([409, 'HOLIDAY_CLOSED']);
    const corrected = await correct(id, { expectedVersion: 2, name: 'Too late' });
    expect([corrected.statusCode, corrected.json().error]).toEqual([409, 'HOLIDAY_CLOSED']);
  });

  it('an amended day stays as it is and is counted apart', async () => {
    const site = await location();
    const e = await worker(site);
    const id = (await addHoliday(site, FRI)).json().id as string;
    await processDay(FRI);
    const r = await recordOn(e.id, FRI);
    expect((await h.call(hr, 'POST', `/v1/attendance/records/${r.id}/amend`, { expectedVersion: r.version, status: 'PRESENT', reason: 'Synthetic' })).statusCode).toBe(200);
    expect((await withdraw(id)).json().reprocess.days).toEqual([{ workDate: FRI, toReprocess: 0, amended: 1, locked: 0 }]);
    expect((await processDay(FRI)).SKIPPED_AMENDED).toBeGreaterThanOrEqual(1);
    expect(await recordOn(e.id, FRI)).toMatchObject({ status: 'PRESENT', amended: true });
  });
});

describe('a holiday added after the day was evaluated (I-04)', () => {
  it('lists the date for HR and changes the day only when it is processed again', async () => {
    const site = await location();
    const e = await worker(site);
    await processDay('2026-03-25');
    expect(await recordOn(e.id, '2026-03-25')).toMatchObject({ status: 'ABSENT', calculationCount: 1 });
    const res = await addHoliday(site, '2026-03-25');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().reprocess).toEqual({ days: [{ workDate: '2026-03-25', toReprocess: 1, amended: 0, locked: 0 }], truncated: false });
    expect(await recordOn(e.id, '2026-03-25')).toMatchObject({ status: 'ABSENT', calculationCount: 1 });
    await processDay('2026-03-25');
    expect(await recordOn(e.id, '2026-03-25')).toMatchObject({ status: 'HOLIDAY', calculationCount: 2 });
  });
});

describe('holiday correction appends a superseding entry (DF08)', () => {
  it('moves a wrong date: the wrong entry stays closed, the new one names it, and both dates are listed for HR', async () => {
    const site = await location();
    const e = await worker(site);
    const id = (await addHoliday(site, '2026-03-10', { name: 'Wrong date' })).json().id as string;
    await processDay('2026-03-10');
    await processDay('2026-03-11');
    expect(await recordOn(e.id, '2026-03-10')).toMatchObject({ status: 'HOLIDAY' });
    expect(await recordOn(e.id, '2026-03-11')).toMatchObject({ status: 'ABSENT' });

    const res = await correct(id, { holidayDate: '2026-03-11' });
    expect(res.statusCode, res.body).toBe(201);
    const fixed = res.json();
    expect(fixed).toMatchObject({ supersedesId: id, holidayDate: '2026-03-11', name: 'Wrong date', holidayType: 'HOLIDAY', locationId: site });
    expect(fixed.reprocess.days).toEqual([
      { workDate: '2026-03-10', toReprocess: 1, amended: 0, locked: 0 },
      { workDate: '2026-03-11', toReprocess: 1, amended: 0, locked: 0 },
    ]);

    expect(await listHolidays(site)).toMatchObject([{ id: fixed.id, holidayDate: '2026-03-11', state: 'ACTIVE', supersedesId: id, supersededById: null }]);
    expect(await listHolidays(site, 'ALL')).toMatchObject([
      { id, holidayDate: '2026-03-10', state: 'SUPERSEDED', supersededById: fixed.id, closedBy: hr.user, closedReason: 'Entered wrongly (synthetic)' },
      { id: fixed.id, holidayDate: '2026-03-11', state: 'ACTIVE' },
    ]);
    const audit = await h.one<{ before_values: { operational: { holidayDate: string } }; after_values: { operational: { holidayDate: string; supersededBy: string } } }>(
      `select before_values, after_values from audit_event where company_id = $1 and resource_code = 'holiday' and record_key = $2 and action = 'CORRECT'`,
      [A.id, id],
    );
    expect(audit).toMatchObject({ before_values: { operational: { holidayDate: '2026-03-10' } }, after_values: { operational: { holidayDate: '2026-03-11', supersededBy: fixed.id } } });

    // Both days keep their results until HR reprocesses them.
    expect(await recordOn(e.id, '2026-03-10')).toMatchObject({ status: 'HOLIDAY' });
    await processDay('2026-03-10');
    await processDay('2026-03-11');
    expect(await recordOn(e.id, '2026-03-10')).toMatchObject({ status: 'ABSENT' });
    expect(await recordOn(e.id, '2026-03-11')).toMatchObject({ status: 'HOLIDAY' });
  });

  it('a change of name or type moves no day; a move to another location lists both calendars', async () => {
    const site = await location();
    const other = await location();
    const inSite = await worker(site);
    const inOther = await worker(other);
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'HOLIDAY_TYPE', 'RESTRICTED', 'Restricted', true)`, [A.id]);
    const id = (await addHoliday(site, '2026-03-12')).json().id as string;
    await processDay('2026-03-12');
    const renamed = (await correct(id, { name: 'Renamed', holidayType: 'RESTRICTED' })).json();
    expect(renamed).toMatchObject({ name: 'Renamed', holidayType: 'RESTRICTED', reprocess: { days: [], truncated: false } });

    const moved = await correct(renamed.id, { locationId: other });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json().reprocess.days).toEqual([{ workDate: '2026-03-12', toReprocess: 2, amended: 0, locked: 0 }]);
    expect(await listHolidays(site)).toEqual([]);
    expect(await listHolidays(other)).toHaveLength(1);
    await processDay('2026-03-12');
    expect(await recordOn(inSite.id, '2026-03-12')).toMatchObject({ status: 'ABSENT' });
    expect(await recordOn(inOther.id, '2026-03-12')).toMatchObject({ status: 'HOLIDAY' });
  });

  it('a renamed entry keeps a type since retired; moving it needs a type in force on the new date (DF04)', async () => {
    const site = await location();
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'HOLIDAY_TYPE', 'SEASONAL', 'Seasonal', true)`, [A.id]);
    const id = (await addHoliday(site, '2026-03-26', { holidayType: 'SEASONAL' })).json().id as string;
    await h.db.query(`update reference_value set active = false where company_id = $1 and category = 'HOLIDAY_TYPE' and code = 'SEASONAL'`, [A.id]);
    const moved = await correct(id, { holidayDate: '2026-03-27' });
    expect([moved.statusCode, moved.json().error]).toEqual([422, 'INVALID_REFERENCE']);
    const renamed = await correct(id, { name: 'Renamed' });
    expect(renamed.statusCode, renamed.body).toBe(201);
    expect(renamed.json()).toMatchObject({ name: 'Renamed', holidayType: 'SEASONAL', holidayDate: '2026-03-26' });
  });

  it('refuses no change, an unknown type or location, and a clash with another active entry, leaving the entry as it was', async () => {
    const site = await location();
    const id = (await addHoliday(site, '2026-03-16', { name: 'Original' })).json().id as string;
    await addHoliday(site, '2026-03-17');
    const noChange = await correct(id, { name: 'Original', holidayDate: '2026-03-16' });
    expect([noChange.statusCode, noChange.json().error]).toEqual([422, 'NO_CHANGE']);
    expect((await correct(id, {})).statusCode).toBe(400);
    const type = await correct(id, { holidayType: 'NOT_A_TYPE' });
    expect([type.statusCode, type.json().error]).toEqual([422, 'INVALID_REFERENCE']);
    const place = await correct(id, { locationId: '00000000-0000-4000-8000-000000000001' });
    expect([place.statusCode, place.json().error]).toEqual([422, 'INVALID_REFERENCE']);
    const clash = await correct(id, { holidayDate: '2026-03-17' });
    expect([clash.statusCode, clash.json().error]).toEqual([409, 'DUPLICATE']);
    expect(await listHolidays(site)).toMatchObject([
      { id, state: 'ACTIVE', name: 'Original', version: 1 },
      { holidayDate: '2026-03-17', state: 'ACTIVE' },
    ]);
  });
});

describe('holiday authority (FR-002, DF02)', () => {
  it('needs the manage duty, company scope and the entry’s location; another company’s entry is not found', async () => {
    const site = await location();
    const other = await location();
    const id = (await addHoliday(site, '2026-03-18')).json().id as string;
    const employee = await h.actor(A, 'EMPLOYEE');
    expect((await withdraw(id, employee)).statusCode).toBe(403);
    expect((await correct(id, { name: 'x' }, employee)).statusCode).toBe(403);
    const byDepartment = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await withdraw(id, byDepartment)).statusCode).toBe(403);
    const otherSite = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: other });
    expect((await withdraw(id, otherSite)).statusCode).toBe(403);
    expect((await correct(id, { name: 'x' }, otherSite)).statusCode).toBe(403);
    // Its own location is not enough to move an entry to one outside the grant.
    const thisSite = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: site });
    expect((await correct(id, { locationId: other }, thisSite)).statusCode).toBe(403);
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    expect((await withdraw(id, bHr)).statusCode).toBe(404);
    expect(await listHolidays(site)).toMatchObject([{ id, state: 'ACTIVE' }]);
    expect((await withdraw(id, thisSite)).statusCode).toBe(200);
  });

  it('re-checks authority inside the transaction: a grant revoked after the route guard changes nothing', async () => {
    const site = await location();
    const id = (await addHoliday(site, '2026-03-19')).json().id as string;
    const late = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await revokedAfterGuard(late, () => withdraw(id, late))).statusCode).toBe(403);
    const later = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await revokedAfterGuard(later, () => correct(id, { name: 'x' }, later))).statusCode).toBe(403);
    const adder = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await revokedAfterGuard(adder, () => h.call(adder, 'POST', '/v1/holidays', { locationId: site, holidayDate: '2026-03-20', name: 'x' }))).statusCode).toBe(403);
    expect(await listHolidays(site, 'ALL')).toMatchObject([{ id, state: 'ACTIVE', version: 1 }]);
  });

  it('the database keeps every entry: no delete, no rewrite, no reopening', async () => {
    const site = await location();
    const id = (await addHoliday(site, '2026-03-23')).json().id as string;
    await expect(h.db.query(`delete from holiday where id = $1`, [id])).rejects.toThrow(/never deleted/);
    await expect(h.db.query(`update holiday set holiday_date = '2026-03-24' where id = $1`, [id])).rejects.toThrow(/superseding entry/);
    await expect(h.db.query(`update holiday set name = 'Rewritten' where id = $1`, [id])).rejects.toThrow(/superseding entry/);
    await expect(h.db.query(`update holiday set state = 'WITHDRAWN' where id = $1`, [id])).rejects.toThrow(/holiday_closed_attributed/);
    expect((await withdraw(id)).statusCode).toBe(200);
    await expect(h.db.query(`update holiday set state = 'ACTIVE', closed_at = null, closed_by = null, closed_reason = null where id = $1`, [id])).rejects.toThrow(/stays as it was/);
    // One entry replaces another at most once.
    const first = (await addHoliday(site, '2026-03-30')).json().id as string;
    const typeId = (await h.one<{ holiday_type_id: string }>(`select holiday_type_id from holiday where id = $1`, [first])).holiday_type_id;
    expect((await correct(first, { holidayDate: '2026-03-31' })).statusCode).toBe(201);
    await expect(
      h.db.query(`insert into holiday (company_id, location_id, holiday_date, holiday_type_id, name, supersedes_id) values ($1, $2, '2026-04-01', $3, 'Second successor', $4)`, [A.id, site, typeId, first]),
    ).rejects.toThrow(/holiday_one_successor/);
  });
});

describe('effective-dated shift revisions (FR-005, DF05)', () => {
  it('a revision applies from its date; the day before keeps the earlier times; evaluated days keep their basis until reprocessed', async () => {
    const shift = await newShift();
    const e = await worker(A.loc, shift.id);
    await worker(A.loc, dayShift); // On another shift, so never listed for this one.
    await punch(e.code, MON, '09:00', '18:00');
    await processDay(MON);
    const mon = await recordOn(e.id, MON);
    expect(mon).toMatchObject({ status: 'PRESENT', scheduledNetMinutes: 480, workedMinutes: 480, late: false, calculationCount: 1 });

    // From Thursday: 10:00-19:00 with a 30-minute break.
    const created = await revise(shift.id, shift.version, {});
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ inTime: '10:00', outTime: '19:00', scheduledMinutes: 540, netScheduledMinutes: 510, revision: 2, effectiveFrom: THU, reprocess: { days: [], truncated: false } });
    expect(created.json().revisions).toMatchObject([
      { revision: 1, effectiveFrom: null, inTime: '09:00', outTime: '18:00', netScheduledMinutes: 480, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] },
      { revision: 2, effectiveFrom: THU, inTime: '10:00', outTime: '19:00', netScheduledMinutes: 510, breaks: [{ startOffsetMinutes: 180, endOffsetMinutes: 210 }], reason: 'Site hours moved (synthetic)' },
    ]);
    expect(created.json().version).toBe(shift.version + 1);
    const audit = await h.one<{ reason: string; after_values: { operational: { revision: number; inTime: string } } }>(
      `select reason, after_values from audit_event where company_id = $1 and resource_code = 'shift' and record_key = $2 and action = 'REVISE'`,
      [A.id, shift.id],
    );
    expect(audit).toMatchObject({ reason: 'Site hours moved (synthetic)', after_values: { operational: { revision: 2, inTime: '10:00' } } });

    // Wednesday still evaluates on revision 1, Thursday on revision 2.
    await punch(e.code, WED, '09:00', '18:00');
    await processDay(WED);
    expect(await recordOn(e.id, WED)).toMatchObject({ status: 'PRESENT', scheduledNetMinutes: 480, workedMinutes: 480, late: false });
    await punch(e.code, THU, '10:00', '19:00');
    await processDay(THU);
    const thu = await recordOn(e.id, THU);
    expect(thu).toMatchObject({ status: 'PRESENT', scheduledNetMinutes: 510, workedMinutes: 510, late: false });
    expect((await dayView(thu.id)).derived).toMatchObject({ shiftRevision: 2 });

    // A back-dated revision lists the evaluated days it reaches, up to the next revision, and changes none of them.
    const windowBefore = await dayView(mon.id);
    expect(windowBefore.derived).toMatchObject({ shiftRevision: 1 });
    const backdated = await revise(shift.id, shift.version + 1, { effectiveFrom: MON, inTime: '11:00', outTime: '20:00', breaks: [] });
    expect(backdated.statusCode, backdated.body).toBe(201);
    expect(backdated.json().reprocess.days).toEqual([
      { workDate: MON, toReprocess: 1, amended: 0, locked: 0 },
      { workDate: WED, toReprocess: 1, amended: 0, locked: 0 },
    ]);
    expect(await recordOn(e.id, MON)).toEqual(mon);
    expect(await dayView(mon.id)).toEqual(windowBefore);

    // Processing the date moves it to the new basis, and the earlier values stay as history.
    expect((await processDay(MON)).UPDATED).toBeGreaterThanOrEqual(1);
    const reprocessed = await recordOn(e.id, MON);
    expect(reprocessed).toMatchObject({ scheduledNetMinutes: 540, workedMinutes: 540, earlyDeparture: true, calculationCount: 2 });
    expect((await dayView(mon.id)).derived).toMatchObject({ shiftRevision: 3 });
    expect(await revisionsOf(mon.id)).toMatchObject([{ cause: 'PROCESSING', scheduledNetMinutes: 480 }]);
    // Thursday is still on its own revision.
    expect(await recordOn(e.id, THU)).toEqual(thu);
    expect((await processDay(THU)).UPDATED).toBe(0);
  });

  it('a mistaken revision is corrected by a later one on the same date, and a change of basis alone is still recorded', async () => {
    const shift = await newShift();
    const e = await worker(A.loc, shift.id);
    const day = '2026-04-06';
    const first = await revise(shift.id, shift.version, { effectiveFrom: day, inTime: '10:00', outTime: '19:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
    await processDay(day);
    const r = await recordOn(e.id, day);
    expect(r).toMatchObject({ scheduledNetMinutes: 480, status: 'ABSENT' });
    expect((await dayView(r.id)).derived).toMatchObject({ shiftRevision: 2 });
    // The same net minutes on other times: the result is the same but its basis is not.
    const second = await revise(shift.id, first.json().version, { effectiveFrom: day, inTime: '08:00', outTime: '17:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }], reason: 'Corrected (synthetic)' });
    expect(second.json().revisions.map((x: { revision: number }) => x.revision)).toEqual([1, 2, 3]);
    expect((await processDay(day)).UPDATED).toBeGreaterThanOrEqual(1);
    const after = await recordOn(e.id, day);
    expect(after).toMatchObject({ scheduledNetMinutes: 480, status: 'ABSENT', calculationCount: 2 });
    expect((await dayView(r.id)).derived).toMatchObject({ shiftRevision: 3 });
    expect((await processDay(day)).UPDATED).toBe(0);
  });

  it('a later-dated revision is listed but not yet in force; an overnight revision crosses midnight', async () => {
    const shift = await newShift();
    const res = await revise(shift.id, shift.version, { effectiveFrom: '2099-01-01', inTime: '22:00', outTime: '06:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ inTime: '09:00', outTime: '18:00', spansMidnight: false, netScheduledMinutes: 480, revision: 1, effectiveFrom: null });
    expect(res.json().revisions[1]).toMatchObject({ revision: 2, effectiveFrom: '2099-01-01', spansMidnight: true, scheduledMinutes: 480, netScheduledMinutes: 450 });
    expect(await shiftOf(shift.id)).toMatchObject({ revision: 1, inTime: '09:00' });

    // A revision to a night shift: the day belongs to the date the shift starts (DF05), on the revision in force that date.
    const night = await newShift();
    const e = await worker(A.loc, night.id);
    expect((await revise(night.id, night.version, { effectiveFrom: '2026-05-04', inTime: '22:00', outTime: '06:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] })).statusCode).toBe(201);
    await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: [
        { employeeCode: e.code, occurredAt: '2026-05-04T22:00:00+05:30', direction: 'IN', externalEventKey: uniq('evt-') },
        { employeeCode: e.code, occurredAt: '2026-05-05T06:00:00+05:30', direction: 'OUT', externalEventKey: uniq('evt-') },
      ],
    });
    await processDay('2026-05-04');
    expect(await recordOn(e.id, '2026-05-04')).toMatchObject({ status: 'PRESENT', scheduledNetMinutes: 450, workedMinutes: 450, late: false, earlyDeparture: false });
    // The day before keeps the day times.
    await processDay('2026-05-01');
    expect(await recordOn(e.id, '2026-05-01')).toMatchObject({ scheduledNetMinutes: 480 });
  });

  it('refuses a stale version, no reason, an empty shift, a break outside it and overlapping breaks, leaving nothing behind', async () => {
    const shift = await newShift();
    const count = async () => (await h.one<{ n: number }>(`select count(*)::int as n from shift_revision where shift_id = $1`, [shift.id])).n;
    const stale = await revise(shift.id, shift.version + 5, {});
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    expect((await revise(shift.id, shift.version, { reason: undefined })).statusCode).toBe(400);
    expect((await revise(shift.id, shift.version, { reason: '  ' })).statusCode).toBe(422);
    expect((await revise(shift.id, shift.version, { inTime: '09:00', outTime: '09:00', breaks: [] })).statusCode).toBe(422);
    expect((await revise(shift.id, shift.version, { inTime: '09:00', outTime: '13:00', breaks: [{ startOffsetMinutes: 200, endOffsetMinutes: 260 }] })).statusCode).toBe(422);
    const overlap = await revise(shift.id, shift.version, {
      breaks: [
        { startOffsetMinutes: 120, endOffsetMinutes: 180 },
        { startOffsetMinutes: 150, endOffsetMinutes: 200 },
      ],
    });
    expect(overlap.statusCode).toBe(409);
    expect((await revise('00000000-0000-4000-8000-000000000001', 1, {})).statusCode).toBe(404);
    expect(await count()).toBe(0);
    expect(await shiftOf(shift.id)).toMatchObject({ version: shift.version, revisions: [{ revision: 1 }] });
  });

  it('needs the update duty under unrestricted company scope, re-checked inside the transaction', async () => {
    const shift = await newShift();
    const employee = await h.actor(A, 'EMPLOYEE');
    expect((await revise(shift.id, shift.version, {}, employee)).statusCode).toBe(403);
    const bySite = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: A.loc });
    expect((await revise(shift.id, shift.version, {}, bySite)).statusCode).toBe(403);
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    expect((await revise(shift.id, shift.version, {}, bHr)).statusCode).toBe(404);
    const late = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await revokedAfterGuard(late, () => revise(shift.id, shift.version, {}, late))).statusCode).toBe(403);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from shift_revision where shift_id = $1`, [shift.id])).n).toBe(0);
    // The existing writes re-check too.
    const creator = await h.actor(A, 'HR_ADMINISTRATOR');
    const code = uniq('NO').toUpperCase();
    const lateCreate = await revokedAfterGuard(creator, () => h.call(creator, 'POST', '/v1/shifts', { code, name: 'x', inTime: '09:00', outTime: '18:00', breaks: [] }));
    expect(lateCreate.statusCode).toBe(403);
    expect((await h.db.query(`select 1 from shift where company_id = $1 and code = $2`, [A.id, code])).rowCount).toBe(0);
    const renamer = await h.actor(A, 'HR_ADMINISTRATOR');
    const lateRename = await revokedAfterGuard(renamer, () => h.call(renamer, 'PATCH', `/v1/shifts/${shift.id}`, { expectedVersion: shift.version, name: 'Renamed late' }));
    expect(lateRename.statusCode).toBe(403);
    expect(await shiftOf(shift.id)).toMatchObject({ name: 'Synthetic shift', version: shift.version });
  });

  it('the database keeps every basis: shift times, breaks and revisions are never rewritten', async () => {
    const shift = await newShift();
    await expect(h.db.query(`update shift set in_time = '08:00' where id = $1`, [shift.id])).rejects.toThrow(/dated revision/);
    await expect(h.db.query(`update shift_break set end_offset_minutes = 310 where shift_id = $1`, [shift.id])).rejects.toThrow(/dated revision/);
    await expect(h.db.query(`delete from shift_break where shift_id = $1`, [shift.id])).rejects.toThrow(/dated revision/);
    const r = (await revise(shift.id, shift.version, {})).json().revisions[1];
    const row = await h.one<{ id: string }>(`select id from shift_revision where shift_id = $1 and revision = $2`, [shift.id, r.revision]);
    await expect(h.db.query(`update shift_revision set in_time = '08:00' where id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from shift_revision where id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`update shift_revision_break set end_offset_minutes = 220 where shift_revision_id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(
      h.db.query(`insert into shift_revision_break (company_id, shift_revision_id, sequence, start_offset_minutes, end_offset_minutes) values ($1, $2, 9, 600, 700)`, [A.id, row.id]),
    ).rejects.toThrow(/ends after the shift/);
    // A name change is not a time change.
    await expect(h.db.query(`update shift set name = 'Renamed' where id = $1`, [shift.id])).resolves.toBeDefined();
  });
});
