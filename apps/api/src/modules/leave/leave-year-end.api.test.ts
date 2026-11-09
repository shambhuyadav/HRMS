// FR-024 / FR-025 leave year and the year-end expiry above the carry cap over HTTP (DF05 "carry cap/expiry", "Carry is zero
// unless explicitly configured; no negative paid balance"; FR-025 "Opening plus credits minus debits equals closing
// balance"), decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-78 item 3; 0183). Each test has
// its own company, so a run's counts are its own. Leave types, caps and balances are synthetic test values, not policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;

interface World {
  A: Company;
  hr: TestActor;
  activator: TestActor;
  permanent: string;
}

async function world(): Promise<World> {
  const A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const activator = await h.actor(A, 'HR_ADMINISTRATOR');
  // DF05: leave back-dated beyond 7 days is reviewed from the HR fallback list.
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  const options = (await h.call(hr, 'GET', '/v1/leave/policy-options')).json() as { employmentTypes: { id: string; code: string }[] };
  return { A, hr, activator, permanent: options.employmentTypes.find((t) => t.code === 'PERMANENT')!.id };
}

/** A paid leave type whose one active policy (from 2025) has the given carry cap and leave-year start month. */
async function leaveType(w: World, carryCap: string, leaveYearStartMonth: number | null): Promise<string> {
  const code = uniq('T').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
  expect((await h.call(w.hr, 'POST', '/v1/leave/types', { code, name: `Synthetic ${code}`, paid: true })).statusCode).toBe(201);
  const draft = await h.call(w.hr, 'POST', '/v1/leave/policies', {
    leaveType: code,
    effectiveFrom: '2025-01-01',
    eligibility: 'SYNTHETIC_GROUP',
    accrualRule: 'NONE',
    annualEntitlement: '0',
    minServiceDays: 0,
    carryCap,
    leaveYearStartMonth,
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const mapped = await h.call(w.hr, 'POST', `/v1/leave/policies/${draft.json().id}/mappings`, { expectedVersion: draft.json().version, employmentTypeId: w.permanent });
  expect(mapped.statusCode, mapped.body).toBe(201);
  const activated = await h.call(w.activator, 'POST', `/v1/leave/policies/${draft.json().id}/activate`, { expectedVersion: mapped.json().policyVersion });
  expect(activated.statusCode, activated.body).toBe(200);
  return code;
}

async function employee(w: World, openings: Record<string, string>) {
  const e = (await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(w.A, { joiningDate: '2025-01-06' }))).json();
  await h.setStatus(w.A, e.id, 'ACTIVE_CONFIRMED');
  for (const [leaveType, units] of Object.entries(openings)) {
    const res = await h.call(w.hr, 'POST', '/v1/leave/adjustments', {
      employeeId: e.id,
      leaveType,
      kind: 'OPENING',
      units,
      effectiveDate: '2025-01-06',
      reason: 'Opening balance (synthetic)',
      idempotencyKey: uniq('opening-'),
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  return { id: e.id as string, actor: await h.actor(w.A, 'EMPLOYEE', { employeeId: e.id }) };
}

const yearEnd = async (w: World, date: string) => (await h.runBulkJob(w.hr, '/v1/leave/year-end-runs', { yearEnd: date })).result;
const balance = async (w: World, employeeId: string, type: string) =>
  ((await h.call(w.hr, 'GET', `/v1/employees/${employeeId}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string }[]).find((b) => b.leaveType === type)!;
const expiries = async (employeeId: string) =>
  (await h.db.query<{ units: string; effective_date: string }>(`select units::text, to_char(effective_date, 'YYYY-MM-DD') as effective_date from leave_movement where employee_id = $1 and movement_kind = 'EXPIRY' order by created_at`, [employeeId])).rows;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('FR-024 FR-025 the year-end expiry above the carry cap (I-78 item 3)', () => {
  it('FR-024 FR-025 a cap of 3: balances one below, equal to and above keep everything; 4 and 10 expire 1 and 7, once', async () => {
    const w = await world();
    const type = await leaveType(w, '3', 1);
    const people = { two: await employee(w, { [type]: '2' }), three: await employee(w, { [type]: '3' }), four: await employee(w, { [type]: '4' }), ten: await employee(w, { [type]: '10' }) };
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ yearEnd: '2025-12-31', employees: 4, expired: 2, withinCap: 2, pendingRequests: 0, notConfigured: 0 });
    expect(await expiries(people.two.id)).toEqual([]);
    expect(await expiries(people.three.id)).toEqual([]);
    expect(await expiries(people.four.id)).toEqual([{ units: '-1.0000', effective_date: '2025-12-31' }]);
    expect(await expiries(people.ten.id)).toEqual([{ units: '-7.0000', effective_date: '2025-12-31' }]);
    expect((await balance(w, people.ten.id, type)).available).toBe('3.0000');

    // FR-025: the ledger of the leave year closes at the cap, opening plus credits minus debits.
    const ledger = (await h.call(w.hr, 'GET', `/v1/employees/${people.ten.id}/leave-ledger?from=2025-01-01&to=2025-12-31&leaveType=${type}`)).json().items[0];
    expect(ledger).toMatchObject({ opening: '0.0000', credits: '10.0000', debits: '7.0000', closing: '3.0000' });
    expect(ledger.movements.map((m: { kind: string; units: string }) => [m.kind, m.units])).toEqual([
      ['OPENING', '10.0000'],
      ['EXPIRY', '-7.0000'],
    ]);

    // A second run of the same year end expires nothing again.
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ expired: 0 });
    expect(await expiries(people.ten.id)).toHaveLength(1);
    const audit = await h.one<{ action: string; after_values: { operational: object } }>(
      `select action, after_values from audit_event where company_id = $1 and resource_code = 'leave_year_end' order by occurred_at limit 1`,
      [w.A.id],
    );
    expect(audit).toMatchObject({ action: 'EXPIRE', after_values: { operational: { yearEnd: '2025-12-31', expired: 2 } } });
  });

  it('FR-024 DF05 units promised to leave after the year end are not expired from under it: no negative balance', async () => {
    const w = await world();
    const type = await leaveType(w, '0', 1);
    const e = await employee(w, { [type]: '10' });
    // Monday 12 to Wednesday 21 January 2026: eight working days, still pending.
    const req = await h.call(e.actor, 'POST', '/v1/leave/requests', { leaveType: type, startDate: '2026-01-12', endDate: '2026-01-21' });
    expect(req.statusCode, req.body).toBe(201);
    expect(req.json().units).toBe('8');
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ expired: 1, pendingRequests: 0 });
    // Held at the year end: 10, cap 0; promised later: 8. Only 2 expire.
    expect(await expiries(e.id)).toEqual([{ units: '-2.0000', effective_date: '2025-12-31' }]);
    expect(await balance(w, e.id, type)).toMatchObject({ available: '0.0000', pending: '8.0000' });
    // The database refuses any expiry that would take the balance below zero (0183).
    await expect(
      h.db.query(
        `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key)
         select $1, $2, id, 'EXPIRY', -1, '2025-12-31', $4 from leave_type where company_id = $1 and code = $3`,
        [w.A.id, e.id, type, uniq('direct-expiry-')],
      ),
    ).rejects.toThrow(/below zero/);
  });

  it('FR-024 a request pending in the closing year holds the pair back until it is decided; a later run takes it', async () => {
    const w = await world();
    const type = await leaveType(w, '0', 1);
    const e = await employee(w, { [type]: '5' });
    // Monday 29 December 2025: one working day, back-dated, so reviewed from the HR fallback list.
    const req = await h.call(e.actor, 'POST', '/v1/leave/requests', { leaveType: type, startDate: '2025-12-29', endDate: '2025-12-29' });
    expect(req.statusCode, req.body).toBe(201);
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ expired: 0, pendingRequests: 1 });
    expect(await expiries(e.id)).toEqual([]);
    const pending = (await h.call(w.hr, 'GET', '/v1/leave/year-end-runs/pending-requests?yearEnd=2025-12-31')).json();
    expect(pending).toMatchObject({ total: 1, items: [{ requestId: req.json().requestId, employeeId: e.id, leaveType: type, startDate: '2025-12-29' }] });

    const task = ((await h.call(w.hr, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; summary: { requestId: string } }[]).find((t) => t.summary.requestId === req.json().requestId)!;
    const decided = await h.call(w.hr, 'POST', `/v1/leave/tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('decide-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ expired: 1, pendingRequests: 0 });
    // 5 held, 1 taken on 29 December: 4 expire.
    expect(await expiries(e.id)).toEqual([{ units: '-4.0000', effective_date: '2025-12-31' }]);
    expect((await h.call(w.hr, 'GET', '/v1/leave/year-end-runs/pending-requests?yearEnd=2025-12-31')).json().total).toBe(0);
  });

  it('FR-024 the leave year is the policy\'s own: an April-March year ends on 31 March; a policy without one never expires', async () => {
    const w = await world();
    const april = await leaveType(w, '0', 4);
    const unset = await leaveType(w, '0', null);
    const e = await employee(w, { [april]: '6', [unset]: '6' });
    expect(await yearEnd(w, '2025-12-31')).toMatchObject({ expired: 0, notConfigured: 1 });
    expect(await yearEnd(w, '2026-03-31')).toMatchObject({ expired: 1, notConfigured: 1 });
    expect(await expiries(e.id)).toEqual([{ units: '-6.0000', effective_date: '2026-03-31' }]);
    expect((await balance(w, e.id, unset)).available).toBe('6.0000');
    const policies = (await h.call(w.hr, 'GET', '/v1/leave/policies')).json().items as { leaveType: string; leaveYearStartMonth: number | null }[];
    expect(policies.find((p) => p.leaveType === april)?.leaveYearStartMonth).toBe(4);
    expect(policies.find((p) => p.leaveType === unset)?.leaveYearStartMonth).toBeNull();
  });

  it('FR-024 a run needs a month end that has passed, the accrual duty and the whole company; the leave year is frozen once active', async () => {
    const w = await world();
    const type = await leaveType(w, '0', 1);
    const run = (actor: TestActor, date: string) => h.call(actor, 'POST', '/v1/leave/year-end-runs', { yearEnd: date });
    expect((await run(w.hr, '2025-12-30')).json().error).toBe('INVALID_YEAR_END');
    expect((await run(w.hr, '2099-12-31')).json().error).toBe('LEAVE_YEAR_NOT_ENDED');
    expect((await run(await h.actor(w.A, 'REPORTING_MANAGER'), '2025-12-31')).statusCode).toBe(403);
    expect((await run(await h.actor(w.A, 'HR_ADMINISTRATOR', { departmentFilter: w.A.dept }), '2025-12-31')).statusCode).toBe(403);
    // No month 0 or 13; a draft takes one, an active revision keeps it.
    const draft = await h.call(w.hr, 'POST', '/v1/leave/policies', { leaveType: type, effectiveFrom: '2030-01-01', eligibility: 'X', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0, leaveYearStartMonth: 13 });
    expect(draft.statusCode).toBe(400);
    expect((await h.call(w.hr, 'POST', '/v1/leave/policies', { leaveType: type, effectiveFrom: '2030-01-01', eligibility: 'X', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0, leaveYearStartMonth: 0 })).statusCode).toBe(400);
    const active = await h.one<{ id: string }>(`select p.id from leave_policy p join leave_type t on t.id = p.leave_type_id where t.company_id = $1 and t.code = $2 and p.state = 'ACTIVE'`, [w.A.id, type]);
    await expect(h.db.query(`update leave_policy set leave_year_start_month = 4 where id = $1`, [active.id])).rejects.toThrow(/immutable/);
  });
});
