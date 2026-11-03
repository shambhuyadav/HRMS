// Training plans over HTTP (FR-049 "maintain course title, dates, venue/mode, trainer, capacity, cost and owner ...
// past/current/future/cancelled views"; acceptance "a plan with end before start is rejected; filtering shows the
// owner-approved date classification; cancelling a plan records actor and reason"; F1 "Training"; BR-015; DB072; DF02;
// DF04; DF08; DF09). Synthetic data only: made-up plan codes, example.test people.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import type { Queryable } from '../../db/queryable.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { AccessGrant } from '../access/authorize.js';
import { BASELINE_ROLES } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { ROW_LIMIT } from './common.js';
import { exportPlans } from './plans.js';
import { act, addDays, advance, businessDate, inbox, newPlan, nominated, person, type Plan } from './training.fixtures.js';

describe.runIf(isModuleActive('training'))('training plans (FR-049, BR-015)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hrReasons: TestActor; // HR Administrator with the approved confidential participation-reason grant
  let coordinator: TestActor;
  let filteredHr: TestActor;
  let noCost: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let colleague: TestActor;
  let sysAdmin: TestActor;
  let bCoordinator: TestActor;
  let ownerEmp: string;
  let employeeEmp: string;
  let colleagueEmp: string;
  let bEmp: string;
  let separatedEmp: string;
  let today: string;

  const plan = (a: TestActor, body: Record<string, unknown> = {}) =>
    newPlan(h, a, { startDate: addDays(today, 10), endDate: addDays(today, 12), ownerEmployeeId: ownerEmp, ...body });
  const create = (a: TestActor, body: Record<string, unknown>) =>
    h.call(a, 'POST', '/v1/training-plans', {
      code: uniq('TRN-'),
      title: 'Synthetic workshop',
      startDate: addDays(today, 10),
      endDate: addDays(today, 12),
      modeCode: 'IN_PERSON',
      capacity: 5,
      ownerEmployeeId: ownerEmp,
      ...body,
    });
  const list = async (a: TestActor, query: string) => {
    const res = await h.call(a, 'GET', `/v1/training-plans?pageSize=100&${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Plan[]; total: number };
  };
  const auditRows = async (recordKey: string) =>
    (
      await h.db.query<{ action: string; before_values: Record<string, unknown> | null; after_values: Record<string, unknown> | null; reason: string | null; actor_user_id: string }>(
        `select action, before_values, after_values, reason, actor_user_id from audit_event
          where company_id = $1 and record_key = $2 and action <> 'ACCESS_DENIED' order by occurred_at, id`,
        [A.id, recordKey],
      )
    ).rows;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrReasons = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['training_participant.read.reason'] });
    coordinator = await h.actor(A, 'TRAINING_COORDINATOR');
    filteredHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    noCost = await h.actor(A, 'TRAINING_COORDINATOR');
    // This coordinator's cost duties are switched off (DB109 allowlist): the operational duties remain.
    await h.db.query(
      `update role_assignment_permission rap set active = false from permission p
        where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = 'training_plan' and p.field_group = 'cost'`,
      [noCost.assignment],
    );
    sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    ownerEmp = await person(h, A, hr, { name: 'Olu Owner (synthetic)' });
    employeeEmp = await person(h, A, hr, { name: 'Ena Employee (synthetic)' });
    colleagueEmp = await person(h, A, hr, { name: 'Cal Colleague (synthetic)' });
    separatedEmp = await person(h, A, hr, { name: 'Sam Separated (synthetic)', status: 'INACTIVE_SEPARATED' });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, hr, { name: 'Mo Manager (synthetic)' }) });
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    bEmp = await person(h, B, bHr, { name: 'Bea Other (synthetic)' });
    bCoordinator = await h.actor(B, 'TRAINING_COORDINATOR');
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('lists the controlled modes and feedback questions (DF04)', async () => {
    expect((await h.call(coordinator, 'GET', '/v1/training-modes')).json().items).toEqual(
      expect.arrayContaining([
        { code: 'IN_PERSON', label: 'In person' },
        { code: 'VIRTUAL', label: 'Virtual' },
      ]),
    );
    expect((await h.call(coordinator, 'GET', '/v1/training-feedback-questions')).json().items).toEqual([{ code: 'OVERALL', label: 'Overall rating of the training' }]);
    expect((await h.call(employee, 'GET', '/v1/training-modes')).statusCode).toBe(403);
  });

  it('creates a plan with a normalised permanent code, owner, mode, cost and the default feedback question', async () => {
    const code = uniq('syn-plan-');
    const res = await create(coordinator, {
      code: ` ${code} `,
      title: '  Synthetic first aid  ',
      venue: 'Room 2 (synthetic)',
      trainer: 'Tess Trainer (synthetic)',
      capacity: 12,
      cost: { amount: '1500', currency: 'inr' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({
      code: code.toUpperCase(),
      title: 'Synthetic first aid',
      startDate: addDays(today, 10),
      endDate: addDays(today, 12),
      view: 'FUTURE',
      state: 'ACTIVE',
      mode: { code: 'IN_PERSON', label: 'In person' },
      venue: 'Room 2 (synthetic)',
      trainer: 'Tess Trainer (synthetic)',
      capacity: 12,
      seatsTaken: 0,
      seatsAvailable: 12,
      nominationsPending: 0,
      owner: { employeeId: ownerEmp, name: 'Olu Owner (synthetic)' },
      selfNomination: false,
      cancellation: null,
      cost: { amount: '1500.00', currency: 'INR' },
      feedbackQuestions: [{ code: 'OVERALL', label: 'Overall rating of the training', position: 1 }],
      feedbackRecorded: false,
      version: 1,
    });
    // The same code in another spelling is the same permanent code.
    expect((await create(coordinator, { code: code.toLowerCase() })).json().error).toBe('PLAN_CODE_EXISTS');
    expect((await h.call(coordinator, 'GET', `/v1/training-plans/${p.id}`)).json()).toMatchObject({ id: p.id, code: code.toUpperCase(), cost: { amount: '1500.00' } });
    const [created] = await auditRows(p.id);
    expect(created).toMatchObject({ action: 'CREATE', actor_user_id: coordinator.user });
    expect(created!.after_values).toMatchObject({ operational: { code: code.toUpperCase(), capacity: 12, feedbackQuestions: ['OVERALL'] }, cost: { amount: '1500', currency: 'INR' } });
    // The operational group of the trail carries no cost value.
    expect(JSON.stringify(created!.after_values!.operational)).not.toContain('1500');
  });

  it('rejects a plan whose end is before its start, and invalid codes, dates, modes, owners, costs and questions (FR-049)', async () => {
    expect((await create(coordinator, { startDate: addDays(today, 5), endDate: addDays(today, 4) })).json()).toMatchObject({ error: 'END_BEFORE_START' });
    // A one-day session (end on its start date) is valid.
    expect((await create(coordinator, { startDate: addDays(today, 5), endDate: addDays(today, 5) })).statusCode).toBe(201);
    expect((await create(coordinator, { startDate: '2026-02-30', endDate: '2026-03-02' })).json().error).toBe('INVALID_DATE');
    expect((await create(coordinator, { code: 'bad code!' })).json().error).toBe('INVALID_PLAN_CODE');
    expect((await create(coordinator, { title: '   ' })).json().error).toBe('INVALID_TITLE');
    expect((await create(coordinator, { modeCode: 'NOT_A_MODE' })).json().error).toBe('INVALID_MODE');
    expect((await create(coordinator, { ownerEmployeeId: bEmp })).json().error).toBe('INVALID_OWNER');
    expect((await create(coordinator, { ownerEmployeeId: separatedEmp })).json().error).toBe('INVALID_OWNER');
    expect((await create(coordinator, { cost: { amount: '-5', currency: 'INR' } })).json().error).toBe('INVALID_COST');
    expect((await create(coordinator, { cost: { amount: '10.125', currency: 'INR' } })).json().error).toBe('INVALID_COST');
    expect((await create(coordinator, { cost: { amount: '10', currency: 'R1X' } })).json().error).toBe('INVALID_CURRENCY');
    expect((await create(coordinator, { feedbackQuestionCodes: ['NOT_A_QUESTION'] })).json().error).toBe('INVALID_QUESTION');
    expect((await create(coordinator, { capacity: 0 })).statusCode).toBe(400);
    // A zero cost (a free session) is a cost, distinct from none.
    expect((await create(coordinator, { cost: { amount: '0', currency: 'INR' } })).json().cost).toEqual({ amount: '0.00', currency: 'INR' });
    expect((await create(coordinator, {})).json().cost).toBeNull();

    // The database refuses the same directly (ZT08).
    const mode = (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'TRAINING_MODE' and code = 'IN_PERSON'`, [A.id])).id;
    const insert = (start: string, end: string, state: 'ACTIVE' | 'CANCELLED') =>
      h.db.query(
        `insert into training_plan (company_id, code, title, start_date, end_date, mode_id, capacity, owner_employee_id, state, cancelled_at)
         values ($1, $2, 'Synthetic', $3, $4, $5, 3, $6, $7, $8)`,
        [A.id, uniq('DIRECT-'), start, end, mode, ownerEmp, state, state === 'CANCELLED' ? new Date() : null],
      );
    await expectSqlError(insert(addDays(today, 3), addDays(today, 2), 'ACTIVE'), CHECK_VIOLATION);
    // Born cancelled, without actor and reason.
    await expectSqlError(insert(addDays(today, 3), addDays(today, 4), 'CANCELLED'), CHECK_VIOLATION);
    // Without any feedback question (checked at commit).
    await expectSqlError(insert(addDays(today, 3), addDays(today, 4), 'ACTIVE'), CHECK_VIOLATION);
  });

  it('classifies plans by the company-local date; CANCELLED overrides; filters by view, text and period (F1, BR-015)', async () => {
    const tag = uniq('VIEWTAG');
    const make = async (name: string, start: number, end: number) =>
      plan(coordinator, { code: `${tag}-${name}`, title: `Synthetic ${name} ${tag}`, startDate: addDays(today, start), endDate: addDays(today, end) });
    const future = await make('FUT', 1, 3);
    const startsToday = await make('STA', 0, 2);
    const endsToday = await make('END', -2, 0);
    const past = await make('PST', -3, -1);
    const cancelled = await make('CAN', 5, 6);
    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${cancelled.id}/cancel`, { reason: 'Trainer unavailable (synthetic)', expectedVersion: 1 })).statusCode).toBe(200);

    const all = await list(coordinator, `search=${tag}`);
    expect(all.total).toBe(5);
    const view = Object.fromEntries(all.items.map((p) => [p.code, p.view]));
    expect(view).toEqual({ [`${tag}-FUT`]: 'FUTURE', [`${tag}-STA`]: 'CURRENT', [`${tag}-END`]: 'CURRENT', [`${tag}-PST`]: 'PAST', [`${tag}-CAN`]: 'CANCELLED' });
    const codes = async (query: string) => (await list(coordinator, `search=${tag}&${query}`)).items.map((p) => p.code).sort();
    expect(await codes('view=FUTURE')).toEqual([future.code]);
    expect(await codes('view=CURRENT')).toEqual([endsToday.code, startsToday.code].sort());
    expect(await codes('view=PAST')).toEqual([past.code]);
    expect(await codes('view=CANCELLED')).toEqual([cancelled.code]);
    // A period selects the plans overlapping it (dates inclusive).
    expect(await codes(`from=${addDays(today, 4)}&to=${addDays(today, 30)}`)).toEqual([cancelled.code]);
    expect(await codes(`to=${addDays(today, -1)}`)).toEqual([endsToday.code, past.code].sort());
    expect(await codes(`from=${today}&to=${today}`)).toEqual([endsToday.code, startsToday.code].sort());
    expect((await h.call(coordinator, 'GET', `/v1/training-plans?from=${today}&to=${addDays(today, -1)}`)).json().error).toBe('INVALID_PERIOD');
    // Search covers the trainer; wildcards match literally.
    expect((await list(coordinator, `search=${encodeURIComponent('Tess Trainer')}&view=PAST`)).items.map((p) => p.code)).toContain(past.code);
    expect((await list(coordinator, `search=${encodeURIComponent('%')}`)).total).toBe(0);
    // Upcoming views list the earliest session first.
    expect((await list(coordinator, `search=${tag}&view=CURRENT`)).items.map((p) => p.code)).toEqual([endsToday.code, startsToday.code]);

    // The one rule in the database: boundaries are inclusive and CANCELLED overrides.
    const v = async (state: string, start: number, end: number) =>
      (await h.one<{ v: string }>(`select hrms_training_plan_view($1, $2::date, $3::date, $4::date) as v`, [state, addDays(today, start), addDays(today, end), today])).v;
    expect([await v('ACTIVE', 1, 1), await v('ACTIVE', 0, 0), await v('ACTIVE', -1, -1), await v('CANCELLED', -1, 1), await v('CANCELLED', 1, 2)]).toEqual([
      'FUTURE',
      'CURRENT',
      'PAST',
      'CANCELLED',
      'CANCELLED',
    ]);
  });

  it('updates a plan with version checks; capacity never drops below confirmed seats; dates fixed once attendance exists', async () => {
    const p = await plan(coordinator, { capacity: 3, cost: { amount: '200.50', currency: 'INR' } });
    const patched = await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, title: 'Synthetic first aid, part 2', trainer: null, selfNomination: true });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ title: 'Synthetic first aid, part 2', trainer: null, selfNomination: true, version: 2 });
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, title: 'Stale' })).json().error).toBe('STALE_VERSION');
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 2, title: 'Synthetic first aid, part 2' })).json().error).toBe('NO_CHANGE');
    // Equal amounts written differently are no change.
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 2, cost: { amount: '200.5', currency: 'INR' } })).json().error).toBe('NO_CHANGE');
    const costed = await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 2, cost: { amount: '250', currency: 'INR' } });
    expect(costed.json()).toMatchObject({ cost: { amount: '250.00', currency: 'INR' }, version: 3 });
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 3, endDate: addDays(today, 9) })).json().error).toBe('END_BEFORE_START');
    const trail = await auditRows(p.id);
    expect(trail.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(trail[1]).toMatchObject({
      before_values: { operational: { title: 'Synthetic safety induction', trainer: 'Tess Trainer (synthetic)', selfNomination: false } },
      after_values: { operational: { title: 'Synthetic first aid, part 2', trainer: null, selfNomination: true } },
    });
    expect(trail[2]).toMatchObject({ before_values: { cost: { cost: { amount: '200.50', currency: 'INR' } } }, after_values: { cost: { cost: { amount: '250', currency: 'INR' } } } });

    const [e1, e2] = [await person(h, A, hr), await person(h, A, hr)];
    const ids = await nominated(h, coordinator, p.id, [e1, e2]);
    await advance(h, coordinator, p.id, ids, ['CONFIRM']);
    const lower = await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 3, capacity: 1 });
    expect(lower.json()).toMatchObject({ error: 'CAPACITY_BELOW_SEATS', details: { seatsTaken: 2 } });
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 3, capacity: 2 })).json()).toMatchObject({ capacity: 2, seatsTaken: 2, seatsAvailable: 0 });
    // Dates may move while no attendance is recorded.
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 4, startDate: addDays(today, 11) })).json()).toMatchObject({ startDate: addDays(today, 11), version: 5 });

    // A session that has started and has recorded attendance keeps its dates.
    const held = await plan(coordinator, { startDate: addDays(today, -2), endDate: addDays(today, -1) });
    const [h1] = await nominated(h, coordinator, held.id, [await person(h, A, hr)]);
    await advance(h, coordinator, held.id, [h1!], ['CONFIRM', 'MARK_ATTENDED']);
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${held.id}`, { expectedVersion: 1, endDate: addDays(today, 3) })).json().error).toBe('DATES_FIXED');
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${held.id}`, { expectedVersion: 1, venue: 'Room 9 (synthetic)' })).statusCode).toBe(200);
    // The database keeps the same rule (direct update).
    await expectSqlError(h.db.query(`update training_plan set end_date = end_date + 1 where id = $1`, [held.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update training_plan set capacity = 1 where id = $1`, [p.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update training_plan set code = 'RENAMED-SYN' where id = $1`, [p.id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`delete from training_plan where id = $1`, [p.id]), CHECK_VIOLATION);
  });

  it('cancels with actor and reason, cancels the live participations, tells the participants and is final (FR-049)', async () => {
    const p = await plan(coordinator, { title: 'Synthetic fire drill' });
    const [n1, n2, n3] = await nominated(h, coordinator, p.id, [employeeEmp, colleagueEmp, await person(h, A, hr)]);
    await advance(h, coordinator, p.id, [n2!], ['CONFIRM']);
    const dropped = await act(h, coordinator, p.id, 'CANCEL', [n3!], 'Moved to another session (synthetic)');
    expect(dropped.statusCode, dropped.body).toBe(200);

    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${p.id}/cancel`, { reason: '   ', expectedVersion: 1 })).json().error).toBe('REASON_REQUIRED');
    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${p.id}/cancel`, { reason: 'Synthetic', expectedVersion: 9 })).json().error).toBe('STALE_VERSION');
    const cancelled = await h.call(coordinator, 'POST', `/v1/training-plans/${p.id}/cancel`, { reason: 'Venue closed for repairs (synthetic)', expectedVersion: 1 });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      state: 'CANCELLED',
      view: 'CANCELLED',
      cancellation: { cancelledBy: coordinator.user, reason: 'Venue closed for repairs (synthetic)' },
      cancelledParticipations: 2,
      seatsTaken: 0,
      replayed: false,
    });
    expect(typeof cancelled.json().cancellation.cancelledAt).toBe('string');
    type Row = { id: string; state: string; cancellationReason?: string };
    const participants = (await h.call(coordinator, 'GET', `/v1/training-plans/${p.id}/participants`)).json().items as Row[];
    expect(participants.map((t) => [t.id, t.state]).sort()).toEqual([[n1, 'CANCELLED'], [n2, 'CANCELLED'], [n3, 'CANCELLED']].sort());
    // A participation's reasons are the confidential `reason` group: the coordinator does not read them, an eligible HR
    // assignment with the approved grant does (DF02; I-16).
    for (const t of participants) expect(t).not.toHaveProperty('cancellationReason');
    const granted = (await h.call(hrReasons, 'GET', `/v1/training-plans/${p.id}/participants`)).json().items as Row[];
    expect(granted.map((t) => [t.id, t.state, t.cancellationReason]).sort()).toEqual(
      [
        [n1, 'CANCELLED', 'Venue closed for repairs (synthetic)'],
        [n2, 'CANCELLED', 'Venue closed for repairs (synthetic)'],
        [n3, 'CANCELLED', 'Moved to another session (synthetic)'],
      ].sort(),
    );
    const history = (await h.call(coordinator, 'GET', `/v1/training-participants/${n2}`)).json().history as { action: string; fromState: string | null; toState: string }[];
    expect(history.map((e) => [e.action, e.fromState, e.toState])).toEqual([
      ['NOMINATE', null, 'NOMINATED'],
      ['CONFIRM', 'NOMINATED', 'CONFIRMED'],
      ['PLAN_CANCELLED', 'CONFIRMED', 'CANCELLED'],
    ]);

    // A repeated cancellation has no second effect; the plan is final.
    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${p.id}/cancel`, { reason: 'Again (synthetic)', expectedVersion: 2 })).json()).toMatchObject({
      replayed: true,
      cancelledParticipations: 0,
      cancellation: { reason: 'Venue closed for repairs (synthetic)' },
    });
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 2, title: 'Revived' })).json().error).toBe('PLAN_CANCELLED');
    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${p.id}/participants`, { employeeIds: [employeeEmp] })).json().error).toBe('PLAN_CANCELLED');
    expect((await act(h, coordinator, p.id, 'CONFIRM', [n1!])).json().error).toBe('PLAN_CANCELLED');
    await expectSqlError(h.db.query(`update training_plan set title = 'Revived directly' where id = $1`, [p.id]), CHECK_VIOLATION);

    const trail = await auditRows(p.id);
    expect(trail.at(-1)).toMatchObject({ action: 'CANCEL', reason: 'Venue closed for repairs (synthetic)', actor_user_id: coordinator.user, after_values: { operational: { state: 'CANCELLED', cancelledParticipations: 2 } } });

    // DF12: both live participants are told, without the reason.
    await dispatchOutbox(h.pool, 500);
    for (const who of [employee, colleague]) {
      const notices = (await inbox(h, who)).filter((n) => n.category === 'TRAINING_PLAN_CANCELLED');
      expect(notices.map((n) => n.body)).toContain(`The training Synthetic fire drill (${p.code}), ${addDays(today, 10)} to ${addDays(today, 12)}, was cancelled.`);
      expect(JSON.stringify(notices)).not.toContain('Venue closed');
    }
    const payloads = (await h.db.query<{ payload: Record<string, unknown> }>(`select payload from outbox_event where company_id = $1 and topic = 'training.plan_cancelled'`, [A.id])).rows;
    expect(payloads.length).toBe(2);
    for (const r of payloads) expect(Object.keys(r.payload).sort()).toEqual(['participantId', 'planId', 'state']);
  });

  it('does not cancel a session whose attendance was recorded', async () => {
    const held = await plan(coordinator, { startDate: addDays(today, -1), endDate: today });
    const [t] = await nominated(h, coordinator, held.id, [await person(h, A, hr)]);
    await advance(h, coordinator, held.id, [t!], ['CONFIRM', 'MARK_NO_SHOW']);
    expect((await h.call(coordinator, 'POST', `/v1/training-plans/${held.id}/cancel`, { reason: 'Synthetic', expectedVersion: 1 })).json().error).toBe('PLAN_HAS_ATTENDANCE');
    await expectSqlError(
      h.db.query(`update training_plan set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Direct' where id = $1`, [held.id, coordinator.user]),
      CHECK_VIOLATION,
    );
  });

  it('access: the register needs the plan duties, maintenance an unrestricted company scope; other companies see nothing (DF02)', async () => {
    const p = await plan(coordinator);
    for (const who of [employee, manager, sysAdmin]) {
      expect((await h.call(who, 'GET', '/v1/training-plans')).statusCode).toBe(403);
      expect((await h.call(who, 'GET', `/v1/training-plans/${p.id}`)).statusCode).toBe(403);
      expect((await create(who, {})).statusCode).toBe(403);
    }
    // HR holds the operational duties by default.
    expect((await create(hr, {})).statusCode).toBe(201);
    // A department-filtered HR assignment reads the register but does not maintain it (recorded denial).
    expect((await h.call(filteredHr, 'GET', `/v1/training-plans/${p.id}`)).statusCode).toBe(200);
    expect((await create(filteredHr, {})).statusCode).toBe(403);
    expect((await h.call(filteredHr, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, title: 'Synthetic' })).statusCode).toBe(403);
    const denial = await h.one<{ after_values: { reason: string } }>(
      `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and resource_code = 'training_plan' order by occurred_at desc limit 1`,
      [A.id, filteredHr.user],
    );
    expect(denial.after_values.reason).toBe('OUT_OF_SCOPE');
    // Another company's coordinator, or an altered id, finds nothing.
    expect((await h.call(bCoordinator, 'GET', `/v1/training-plans/${p.id}`)).statusCode).toBe(404);
    expect((await h.call(bCoordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, title: 'Synthetic' })).statusCode).toBe(404);
    expect((await h.call(bCoordinator, 'POST', `/v1/training-plans/${p.id}/cancel`, { reason: 'Synthetic', expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(bCoordinator, 'GET', '/v1/training-plans?pageSize=100')).json().items.map((x: Plan) => x.id)).not.toContain(p.id);
    expect((await h.call(coordinator, 'GET', `/v1/training-plans/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).statusCode).toBe(404);
  });

  it('cost is operational but held only by those with the cost group; the Employee role never has it (DF02)', async () => {
    const p = await plan(coordinator, { cost: { amount: '999.99', currency: 'INR' } });
    const seen = (await h.call(noCost, 'GET', `/v1/training-plans/${p.id}`)).json();
    expect(seen.id).toBe(p.id);
    expect(seen).not.toHaveProperty('cost');
    expect(JSON.stringify((await h.call(noCost, 'GET', '/v1/training-plans?pageSize=100')).json())).not.toContain('999.99');
    expect((await create(noCost, { cost: { amount: '10', currency: 'INR' } })).statusCode).toBe(403);
    expect((await create(noCost, {})).statusCode).toBe(201);
    expect((await h.call(noCost, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, cost: null })).statusCode).toBe(403);
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, cost: null })).json()).toMatchObject({ cost: null, version: 2 });
    const employeeRole = BASELINE_ROLES.find((r) => r.code === 'EMPLOYEE')!;
    expect(employeeRole.ceiling.filter((k) => k.startsWith('training_plan.'))).toEqual([]);
  });

  it('exports the register with its filters and generation time, neutralised formulas and cost columns only with the cost group (DF09)', async () => {
    const tag = uniq('EXPTAG');
    await plan(coordinator, { code: `${tag}-1`, title: `=HYPERLINK("synthetic") ${tag}`, cost: { amount: '75', currency: 'INR' } });
    const res = await h.call(coordinator, 'GET', `/v1/training-plans/export?search=${tag}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="training-plans-');
    expect(res.body).toContain(`"Search","${tag}"`);
    expect(res.body).toContain('"Generated at"');
    expect(res.body).toContain('"Rows","1"');
    expect(res.body).toContain(`"'=HYPERLINK(""synthetic"") ${tag}"`);
    expect(res.body).toContain('"Cost","Cost currency"');
    expect(res.body).toContain('"75.00","INR"');
    const plain = await h.call(noCost, 'GET', `/v1/training-plans/export?search=${tag}`);
    expect(plain.statusCode).toBe(200);
    expect(plain.body).not.toContain('Cost');
    expect(plain.body).not.toContain('75.00');
    expect((await h.call(employee, 'GET', '/v1/training-plans/export')).statusCode).toBe(403);
    const exported = await h.one<{ after_values: { operational: Record<string, unknown> } }>(
      `select after_values from audit_event where company_id = $1 and resource_code = 'training_plan' and action = 'EXPORT' and actor_user_id = $2 order by occurred_at desc limit 1`,
      [A.id, coordinator.user],
    );
    expect(exported.after_values.operational).toMatchObject({ rows: 1, search: tag, costColumns: true });
  });

  it('refuses an export above its row bound instead of truncating it silently (DF09)', async () => {
    // A stand-in database answering one row more than the bound; nothing else may be asked (no audit row either).
    const asked: string[] = [];
    const fake: Queryable = {
      query: async (text: string) => {
        asked.push(text);
        if (text.includes('from training_plan p')) return { rows: Array.from({ length: ROW_LIMIT + 1 }, (_, i) => ({ code: `SYN-${i}` })) } as never;
        throw new Error('unexpected query');
      },
    };
    const grant: AccessGrant = {
      allowed: true,
      userId: coordinator.user,
      companyId: A.id,
      assignmentId: coordinator.assignment,
      roleCode: 'TRAINING_COORDINATOR',
      accessClass: 'OTHER',
      scopeKind: 'COMPANY',
      filters: { departments: [], locations: [], employees: [] },
      allowedFieldGroups: ['operational'],
      ownEssFieldGroups: [],
      deniedFieldGroups: [],
      linkedEmployeeId: null,
      at: new Date(),
      businessDate: today,
    };
    await expect(exportPlans(fake, grant, {})).rejects.toMatchObject({ statusCode: 422, code: 'EXPORT_TOO_LARGE', details: { limit: ROW_LIMIT } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`limit ${ROW_LIMIT + 1}`);
  });

  it('a plan without an active feedback question cannot exist (DB074 controlled definitions)', async () => {
    const C = await h.makeCompany();
    const cCoordinator = await h.actor(C, 'TRAINING_COORDINATOR');
    const cHr = await h.actor(C, 'HR_ADMINISTRATOR');
    const cOwner = await person(h, C, cHr);
    await h.db.query(`update reference_value set active = false where company_id = $1 and category = 'TRAINING_FEEDBACK_QUESTION'`, [C.id]);
    const res = await h.call(cCoordinator, 'POST', '/v1/training-plans', {
      code: uniq('NOQ-'),
      title: 'Synthetic',
      startDate: addDays(today, 1),
      endDate: addDays(today, 1),
      modeCode: 'VIRTUAL',
      capacity: 2,
      ownerEmployeeId: cOwner,
    });
    expect(res.json().error).toBe('NO_FEEDBACK_QUESTIONS');
  });
});
