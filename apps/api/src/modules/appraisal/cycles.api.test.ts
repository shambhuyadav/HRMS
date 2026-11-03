// Appraisal settings and cycles over HTTP and in the database (FR-040; F1 "financial-year cycle"; E11; DB063; DF08;
// DF18 configuration with no invented default). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { addDays, businessDate, enrol, fyStart, HR_OVERSIGHT, openWindows, person } from './appraisal.fixtures.js';

describe.runIf(isModuleActive('appraisal'))('appraisal: settings and cycles', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let hrFin: TestActor;
  let bHr: TestActor;
  let today: string;

  const cycleBody = (overrides: Record<string, unknown> = {}) => ({ code: `fy-${Math.random().toString(36).slice(2, 8)}`, name: 'Synthetic cycle', startDate: fyStart(today), ...overrides });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT });
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    const managerEmp = await person(h, A, hr);
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person(h, A, hr, { managerId: managerEmp }) });
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('has no cycle start month until HR sets one of the explained quarter-start months', async () => {
    expect((await h.call(hr, 'GET', '/v1/appraisal-settings')).json()).toEqual({ configured: false, cycleStartMonth: null, version: null, missing: ['cycleStartMonth'] });
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody())).json()).toMatchObject({ error: 'APPRAISAL_NOT_CONFIGURED', details: { missing: ['cycleStartMonth'] } });
    // FR-040: 1, 4, 7 and 10 are the explained values; anything else is refused.
    expect((await h.call(hr, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 5 })).statusCode).toBe(400);
    for (const a of [manager, employee]) expect((await h.call(a, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 4 })).statusCode).toBe(403);
    expect((await h.call(hrFin, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 4 })).statusCode).toBe(403);
    const set = await h.call(hr, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 4 });
    expect(set.json()).toEqual({ configured: true, cycleStartMonth: 4, version: 1 });
    expect((await h.call(hr, 'PUT', '/v1/appraisal-settings', { cycleStartMonth: 7 })).json().error).toBe('STALE_VERSION');
    expect((await h.call(manager, 'GET', '/v1/appraisal-settings')).json()).toMatchObject({ cycleStartMonth: 4 });
    expect((await h.call(employee, 'GET', '/v1/appraisal-settings')).statusCode).toBe(403);
    // Another company is not configured by this one.
    expect((await h.call(bHr, 'GET', '/v1/appraisal-settings')).json()).toMatchObject({ configured: false });
  });

  it('creates financial-year cycles with ordered windows and one reviewer level by default (F1)', async () => {
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ startDate: `${fyStart(today).slice(0, 4)}-05-01` }))).json()).toMatchObject({ error: 'CYCLE_START_NOT_ALIGNED', details: { cycleStartMonth: 4 } });
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ startDate: `${fyStart(today).slice(0, 4)}-04-02` }))).json().error).toBe('CYCLE_START_NOT_ALIGNED');
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ code: 'bad code!' }))).json().error).toBe('INVALID_CODE');
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ approvalLevels: 3 }))).statusCode).toBe(400);
    const reversed = { ...openWindows(today), selfEntry: { opensOn: addDays(today, 3), closesOn: addDays(today, 1) } };
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ windows: reversed }))).json().error).toBe('INVALID_WINDOW');
    // The rating window would close before the self-entry window does.
    const outOfOrder = { ...openWindows(today), managerRating: { opensOn: addDays(today, -5), closesOn: addDays(today, 8) } };
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ windows: outOfOrder }))).json()).toMatchObject({ error: 'WINDOW_ORDER', details: { earlier: 'SELF_ENTRY', later: 'MANAGER_RATING' } });
    // Company configuration needs an unrestricted company-scope HR assignment.
    expect((await h.call(hrFin, 'POST', '/v1/appraisal-cycles', cycleBody())).statusCode).toBe(403);
    expect((await h.call(manager, 'POST', '/v1/appraisal-cycles', cycleBody())).statusCode).toBe(403);

    const created = await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ code: ' fy-main ', windows: openWindows(today) }));
    expect(created.statusCode, created.body).toBe(201);
    const start = fyStart(today);
    expect(created.json()).toMatchObject({
      code: 'FY-MAIN',
      startDate: start,
      endDate: `${Number(start.slice(0, 4)) + 1}-03-31`,
      approvalLevels: 1,
      state: 'OPEN',
      windows: { goalSetting: { openToday: true }, selfEntry: { openToday: true }, managerRating: { openToday: true } },
      version: 1,
    });
    expect((await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ code: 'FY-MAIN' }))).json().error).toBe('CYCLE_CODE_EXISTS');
    // Windows may be left unscheduled; entries at that stage are then refused.
    const unscheduled = await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ windows: { goalSetting: null } }));
    expect(unscheduled.json()).toMatchObject({ windows: { goalSetting: null, selfEntry: null, managerRating: null } });
    // Readers: HR and managers; other companies never see it.
    const id = created.json().id as string;
    expect((await h.call(manager, 'GET', `/v1/appraisal-cycles/${id}`)).statusCode).toBe(200);
    expect((await h.call(employee, 'GET', `/v1/appraisal-cycles/${id}`)).statusCode).toBe(403);
    expect((await h.call(bHr, 'GET', `/v1/appraisal-cycles/${id}`)).statusCode).toBe(404);
    expect(((await h.call(bHr, 'GET', '/v1/appraisal-cycles')).json().items as unknown[]).length).toBe(0);
    expect(((await h.call(hr, 'GET', '/v1/appraisal-cycles?state=OPEN')).json().items as { id: string }[]).map((c) => c.id)).toContain(id);
  });

  it('updates windows and levels with optimistic versions; closes only when every appraisal is finished', async () => {
    const created = (await h.call(hr, 'POST', '/v1/appraisal-cycles', cycleBody({ windows: openWindows(today) }))).json();
    const update = (body: Record<string, unknown>) => h.call(hr, 'PUT', `/v1/appraisal-cycles/${created.id}`, { name: 'Synthetic renamed cycle', approvalLevels: 2, windows: openWindows(today), ...body });
    expect((await update({ expectedVersion: 99 })).json().error).toBe('STALE_VERSION');
    const updated = await update({ expectedVersion: 1 });
    expect(updated.json()).toMatchObject({ name: 'Synthetic renamed cycle', approvalLevels: 2, version: 2 });
    // An unfinished appraisal keeps the cycle open.
    const e = await person(h, A, hr);
    const appraisal = await enrol(h, hr, created.id, e);
    expect((await h.call(hr, 'POST', `/v1/appraisal-cycles/${created.id}/close`, { expectedVersion: 2 })).json()).toMatchObject({ error: 'OPEN_APPRAISALS', details: { open: 1 } });
    expect((await h.call(hr, 'POST', `/v1/appraisals/${appraisal.id}/cancel`, { reason: 'Synthetic test cancellation', expectedVersion: appraisal.version })).statusCode).toBe(200);
    const closed = await h.call(hr, 'POST', `/v1/appraisal-cycles/${created.id}/close`, { expectedVersion: 2 });
    expect(closed.json()).toMatchObject({ state: 'CLOSED' });
    // A closed cycle is final and takes no new appraisals.
    expect((await update({ expectedVersion: 3 })).json().error).toBe('CYCLE_CLOSED');
    expect((await h.call(hr, 'POST', '/v1/appraisals', { cycleId: created.id, employeeId: e })).json().error).toBe('CYCLE_CLOSED');
    expect((await h.call(hr, 'POST', `/v1/appraisal-cycles/${created.id}/close`, { expectedVersion: 3 })).json().error).toBe('CYCLE_CLOSED');
  });

  it('enforces the cycle and overlap rules in the database too (DF08 direct constraint tests)', async () => {
    const start = fyStart(today, 3);
    const end = `${Number(start.slice(0, 4)) + 1}-03-31`;
    // Not a twelve-month period from the first of a month.
    await expect(h.db.query(`insert into appraisal_cycle (company_id, code, name, start_date, end_date) values ($1, 'DB-1', 'x', $2, $3)`, [A.id, start, `${start.slice(0, 4)}-12-31`])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(h.db.query(`insert into appraisal_cycle (company_id, code, name, start_date, end_date) values ($1, 'DB-2', 'x', $2, $3)`, [A.id, addDays(start, 1), addDays(end, 1)])).rejects.toMatchObject({
      code: '23514',
    });
    // Windows out of process order.
    await expect(
      h.db.query(
        `insert into appraisal_cycle (company_id, code, name, start_date, end_date, goal_opens_on, goal_closes_on, self_opens_on, self_closes_on) values ($1, 'DB-3', 'x', $2, $3, $4, $5, $6, $7)`,
        [A.id, start, end, addDays(start, 10), addDays(start, 20), addDays(start, 5), addDays(start, 30)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const cycle = await h.one<{ id: string }>(`insert into appraisal_cycle (company_id, code, name, start_date, end_date) values ($1, 'DB-4', 'x', $2, $3) returning id`, [A.id, start, end]);
    // Code and period never change; reviewer levels are 1 or 2.
    await expect(h.db.query(`update appraisal_cycle set code = 'DB-5' where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_cycle set approval_levels = 3 where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from appraisal_cycle where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    // One employee is never in two overlapping cycles (exclusion constraint), whatever the application does.
    const twin = await h.one<{ id: string }>(`insert into appraisal_cycle (company_id, code, name, start_date, end_date) values ($1, 'DB-6', 'x', $2, $3) returning id`, [A.id, start, end]);
    const e = await person(h, A, hr);
    const insertAppraisal = async (cycleId: string) => {
      const client = await h.pool.connect();
      try {
        await client.query('begin');
        const bt = await client.query<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'appraisal', $2, 'DRAFT') returning id`, [A.id, e]);
        await client.query(
          `insert into appraisal (company_id, cycle_id, period_start, period_end, employee_id, transaction_id, state, source) values ($1, $2, $3, $4, $5, $6, 'DRAFT', 'MANUAL')`,
          [A.id, cycleId, start, end, e, bt.rows[0]!.id],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    };
    await insertAppraisal(cycle.id);
    await expect(insertAppraisal(twin.id)).rejects.toMatchObject({ code: '23P01' });
    // The appraisal's period must be its cycle's (composite key).
    const other = await person(h, A, hr);
    await expect(
      h.db.query(`insert into appraisal (company_id, cycle_id, period_start, period_end, employee_id, transaction_id, state, source) values ($1, $2, $3, $4, $5, gen_random_uuid(), 'DRAFT', 'MANUAL')`, [
        A.id,
        twin.id,
        addDays(start, 1),
        end,
        other,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
