// Payroll and the location calendar (FR-032, FR-033; DF05; I-54; ZT36). Loss of pay counts approved unpaid leave on the
// working days of the employee's location calendar; a revision counts on the calendar known when its calculation started;
// its results rest on its snapshot, so a later calendar change cannot change a rerun; and a calendar change never reaches a
// day a processed payroll used. Synthetic employees and amounts. Unpaid leave of 2026-10 and 2026-03 (2 March is a Monday).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  approvedLeave,
  calculate,
  calendar,
  CONFIG,
  createRun,
  getRun,
  grantOf,
  grants,
  head,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from './payroll.fixtures.js';
import { calculateRun } from './runs.js';

describe.runIf(isModuleActive('payroll'))('payroll on the location calendar (FR-032, FR-033)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let periods: Record<string, string>;

  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, uniq('CAL').toUpperCase()])).id;
  const site = async () => (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, uniq('L').toUpperCase()])).id;
  const pattern = async (locationId: string, offDays: number[], effectiveFrom = '2026-01-01', expectedRevision = 0) =>
    ok(await h.call(hr, 'POST', '/v1/weekly-off-patterns', { locationId, effectiveFrom, offDays, reason: 'Synthetic pattern', expectedRevision }), 201);
  const employee = async (departmentId: string, locationId: string) => {
    const e = await person(h, A, hr, { departmentId, locationId, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'CL_BASIC', amount: '31000' }] });
    return e;
  };
  const runFor = (code: string, departmentId: string) => createRun(h, preparer, periods[code]!, { departmentIds: [departmentId] });
  const days = (lop: { day: string; units: string }[]) => lop.map((d) => [d.day, d.units]);
  const exceptionCodes = (r: { exceptions: { code: string }[] }) => r.exceptions.map((x) => x.code);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'CL_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
    await ok(await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version }));
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('loss of pay falls on the Saturday of a Saturday-working location and not on the same Saturday elsewhere', async () => {
    const dept = await department();
    const six = await site();
    await pattern(six, [7]);
    const onSix = await employee(dept, six);
    const onDefault = await employee(dept, A.loc);
    // Fri 9 to Mon 12 October: three working days at the six-day location, two on the default.
    await approvedLeave(h, A, onSix, 'UNPAID', '2026-10-09', '2026-10-12', '3');
    await approvedLeave(h, A, onDefault, 'UNPAID', '2026-10-09', '2026-10-12', '2');
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const six_ = await record(h, preparer, run.id, onSix);
    expect(days(six_.lossOfPay)).toEqual([
      ['2026-10-09', '1.0000'],
      ['2026-10-10', '1.0000'],
      ['2026-10-12', '1.0000'],
    ]);
    expect(exceptionCodes(six_)).not.toContain('LEAVE_UNITS_MISMATCH');
    // 31000 x 28 / 31 = 28000.00
    expect(six_).toMatchObject({ calculationStatus: 'CALCULATED', paidUnits: '28.0000', earnings: '28000.0000' });
    const def = await record(h, preparer, run.id, onDefault);
    expect(days(def.lossOfPay)).toEqual([
      ['2026-10-09', '1.0000'],
      ['2026-10-12', '1.0000'],
    ]);
    expect(def).toMatchObject({ calculationStatus: 'CALCULATED', paidUnits: '29.0000', earnings: '29000.0000' });
  });

  it('a Friday-off location loses no pay on Friday', async () => {
    const dept = await department();
    const fridayOff = await site();
    await pattern(fridayOff, [5]);
    const e = await employee(dept, fridayOff);
    // Thu 8 to Sat 10 October: Thursday and Saturday are worked, Friday is off.
    await approvedLeave(h, A, e, 'UNPAID', '2026-10-08', '2026-10-10', '2');
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(days(r.lossOfPay)).toEqual([
      ['2026-10-08', '1.0000'],
      ['2026-10-10', '1.0000'],
    ]);
    expect(r.paidUnits).toBe('29.0000');
  });

  it('approved units that no longer match the calendar still block, naming the leave, whichever calendar change caused it', async () => {
    const dept = await department();
    const place = await site();
    const e = await employee(dept, place);
    // Approved as two working days under the default; then the location starts working Saturdays.
    await approvedLeave(h, A, e, 'UNPAID', '2026-10-09', '2026-10-12', '2');
    await pattern(place, [7], '2026-10-01');
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(exceptionCodes(r)).toContain('LEAVE_UNITS_MISMATCH');
    expect(r.calculationStatus).toBe('FAILED');
  });

  it('a withdrawn holiday is a working day to payroll again; an active one is not', async () => {
    const dept = await department();
    const place = await site();
    const e = await employee(dept, place);
    const holiday = await ok<{ id: string }>(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-11-03', name: 'Synthetic holiday' }), 201);
    await approvedLeave(h, A, e, 'UNPAID', '2026-11-02', '2026-11-03', '1');
    const first = await runFor('2026-11', dept);
    await calculate(h, preparer, first.id);
    expect(days((await record(h, preparer, first.id, e)).lossOfPay)).toEqual([['2026-11-02', '1.0000']]);
    expect(exceptionCodes(await record(h, preparer, first.id, e))).not.toContain('LEAVE_UNITS_MISMATCH');

    await ok(await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' }));
    // The first calculation is unmoved; a new revision counts on the calendar as it now stands.
    expect(await ok<{ identical: boolean }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${first.id}/verify`))).toMatchObject({ identical: true });
    expect(days((await record(h, preparer, first.id, e)).lossOfPay)).toEqual([['2026-11-02', '1.0000']]);
    const current = await getRun(h, preparer, first.id);
    const next = await ok<{ id: string }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${first.id}/revise`, { reason: 'Calendar corrected (synthetic)', expectedVersion: current.version }), 201);
    await calculate(h, preparer, next.id);
    const again = await record(h, preparer, next.id, e);
    expect(days(again.lossOfPay)).toEqual([
      ['2026-11-02', '1.0000'],
      ['2026-11-03', '1.0000'],
    ]);
    expect(exceptionCodes(again)).toContain('LEAVE_UNITS_MISMATCH');
  });

  it('a later calendar change cannot change a rerun: the snapshot stays identical to its results (FR-033, ZT36)', async () => {
    const dept = await department();
    const place = await site();
    await pattern(place, [7]);
    const e = await employee(dept, place);
    await approvedLeave(h, A, e, 'UNPAID', '2026-09-04', '2026-09-05', '2');
    const holiday = await ok<{ id: string }>(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-09-15', name: 'Synthetic holiday' }), 201);
    const run = await runFor('2026-09', dept);
    await calculate(h, preparer, run.id);
    const before = await record(h, preparer, run.id, e);
    expect(days(before.lossOfPay)).toEqual([
      ['2026-09-04', '1.0000'],
      ['2026-09-05', '1.0000'],
    ]);

    // Every kind of calendar change, each touching the period and a day of the leave.
    await pattern(place, [6, 7], '2026-09-01', 1);
    await ok(await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' }));
    await ok(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-09-04', name: 'Synthetic holiday' }), 201);

    expect(await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0 });
    expect(await record(h, preparer, run.id, e)).toEqual(before);
  });

  it('every chunk of one revision counts on the calendar known when the calculation started', async () => {
    const dept = await department();
    const place = await site();
    await pattern(place, [7]);
    const staff = [await employee(dept, place), await employee(dept, place)].sort();
    for (const e of staff) await approvedLeave(h, A, e, 'UNPAID', '2026-08-07', '2026-08-08', '2');
    const holiday = await ok<{ id: string }>(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-08-10', name: 'Synthetic holiday' }), 201);
    await approvedLeave(h, A, staff[0]!, 'UNPAID', '2026-08-10', '2026-08-11', '1');
    await approvedLeave(h, A, staff[1]!, 'UNPAID', '2026-08-10', '2026-08-11', '1');
    const run = await createRun(h, preparer, periods['2026-08']!, { departmentIds: [dept] });
    const grant = await grantOf(h, preparer, 'payroll_run', 'prepare', ['amount']);
    await calculateRun(h.pool, grant, run.id, { expectedVersion: run.version }, { chunkSize: 1, maxChunks: 1 });
    expect((await h.db.query(`select 1 from payroll_record where run_id = $1`, [run.id])).rowCount).toBe(1);

    // Between the chunks: Saturday stops being a working day, one holiday goes and a new one comes.
    await pattern(place, [6, 7], '2026-08-01', 1);
    await ok(await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' }));
    await ok(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-08-11', name: 'Synthetic holiday' }), 201);

    await calculateRun(h.pool, grant, run.id, { expectedVersion: 1 }, { chunkSize: 1 });
    const firstRecord = await record(h, preparer, run.id, staff[0]!);
    const secondRecord = await record(h, preparer, run.id, staff[1]!);
    const expected = [
      ['2026-08-07', '1.0000'],
      ['2026-08-08', '1.0000'],
      ['2026-08-11', '1.0000'],
    ];
    expect(days(firstRecord.lossOfPay)).toEqual(expected);
    expect(days(secondRecord.lossOfPay)).toEqual(expected);
    expect(exceptionCodes(secondRecord)).not.toContain('LEAVE_UNITS_MISMATCH');
  });

  it('calendar changes and the start of a calculation take turns, and are stamped after their turn begins', async () => {
    const dept = await department();
    const place = await site();
    await employee(dept, place);
    const run = await runFor('2026-06', dept);
    const grant = await grantOf(h, preparer, 'payroll_run', 'prepare', ['amount']);
    /** Runs `start` while the calendar lock is held; answers the instant just before the lock is released. */
    const whileLocked = async <T>(start: () => Promise<T>): Promise<{ released: string; result: T }> => {
      await h.db.query('begin');
      let pending: Promise<T> | undefined;
      let released = '';
      try {
        await h.db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`calendar:${A.id}`]);
        pending = start();
        let blocked = false;
        for (let i = 0; i < 400 && !blocked; i++) {
          blocked = ((await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rowCount ?? 0) > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(true);
        released = (await h.one<{ at: string }>(`select clock_timestamp()::text as at`)).at;
      } finally {
        await h.db.query('commit');
      }
      return { released, result: await pending! };
    };
    const stampedAfter = async (table: string, column: string, id: string, released: string) =>
      (await h.one<{ later: boolean }>(`select ${column} > $1::timestamptz as later from ${table} where id = $2`, [released, id])).later;

    const entry = await whileLocked(() => h.call(hr, 'POST', '/v1/weekly-off-patterns', { locationId: place, effectiveFrom: '2026-06-01', offDays: [7], reason: 'Synthetic pattern', expectedRevision: 0 }));
    expect(entry.result.statusCode, entry.result.body).toBe(201);
    expect(await stampedAfter('weekly_off_pattern', 'created_at', entry.result.json().id, entry.released)).toBe(true);

    const added = await whileLocked(() => h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-06-10', name: 'Synthetic holiday' }));
    expect(added.result.statusCode, added.result.body).toBe(201);
    expect(await stampedAfter('holiday', 'created_at', added.result.json().id, added.released)).toBe(true);

    const corrected = await whileLocked(() => h.call(hr, 'POST', `/v1/holidays/${added.result.json().id}/correct`, { expectedVersion: 1, reason: 'Wrong date (synthetic)', holidayDate: '2026-06-11' }));
    expect(corrected.result.statusCode, corrected.result.body).toBe(201);
    expect(await stampedAfter('holiday', 'closed_at', added.result.json().id, corrected.released)).toBe(true);
    expect(await stampedAfter('holiday', 'created_at', corrected.result.json().id, corrected.released)).toBe(true);

    const withdrawn = await whileLocked(() => h.call(hr, 'POST', `/v1/holidays/${corrected.result.json().id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' }));
    expect(withdrawn.result.statusCode, withdrawn.result.body).toBe(200);
    expect(await stampedAfter('holiday', 'closed_at', corrected.result.json().id, withdrawn.released)).toBe(true);

    const started = await whileLocked(() => calculateRun(h.pool, grant, run.id, { expectedVersion: run.version }, { chunkSize: 1, maxChunks: 1 }));
    expect(await stampedAfter('payroll_run', 'calendar_as_of', run.id, started.released)).toBe(true);
    // The run shows which calendar it counted on.
    const shown = (await getRun(h, preparer, run.id)) as unknown as { snapshot: { calendarAsOf: string | null } };
    expect(shown.snapshot.calendarAsOf).toEqual(expect.any(String));
  });

  describe('a day a processed payroll used stays as it is (I-54)', () => {
    const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];
    const processed = async (code: string, dept: string) => {
      const run = await runFor(code, dept);
      await calculate(h, preparer, run.id);
      await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
      await processRun(h, processor, run.id);
      return run;
    };
    const processDay = async (workDate: string) => (await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).result;

    it('every calendar change lists the day as locked, processing skips it, its record and the run do not move, and the next day still can', async () => {
      const dept = await department();
      const place = await site();
      const e = await employee(dept, place);
      const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: uniq('S').toUpperCase(), name: 'Own', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json();
      await ok(await h.call(hr, 'POST', `/v1/employees/${e}/shift`, { shiftId: shift.id, effectiveFrom: '2026-01-05' }));
      const holiday = await ok<{ id: string }>(await h.call(hr, 'POST', '/v1/holidays', { locationId: place, holidayDate: '2026-03-03', name: 'Synthetic holiday' }), 201);
      await processDay('2026-03-03'); // HOLIDAY
      await processDay('2026-03-07'); // WEEKLY_OFF
      const sat = await recordOn(e, '2026-03-07');
      expect(sat.status).toBe('WEEKLY_OFF');
      const hol = await recordOn(e, '2026-03-03');
      expect(hol).toMatchObject({ status: 'HOLIDAY', scheduledNetMinutes: 480 });
      const run = await processed('2026-03', dept);
      expect((await getRun(h, processor, run.id)).state).toBe('PROCESSED_LOCKED');

      // A withdrawal, a pattern and a shift revision, each reaching the used days.
      const withdrawn = await ok<{ reprocess: { days: unknown[] } }>(await h.call(hr, 'POST', `/v1/holidays/${holiday.id}/withdraw`, { expectedVersion: 1, reason: 'Withdrawn (synthetic)' }));
      expect(withdrawn.reprocess.days).toEqual([{ workDate: '2026-03-03', toReprocess: 0, amended: 0, locked: 1 }]);
      const off = await ok<{ reprocess: { days: unknown[] } }>(await h.call(hr, 'POST', '/v1/weekly-off-patterns', { locationId: place, effectiveFrom: '2026-03-01', offDays: [7], reason: 'Synthetic pattern', expectedRevision: 0 }), 201);
      expect(off.reprocess.days).toEqual([{ workDate: '2026-03-07', toReprocess: 0, amended: 0, locked: 1 }]);
      const revised = await ok<{ reprocess: { days: { workDate: string; locked: number }[] } }>(
        await h.call(hr, 'POST', `/v1/shifts/${shift.id}/revisions`, { expectedVersion: shift.version, effectiveFrom: '2026-03-01', inTime: '08:00', outTime: '12:00', breaks: [], reason: 'Synthetic revision' }),
        201,
      );
      expect(revised.reprocess.days).toEqual([
        { workDate: '2026-03-03', toReprocess: 0, amended: 0, locked: 1 },
        { workDate: '2026-03-07', toReprocess: 0, amended: 0, locked: 1 },
      ]);

      // HR's processing skips both, with a count, and the results stay.
      expect((await processDay('2026-03-03')).SKIPPED_LOCKED).toBeGreaterThanOrEqual(1);
      expect((await processDay('2026-03-07')).SKIPPED_LOCKED).toBeGreaterThanOrEqual(1);
      expect(await recordOn(e, '2026-03-03')).toEqual(hol);
      expect(await recordOn(e, '2026-03-07')).toEqual(sat);
      expect(await ok(await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true });

      // The database refuses a direct change of the basis of a used day too.
      const rev = await h.one<{ id: string; shift_id: string }>(`select r.id, r.shift_id from shift_revision r where r.shift_id = $1`, [shift.id]);
      await expect(h.db.query(`update attendance_record set shift_revision_id = $2 where id = $1`, [hol.id, rev.id])).rejects.toThrow(/processed payroll/);

      // April was not frozen: the same changes reach it when HR processes it.
      await processDay('2026-04-04');
      expect(await recordOn(e, '2026-04-04')).toMatchObject({ status: 'ABSENT', scheduledNetMinutes: 240 });
    });
  });

  it('no pattern at all keeps Monday to Friday: leave over a weekend loses only its working days', async () => {
    const dept = await department();
    const e = await employee(dept, A.loc);
    await approvedLeave(h, A, e, 'UNPAID', '2026-07-10', '2026-07-13', '2');
    const run = await runFor('2026-07', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(days(r.lossOfPay)).toEqual([
      ['2026-07-10', '1.0000'],
      ['2026-07-13', '1.0000'],
    ]);
    expect(exceptionCodes(r)).not.toContain('LEAVE_UNITS_MISMATCH');
  });
});
