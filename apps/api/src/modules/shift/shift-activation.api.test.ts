// Shifts, holidays and employee activation over HTTP (FR-005, BR-008, DF04, DF05).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { approvedExit } from '../payroll/payroll.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let dayShift: { id: string; version: number };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

const createShift = (body: object) => h.call(hr, 'POST', '/v1/shifts', { bufferMinutes: 240, ...body });

describe('shift definitions (FR-005, BR-008)', () => {
  it('DF05 default day shift: 09:00-18:00 with a 60-minute unpaid break gives 480 net minutes', async () => {
    const res = await createShift({ code: 'day', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: 'DAY', spansMidnight: false, scheduledMinutes: 540, netScheduledMinutes: 480 });
    dayShift = res.json();
  });

  it('overnight shift crosses midnight explicitly with a positive duration', async () => {
    const res = await createShift({ code: 'NIGHT', name: 'Night', inTime: '22:00', outTime: '06:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ spansMidnight: true, scheduledMinutes: 480, netScheduledMinutes: 450 });
  });

  it('rejects zero-length shifts, breaks outside the shift and overlapping breaks', async () => {
    expect((await createShift({ code: 'ZERO', name: 'Zero', inTime: '09:00', outTime: '09:00', breaks: [] })).statusCode).toBe(422);
    const outside = await createShift({ code: 'OUT', name: 'Out', inTime: '09:00', outTime: '13:00', breaks: [{ startOffsetMinutes: 200, endOffsetMinutes: 260 }] });
    expect(outside.statusCode).toBe(422);
    const overlap = await createShift({
      code: 'OVL',
      name: 'Overlap',
      inTime: '09:00',
      outTime: '18:00',
      breaks: [
        { startOffsetMinutes: 120, endOffsetMinutes: 180 },
        { startOffsetMinutes: 150, endOffsetMinutes: 200 },
      ],
    });
    expect(overlap.statusCode).toBe(409);
    // A failed creation leaves nothing behind (transactional).
    const codes = (await h.call(hr, 'GET', '/v1/shifts')).json().items.map((s: { code: string }) => s.code);
    expect(codes).not.toContain('OVL');
    expect(codes).not.toContain('OUT');
  });
});

describe('holiday calendars (FR-005)', () => {
  it('stores per-location holidays and rejects a duplicate date of the same type', async () => {
    const body = { locationId: A.loc, holidayDate: '2026-08-15', name: 'Synthetic holiday' };
    expect((await h.call(hr, 'POST', '/v1/holidays', body)).statusCode).toBe(201);
    expect((await h.call(hr, 'POST', '/v1/holidays', body)).statusCode).toBe(409);
    const list = (await h.call(hr, 'GET', `/v1/holidays?locationId=${A.loc}&year=2026`)).json();
    expect(list.items).toMatchObject([{ holidayDate: '2026-08-15', holidayType: 'HOLIDAY' }]);
    const other = await h.call(hr, 'POST', '/v1/holidays', { ...body, holidayType: 'NOT_A_TYPE' });
    expect(other.statusCode).toBe(422);
  });
});

describe('employee activation (DF04)', () => {
  it('lists every missing requirement, then activates once all are met', async () => {
    const created = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { workEmail: undefined }))).json();
    const blocked = await h.call(hr, 'POST', `/v1/employees/${created.id}/activate`, { expectedVersion: created.version });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().details.missing).toEqual(['WORK_EMAIL', 'SHIFT_ASSIGNMENT', 'MANAGER_OR_NO_MANAGER_REASON']);

    const withEmail = (await h.call(hr, 'PATCH', `/v1/employees/${created.id}`, { expectedVersion: created.version, workEmail: 'new.joiner@example.test' })).json();
    const withShift = (await h.call(hr, 'POST', `/v1/employees/${created.id}/shift`, { shiftId: dayShift.id, effectiveFrom: '2026-01-05' })).json();
    expect(withShift.version).toBe(withEmail.version); // shift lives in its own dated table

    const ok = await h.call(hr, 'POST', `/v1/employees/${created.id}/activate`, {
      expectedVersion: withShift.version,
      noManagerReason: 'Founding member (synthetic)',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ACTIVE_PROBATION');

    const twice = await h.call(hr, 'POST', `/v1/employees/${created.id}/activate`, { expectedVersion: ok.json().version });
    expect(twice.statusCode).toBe(409);

    const history = (await h.call(hr, 'GET', `/v1/employees/${created.id}/history`)).json();
    expect(history.shifts).toMatchObject([{ shiftCode: 'DAY', effectiveFrom: '2026-01-05', effectiveTo: null }]);
  });

  it('accepts a current manager instead of a no-manager reason', async () => {
    const manager = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, manager.id, 'ACTIVE_CONFIRMED');
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: dayShift.id, effectiveFrom: '2026-01-05' });
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: manager.id, effectiveFrom: '2026-01-05' });
    const ok = await h.call(hr, 'POST', `/v1/employees/${e.id}/activate`, { expectedVersion: e.version });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ACTIVE_PROBATION', manager: { id: manager.id } });
  });

  it('an assignment outside the employment dates is rejected on the single route too (FR-023, DF04, I-41)', async () => {
    const assign = (id: string, effectiveFrom: string) => h.call(hr, 'POST', `/v1/employees/${id}/shift`, { shiftId: dayShift.id, effectiveFrom });
    const refused = async (id: string, effectiveFrom: string) => {
      const res = await assign(id, effectiveFrom);
      return [res.statusCode, res.json().error];
    };
    const notice = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, notice.id, 'ACTIVE_CONFIRMED');
    await approvedExit(h, A, notice.id, '2026-08-01', '2026-08-31');
    await h.setStatus(A, notice.id, 'NOTICE');
    expect(await refused(notice.id, '2026-09-01')).toEqual([422, 'AFTER_LAST_WORKING_DATE']);
    expect((await assign(notice.id, '2026-08-31')).statusCode).toBe(200); // the inclusive last working date

    const gone = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, gone.id, 'INACTIVE_SEPARATED');
    expect(await refused(gone.id, '2026-06-01')).toEqual([422, 'EMPLOYMENT_ENDED']);
    const archived = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, archived.id, 'ARCHIVED');
    expect(await refused(archived.id, '2026-06-01')).toEqual([422, 'EMPLOYMENT_ENDED']);
    const assignments = await h.db.query(`select 1 from shift_assignment where employee_id = any($1::uuid[])`, [[gone.id, archived.id]]);
    expect(assignments.rowCount).toBe(0);
  });

  it('rejects assignment of an inactive shift and activation without permission', async () => {
    const off = (await createShift({ code: 'OLD', name: 'Old', inTime: '07:00', outTime: '15:00', breaks: [] })).json();
    await h.call(hr, 'PATCH', `/v1/shifts/${off.id}`, { expectedVersion: off.version, active: false });
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: off.id, effectiveFrom: '2026-01-05' })).statusCode).toBe(422);

    const sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    expect((await h.call(sysAdmin, 'POST', `/v1/employees/${e.id}/activate`, { expectedVersion: e.version })).statusCode).toBe(403);
  });
});
