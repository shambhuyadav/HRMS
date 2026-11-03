// Training participation over HTTP (FR-050 "record participant nomination, confirmation, attendance/completion ...
// linked to training and employee"; acceptance "the same employee cannot be duplicated in a training session"; F1 "one
// employee participation per session; capacity enforced at nomination confirmation; states NOMINATED/CONFIRMED/
// ATTENDED/COMPLETED/NO_SHOW/CANCELLED"; H3 TN17 "own enrollment, assigned sessions, attendance/completion ... no
// falsified completion"; FR-110; DB073; DF02; DF08; DF12; DF16; C4). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, FK_VIOLATION, UNIQUE_VIOLATION } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { TRAINING_EVENTS } from './events.js';
import { act, addDays, advance, businessDate, inbox, newPlan, nominate, nominated, person } from './training.fixtures.js';

type Participant = {
  id: string;
  planId: string;
  employeeId: string;
  state: string;
  selfNominated: boolean;
  cancellationReason?: string | null;
  feedbackStatus: string;
  confirmedAt: string | null;
  completedAt: string | null;
};
type HistoryEntry = { action: string; fromState: string | null; toState: string; reason?: string | null; reasonRecorded: boolean };

describe.runIf(isModuleActive('training'))('training participants (FR-050, F1, H3 TN17)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hrReasons: TestActor; // HR Administrator with the approved confidential participation-reason grant
  let coordinator: TestActor;
  let coordinator2: TestActor;
  let ownCoordinator: TestActor; // a coordinator who is also an employee of A
  let filteredHr: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let colleague: TestActor;
  let leaver: TestActor;
  let bCoordinator: TestActor;
  let managerEmp: string;
  let employeeEmp: string;
  let colleagueEmp: string;
  let coordinatorEmp: string;
  let separatedEmp: string;
  let bEmp: string;
  let owner: string;
  let today: string;

  const plan = (body: Record<string, unknown> = {}) =>
    newPlan(h, coordinator, { startDate: addDays(today, 10), endDate: addDays(today, 12), ownerEmployeeId: owner, ...body });
  const pastPlan = (body: Record<string, unknown> = {}) => plan({ startDate: addDays(today, -3), endDate: addDays(today, -1), ...body });
  const participants = async (a: TestActor, planId: string, query = '') => {
    const res = await h.call(a, 'GET', `/v1/training-plans/${planId}/participants?pageSize=100${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Participant[]; total: number; scope: { kind: string; companyWide: boolean } };
  };
  const detail = async (a: TestActor, participantId: string) => h.call(a, 'GET', `/v1/training-participants/${participantId}`);
  const historyOf = async (participantId: string) =>
    ((await detail(coordinator, participantId)).json().history as HistoryEntry[]).map((e) => [e.action, e.fromState, e.toState]);
  const fresh = (opts: { name?: string; departmentId?: string } = {}) => person(h, A, hr, opts);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrReasons = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['training_participant.read.reason'] });
    coordinator = await h.actor(A, 'TRAINING_COORDINATOR');
    coordinator2 = await h.actor(A, 'TRAINING_COORDINATOR');
    filteredHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    owner = await fresh({ name: 'Olu Owner (synthetic)' });
    managerEmp = await fresh({ name: 'Mo Manager (synthetic)' });
    employeeEmp = await person(h, A, hr, { name: 'Ena Employee (synthetic)', managerId: managerEmp });
    colleagueEmp = await fresh({ name: 'Cal Colleague (synthetic)', departmentId: A.financeDept });
    coordinatorEmp = await fresh({ name: 'Cora Coordinator (synthetic)' });
    separatedEmp = await person(h, A, hr, { name: 'Sam Separated (synthetic)', status: 'INACTIVE_SEPARATED' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
    colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
    leaver = await h.actor(A, 'EMPLOYEE', { employeeId: separatedEmp });
    ownCoordinator = await h.actor(A, 'TRAINING_COORDINATOR', { employeeId: coordinatorEmp });
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    bEmp = await person(h, B, bHr);
    bCoordinator = await h.actor(B, 'TRAINING_COORDINATOR');
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('nomination', () => {
    it('nominates employees once per session; a duplicate is refused and a batch applies all or nothing (FR-050)', async () => {
      const p = await plan({ capacity: 5 });
      const res = await nominate(h, coordinator, p.id, [employeeEmp, colleagueEmp]);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ nominated: 2 });
      expect((res.json().items as Participant[]).map((t) => [t.employeeId, t.state, t.selfNominated, t.feedbackStatus]).sort()).toEqual(
        [
          [employeeEmp, 'NOMINATED', false, 'NOT_APPLICABLE'],
          [colleagueEmp, 'NOMINATED', false, 'NOT_APPLICABLE'],
        ].sort(),
      );
      const existing = (res.json().items as Participant[]).find((t) => t.employeeId === employeeEmp)!;
      const dup = await nominate(h, coordinator, p.id, [employeeEmp]);
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ error: 'PARTICIPANT_EXISTS', details: { employeeId: employeeEmp, participantId: existing.id, state: 'NOMINATED' } });
      // All or nothing: the new employee of a refused batch is not nominated either.
      const newcomer = await fresh();
      expect((await nominate(h, coordinator, p.id, [newcomer, employeeEmp])).statusCode).toBe(409);
      expect((await participants(coordinator, p.id)).total).toBe(2);
      // The database keeps one row per employee and plan.
      await expectSqlError(
        h.db.query(
          `insert into training_participant (company_id, plan_id, employee_id, participation_state, self_nominated, nominated_by) values ($1, $2, $3, 'NOMINATED', false, $4)`,
          [A.id, p.id, employeeEmp, coordinator.user],
        ),
        UNIQUE_VIOLATION,
      );
      // A participation starts NOMINATED.
      await expectSqlError(
        h.db.query(
          `insert into training_participant (company_id, plan_id, employee_id, participation_state, self_nominated, nominated_by, confirmed_at, confirmed_by)
           values ($1, $2, $3, 'CONFIRMED', false, $4, now(), $4)`,
          [A.id, p.id, newcomer, coordinator.user],
        ),
        CHECK_VIOLATION,
      );
    });

    it('the database keeps participations inside their company (ZT06)', async () => {
      const p = await plan();
      const insert = (companyId: string, employeeId: string) =>
        h.db.query(
          `insert into training_participant (company_id, plan_id, employee_id, participation_state, self_nominated, nominated_by) values ($1, $2, $3, 'NOMINATED', false, $4)`,
          [companyId, p.id, employeeId, coordinator.user],
        );
      // A row of another company naming this company's plan, and another company's employee in this plan.
      await expectSqlError(insert(B.id, bEmp), FK_VIOLATION);
      await expectSqlError(insert(A.id, bEmp), FK_VIOLATION);
      const question = (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'TRAINING_FEEDBACK_QUESTION' and code = 'OVERALL'`, [B.id])).id;
      await expectSqlError(
        h.db.query(`insert into training_plan_question (company_id, plan_id, question_id, position, active) values ($1, $2, $3, 2, true)`, [B.id, p.id, question]),
        FK_VIOLATION,
      );
    });

    it('two concurrent nominations of one employee create one participation', async () => {
      const p = await plan();
      const target = await fresh();
      const results = await Promise.all([nominate(h, coordinator, p.id, [target]), nominate(h, coordinator2, p.id, [target])]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect((await participants(coordinator, p.id)).items.filter((t) => t.employeeId === target)).toHaveLength(1);
    });

    it('refuses inactive employees, employees outside the scope or company, and own nominations (C4)', async () => {
      const p = await plan();
      expect((await nominate(h, coordinator, p.id, [separatedEmp])).json()).toMatchObject({ error: 'EMPLOYEE_NOT_ACTIVE', details: { employeeId: separatedEmp } });
      expect((await nominate(h, coordinator, p.id, [bEmp])).statusCode).toBe(404);
      // A department-filtered HR assignment nominates in its department only.
      expect((await nominate(h, filteredHr, p.id, [colleagueEmp])).statusCode).toBe(404);
      expect((await nominate(h, filteredHr, p.id, [employeeEmp])).statusCode).toBe(201);
      // In a coordinator context nobody nominates themselves (the plan's self-nomination setting would be bypassed).
      expect((await nominate(h, ownCoordinator, p.id, [coordinatorEmp])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      for (const who of [employee, manager]) expect((await nominate(h, who, p.id, [colleagueEmp])).statusCode).toBe(403);
      // Another company's coordinator, or an altered plan id, finds nothing.
      expect((await nominate(h, bCoordinator, p.id, [bEmp])).statusCode).toBe(404);
      expect((await nominate(h, coordinator, '00000000-0000-4000-8000-000000000000', [employeeEmp])).statusCode).toBe(404);
    });

    it('a cancelled participation is nominated again on the same row; its history is kept (DB073, DF08)', async () => {
      const p = await plan();
      const target = await fresh();
      const [id] = await nominated(h, coordinator, p.id, [target]);
      expect((await act(h, coordinator, p.id, 'CANCEL', [id!], 'Clashes with a project deadline (synthetic)')).statusCode).toBe(200);
      const again = await nominate(h, coordinator, p.id, [target]);
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json().items[0]).toMatchObject({ id, state: 'NOMINATED', confirmedAt: null, cancelledAt: null });
      expect(await historyOf(id!)).toEqual([
        ['NOMINATE', null, 'NOMINATED'],
        ['CANCEL', 'NOMINATED', 'CANCELLED'],
        ['NOMINATE', 'CANCELLED', 'NOMINATED'],
      ]);
      // The coordinator sees that a reason was recorded; the reason itself needs the confidential grant (DF02; I-16).
      const plain = (await detail(coordinator, id!)).json().history as HistoryEntry[];
      expect(plain.map((e) => e.reasonRecorded)).toEqual([false, true, false]);
      for (const e of plain) expect(e).not.toHaveProperty('reason');
      const reasons = ((await detail(hrReasons, id!)).json().history as HistoryEntry[]).map((e) => e.reason);
      expect(reasons).toEqual([null, 'Clashes with a project deadline (synthetic)', null]);
    });
  });

  describe('confirmation and capacity (F1)', () => {
    it('confirms within capacity; a confirmation beyond it is refused whole; cancellation frees a seat', async () => {
      const p = await plan({ capacity: 2 });
      const e = [await fresh(), await fresh(), await fresh(), await fresh()];
      const ids = await nominated(h, coordinator, p.id, e);
      const over = await act(h, coordinator, p.id, 'CONFIRM', ids.slice(0, 3));
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ error: 'PLAN_FULL', details: { capacity: 2, seatsTaken: 0, requested: 3 } });
      expect((await participants(coordinator, p.id, '&state=CONFIRMED')).total).toBe(0);

      const first = await act(h, coordinator, p.id, 'CONFIRM', [ids[0]!]);
      expect(first.json()).toMatchObject({ action: 'CONFIRM', changed: 1, replayed: 0 });
      // A replay has no second effect (no second history entry or notice).
      expect((await act(h, coordinator, p.id, 'CONFIRM', [ids[0]!])).json()).toMatchObject({ changed: 0, replayed: 1 });
      expect((await historyOf(ids[0]!)).filter(([a]) => a === 'CONFIRM')).toHaveLength(1);
      const confirmedEvents = await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1 and topic = 'training.confirmed' and aggregate_id = $2`, [
        A.id,
        ids[0],
      ]);
      expect(confirmedEvents.n).toBe(1);

      expect((await act(h, coordinator, p.id, 'CONFIRM', [ids[1]!])).statusCode).toBe(200);
      expect((await act(h, coordinator, p.id, 'CONFIRM', [ids[2]!])).json().error).toBe('PLAN_FULL');
      expect((await h.call(coordinator, 'GET', `/v1/training-plans/${p.id}`)).json()).toMatchObject({ seatsTaken: 2, seatsAvailable: 0, nominationsPending: 2 });
      expect((await act(h, coordinator, p.id, 'CANCEL', [ids[0]!])).json().error).toBe('REASON_REQUIRED');
      expect((await act(h, coordinator, p.id, 'CANCEL', [ids[0]!], 'Withdrawn by the manager (synthetic)')).statusCode).toBe(200);
      expect((await act(h, coordinator, p.id, 'CONFIRM', [ids[2]!])).statusCode).toBe(200);
      expect((await h.call(coordinator, 'GET', `/v1/training-plans/${p.id}`)).json()).toMatchObject({ seatsTaken: 2, nominationsPending: 1 });

      // The database enforces the capacity as well (direct update past it).
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2 where id = $1`, [ids[3], coordinator.user]),
        CHECK_VIOLATION,
      );
    });

    it('two concurrent confirmations for the last seat confirm exactly one (plan row lock)', async () => {
      for (let round = 0; round < 3; round++) {
        const p = await plan({ capacity: 1 });
        const ids = await nominated(h, coordinator, p.id, [await fresh(), await fresh()]);
        const results = await Promise.all([act(h, coordinator, p.id, 'CONFIRM', [ids[0]!]), act(h, coordinator2, p.id, 'CONFIRM', [ids[1]!])]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('PLAN_FULL');
        expect((await participants(coordinator, p.id, '&state=CONFIRMED')).total).toBe(1);
      }
    });

    it('confirms only active employees, and never in a cancelled plan', async () => {
      const p = await plan();
      const leaving = await fresh();
      const [id] = await nominated(h, coordinator, p.id, [leaving]);
      await h.setStatus(A, leaving, 'INACTIVE_SEPARATED');
      expect((await act(h, coordinator, p.id, 'CONFIRM', [id!])).json()).toMatchObject({ error: 'EMPLOYEE_NOT_ACTIVE', details: { employeeId: leaving } });
      expect((await act(h, coordinator, p.id, 'CANCEL', [id!], 'Left the company (synthetic)')).statusCode).toBe(200);
    });
  });

  describe('attendance and completion', () => {
    it('records attendance from the start date and completion from the end date', async () => {
      const future = await plan();
      const [f] = await nominated(h, coordinator, future.id, [await fresh()]);
      await advance(h, coordinator, future.id, [f!], ['CONFIRM']);
      expect((await act(h, coordinator, future.id, 'MARK_ATTENDED', [f!])).json().error).toBe('SESSION_NOT_STARTED');
      expect((await act(h, coordinator, future.id, 'MARK_NO_SHOW', [f!])).json().error).toBe('SESSION_NOT_STARTED');

      const running = await plan({ startDate: addDays(today, -1), endDate: addDays(today, 1) });
      const [r] = await nominated(h, coordinator, running.id, [await fresh()]);
      await advance(h, coordinator, running.id, [r!], ['CONFIRM', 'MARK_ATTENDED']);
      expect((await act(h, coordinator, running.id, 'COMPLETE', [r!])).json().error).toBe('SESSION_NOT_ENDED');

      // The last day of a session counts as its end (F1: CURRENT includes the end date).
      const endsToday = await plan({ startDate: addDays(today, -1), endDate: today });
      const [t] = await nominated(h, coordinator, endsToday.id, [await fresh()]);
      await advance(h, coordinator, endsToday.id, [t!], ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
      expect((await detail(coordinator, t!)).json()).toMatchObject({ state: 'COMPLETED', feedbackStatus: 'MISSING' });

      // The database applies the same date rules.
      const [d] = await nominated(h, coordinator, future.id, [await fresh()]);
      await advance(h, coordinator, future.id, [d!], ['CONFIRM']);
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'ATTENDED', attendance_at = now(), attendance_by = $2 where id = $1`, [d, coordinator.user]),
        CHECK_VIOLATION,
      );
    });

    it('moves only along the F1 states; attendance corrections need a reason; completion is final', async () => {
      const p = await pastPlan();
      const [a, b, c] = await nominated(h, coordinator, p.id, [await fresh(), await fresh(), await fresh()]);
      expect((await act(h, coordinator, p.id, 'MARK_ATTENDED', [a!])).json()).toMatchObject({ error: 'INVALID_TRANSITION', details: { participantId: a, state: 'NOMINATED' } });
      await advance(h, coordinator, p.id, [a!, b!, c!], ['CONFIRM']);
      // Completion follows attendance.
      expect((await act(h, coordinator, p.id, 'COMPLETE', [c!])).json().error).toBe('INVALID_TRANSITION');
      await advance(h, coordinator, p.id, [a!], ['MARK_ATTENDED']);
      await advance(h, coordinator, p.id, [b!], ['MARK_NO_SHOW']);
      expect((await act(h, coordinator, p.id, 'COMPLETE', [b!])).json().error).toBe('INVALID_TRANSITION');
      // Correcting recorded attendance needs a reason.
      expect((await act(h, coordinator, p.id, 'MARK_ATTENDED', [b!])).json().error).toBe('REASON_REQUIRED');
      const corrected = await act(h, coordinator, p.id, 'MARK_ATTENDED', [b!], 'Signed the attendance sheet late (synthetic)');
      expect(corrected.json()).toMatchObject({ changed: 1, items: [{ id: b, state: 'ATTENDED' }] });
      // After attendance a participation is no longer cancelled.
      expect((await act(h, coordinator, p.id, 'CANCEL', [a!], 'Synthetic')).json().error).toBe('INVALID_TRANSITION');
      const done = await act(h, coordinator, p.id, 'COMPLETE', [a!, b!]);
      expect(done.json()).toMatchObject({ changed: 2, replayed: 0 });
      expect((await act(h, coordinator, p.id, 'COMPLETE', [a!])).json()).toMatchObject({ changed: 0, replayed: 1 });
      for (const action of ['MARK_NO_SHOW', 'CANCEL', 'CONFIRM']) {
        expect((await act(h, coordinator, p.id, action, [a!], 'Synthetic')).json().error, action).toBe('INVALID_TRANSITION');
      }
      expect(await historyOf(b!)).toEqual([
        ['NOMINATE', null, 'NOMINATED'],
        ['CONFIRM', 'NOMINATED', 'CONFIRMED'],
        ['MARK_NO_SHOW', 'CONFIRMED', 'NO_SHOW'],
        ['MARK_ATTENDED', 'NO_SHOW', 'ATTENDED'],
        ['COMPLETE', 'ATTENDED', 'COMPLETED'],
      ]);
      // Direct changes cannot leave the F1 states or rewrite history.
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'NOMINATED', confirmed_at = null, confirmed_by = null where id = $1`, [a]),
        CHECK_VIOLATION,
      );
      await expectSqlError(h.db.query(`update training_participant set updated_by = $2 where id = $1`, [a, coordinator.user]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`delete from training_participant where id = $1`, [c]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`update training_participant_event set reason = 'Rewritten' where participant_id = $1`, [a]), CHECK_VIOLATION);
      await expectSqlError(h.db.query(`delete from training_participant_event where participant_id = $1`, [a]), CHECK_VIOLATION);
    });

    it('nobody records their own participation in a coordinator context (C4; H3 TN17 "no falsified completion")', async () => {
      const p = await pastPlan();
      const [own] = await nominated(h, coordinator, p.id, [coordinatorEmp]);
      expect((await act(h, ownCoordinator, p.id, 'CONFIRM', [own!])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      // The database refuses the same directly: no confirmation, attendance or completion by the participant's own user.
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2 where id = $1`, [own, ownCoordinator.user]),
        CHECK_VIOLATION,
      );
      await advance(h, coordinator, p.id, [own!], ['CONFIRM']);
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'ATTENDED', attendance_at = now(), attendance_by = $2 where id = $1`, [own, ownCoordinator.user]),
        CHECK_VIOLATION,
      );
      await advance(h, coordinator, p.id, [own!], ['MARK_ATTENDED']);
      expect((await act(h, ownCoordinator, p.id, 'COMPLETE', [own!])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      await expectSqlError(
        h.db.query(`update training_participant set participation_state = 'COMPLETED', completed_at = now(), completed_by = $2 where id = $1`, [own, ownCoordinator.user]),
        CHECK_VIOLATION,
      );
      await advance(h, coordinator2, p.id, [own!], ['COMPLETE']);
      // The employee never records attendance or completion.
      const [mine] = await nominated(h, coordinator, p.id, [employeeEmp]);
      await advance(h, coordinator, p.id, [mine!], ['CONFIRM']);
      for (const action of ['MARK_ATTENDED', 'COMPLETE', 'CONFIRM']) expect((await act(h, employee, p.id, action, [mine!])).statusCode, action).toBe(403);
      expect((await detail(employee, mine!)).json().state).toBe('CONFIRMED');
    });

    it('acts only on participations of the plan, within scope and company', async () => {
      const p = await plan();
      const other = await plan();
      const [inP] = await nominated(h, coordinator, p.id, [await fresh()]);
      const [inOther] = await nominated(h, coordinator, other.id, [await fresh()]);
      expect((await act(h, coordinator, p.id, 'CONFIRM', [inP!, inOther!])).statusCode).toBe(404);
      const [fin] = await nominated(h, coordinator, p.id, [await fresh({ departmentId: A.financeDept })]);
      expect((await act(h, filteredHr, p.id, 'CONFIRM', [fin!])).statusCode).toBe(404);
      expect((await act(h, bCoordinator, p.id, 'CONFIRM', [inP!])).statusCode).toBe(404);
      expect((await detail(bCoordinator, inP!)).statusCode).toBe(404);
      expect((await participants(coordinator, p.id, '&state=CONFIRMED')).total).toBe(0);
    });
  });

  describe('own enrolment (H3 TN17)', () => {
    it('the employee nominates themselves only where the plan allows it and the session has not ended', async () => {
      const closed = await plan();
      expect((await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: closed.id })).statusCode).toBe(404);
      const open = await plan({ selfNomination: true, title: 'Synthetic open course', cost: { amount: '300', currency: 'INR' } });
      const listed = (await h.call(employee, 'GET', '/v1/me/training-plans')).json().items as Record<string, unknown>[];
      const entry = listed.find((x) => x.id === open.id)!;
      expect(entry).toMatchObject({ code: open.code, title: 'Synthetic open course', view: 'FUTURE', myParticipation: null });
      // No cost, seat counts or other participants in the employee's view.
      for (const key of ['cost', 'seatsTaken', 'capacity', 'nominationsPending']) expect(entry, key).not.toHaveProperty(key);
      expect(listed.map((x) => x.id)).not.toContain(closed.id);

      const res = await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: open.id });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ employeeId: employeeEmp, state: 'NOMINATED', selfNominated: true });
      expect((await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: open.id })).json().error).toBe('PARTICIPANT_EXISTS');
      const mine = ((await h.call(employee, 'GET', '/v1/me/training-plans')).json().items as Record<string, unknown>[]).find((x) => x.id === open.id)!;
      expect(mine.myParticipation).toEqual({ participantId: res.json().id, state: 'NOMINATED', selfNominated: true });
      // The coordinator still confirms it (capacity).
      expect((await act(h, coordinator, open.id, 'CONFIRM', [res.json().id])).statusCode).toBe(200);

      const ended = await pastPlan({ selfNomination: true });
      expect((await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: ended.id })).json().error).toBe('PLAN_ENDED');
      const cancelled = await plan({ selfNomination: true });
      await h.call(coordinator, 'POST', `/v1/training-plans/${cancelled.id}/cancel`, { reason: 'Synthetic', expectedVersion: 1 });
      expect((await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: cancelled.id })).statusCode).toBe(404);
      expect((await h.call(leaver, 'POST', '/v1/me/training-nominations', { planId: open.id })).json().error).toBe('EMPLOYEE_NOT_ACTIVE');
      // Other contexts do not enrol (BR-055: own records in the Employee context).
      for (const who of [coordinator, manager, hr]) expect((await h.call(who, 'POST', '/v1/me/training-nominations', { planId: open.id })).statusCode).toBe(403);
      expect((await h.call(coordinator, 'GET', '/v1/me/training-plans')).statusCode).toBe(403);
      // A coordinator who is also an employee reads their own training records in their Employee context only, even
      // where the coordinator context holds the permission (BR-055).
      const ownFeedback = await h.call(ownCoordinator, 'GET', '/v1/me/training-feedback');
      expect(ownFeedback.statusCode).toBe(403);
      expect(ownFeedback.json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
    });

    it('withdraws only their own self-nomination before it is confirmed', async () => {
      const open = await plan({ selfNomination: true });
      const own = (await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: open.id })).json() as Participant;
      expect((await h.call(colleague, 'POST', `/v1/me/training-nominations/${own.id}/withdraw`, { reason: 'Synthetic' })).statusCode).toBe(404);
      expect((await h.call(employee, 'POST', `/v1/me/training-nominations/${own.id}/withdraw`, { reason: '  ' })).json().error).toBe('REASON_REQUIRED');
      const withdrawn = await h.call(employee, 'POST', `/v1/me/training-nominations/${own.id}/withdraw`, { reason: 'Schedule conflict (synthetic)' });
      expect(withdrawn.json()).toMatchObject({ id: own.id, state: 'CANCELLED', replayed: false });
      // The withdrawal reason is kept as a confidential participation reason (an approved grant reads it).
      expect((await detail(hrReasons, own.id)).json()).toMatchObject({ state: 'CANCELLED', cancellationReason: 'Schedule conflict (synthetic)' });
      expect((await h.call(employee, 'POST', `/v1/me/training-nominations/${own.id}/withdraw`, { reason: 'Again' })).json()).toMatchObject({ state: 'CANCELLED', replayed: true });
      // Enrolling again uses the same participation row.
      expect((await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: open.id })).json()).toMatchObject({ id: own.id, state: 'NOMINATED', selfNominated: true });
      expect(await historyOf(own.id)).toEqual([
        ['SELF_NOMINATE', null, 'NOMINATED'],
        ['WITHDRAW', 'NOMINATED', 'CANCELLED'],
        ['SELF_NOMINATE', 'CANCELLED', 'NOMINATED'],
      ]);
      await advance(h, coordinator, open.id, [own.id], ['CONFIRM']);
      expect((await h.call(employee, 'POST', `/v1/me/training-nominations/${own.id}/withdraw`, { reason: 'Synthetic' })).json().error).toBe('NOT_WITHDRAWABLE');

      const assigned = await plan({ selfNomination: true });
      const [byCoordinator] = await nominated(h, coordinator, assigned.id, [colleagueEmp]);
      expect((await h.call(colleague, 'POST', `/v1/me/training-nominations/${byCoordinator}/withdraw`, { reason: 'Synthetic' })).json().error).toBe('NOT_SELF_NOMINATED');
      // A coordinator's cancellation stands: the employee does not enrol again over it.
      expect((await act(h, coordinator, assigned.id, 'CANCEL', [byCoordinator!], 'Prerequisite course missing (synthetic)')).statusCode).toBe(200);
      expect((await h.call(colleague, 'POST', '/v1/me/training-nominations', { planId: assigned.id })).json()).toMatchObject({
        error: 'CANCELLED_BY_COORDINATOR',
        details: { participantId: byCoordinator },
      });
      expect((await nominate(h, coordinator, assigned.id, [colleagueEmp])).statusCode).toBe(201);
    });
  });

  describe('views and scope (H3 TN17, DF16)', () => {
    it('shows the employee their own participations, the manager the direct team, the coordinator its scope; the rest reads as missing', async () => {
      const p = await plan({ title: 'Synthetic team course' });
      const [mine, theirs] = await nominated(h, coordinator, p.id, [employeeEmp, colleagueEmp]);
      const own = await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/training`);
      expect(own.statusCode, own.body).toBe(200);
      const item = (own.json().items as Record<string, unknown>[]).find((x) => x.id === mine)!;
      expect(item).toMatchObject({ state: 'NOMINATED', feedbackStatus: 'NOT_APPLICABLE', plan: { id: p.id, code: p.code, title: 'Synthetic team course', view: 'FUTURE', ownerName: 'Olu Owner (synthetic)' } });
      expect(JSON.stringify(own.json())).not.toContain(colleagueEmp);
      expect(item.plan).not.toHaveProperty('cost');
      expect((await detail(employee, mine!)).statusCode).toBe(200);

      // Another employee's record reads as missing (and the attempt is recorded).
      expect((await h.call(employee, 'GET', `/v1/employees/${colleagueEmp}/training`)).statusCode).toBe(404);
      expect((await detail(employee, theirs!)).statusCode).toBe(404);
      const denial = await h.one<{ after_values: { reason: string } }>(
        `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and record_key = $3`,
        [A.id, employee.user, colleagueEmp],
      );
      expect(denial.after_values.reason).toBe('OUT_OF_SCOPE');

      // The manager sees the direct report's training (My Team), not others; not the plan register.
      expect((await h.call(manager, 'GET', `/v1/employees/${employeeEmp}/training`)).json().items.map((x: { id: string }) => x.id)).toContain(mine);
      expect((await h.call(manager, 'GET', `/v1/employees/${colleagueEmp}/training`)).statusCode).toBe(404);
      expect((await detail(manager, mine!)).statusCode).toBe(200);
      expect((await detail(manager, theirs!)).statusCode).toBe(404);
      expect((await h.call(manager, 'GET', `/v1/training-plans/${p.id}/participants`)).statusCode).toBe(403);

      // A department-filtered HR assignment lists the plan's participants of its department only.
      const scoped = await participants(filteredHr, p.id);
      expect(scoped.items.map((t) => t.employeeId)).toEqual([employeeEmp]);
      expect(scoped).toMatchObject({ total: 1, scope: { kind: 'COMPANY', companyWide: false } });
      expect((await participants(coordinator, p.id)).total).toBe(2);
      expect((await h.call(bCoordinator, 'GET', `/v1/training-plans/${p.id}/participants`)).statusCode).toBe(404);
      expect((await h.call(bCoordinator, 'GET', `/v1/employees/${employeeEmp}/training`)).statusCode).toBe(404);
    });

    it('participation reasons are confidential: the employee, the manager, the coordinator and default HR never read them (DF02, I-16)', async () => {
      // A coordinator's attendance correction and cancellation, and the employee's own withdrawal.
      const held = await pastPlan({ title: 'Synthetic reasons course' });
      const [corrected] = await nominated(h, coordinator, held.id, [employeeEmp]);
      await advance(h, coordinator, held.id, [corrected!], ['CONFIRM', 'MARK_NO_SHOW']);
      expect((await act(h, coordinator, held.id, 'MARK_ATTENDED', [corrected!], 'Signed the sheet late, synthetic narrative R')).statusCode).toBe(200);
      const other = await plan();
      const [dropped] = await nominated(h, coordinator, other.id, [employeeEmp]);
      expect((await act(h, coordinator, other.id, 'CANCEL', [dropped!], 'Private matter, synthetic narrative S')).statusCode).toBe(200);
      const open = await plan({ selfNomination: true });
      const self = (await h.call(employee, 'POST', '/v1/me/training-nominations', { planId: open.id })).json() as Participant;
      expect((await h.call(employee, 'POST', `/v1/me/training-nominations/${self.id}/withdraw`, { reason: 'Personal reason, synthetic narrative T' })).statusCode).toBe(200);

      const views = async (who: TestActor) => {
        const list = await h.call(who, 'GET', `/v1/employees/${employeeEmp}/training`);
        expect(list.statusCode, list.body).toBe(200);
        const details = [];
        for (const id of [corrected!, dropped!, self.id]) {
          const d = await detail(who, id);
          expect(d.statusCode, d.body).toBe(200);
          details.push(d.json());
        }
        return { items: list.json().items as Participant[], details: details as (Participant & { history: HistoryEntry[] })[] };
      };
      for (const who of [employee, manager, coordinator, hr]) {
        const seen = await views(who);
        expect(JSON.stringify(seen)).not.toContain('synthetic narrative');
        for (const item of [...seen.items, ...seen.details]) expect(item).not.toHaveProperty('cancellationReason');
        for (const e of seen.details.flatMap((d) => d.history)) expect(e).not.toHaveProperty('reason');
      }
      for (const who of [coordinator, hr]) expect(JSON.stringify(await participants(who, other.id))).not.toContain('synthetic narrative');
      // What is shown is that a reason was recorded.
      const history = (await detail(employee, corrected!)).json().history as HistoryEntry[];
      expect(history.map((e) => [e.action, e.reasonRecorded])).toEqual([
        ['NOMINATE', false],
        ['CONFIRM', false],
        ['MARK_NO_SHOW', false],
        ['MARK_ATTENDED', true],
      ]);
      // An eligible HR Administrator assignment with the approved grant reads them.
      const granted = await views(hrReasons);
      for (const n of ['R', 'S', 'T']) expect(JSON.stringify(granted)).toContain(`synthetic narrative ${n}`);
      expect(granted.details[0]!.history.at(-1)).toMatchObject({ action: 'MARK_ATTENDED', reason: 'Signed the sheet late, synthetic narrative R', reasonRecorded: true });
      expect(granted.details[1]).toMatchObject({ state: 'CANCELLED', cancellationReason: 'Private matter, synthetic narrative S' });
      expect((await participants(hrReasons, other.id)).items.find((t) => t.id === dropped)).toMatchObject({ cancellationReason: 'Private matter, synthetic narrative S' });
      // The group is confidential and ceiling-only: never a default duty, never an own-ESS group, never the coordinator's.
      const roles = new Map(BASELINE_ROLES.map((r) => [r.code, r]));
      for (const code of ['HR_ADMINISTRATOR', 'REPORTING_MANAGER']) {
        expect(roles.get(code)!.ceiling, code).toContain('training_participant.read.reason');
        expect(roles.get(code)!.defaultDuties, code).not.toContain('training_participant.read.reason');
      }
      for (const code of ['EMPLOYEE', 'TRAINING_COORDINATOR']) expect(roles.get(code)!.ceiling, code).not.toContain('training_participant.read.reason');
      const flag = await h.one<{ own_ess: boolean }>(`select own_ess from permission where resource = 'training_participant' and action = 'read' and field_group = 'reason'`);
      expect(flag.own_ess).toBe(false);
    });
  });

  describe('notifications and audit (DF12, DF08)', () => {
    it('tells the participant when nominated, confirmed, cancelled and completed, with plan identity and dates only', async () => {
      const p = await pastPlan({ title: 'Synthetic data handling' });
      const [mine] = await nominated(h, coordinator, p.id, [employeeEmp]);
      await advance(h, coordinator, p.id, [mine!], ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
      const other = await plan({ title: 'Synthetic negotiation basics' });
      const [theirs] = await nominated(h, coordinator, other.id, [colleagueEmp]);
      expect((await act(h, coordinator, other.id, 'CANCEL', [theirs!], 'Private family matter (synthetic)')).statusCode).toBe(200);
      const open = await plan({ selfNomination: true, title: 'Synthetic self-enrolled course' });
      expect((await h.call(colleague, 'POST', '/v1/me/training-nominations', { planId: open.id })).statusCode).toBe(201);

      await dispatchOutbox(h.pool, 500);
      const mineNotes = (await inbox(h, employee)).filter((n) => n.body.includes(p.code));
      expect(mineNotes.map((n) => n.category).sort()).toEqual(['TRAINING_COMPLETED', 'TRAINING_CONFIRMED', 'TRAINING_NOMINATED']);
      expect(mineNotes.find((n) => n.category === 'TRAINING_CONFIRMED')!.body).toBe(
        `Your place in the training Synthetic data handling (${p.code}), ${addDays(today, -3)} to ${addDays(today, -1)}, is confirmed.`,
      );
      const theirNotes = await inbox(h, colleague);
      expect(theirNotes.filter((n) => n.body.includes(other.code)).map((n) => n.category).sort()).toEqual(['TRAINING_NOMINATED', 'TRAINING_PARTICIPATION_CANCELLED']);
      expect(JSON.stringify(theirNotes)).not.toContain('Private family matter');
      // A self-nomination is not announced to the employee who made it.
      expect(theirNotes.filter((n) => n.body.includes(open.code))).toEqual([]);

      const payloads = (await h.db.query<{ topic: string; payload: Record<string, unknown> }>(`select topic, payload from outbox_event where company_id = $1 and topic like 'training.%'`, [A.id])).rows;
      expect(payloads.length).toBeGreaterThan(0);
      for (const r of payloads) {
        expect(Object.keys(r.payload).sort(), r.topic).toEqual(['participantId', 'planId', 'state']);
        expect(JSON.stringify(r.payload)).not.toContain('Private family matter');
      }
      const trail = (
        await h.db.query<{ action: string; reason: string | null; after_values: Record<string, unknown> }>(
          `select action, reason, after_values from audit_event where company_id = $1 and resource_code = 'training_participant' and record_key = $2`,
          [A.id, theirs],
        )
      ).rows;
      expect(trail.map((r) => r.action).sort()).toEqual(['CANCEL', 'NOMINATE']);
      expect(trail.find((r) => r.action === 'CANCEL')).toMatchObject({ reason: 'Private family matter (synthetic)', after_values: { operational: { state: 'CANCELLED' } } });
      // The describer ignores malformed payloads and other companies' ids instead of failing (DF12 retries).
      expect(await TRAINING_EVENTS['training.confirmed']!(h.pool, { companyId: A.id, topic: 'training.confirmed', aggregateId: mine!, payload: { participantId: 'not-a-uuid' } })).toBeNull();
      expect(
        await TRAINING_EVENTS['training.confirmed']!(h.pool, { companyId: B.id, topic: 'training.confirmed', aggregateId: mine!, payload: { participantId: mine! } }),
      ).toBeNull();
    });
  });
});
