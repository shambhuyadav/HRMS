// Manpower budgets and requisitions over HTTP (FR-011, FR-012; F1 hiring route and states; DF02; DF03; DF08; C4;
// ZT01/02/04/07/10/11/12). Synthetic data only: example.test addresses and made-up names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { revokedAfterGuard } from '../../test/after-guard.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { HIRING_EVENTS } from './events.js';
import { closeRequisition } from './requisition.js';

describe.runIf(isModuleActive('hiring'))('hiring: budgets and requisitions', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr1: TestActor;
  let hr2: TestActor;
  let hr3: TestActor;
  let hrFin: TestActor;
  let bHr: TestActor;
  let topManager: TestActor;
  let requester: TestActor;
  let otherManager: TestActor;
  let employee: TestActor;
  let recruiter: TestActor;
  let requesterEmp: string;
  let today: string;
  let targetDate: string;
  let periodStart: string;
  let periodEnd: string;
  let desigQa: string;
  let desigOps: string;

  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  const requisitionBody = (overrides: Record<string, unknown> = {}) => ({
    title: 'Synthetic platform engineer',
    departmentId: A.dept,
    locationId: A.loc,
    designationId: A.desig,
    employmentType: 'PERMANENT',
    vacancies: 1,
    reasonType: 'NEW',
    reason: 'Synthetic team growth',
    skills: ['TypeScript', ' typescript ', 'PostgreSQL'],
    targetDate,
    hiringManagerId: requesterEmp,
    ...overrides,
  });
  const createReq = async (a: TestActor, overrides: Record<string, unknown> = {}) => {
    const res = await h.call(a, 'POST', '/v1/hiring/requisitions', requisitionBody(overrides));
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; code: string; version: number; state: string } & Record<string, unknown>;
  };
  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/hiring/requisitions/${id}`)).json();
  const submit = async (a: TestActor, id: string) => h.call(a, 'POST', `/v1/hiring/requisitions/${id}/submit`, { expectedVersion: (await view(a, id)).version });
  const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/hiring/requisition-tasks')).json().items as { taskId: string; step: number; stepAction: string; requisition: { id: string } | null }[];
  const taskFor = async (a: TestActor, id: string) => (await tasks(a)).find((t) => t.requisition?.id === id);
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/hiring/requisition-tasks/${taskId}/decision`, { idempotencyKey: uniq('req-key-'), ...body });
  /** Submits and takes the requisition through both steps. */
  const approveThrough = async (id: string, hrApprover: TestActor, extra: Record<string, unknown> = {}) => {
    expect((await submit(requester, id)).json().state).toBe('SUBMITTED');
    const t1 = (await taskFor(topManager, id))!;
    expect((await decide(topManager, t1.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'SUBMITTED', pendingStep: 2 });
    const t2 = (await taskFor(hrApprover, id))!;
    return decide(hrApprover, t2.taskId, { decision: 'APPROVE', ...extra });
  };
  const budget = async (designationId: string, headcount: number) => {
    const created = await h.call(hr1, 'POST', '/v1/hiring/budgets', { departmentId: A.dept, locationId: A.loc, designationId, periodStart, periodEnd, headcount, reason: 'Synthetic plan' });
    expect(created.statusCode, created.body).toBe(201);
    const { revisionId, budgetId } = created.json() as { revisionId: string; budgetId: string };
    expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${revisionId}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
    const task = ((await h.call(hr2, 'GET', '/v1/hiring/budget-tasks')).json().items as { taskId: string; revision: { revisionId: string } }[]).find((t) => t.revision?.revisionId === revisionId)!;
    expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('budget-key-') })).json().state).toBe('APPROVED');
    return budgetId;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr1 = await h.actor(A, 'HR_ADMINISTRATOR');
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    const person = async (managerId?: string, departmentId = A.dept) => {
      const e = (await h.call(hr1, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId }))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      if (managerId) expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
      return e.id as string;
    };
    const topEmp = await person();
    requesterEmp = await person(topEmp);
    topManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: topEmp });
    requester = await h.actor(A, 'REPORTING_MANAGER', { employeeId: requesterEmp });
    otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person() });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person(requesterEmp) });
    recruiter = await h.actor(A, 'RECRUITER');
    // An HR Administrator who is also an employee without a manager raises a requisition later (fallback route).
    hr3 = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: await person() });
    for (const kind of ['requisition', 'manpower_budget_revision']) {
      const res = await h.call(hr1, 'PUT', `/v1/workflows/${kind}/fallback-reviewers`, { reviewers: [{ userId: hr1.user, priority: 1 }, { userId: hr2.user, priority: 2 }] });
      expect(res.statusCode, res.body).toBe(200);
    }
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    targetDate = addDays(today, 30);
    periodStart = addDays(today, -30);
    periodEnd = addDays(today, 365);
    const designation = async (code: string) => (await h.one<{ id: string }>(`insert into designation (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
    desigQa = await designation('QA');
    desigOps = await designation('OPS');
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('manpower budget (FR-011)', () => {
    it('needs an independent HR approval; the latest approved revision is in force', async () => {
      const created = await h.call(hr1, 'POST', '/v1/hiring/budgets', { departmentId: A.dept, locationId: A.loc, designationId: A.desig, periodStart, periodEnd, headcount: 2, reason: 'Synthetic plan' });
      expect(created.statusCode, created.body).toBe(201);
      const { budgetId, revisionId } = created.json();
      expect(created.json()).toMatchObject({ revision: 1, state: 'DRAFT', headcount: 2 });
      // One budget line per department, location and designation on any date.
      const overlapping = await h.call(hr1, 'POST', '/v1/hiring/budgets', { departmentId: A.dept, locationId: A.loc, designationId: A.desig, periodStart: today, periodEnd: today, headcount: 9, reason: 'Overlap' });
      expect(overlapping.json().error).toBe('OVERLAPPING_PERIOD');
      // Only the preparer changes or submits the draft.
      expect((await h.call(hr2, 'PUT', `/v1/hiring/budget-revisions/${revisionId}`, { headcount: 9, reason: 'x', expectedVersion: 1 })).json().error).toBe('NOT_PREPARER');
      expect((await h.call(hr1, 'PUT', `/v1/hiring/budget-revisions/${revisionId}`, { headcount: 3, reason: 'Synthetic plan, revised', expectedVersion: 1 })).json()).toMatchObject({ headcount: 3, version: 2 });
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${revisionId}/submit`, { expectedVersion: 1 })).json().error).toBe('STALE_VERSION');
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${revisionId}/submit`, { expectedVersion: 2 })).json().state).toBe('SUBMITTED');
      // Reviewer notices are delivered while the reviewer still holds the open task.
      await dispatchOutbox(h.pool, 500);
      expect((await inbox(hr2)).find((n) => n.category === 'BUDGET_REVISION_SUBMITTED')!.body).toContain('ENG, HQ, DEV');
      // The preparer is first on the list but never reviews their own revision.
      expect((await h.call(hr1, 'GET', '/v1/hiring/budget-tasks')).json().items).toEqual([]);
      const task = (await h.call(hr2, 'GET', '/v1/hiring/budget-tasks')).json().items[0];
      expect(task.revision).toMatchObject({ revisionId, headcount: 3, approvedHeadcount: null, committed: 0, departmentName: 'ENG' });
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('budget-key-') })).statusCode).toBe(404);
      expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'REJECT', idempotencyKey: uniq('budget-key-') })).json().error).toBe('REASON_REQUIRED');
      // Returning is not offered for budget revisions (approve or reject; a new revision follows a rejection).
      expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'RETURN', reason: 'x', idempotencyKey: uniq('budget-key-') })).statusCode).toBe(400);
      const key = uniq('budget-key-');
      expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key })).json()).toEqual({ revisionId, state: 'APPROVED', replayed: false });
      // ZT07: the same key replays without a second effect.
      expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key })).json()).toEqual({ revisionId, state: 'APPROVED', replayed: true });
      const stored = await h.one<{ decided_by: string; prepared_by: string }>(`select decided_by, prepared_by from manpower_budget_revision where id = $1`, [revisionId]);
      expect(stored).toEqual({ decided_by: hr2.user, prepared_by: hr1.user });

      // A second revision while none is open; while it is pending the approved headcount stays in force.
      const second = await h.call(hr1, 'POST', `/v1/hiring/budgets/${budgetId}/revisions`, { headcount: 1, reason: 'Synthetic reduction' });
      expect(second.json()).toMatchObject({ revision: 2, state: 'DRAFT' });
      expect((await h.call(hr1, 'POST', `/v1/hiring/budgets/${budgetId}/revisions`, { headcount: 5, reason: 'Another' })).json().error).toBe('OPEN_REVISION_EXISTS');
      expect((await h.call(hr1, 'GET', `/v1/hiring/budgets/${budgetId}`)).json()).toMatchObject({ approvedHeadcount: 3, openRevision: { revision: 2, state: 'DRAFT' } });
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${second.json().revisionId}/withdraw`)).json().state).toBe('WITHDRAWN');
      const detail = (await h.call(hr1, 'GET', `/v1/hiring/budgets/${budgetId}`)).json();
      expect(detail).toMatchObject({ approvedHeadcount: 3, committed: 0, openRevision: null });
      expect(detail.revisions.map((r: { revision: number; state: string }) => [r.revision, r.state])).toEqual([
        [2, 'WITHDRAWN'],
        [1, 'APPROVED'],
      ]);

      await dispatchOutbox(h.pool, 500);
      expect((await inbox(hr1)).find((n) => n.category === 'BUDGET_REVISION_DECIDED')!.body).toContain('was approved');

      // DF12: withdrawing a submitted revision cancels the review and tells the reviewer no decision is needed.
      const third = (await h.call(hr1, 'POST', `/v1/hiring/budgets/${budgetId}/revisions`, { headcount: 4, reason: 'Synthetic growth' })).json();
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${third.revisionId}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
      const pending = ((await h.call(hr2, 'GET', '/v1/hiring/budget-tasks')).json().items as { taskId: string; revision: { revisionId: string } }[]).find((t) => t.revision?.revisionId === third.revisionId)!;
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${third.revisionId}/withdraw`)).json().state).toBe('WITHDRAWN');
      expect((await h.call(hr2, 'GET', '/v1/hiring/budget-tasks')).json().items).toEqual([]);
      expect((await h.call(hr2, 'POST', `/v1/hiring/budget-tasks/${pending.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('budget-key-') })).json().error).toBe('TASK_CLOSED');
      expect((await h.call(hr1, 'GET', `/v1/hiring/budgets/${budgetId}`)).json()).toMatchObject({ approvedHeadcount: 3, openRevision: null });
      await dispatchOutbox(h.pool, 500);
      expect((await inbox(hr2)).filter((n) => n.category === 'BUDGET_REVISION_WITHDRAWN').map((n) => n.body)).toEqual([
        'The manpower budget revision for ENG, HQ, DEV (' + periodStart + ' to ' + periodEnd + ') was withdrawn by its preparer; no decision is needed.',
      ]);
    });

    it('is visible only within scope and never across companies', async () => {
      const list = (await h.call(hr1, 'GET', '/v1/hiring/budgets')).json().items as { id: string }[];
      expect(list).toHaveLength(1);
      const id = list[0]!.id;
      expect((await h.call(hrFin, 'GET', `/v1/hiring/budgets/${id}`)).statusCode).toBe(404);
      expect((await h.call(hrFin, 'GET', '/v1/hiring/budgets')).json().items).toEqual([]);
      expect((await h.call(bHr, 'GET', `/v1/hiring/budgets/${id}`)).statusCode).toBe(404);
      expect((await h.call(recruiter, 'GET', '/v1/hiring/budgets')).statusCode).toBe(403);
      // A filtered HR Administrator cannot place a budget outside the filter.
      expect((await h.call(hrFin, 'POST', '/v1/hiring/budgets', { departmentId: A.dept, locationId: A.loc, designationId: desigOps, periodStart, periodEnd, headcount: 1, reason: 'x' })).statusCode).toBe(403);
    });
  });

  describe('requisition route (FR-012, F1)', () => {
    let first: string;

    it('requester -> direct manager validation -> HR budget/headcount approval', async () => {
      const created = await createReq(requester, { vacancies: 2 });
      first = created.id;
      expect(created).toMatchObject({
        state: 'DRAFT',
        code: expect.stringMatching(/^REQ-\d{6}$/),
        currentRevision: 0,
        skills: ['TypeScript', 'PostgreSQL'],
        employmentType: 'PERMANENT',
        requester: { id: requesterEmp },
        budgetCheck: { budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 3, committed: 0, requested: 2 },
        decisions: [],
        pendingWith: null,
      });
      expect((await submit(requester, first)).json()).toMatchObject({ state: 'SUBMITTED', revision: 1, budgetStatus: 'WITHIN_BUDGET' });
      // A submitted requisition is kept as sent.
      expect((await h.call(requester, 'PUT', `/v1/hiring/requisitions/${first}`, { ...requisitionBody(), expectedVersion: (await view(requester, first)).version })).json().error).toBe('INVALID_STATE');

      // Step 1 goes to the requester's direct manager, never to HR or the requester.
      expect(await taskFor(hr1, first)).toBeUndefined();
      const t1 = (await taskFor(topManager, first))!;
      expect(t1).toMatchObject({ step: 1, stepAction: 'validate' });
      expect((await view(requester, first)).pendingWith).toMatchObject({ step: 1, action: 'validate' });
      await dispatchOutbox(h.pool, 500);
      const code = (await view(requester, first)).code as string;
      expect((await inbox(topManager)).find((n) => n.category === 'REQUISITION_SUBMITTED')!.body).toBe(
        `Requisition ${code} (Synthetic platform engineer, 2 vacancies) is waiting for your validation.`,
      );
      // Someone else's task reads as missing; the requester decides nothing.
      expect((await decide(requester, t1.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
      expect((await decide(topManager, t1.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'SUBMITTED', pendingStep: 2 });
      expect(await taskFor(topManager, first)).toBeUndefined();

      // Step 2: the first eligible HR Administrator on the explicit list.
      const t2 = (await taskFor(hr1, first))!;
      expect(t2).toMatchObject({ step: 2, stepAction: 'approve', requisition: { budgetCheck: { budgetStatus: 'WITHIN_BUDGET' } } });
      await dispatchOutbox(h.pool, 500);
      expect((await inbox(hr1)).find((n) => n.category === 'REQUISITION_SUBMITTED')!.body).toContain('waiting for your budget and headcount approval');
      expect((await decide(topManager, t2.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
      expect((await decide(hr1, t2.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ requisitionId: first, state: 'APPROVED' });

      const approved = await view(requester, first);
      // FR-011: the requisition records the budget line it was checked and approved against.
      const line = ((await h.call(hr1, 'GET', '/v1/hiring/budgets')).json().items as { id: string; designationId: string }[]).find((b) => b.designationId === A.desig)!;
      expect(approved).toMatchObject({ state: 'APPROVED', decidedBy: hr1.user, budgetCheck: null, filled: 0, budgetId: line.id });
      expect(approved.decisions.map((d: { step: number; decision: string }) => [d.step, d.decision])).toEqual([
        [1, 'APPROVE'],
        [2, 'APPROVE'],
      ]);
      expect(approved.revisions).toEqual([expect.objectContaining({ revision: 1, budgetId: line.id, budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 3, committed: 0, vacancies: 2 })]);

      await dispatchOutbox(h.pool, 500);
      expect((await inbox(requester)).find((n) => n.category === 'REQUISITION_DECIDED')!.body).toBe(`Your requisition ${approved.code} (Synthetic platform engineer) was approved.`);
    });

    it('a requisition beyond its budget needs a recorded exception that HR approves explicitly', async () => {
      // 2 of 3 approved places are committed; 2 more exceed the budget.
      const r = await createReq(requester, { vacancies: 2, title: 'Synthetic second team' });
      expect(r.budgetCheck).toEqual({ budgetStatus: 'EXCEEDS_BUDGET', approvedHeadcount: 3, committed: 2, requested: 2 });
      const refused = await submit(requester, r.id);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'BUDGET_EXCEPTION_REASON_REQUIRED', details: { budgetStatus: 'EXCEEDS_BUDGET', committed: 2 } });
      const updated = await h.call(requester, 'PUT', `/v1/hiring/requisitions/${r.id}`, { ...requisitionBody({ vacancies: 2, title: 'Synthetic second team' }), budgetExceptionReason: 'Synthetic urgent project', expectedVersion: r.version });
      expect(updated.json()).toMatchObject({ budgetExceptionReason: 'Synthetic urgent project' });
      expect((await submit(requester, r.id)).json()).toMatchObject({ state: 'SUBMITTED', budgetStatus: 'EXCEEDS_BUDGET' });
      const t1 = (await taskFor(topManager, r.id))!;
      await decide(topManager, t1.taskId, { decision: 'APPROVE' });
      const t2 = (await taskFor(hr1, r.id))!;
      expect((await decide(hr1, t2.taskId, { decision: 'APPROVE' })).json().error).toBe('BUDGET_EXCEPTION_DECISION_REQUIRED');
      expect((await decide(hr1, t2.taskId, { decision: 'APPROVE', approveBudgetException: true })).json().state).toBe('APPROVED');
      expect(await view(hr1, r.id)).toMatchObject({ state: 'APPROVED', budgetExceptionApprovedBy: hr1.user, budgetExceptionReason: 'Synthetic urgent project' });
      const trail = await h.one<{ after_values: { operational: Record<string, unknown> } }>(`select after_values from audit_event where record_key = $1 and action = 'APPROVE'`, [r.id]);
      expect(trail.after_values.operational).toMatchObject({ budgetStatus: 'EXCEEDS_BUDGET', budgetExceptionApproved: true, approvedHeadcount: 3, committed: 2, requested: 2 });
    });

    it('a requisition without any budget is an exception too', async () => {
      const r = await createReq(requester, { designationId: desigOps, title: 'Synthetic operator' });
      expect(r.budgetCheck).toEqual({ budgetStatus: 'NO_BUDGET', approvedHeadcount: null, committed: 0, requested: 1 });
      expect((await submit(requester, r.id)).json().error).toBe('BUDGET_EXCEPTION_REASON_REQUIRED');
      // DF08: the abandoned draft is kept, closed with its reason.
      expect((await h.call(requester, 'POST', `/v1/hiring/requisitions/${r.id}/discard`, { reason: 'Synthetic: not needed' })).json().state).toBe('CLOSED');
      expect(await view(requester, r.id)).toMatchObject({ state: 'CLOSED', closureReason: 'Synthetic: not needed' });
    });

    describe('DF03 "a new request links to the rejected predecessor"', () => {
      const rejectedRequisition = async () => {
        const r = await createReq(requester, { title: 'Synthetic rejected role', budgetExceptionReason: 'Synthetic: no budget line yet' });
        expect((await submit(requester, r.id)).statusCode).toBe(200);
        const t1 = (await taskFor(topManager, r.id))!;
        expect((await decide(topManager, t1.taskId, { decision: 'REJECT', reason: 'Synthetic: not this year' })).json().state).toBe('REJECTED');
        return r.id;
      };
      const raiseAgain = (a: TestActor, id: string) => h.call(a, 'POST', `/v1/hiring/requisitions/${id}/raise-again`);

      it('raising again copies the job details into a draft that says what it follows, and shows the link; a plain copy has none', async () => {
        const first = await rejectedRequisition();
        const copy = await h.call(requester, 'POST', `/v1/hiring/requisitions/${first}/copy`);
        expect(copy.json()).toMatchObject({ predecessorRequestId: null, copiedFromRequisitionId: first });
        const res = await raiseAgain(requester, first);
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json()).toMatchObject({ state: 'DRAFT', title: 'Synthetic rejected role', predecessorRequestId: first, copiedFromRequisitionId: first });
        expect((await view(requester, res.json().id)).predecessorRequestId).toBe(first);
      });

      it('a created requisition can name it too; the same rules hold: own, rejected, one live successor, set at creation only', async () => {
        const first = await rejectedRequisition();
        const created = await createReq(requester, { predecessorRequestId: first });
        expect(created.predecessorRequestId).toBe(first);
        // One live successor, by either path.
        const second = await h.call(requester, 'POST', '/v1/hiring/requisitions', requisitionBody({ predecessorRequestId: first }));
        expect(second.statusCode).toBe(409);
        expect(second.json().error).toBe('PREDECESSOR_ALREADY_FOLLOWED');
        expect((await raiseAgain(requester, first)).json().error).toBe('PREDECESSOR_ALREADY_FOLLOWED');
        // Not rejected, or unknown, is refused.
        const notRejected = await h.call(requester, 'POST', '/v1/hiring/requisitions', requisitionBody({ predecessorRequestId: created.id }));
        expect(notRejected.json().error).toBe('PREDECESSOR_NOT_REJECTED');
        const unknown = await h.call(requester, 'POST', '/v1/hiring/requisitions', requisitionBody({ predecessorRequestId: '00000000-0000-4000-8000-000000000000' }));
        expect(unknown.json().error).toBe('PREDECESSOR_NOT_FOUND');
        // A draft's correction does not change it, whatever it names.
        const another = await rejectedRequisition();
        const put = await h.call(requester, 'PUT', `/v1/hiring/requisitions/${created.id}`, { ...requisitionBody(), expectedVersion: created.version, predecessorRequestId: another });
        expect(put.statusCode, put.body).toBe(200);
        expect((await view(requester, created.id)).predecessorRequestId).toBe(first);
      });

      it('someone else’s rejected requisition is not theirs to raise again, though they may copy what they can read', async () => {
        const first = await rejectedRequisition();
        const other = await raiseAgain(hr1, first);
        expect(other.statusCode).toBeGreaterThanOrEqual(400);
        const foreign = await h.call(otherManager, 'POST', `/v1/hiring/requisitions/${first}/raise-again`);
        expect([404, 422]).toContain(foreign.statusCode);
        expect((await h.db.query(`select 1 from business_transaction bt join requisition r on r.company_id = bt.company_id and r.transaction_id = bt.predecessor_transaction_id where r.id = $1`, [first])).rowCount).toBe(0);
      });

      it('raising again re-checks the create duty inside its transaction', async () => {
        const first = await rejectedRequisition();
        const seat = await h.actor(A, 'REPORTING_MANAGER', { user: requester.user });
        const res = await revokedAfterGuard(h, A, seat, () => raiseAgain(seat, first));
        expect(res.statusCode, res.body).toBe(403);
        expect((await h.db.query(`select 1 from business_transaction bt join requisition r on r.company_id = bt.company_id and r.transaction_id = bt.predecessor_transaction_id where r.id = $1`, [first])).rowCount).toBe(0);
      });
    });

    it('return-for-edit goes back to DRAFT; resubmission is a new immutable revision; rejection is final and recorded', async () => {
      const r = await createReq(requester, { title: 'Synthetic analyst', designationId: desigOps, budgetExceptionReason: 'Synthetic: no budget line yet' });
      expect((await submit(requester, r.id)).json().revision).toBe(1);
      const t1 = (await taskFor(topManager, r.id))!;
      expect((await decide(topManager, t1.taskId, { decision: 'RETURN' })).json().error).toBe('REASON_REQUIRED');
      expect((await decide(topManager, t1.taskId, { decision: 'RETURN', reason: 'Synthetic: add the skills needed' })).json()).toMatchObject({ state: 'DRAFT' });
      const returned = await view(requester, r.id);
      expect(returned).toMatchObject({ state: 'DRAFT', currentRevision: 1, pendingWith: null, decidedBy: null });
      expect(returned.decisions).toEqual([expect.objectContaining({ step: 1, decision: 'RETURN', reason: 'Synthetic: add the skills needed', decidedBy: expect.objectContaining({ userId: topManager.user }) })]);
      // The old task cannot be decided again.
      expect((await decide(topManager, t1.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');

      const edited = await h.call(requester, 'PUT', `/v1/hiring/requisitions/${r.id}`, {
        ...requisitionBody({ title: 'Synthetic analyst', designationId: desigOps, skills: ['SQL', 'Reporting'] }),
        budgetExceptionReason: 'Synthetic: no budget line yet',
        expectedVersion: returned.version,
      });
      expect(edited.json()).toMatchObject({ skills: ['SQL', 'Reporting'], state: 'DRAFT' });
      expect((await submit(requester, r.id)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
      const resubmitted = await view(requester, r.id);
      expect(resubmitted.revisions.map((x: { revision: number }) => x.revision)).toEqual([1, 2]);
      const instances = await h.db.query<{ transaction_revision: number; state: string }>(
        `select i.transaction_revision, i.state from approval_instance i join requisition q on q.transaction_id = i.transaction_id where q.id = $1 order by i.created_at`,
        [r.id],
      );
      expect(instances.rows).toEqual([
        { transaction_revision: 1, state: 'RETURNED' },
        { transaction_revision: 2, state: 'ACTIVE' },
      ]);
      // ZT12: the submitted revision and the submitted requisition are immutable in the database too.
      await expect(h.db.query(`update requisition_revision set vacancies = 9 where requisition_id = $1`, [r.id])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update requisition set vacancies = 9 where id = $1`, [r.id])).rejects.toMatchObject({ code: '23514' });

      const again = (await taskFor(topManager, r.id))!;
      await decide(topManager, again.taskId, { decision: 'APPROVE' });
      const t2 = (await taskFor(hr1, r.id))!;
      const rejected = await decide(hr1, t2.taskId, { decision: 'REJECT', reason: 'Synthetic: role covered elsewhere' });
      expect(rejected.json()).toMatchObject({ state: 'REJECTED' });
      const final = await view(requester, r.id);
      expect(final).toMatchObject({ state: 'REJECTED', decidedBy: hr1.user, decidedAt: expect.any(String) });
      expect(final.decisions.at(-1)).toMatchObject({ revision: 2, step: 2, decision: 'REJECT', reason: 'Synthetic: role covered elsewhere', decidedBy: { userId: hr1.user }, decidedAt: expect.any(String) });
      // Rejected is terminal: no resubmission, no edit.
      expect((await submit(requester, r.id)).json().error).toBe('INVALID_STATE');
      await dispatchOutbox(h.pool, 500);
      const notices = (await inbox(requester)).filter((n) => n.category === 'REQUISITION_DECIDED').map((n) => n.body);
      expect(notices).toEqual(expect.arrayContaining([expect.stringContaining('was returned for changes'), expect.stringContaining('was rejected')]));
      // Decision reasons never travel in notifications.
      expect(JSON.stringify(notices)).not.toContain('covered elsewhere');

      // FR-011: a copy keeps the job details only: new reference, a draft with no revisions, decisions or exception.
      const copy = await h.call(requester, 'POST', `/v1/hiring/requisitions/${r.id}/copy`);
      expect(copy.statusCode).toBe(201);
      expect(copy.json()).toMatchObject({
        state: 'DRAFT',
        title: 'Synthetic analyst',
        skills: ['SQL', 'Reporting'],
        currentRevision: 0,
        revisions: [],
        decisions: [],
        budgetExceptionReason: null,
        budgetExceptionApprovedBy: null,
        copiedFromRequisitionId: r.id,
        filled: 0,
      });
      expect(copy.json().code).not.toBe(final.code);
      expect((await view(requester, r.id)).state).toBe('REJECTED');
    });

    it('withdrawal before a decision returns the requisition to the draft and tells the reviewer', async () => {
      const r = await createReq(requester, { title: 'Synthetic withdrawn role', designationId: desigOps, budgetExceptionReason: 'Synthetic exception' });
      await submit(requester, r.id);
      const t1 = (await taskFor(topManager, r.id))!;
      expect((await h.call(requester, 'POST', `/v1/hiring/requisitions/${r.id}/withdraw`)).json().state).toBe('DRAFT');
      expect((await decide(topManager, t1.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');
      expect((await h.call(requester, 'POST', `/v1/hiring/requisitions/${r.id}/withdraw`)).json().error).toBe('INVALID_STATE');
      await dispatchOutbox(h.pool, 500);
      expect((await inbox(topManager)).find((n) => n.category === 'REQUISITION_WITHDRAWN')!.body).toContain(`${r.code} (Synthetic withdrawn role) was withdrawn`);
    });

    it('HR closes an approved requisition; only HR holds the close duty', async () => {
      expect((await h.call(requester, 'POST', `/v1/hiring/requisitions/${first}/close`, { reason: 'x' })).statusCode).toBe(403);
      expect((await h.call(hr2, 'POST', `/v1/hiring/requisitions/${first}/close`, { reason: 'Synthetic: positions filled elsewhere' })).json().state).toBe('CLOSED');
      expect((await h.call(hr2, 'POST', `/v1/hiring/requisitions/${first}/close`, { reason: 'again' })).json().error).toBe('INVALID_STATE');
      // A closed requisition with no placements releases its vacancies.
      const budgets = (await h.call(hr1, 'GET', '/v1/hiring/budgets')).json().items as { designationId: string; committed: number }[];
      expect(budgets.find((b) => b.designationId === A.desig)!.committed).toBe(2);
    });
  });

  describe('independence and concurrency (C4, ZT04, ZT11)', () => {
    it('the requester and the validator never take the HR step, even when they are on the list', async () => {
      const setList = (users: TestActor[]) =>
        h.call(hr1, 'PUT', '/v1/workflows/requisition/fallback-reviewers', { reviewers: users.map((u, i) => ({ userId: u.user, priority: i + 1 })) });
      // hr3 is an HR Administrator and an employee without a manager, first on the list.
      expect((await setList([hr3, hr1])).statusCode).toBe(200);
      const r = await createReq(hr3, { designationId: desigOps, title: 'Synthetic HR role', budgetExceptionReason: 'Synthetic exception' });
      expect((await submit(hr3, r.id)).json().state).toBe('SUBMITTED');
      // No eligible manager: the explicit list, skipping the requester.
      expect(await taskFor(hr3, r.id)).toBeUndefined();
      const t1 = (await taskFor(hr1, r.id))!;
      expect(t1.step).toBe(1);
      // Step 2 may go neither to the requester nor to the validator: nobody is left, so the validation is refused
      // with a repairable routing error and nothing is recorded.
      expect((await decide(hr1, t1.taskId, { decision: 'APPROVE' })).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await view(hr3, r.id)).decisions).toEqual([]);
      expect((await setList([hr3, hr1, hr2])).statusCode).toBe(200);
      expect((await decide(hr1, t1.taskId, { decision: 'APPROVE' })).json().pendingStep).toBe(2);
      expect(await taskFor(hr1, r.id)).toBeUndefined();
      expect(await taskFor(hr3, r.id)).toBeUndefined();
      const t2 = (await taskFor(hr2, r.id))!;
      // The requester can never decide their own requisition, whatever the task id.
      expect((await decide(hr3, t2.taskId, { decision: 'APPROVE', approveBudgetException: true })).statusCode).toBe(404);
      expect((await decide(hr2, t2.taskId, { decision: 'APPROVE', approveBudgetException: true })).json().state).toBe('APPROVED');
      const deciders = await h.db.query<{ actor_user_id: string }>(
        `select d.actor_user_id from approval_decision d join approval_task t on t.id = d.task_id join approval_instance i on i.id = t.instance_id
           join requisition q on q.transaction_id = i.transaction_id where q.id = $1 order by d.occurred_at`,
        [r.id],
      );
      expect(deciders.rows.map((x) => x.actor_user_id)).toEqual([hr1.user, hr2.user]);
      expect((await setList([hr1, hr2])).statusCode).toBe(200);
    });

    it('two simultaneous decisions on one task produce one decision; keys replay and are never reused', async () => {
      const r = await createReq(requester, { designationId: desigOps, title: 'Synthetic race', budgetExceptionReason: 'Synthetic exception' });
      await submit(requester, r.id);
      const t1 = (await taskFor(topManager, r.id))!;
      const results = await Promise.all([decide(topManager, t1.taskId, { decision: 'APPROVE' }), decide(topManager, t1.taskId, { decision: 'REJECT', reason: 'Synthetic' })]);
      expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((x) => x.statusCode === 409)!.json().error).toBe('TASK_CLOSED');
      expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where task_id = $1`, [t1.taskId])).n).toBe(1);

      const other = await createReq(requester, { designationId: desigOps, title: 'Synthetic other', budgetExceptionReason: 'Synthetic exception' });
      const third = await createReq(requester, { designationId: desigOps, title: 'Synthetic third', budgetExceptionReason: 'Synthetic exception' });
      await submit(requester, other.id);
      await submit(requester, third.id);
      const [to, tt] = [(await taskFor(topManager, other.id))!, (await taskFor(topManager, third.id))!];
      const key = uniq('req-key-');
      const once = await h.call(topManager, 'POST', `/v1/hiring/requisition-tasks/${to.taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic', idempotencyKey: key });
      expect(once.json()).toMatchObject({ state: 'DRAFT', replayed: false });
      const replay = await h.call(topManager, 'POST', `/v1/hiring/requisition-tasks/${to.taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic', idempotencyKey: key });
      expect(replay.json()).toMatchObject({ state: 'DRAFT', replayed: true });
      expect((await h.call(topManager, 'POST', `/v1/hiring/requisition-tasks/${tt.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key })).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await view(requester, other.id)).decisions).toHaveLength(1);
    });

    it('concurrent HR approvals never commit more headcount than the budget holds', async () => {
      await budget(desigQa, 1);
      const a = await createReq(requester, { designationId: desigQa, title: 'Synthetic tester A' });
      const b = await createReq(requester, { designationId: desigQa, title: 'Synthetic tester B' });
      for (const r of [a, b]) {
        await submit(requester, r.id);
        await decide(topManager, (await taskFor(topManager, r.id))!.taskId, { decision: 'APPROVE' });
      }
      const [ta, tb] = [(await taskFor(hr1, a.id))!, (await taskFor(hr1, b.id))!];
      const results = await Promise.all([decide(hr1, ta.taskId, { decision: 'APPROVE' }), decide(hr1, tb.taskId, { decision: 'APPROVE' })]);
      expect(results.map((x) => x.json().state ?? x.json().error).sort()).toEqual(['APPROVED', 'BUDGET_EXCEPTION_REQUIRED']);
      const approved = await h.one<{ n: number }>(`select count(*)::int as n from requisition where company_id = $1 and designation_id = $2 and state = 'APPROVED'`, [A.id, desigQa]);
      expect(approved.n).toBe(1);
    });
  });

  describe('access (DF02, C1, ZT01, ZT02)', () => {
    it('denies other roles, other scopes, other companies and altered ids', async () => {
      const r = await createReq(requester, { designationId: desigOps, title: 'Synthetic scoped role', budgetExceptionReason: 'Synthetic exception' });
      expect((await h.call(employee, 'GET', '/v1/hiring/requisitions')).statusCode).toBe(403);
      expect((await h.call(employee, 'POST', '/v1/hiring/requisitions', requisitionBody())).statusCode).toBe(403);
      // The recruiter sees the pipeline's requisitions (company scope) but does not raise or decide them.
      expect((await h.call(recruiter, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(200);
      expect((await h.call(recruiter, 'POST', '/v1/hiring/requisitions', requisitionBody())).statusCode).toBe(403);
      // TEAM scope: an unrelated manager sees nothing; the requester's manager sees it but cannot edit it.
      expect((await h.call(otherManager, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(404);
      expect(((await h.call(otherManager, 'GET', '/v1/hiring/requisitions')).json().items as { id: string }[]).map((x) => x.id)).not.toContain(r.id);
      expect((await h.call(topManager, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(200);
      expect((await h.call(topManager, 'PUT', `/v1/hiring/requisitions/${r.id}`, { ...requisitionBody(), expectedVersion: r.version })).json().error).toBe('NOT_REQUESTER');
      expect((await h.call(otherManager, 'POST', `/v1/hiring/requisitions/${r.id}/submit`, { expectedVersion: r.version })).statusCode).toBe(404);
      // A department-filtered HR Administrator, another company and unknown ids all read as missing.
      expect((await h.call(hrFin, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(404);
      expect((await h.call(bHr, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(404);
      expect((await h.call(bHr, 'POST', `/v1/hiring/requisitions/${r.id}/copy`)).statusCode).toBe(404);
      expect((await h.call(hr1, 'GET', `/v1/hiring/requisitions/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).statusCode).toBe(404);
      expect((await h.call(bHr, 'GET', '/v1/hiring/requisitions')).json().items).toEqual([]);
      // A requisition is raised by an employee; masters of another company are refused.
      const unlinked = await h.call(hr1, 'POST', '/v1/hiring/requisitions', requisitionBody());
      expect(unlinked.json().error).toBe('REQUESTER_NOT_LINKED');
      const foreign = await h.call(requester, 'POST', '/v1/hiring/requisitions', requisitionBody({ departmentId: B.dept }));
      expect(foreign.json().error).toBe('INVALID_REFERENCE');
      const badManager = await h.call(requester, 'POST', '/v1/hiring/requisitions', requisitionBody({ hiringManagerId: r.id }));
      expect(badManager.json().error).toBe('INVALID_HIRING_MANAGER');
    });

    it('rejects tenant mismatches and unsupported states in the database (ZT06, ZT10)', async () => {
      const r = await h.one<{ transaction_id: string; id: string }>(`select id, transaction_id from requisition where company_id = $1 limit 1`, [A.id]);
      await expect(h.db.query(`update requisition set department_id = $2 where id = $1`, [r.id, B.dept])).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      await expect(h.db.query(`update business_transaction set state = 'CANCELLED' where id = $1`, [r.transaction_id])).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
      await expect(h.db.query(`delete from requisition where id = $1`, [r.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('audit and outbox carry operational values and identifiers only', async () => {
      const events = await h.db.query<{ topic: string; payload: Record<string, unknown> }>(`select topic, payload from outbox_event where company_id = $1 and topic like 'hiring.%'`, [A.id]);
      expect(events.rows.length).toBeGreaterThan(5);
      for (const e of events.rows) {
        expect(Object.keys(e.payload).every((k) => ['requisitionId', 'revisionId', 'taskId', 'revision', 'step', 'outcome', 'userId'].includes(k)), e.topic).toBe(true);
      }
      const trail = await h.db.query<{ before_values: Record<string, unknown> | null; after_values: Record<string, unknown> }>(
        `select before_values, after_values from audit_event
          where company_id = $1 and resource_code in ('requisition', 'manpower_budget', 'manpower_budget_revision') and action <> 'ACCESS_DENIED'`,
        [A.id],
      );
      for (const t of trail.rows) {
        expect(Object.keys(t.after_values)).toEqual(['operational']);
        if (t.before_values) expect(Object.keys(t.before_values)).toEqual(['operational']);
      }
    });

    it('event describers describe nothing for malformed or foreign payloads and never fail (DF12)', async () => {
      const malformed: unknown[] = [null, [], 'text', {}, { requisitionId: 'not-a-uuid', revisionId: 42, offerId: null, taskId: 'x', userId: {}, outcome: '__proto__', step: 'two' }];
      for (const [topic, describer] of Object.entries(HIRING_EVENTS)) {
        for (const payload of malformed) {
          await expect(describer(h.db, { companyId: A.id, topic, aggregateId: A.id, payload: payload as Record<string, unknown> }), topic).resolves.toBeNull();
        }
      }
      const r = await h.one<{ id: string }>(`select id from requisition where company_id = $1 and state = 'REJECTED' limit 1`, [A.id]);
      const decided = HIRING_EVENTS['hiring.requisition.decided']!;
      expect(await decided(h.db, { companyId: A.id, topic: 'hiring.requisition.decided', aggregateId: r.id, payload: { requisitionId: r.id, outcome: 'REJECTED' } })).toMatchObject({ data: { outcome: 'rejected' } });
      // Another company's identifier, or an outcome that is only an inherited object key, renders nothing.
      expect(await decided(h.db, { companyId: B.id, topic: 'hiring.requisition.decided', aggregateId: r.id, payload: { requisitionId: r.id, outcome: 'REJECTED' } })).toBeNull();
      expect(await decided(h.db, { companyId: A.id, topic: 'hiring.requisition.decided', aggregateId: r.id, payload: { requisitionId: r.id, outcome: 'constructor' } })).toBeNull();
    });
  });

  describe('routing within scope, form choices, names and paging (DF03, I-25, DF04, DF12)', () => {
    const setList = (kind: string, users: TestActor[]) =>
      h.call(hr1, 'PUT', `/v1/workflows/${kind}/fallback-reviewers`, { reviewers: users.map((u, i) => ({ userId: u.user, priority: i + 1 })) });
    const newDesignation = async (code: string, active = true) =>
      (await h.one<{ id: string }>(`insert into designation (company_id, code, name, active) values ($1, $2, $2, $3) returning id`, [A.id, code, active])).id;
    const linkedEmployee = async (departmentId: string) => {
      const e = (await h.call(hr1, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId }))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      return e.id as string;
    };

    it('a budget revision never goes to a listed reviewer whose scope does not reach the budget line', async () => {
      const line = async () => {
        const created = await h.call(hr1, 'POST', '/v1/hiring/budgets', { departmentId: A.dept, locationId: A.loc, designationId: await newDesignation(uniq('SCOPE')), periodStart, periodEnd, headcount: 1, reason: 'Synthetic plan' });
        expect(created.statusCode, created.body).toBe(201);
        return created.json() as { revisionId: string; budgetId: string };
      };
      // hrFin's Finance filter does not reach an Engineering budget line: skipped for the next listed reviewer.
      expect((await setList('manpower_budget_revision', [hrFin, hr2])).statusCode).toBe(200);
      const first = await line();
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${first.revisionId}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
      expect((await h.call(hrFin, 'GET', '/v1/hiring/budget-tasks')).json().items).toEqual([]);
      expect(((await h.call(hr2, 'GET', '/v1/hiring/budget-tasks')).json().items as { revision: { revisionId: string } | null }[]).map((t) => t.revision?.revisionId)).toContain(first.revisionId);
      // Nobody in scope is left: refused with the repairable routing error; the draft stays a draft.
      expect((await setList('manpower_budget_revision', [hrFin])).statusCode).toBe(200);
      const second = await line();
      expect((await h.call(hr1, 'POST', `/v1/hiring/budget-revisions/${second.revisionId}/submit`, { expectedVersion: 1 })).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await h.call(hr1, 'GET', `/v1/hiring/budgets/${second.budgetId}`)).json().openRevision).toMatchObject({ state: 'DRAFT' });
      expect((await h.call(hrFin, 'GET', '/v1/hiring/budget-tasks')).json().items).toEqual([]);
      expect((await setList('manpower_budget_revision', [hr1, hr2])).statusCode).toBe(200);
    });

    it('a requisition step never goes to a reviewer who could not open the requisition', async () => {
      // An Engineering-filtered HR Administrator reaches the requester (an Engineering employee) but not a Finance
      // requisition: the engine's employee check alone would route to them.
      const hrEng = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
      const fin = { departmentId: A.financeDept, designationId: desigOps, title: 'Synthetic finance role', budgetExceptionReason: 'Synthetic exception' };
      expect((await setList('requisition', [hrEng, hr1])).statusCode).toBe(200);
      // Step 1 by the fallback list (hr3 has no manager): the out-of-scope reviewer is skipped at submission.
      const r = await createReq(hr3, fin);
      expect((await submit(hr3, r.id)).json().state).toBe('SUBMITTED');
      expect(await taskFor(hrEng, r.id)).toBeUndefined();
      expect((await h.call(hrEng, 'GET', `/v1/hiring/requisitions/${r.id}`)).statusCode).toBe(404);
      const t1 = (await taskFor(hr1, r.id))!;
      expect(t1.step).toBe(1);
      // Step 2 is chosen by the engine. The reviewer excluded at submission because it cannot open the requisition stays
      // excluded at every later step (0052, I-25), so step 2 goes to the next listed reviewer who can open it.
      expect((await setList('requisition', [hrEng, hr1, hr2])).statusCode).toBe(200);
      expect((await decide(hr1, t1.taskId, { decision: 'APPROVE' })).json().pendingStep).toBe(2);
      expect(await taskFor(hrEng, r.id)).toBeUndefined();
      expect((await taskFor(hr2, r.id))!.step).toBe(2);
      // A filtered reviewer who reaches both the requester and the requisition is routed to as usual.
      expect((await setList('requisition', [hrEng])).statusCode).toBe(200);
      const eng = await createReq(hr3, { designationId: desigOps, title: 'Synthetic engineering role', budgetExceptionReason: 'Synthetic exception' });
      expect((await submit(hr3, eng.id)).json().state).toBe('SUBMITTED');
      expect((await taskFor(hrEng, eng.id))!.step).toBe(1);
      expect((await h.call(hrEng, 'GET', `/v1/hiring/requisitions/${eng.id}`)).statusCode).toBe(200);
      expect((await setList('requisition', [hr1, hr2])).statusCode).toBe(200);
    });

    it('serves the reference values and masters the requisition form needs, under the form permission (DF04)', async () => {
      const values = (a: TestActor, category: string) => h.call(a, 'GET', `/v1/hiring/reference-values?category=${category}`);
      await h.db.query(
        `insert into reference_value (company_id, category, code, label, active) values ($1, 'EMPLOYMENT_TYPE', 'SYNTHETIC_RETIRED', 'Synthetic retired type', false),
                ($1, 'EMPLOYMENT_TYPE', 'SYNTHETIC_A_ONLY', 'Synthetic company A type', true)`,
        [A.id],
      );
      const types = await values(requester, 'EMPLOYMENT_TYPE');
      expect(types.statusCode, types.body).toBe(200);
      const codes = (types.json().items as { code: string; label: string }[]).map((t) => t.code);
      expect(codes).toEqual(expect.arrayContaining(['PERMANENT', 'FIXED_TERM', 'INTERN', 'CONTRACTOR', 'SYNTHETIC_A_ONLY']));
      expect(codes).not.toContain('SYNTHETIC_RETIRED');
      expect(types.json()).toMatchObject({ category: 'EMPLOYMENT_TYPE', items: expect.arrayContaining([expect.objectContaining({ code: 'PERMANENT', label: expect.any(String) })]) });
      // Each category answers under its own form's permission.
      expect((await values(recruiter, 'EMPLOYMENT_TYPE')).statusCode).toBe(403);
      expect((await values(employee, 'EMPLOYMENT_TYPE')).statusCode).toBe(403);
      expect((await values(requester, 'CANDIDATE_SOURCE')).statusCode).toBe(403);
      expect((await values(requester, 'EMPLOYEE_STATUS')).statusCode).toBe(400);
      // Another company never sees this company's values.
      expect((await values(bHr, 'EMPLOYMENT_TYPE')).json().items.map((t: { code: string }) => t.code)).not.toContain('SYNTHETIC_A_ONLY');

      const retired = await newDesignation(uniq('RETIRED'), false);
      const masters = await h.call(requester, 'GET', '/v1/hiring/requisition-masters');
      expect(masters.statusCode, masters.body).toBe(200);
      const ids = (k: string) => (masters.json()[k] as { id: string; code: string; name: string }[]).map((m) => m.id);
      expect(ids('departments')).toEqual(expect.arrayContaining([A.dept, A.financeDept]));
      expect(ids('locations')).toEqual([A.loc]);
      expect(ids('designations')).toEqual(expect.arrayContaining([A.desig, desigQa, desigOps]));
      expect(ids('designations')).not.toContain(retired);
      expect(masters.json().departments[0]).toEqual({ id: expect.any(String), code: expect.any(String), name: expect.any(String) });
      // A department-filtered assignment is offered only what it may name; other roles and companies get nothing.
      expect((await h.call(hrFin, 'GET', '/v1/hiring/requisition-masters')).json().departments.map((d: { id: string }) => d.id)).toEqual([A.financeDept]);
      expect((await h.call(recruiter, 'GET', '/v1/hiring/requisition-masters')).statusCode).toBe(403);
      expect((await h.call(employee, 'GET', '/v1/hiring/requisition-masters')).statusCode).toBe(403);
      expect((await h.call(bHr, 'GET', '/v1/hiring/requisition-masters')).json().departments.map((d: { id: string }) => d.id)).not.toContain(A.dept);
    });

    it('checks the budget of a requisition before its draft exists, as creation would admit it (FR-011)', async () => {
      const check = (a: TestActor, q: Record<string, string>) => h.call(a, 'GET', `/v1/hiring/requisition-budget-check?${new URLSearchParams(q).toString()}`);
      const base = { departmentId: A.dept, locationId: A.loc, designationId: A.desig, targetDate, vacancies: '1' };
      const count = async () => (await h.one<{ n: number }>(`select count(*)::int as n from requisition where company_id = $1`, [A.id])).n;
      const before = await count();
      // 2 of the 3 approved places are committed (the closed requisition released its own).
      expect((await check(requester, base)).json()).toEqual({ budgetStatus: 'WITHIN_BUDGET', approvedHeadcount: 3, committed: 2, requested: 1, budgetExceptionReasonRequired: false });
      expect((await check(requester, { ...base, vacancies: '2' })).json()).toMatchObject({ budgetStatus: 'EXCEEDS_BUDGET', requested: 2, budgetExceptionReasonRequired: true });
      expect((await check(requester, { ...base, designationId: desigOps })).json()).toEqual({ budgetStatus: 'NO_BUDGET', approvedHeadcount: null, committed: 0, requested: 1, budgetExceptionReasonRequired: true });
      // Nothing is recorded by a check.
      expect(await count()).toBe(before);
      expect((await check(requester, { ...base, departmentId: B.dept })).json().error).toBe('INVALID_REFERENCE');
      expect((await check(requester, { ...base, vacancies: '0' })).statusCode).toBe(400);
      expect((await check(hr1, base)).json().error).toBe('REQUESTER_NOT_LINKED');
      expect((await check(employee, base)).statusCode).toBe(403);
      expect((await check(recruiter, base)).statusCode).toBe(403);
      // A Finance-filtered requester cannot probe an Engineering budget line.
      const finRequester = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept, employeeId: await linkedEmployee(A.financeDept) });
      expect((await check(finRequester, base)).statusCode).toBe(403);
      expect((await check(finRequester, { ...base, departmentId: A.financeDept })).json()).toMatchObject({ budgetStatus: 'NO_BUDGET' });
    });

    it('names the people behind user ids the caller already sees, and pages capped lists with a total', async () => {
      const budgets = (await h.call(hr1, 'GET', '/v1/hiring/budgets')).json();
      expect(budgets.total).toBe(budgets.items.length);
      const line = (budgets.items as { id: string; designationId: string }[]).find((b) => b.designationId === A.desig)!;
      const detail = (await h.call(hr1, 'GET', `/v1/hiring/budgets/${line.id}`)).json();
      const approved = (detail.revisions as Record<string, unknown>[]).find((r) => r.state === 'APPROVED')!;
      expect(approved).toMatchObject({ preparedBy: hr1.user, preparedByPerson: { userId: hr1.user, employeeCode: null, displayName: null }, decidedByPerson: { userId: hr2.user } });
      expect((detail.revisions as Record<string, unknown>[]).find((r) => r.state === 'WITHDRAWN')).toMatchObject({ decidedBy: null, decidedByPerson: null });

      const listed = (await h.call(requester, 'GET', '/v1/hiring/requisitions?state=APPROVED&search=second%20team')).json().items[0];
      const second = await view(requester, listed.id);
      expect(second).toMatchObject({ decidedByPerson: { userId: hr1.user }, budgetExceptionApprovedByPerson: { userId: hr1.user } });
      expect(second.revisions[0].submittedByPerson).toEqual({ userId: requester.user, employeeCode: second.requester.employeeCode, displayName: second.requester.displayName });
      expect(listed.decidedByPerson).toEqual(second.decidedByPerson);

      // Paging is opt-in for the budget list; every page says how many rows match.
      const paged = (await h.call(hr1, 'GET', '/v1/hiring/budgets?page=1&pageSize=25')).json();
      expect(paged).toMatchObject({ total: budgets.total, page: 1, pageSize: 25 });
      expect(paged.items.map((b: { id: string }) => b.id)).toEqual(budgets.items.map((b: { id: string }) => b.id));
      expect((await h.call(hr1, 'GET', '/v1/hiring/budgets?page=9&pageSize=25')).json()).toEqual({ items: [], total: budgets.total, page: 9, pageSize: 25 });
      expect((await h.call(hr1, 'GET', '/v1/hiring/budgets?pageSize=30')).statusCode).toBe(400);
      // A page past the end still reports the total.
      const all = (await h.call(hr1, 'GET', '/v1/hiring/requisitions')).json();
      expect(all.total).toBeGreaterThan(0);
      expect((await h.call(hr1, 'GET', '/v1/hiring/requisitions?page=50')).json()).toEqual({ items: [], total: all.total, page: 50, pageSize: 25 });
    });

    it('HR closure tells the requester; the closing duty is checked again inside the transaction (DF12, docs/09 §6.5)', async () => {
      const r = await createReq(requester, { designationId: desigOps, title: 'Synthetic closure role', budgetExceptionReason: 'Synthetic exception' });
      expect((await approveThrough(r.id, hr1, { approveBudgetException: true })).json().state).toBe('APPROVED');
      // The guard ran, then the closer's DB109 entry was withdrawn: nothing changes.
      const closer = await h.actor(A, 'HR_ADMINISTRATOR');
      const grant = (await resolveAccess(h.pool, { userId: closer.user, companyId: A.id, assignmentId: closer.assignment, resource: 'requisition', action: 'close', fieldGroups: ['operational'] })) as AccessGrant;
      expect(grant.allowed).toBe(true);
      await h.db.query(
        `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
            and permission_id = (select id from permission where resource = 'requisition' and action = 'close' and field_group = 'operational')`,
        [A.id, closer.assignment],
      );
      await expect(withTransaction(h.pool, (tx) => closeRequisition(tx, grant, r.id, { reason: 'Synthetic stale closure' }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await view(requester, r.id)).state).toBe('APPROVED');

      expect((await h.call(hr2, 'POST', `/v1/hiring/requisitions/${r.id}/close`, { reason: 'Synthetic: secret closure detail' })).json().state).toBe('CLOSED');
      await dispatchOutbox(h.pool, 500);
      const closed = (await inbox(requester)).filter((n) => n.category === 'REQUISITION_CLOSED' && n.body.includes(r.code)).map((n) => n.body);
      expect(closed).toEqual([`Your approved requisition ${r.code} (Synthetic closure role) was closed by HR.`]);
      expect(JSON.stringify(await inbox(requester))).not.toContain('secret closure detail');
      const event = await h.one<{ payload: Record<string, unknown> }>(`select payload from outbox_event where company_id = $1 and topic = 'hiring.requisition.closed' and aggregate_id = $2`, [A.id, r.id]);
      expect(Object.keys(event.payload).sort()).toEqual(['requisitionId', 'revision']);
    });
  });
});
