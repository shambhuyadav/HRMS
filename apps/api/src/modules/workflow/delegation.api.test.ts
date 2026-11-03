// Delegation end to end (FR-003, FR-068; DF03; DB018; C4 "Delegated task"; CI10; RBAC instruction line 95; ZT04 "delegated
// self task"; ZT05 "delegation expire/revoke"). Requests, independent approval, routing of new tasks, the decision-time checks,
// reads while live and after the end, and races between a decision and a revocation. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { endGrant } from '../access/admin.js';
import { type AccessGrant, resolveAccess, SqlParams } from '../access/authorize.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { approveDelegation, endDelegation, rejectDelegation, requestDelegation } from '../access/delegation.js';
import { countOf, myPendingTasks } from '../dashboard/tasks.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { runReminders } from '../notification/reminders.js';
import { decideTask, startApproval } from './engine.js';
import { leaveQueue, leaveTasks } from './leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let admin: TestActor;
let world: ReturnType<typeof leaveTasks>;

const DELEGATE: PermissionKey = 'access.delegate.operational';
const LEAVE: PermissionKey = 'leave.approve.operational';
const REROUTE: PermissionKey = 'workflow.reroute_task.operational';

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;
const now = () => iso(-60_000);

/** A manager who may delegate, an ASSIGNED-scope colleague holding the same duty, and a report of the manager. */
async function people() {
  const mEmp = await world.employee();
  const dEmp = await world.employee();
  const m = await h.actor(A, 'REPORTING_MANAGER', { employeeId: mEmp, extra: [DELEGATE] });
  const d = await h.actor(A, 'REPORTING_MANAGER', { employeeId: dEmp, scope: 'ASSIGNED' });
  const x = await world.employee(mEmp);
  const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
  return { mEmp, dEmp, m, d, x, self };
}

const ask = (from: TestActor, to: TestActor | string, body: Record<string, unknown> = {}) =>
  h.call(from, 'POST', '/v1/access/delegations', { delegateUserId: typeof to === 'string' ? to : to.user, permission: LEAVE, effectiveFrom: now(), effectiveTo: iso(10 * DAY), ...body });

const approve = (a: TestActor, id: string, expectedVersion = 1) => h.call(a, 'POST', `/v1/access/delegations/${id}/approve`, { expectedVersion });

/** A delegation made through its routes: requested and independently approved. */
async function live(from: TestActor, to: TestActor, body: Record<string, unknown> = {}) {
  const asked = await ask(from, to, body);
  expect(asked.statusCode, asked.body).toBe(201);
  const id = asked.json().id as string;
  const approved = await approve(admin, id);
  expect(approved.statusCode, approved.body).toBe(200);
  return id;
}

const end = (a: TestActor, id: string, expectedVersion = 2, reason = 'Back early (synthetic)') => h.call(a, 'POST', `/v1/access/delegations/${id}/end`, { expectedVersion, reason });
/** Moves the window into the past, as time passing would (fixture write through the bootstrap session). */
const expire = (id: string) => h.db.query(`update delegation set effective_from = now() - interval '2 days', effective_to = now() - interval '1 day' where company_id = $1 and id = $2`, [A.id, id]);

const taskRow = (taskId: string) =>
  h.one<{ state: string; assignee_user_id: string; delegation_id: string | null }>(`select state, assignee_user_id, delegation_id from approval_task where company_id = $1 and id = $2`, [A.id, taskId]);
const openTaskOf = (employeeId: string) =>
  h.one<{ id: string; assignee_user_id: string; delegation_id: string | null }>(
    `select t.id, t.assignee_user_id, t.delegation_id from approval_task t
       join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
       join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
      where t.company_id = $1 and t.state = 'PENDING' and bt.owner_employee_id = $2 order by t.created_at desc limit 1`,
    [A.id, employeeId],
  );
const decide = (a: TestActor, taskId: string, decision = 'APPROVE') =>
  h.call(a, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('delegation-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
const decisions = async (taskId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where company_id = $1 and task_id = $2`, [A.id, taskId])).n;
const auditOf = async (resource: string, recordKey: string) =>
  (await h.db.query<{ action: string; actor_user_id: string; after_values: { operational?: Record<string, unknown> } | null; reason: string | null }>(
    `select action, actor_user_id, after_values, reason from audit_event where company_id = $1 and resource_code = $2 and record_key = $3 order by occurred_at, action`,
    [A.id, resource, recordKey],
  )).rows;
const grantOf = async (a: TestActor, resource: string, action: string, fieldGroup = 'operational') =>
  (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource, action, fieldGroups: [fieldGroup] })) as AccessGrant;
const openTaskCount = async (a: TestActor) =>
  ((await h.call(a, 'GET', '/v1/dashboard')).json().widgets as { code: string; value?: number }[]).find((w) => w.code === 'MY_TASKS')!.value!;
const setFallback = async (...reviewers: TestActor[]) => {
  const res = await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });
  expect(res.statusCode, res.body).toBe(200);
};
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];

/** Resolves once another backend of this database waits on a lock, so a race test knows the second transaction is blocked. */
async function untilSomeoneWaits() {
  for (let i = 0; i < 400; i++) {
    const n = (await h.one<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).n;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Nobody waited on a lock');
}
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  // The fixtures' reviewers on the leave fallback list, and a role widened to exercise the reroute (no baseline ceiling holds it).
  await h.db.query(
    `insert into role_permission (company_id, role_id, permission_id, effect)
     select $1, r.id, p.id, 'ALLOW' from role r, permission p
      where r.company_id = $1 and r.code = 'HR_ADMINISTRATOR' and p.resource = 'workflow' and p.action = 'reroute_task' and p.field_group = 'operational'`,
    [A.id],
  );
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  await setFallback(hr);
});

afterAll(async () => {
  await h?.stop();
});

describe('request and independent approval (DF03, DB018, C4)', () => {
  it('changes nothing until someone else approves it; then a new task goes to the delegate with delegation_id, all audited', async () => {
    const { m, d, self, x } = await people();
    const asked = await ask(m, d, { purpose: 'Annual leave cover (synthetic)' });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json()).toMatchObject({ state: 'PENDING', version: 1 });
    const id = asked.json().id as string;

    await world.submitLeave(self);
    expect(await openTaskOf(x)).toMatchObject({ assignee_user_id: m.user, delegation_id: null });

    expect((await approve(admin, id)).json()).toMatchObject({ state: 'ACTIVE' });
    const row = await h.one<{ approved_by: string; approved_at: Date; created_by: string }>(`select approved_by, approved_at, created_by from delegation where id = $1`, [id]);
    expect(row).toMatchObject({ approved_by: admin.user, created_by: m.user });
    expect(row.approved_at).toBeInstanceOf(Date);

    await world.submitLeave(self);
    expect(await openTaskOf(x)).toMatchObject({ assignee_user_id: d.user, delegation_id: id });

    expect((await auditOf('delegation', id)).map((a) => [a.action, a.actor_user_id])).toEqual([
      ['CREATE', m.user],
      ['APPROVE', admin.user],
    ]);
  });

  it('neither the delegator, the delegate nor anyone without the approval duty can approve', async () => {
    const { m, d } = await people();
    const id = (await ask(m, d)).json().id as string;
    const delegatorAsAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { user: m.user });
    const delegateAsAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { user: d.user });
    for (const a of [delegatorAsAdmin, delegateAsAdmin]) {
      const res = await approve(a, id);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('SELF_APPROVAL');
    }
    expect((await approve(m, id)).statusCode).toBe(403);
    expect((await approve(d, id)).statusCode).toBe(403);
    expect((await h.one<{ state: string }>(`select state from delegation where id = $1`, [id])).state).toBe('PENDING');
    expect((await approve(admin, id, 9)).json().error).toBe('STALE_VERSION');
    expect((await approve(admin, id)).statusCode).toBe(200);
    expect((await approve(admin, id, 2)).json().error).toBe('INVALID_STATE');
  });

  it('a rejection needs a reason, keeps the record and activates nothing', async () => {
    const { m, d, self, x } = await people();
    const id = (await ask(m, d)).json().id as string;
    expect((await h.call(admin, 'POST', `/v1/access/delegations/${id}/reject`, { expectedVersion: 1 })).statusCode).toBe(400);
    expect((await h.call(m, 'POST', `/v1/access/delegations/${id}/reject`, { expectedVersion: 1, reason: 'Nope' })).statusCode).toBe(403);
    expect((await h.call(admin, 'POST', `/v1/access/delegations/${id}/reject`, { expectedVersion: 1, reason: 'Cover not needed (synthetic)' })).json().state).toBe('REJECTED');
    await world.submitLeave(self);
    expect(await openTaskOf(x)).toMatchObject({ assignee_user_id: m.user, delegation_id: null });
    expect((await auditOf('delegation', id)).at(-1)).toMatchObject({ action: 'REJECT', reason: 'Cover not needed (synthetic)' });
    expect((await approve(admin, id, 2)).json().error).toBe('INVALID_STATE');
  });

  it('DF03 limits: at most 30 calendar days, ends after it starts and in the future, no self delegation', async () => {
    const { m, d } = await people();
    const start = iso(DAY);
    const tooLong = await ask(m, d, { effectiveFrom: start, effectiveTo: new Date(Date.parse(start) + 30 * DAY + 1000).toISOString() });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error).toBe('DELEGATION_TOO_LONG');
    expect((await ask(m, d, { effectiveFrom: start, effectiveTo: start })).json().error).toBe('INVALID_PERIOD');
    expect((await ask(m, d, { effectiveFrom: iso(-3 * DAY), effectiveTo: iso(-DAY) })).json().error).toBe('INVALID_PERIOD');
    expect((await ask(m, m)).json().error).toBe('SELF_DELEGATION');
    const exactly = await ask(m, d, { effectiveFrom: start, effectiveTo: new Date(Date.parse(start) + 30 * DAY).toISOString() });
    expect(exactly.statusCode, exactly.body).toBe(201);
  });

  it('FR-003 request types and DB018: only a decision permission the selected assignment itself holds', async () => {
    const { m, d } = await people();
    expect((await ask(m, d, { permission: 'employee.read.operational' })).json().error).toBe('NOT_DELEGABLE');
    expect((await ask(m, d, { permission: 'no_such.thing.operational' })).json().error).toBe('NOT_DELEGABLE');
    expect((await ask(m, d, { permission: 'expense.finance_decide.operational' })).json().error).toBe('OUTSIDE_OWN_AUTHORITY');
    // The duty itself is needed, and the delegator's other assignment lends nothing.
    const noDuty = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    expect((await ask(noDuty, d)).statusCode).toBe(403);
    const sameUserOtherRole = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { user: m.user, extra: [] });
    expect((await ask(sameUserOtherRole, d)).statusCode).toBe(403);
    // Own scope reviews nobody, whatever a company's own role holds.
    const ownScope = await h.customActor(A, { scope: 'OWN', permissions: [DELEGATE, LEAVE] });
    expect((await ask(ownScope, d)).json().error).toBe('OUTSIDE_OWN_AUTHORITY');
    expect((await h.call(ownScope, 'GET', '/v1/access/delegations/options')).json().items).toEqual([]);
  });

  it('DB018 "delegate must hold applicable base permission and scope": no permission, team scope only or another company are refused', async () => {
    const { m } = await people();
    const noPermission = await h.actor(A, 'EMPLOYEE', { employeeId: await world.employee() });
    expect((await ask(m, noPermission)).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
    const teamOnly = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    expect((await ask(m, teamOnly)).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
    const B = await h.makeCompany();
    const elsewhere = await h.actor(B, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    expect((await ask(m, elsewhere)).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
    const unknown = await ask(m, '00000000-0000-4000-8000-000000000001');
    expect(unknown.json().error).toBe('DELEGATE_NOT_ELIGIBLE');
  });

  it('DF03 "cannot introduce Admin eligibility or confidential field grants": equivalent class, and the delegate holds the confidential permission independently', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE, 'increment.approve.salary'] });
    const manager = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    expect((await ask(delegator, manager)).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
    const plainHr = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await ask(delegator, plainHr, { permission: 'increment.approve.salary' })).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
    const salaryHr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.approve.salary'] });
    const ok = await ask(delegator, salaryHr, { permission: 'increment.approve.salary' });
    expect(ok.statusCode, ok.body).toBe(201);
    // A manager may hand over to an Admin: higher, not lower.
    const { m } = await people();
    expect((await ask(m, plainHr)).statusCode).toBe(201);
  });

  it('no redelegation (DF03, CI10): a delegate cannot delegate the same permission in the period, nor a delegator receive it', async () => {
    const x1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const d1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const e1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const id = await live(x1, d1);
    const onward = await ask(d1, e1);
    expect(onward.statusCode).toBe(409);
    expect(onward.json().error).toBe('REDELEGATION_NOT_ALLOWED');
    const into = await ask(e1, x1);
    expect(into.json().error).toBe('REDELEGATION_NOT_ALLOWED');
    // Outside the period, or for another permission, it is not a chain.
    expect((await ask(d1, e1, { effectiveFrom: iso(11 * DAY), effectiveTo: iso(12 * DAY) })).statusCode).toBe(201);
    expect((await end(x1, id)).statusCode).toBe(200);
    expect((await ask(e1, x1)).statusCode).toBe(201);
  });

  it('two requests forming a chain at the same moment: one wins and the other is refused', async () => {
    const x1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const d1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const e1 = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    const results = await Promise.all([ask(x1, d1), ask(d1, e1)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('REDELEGATION_NOT_ALLOWED');
  });

  it('one open delegation per delegator, permission and period; a withdrawal frees the period', async () => {
    const { m, d } = await people();
    const second = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    const id = (await ask(m, d)).json().id as string;
    const overlap = await ask(m, second);
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toBe('DELEGATION_OVERLAP');
    const withdrawn = await end(m, id, 1, 'Changed my mind (synthetic)');
    expect(withdrawn.json()).toMatchObject({ state: 'WITHDRAWN', openTasks: 0 });
    expect((await ask(m, second)).statusCode).toBe(201);
    expect((await auditOf('delegation', id)).at(-1)).toMatchObject({ action: 'WITHDRAW', actor_user_id: m.user, reason: 'Changed my mind (synthetic)' });
  });

  it('an administrator acts only inside their own scope (C4), and the list follows it', async () => {
    const { m, d } = await people();
    const id = (await ask(m, d)).json().id as string;
    const financeAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const engineeringAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await approve(financeAdmin, id)).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    expect((await h.call(financeAdmin, 'POST', `/v1/access/delegations/${id}/reject`, { expectedVersion: 1, reason: 'Out of scope (synthetic)' })).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    const listed = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/access/delegations?state=PENDING')).json().items as { id: string }[]).map((r) => r.id);
    expect(await listed(financeAdmin)).not.toContain(id);
    expect(await listed(engineeringAdmin)).toContain(id);
    expect(await listed(admin)).toContain(id);
    expect((await approve(engineeringAdmin, id)).statusCode).toBe(200);
    expect((await end(financeAdmin, id)).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    expect((await end(engineeringAdmin, id, 2)).json()).toMatchObject({ state: 'ENDED' });
    // Listing the company's delegations needs the administrative read in company scope.
    expect((await h.call(m, 'GET', '/v1/access/delegations')).statusCode).toBe(403);
  });

  it('each party lists their own delegations with who and what, and nobody else does', async () => {
    const { m, d } = await people();
    const id = await live(m, d, { purpose: 'Cover (synthetic)' });
    const mine = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/delegations')).json().items as Record<string, any>[];
    const seen = (await mine(m)).find((r) => r.id === id)!;
    expect(seen).toMatchObject({ state: 'ACTIVE', status: 'LIVE', permission: LEAVE, purpose: 'Cover (synthetic)', openTasks: 0, version: 2, confidential: false });
    expect(seen.delegator.userId).toBe(m.user);
    expect(seen.delegate.userId).toBe(d.user);
    expect(seen.approvedBy.userId).toBe(admin.user);
    expect(seen.kinds).toEqual(expect.arrayContaining(['leave_request', 'leave_cancellation']));
    expect((await mine(d)).map((r) => r.id)).toContain(id);
    const stranger = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    expect((await mine(stranger)).map((r) => r.id)).not.toContain(id);
    // An administrator holds no row scope over the tasks, so sees no count of them (C1 "counts").
    const asAdmin = ((await h.call(admin, 'GET', '/v1/access/delegations')).json().items as Record<string, unknown>[]).find((r) => r.id === id)!;
    expect(asAdmin.openTasks).toBeNull();
  });

  it('the approval re-checks what the request said: the period, the delegator’s authority and the delegate’s eligibility', async () => {
    const expired = await people();
    const expiredId = (await ask(expired.m, expired.d)).json().id as string;
    await h.db.query(`update delegation set effective_from = now() - interval '2 days', effective_to = now() - interval '1 day' where id = $1`, [expiredId]);
    expect((await approve(admin, expiredId, 2)).json().error).toBe('DELEGATION_EXPIRED');
    expect(((await h.call(expired.m, 'GET', '/v1/me/delegations')).json().items as { id: string; status: string }[]).find((r) => r.id === expiredId)!.status).toBe('EXPIRED');

    const narrowed = await people();
    const narrowedId = (await ask(narrowed.m, narrowed.d)).json().id as string;
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'leave' and action = 'approve' and field_group = 'operational')`,
      [A.id, narrowed.m.assignment],
    );
    expect((await approve(admin, narrowedId)).json().error).toBe('DELEGATOR_NOT_ELIGIBLE');

    const gone = await people();
    const goneId = (await ask(gone.m, gone.d)).json().id as string;
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [A.id, gone.d.assignment]);
    expect((await approve(admin, goneId)).json().error).toBe('DELEGATE_NOT_ELIGIBLE');
  });

  it('every changing transaction re-checks the actor’s authority: a grant narrowed after the route guard refuses and records nothing', async () => {
    const stale = async (a: TestActor, action: string) => {
      const grant = await grantOf(a, 'access', action);
      await h.db.query(
        `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
            and permission_id = (select id from permission where resource = 'access' and action = $3 and field_group = 'operational')`,
        [A.id, a.assignment, action],
      );
      return grant;
    };
    const FORBIDDEN = { statusCode: 403, code: 'FORBIDDEN' };
    const { m, d } = await people();
    const requester = await stale(await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] }), 'delegate');
    await expect(withTransaction(h.pool, (tx) => requestDelegation(tx, requester, { delegateUserId: d.user, permission: LEAVE, effectiveFrom: now(), effectiveTo: iso(DAY) }))).rejects.toMatchObject(FORBIDDEN);

    const asked = (await ask(m, d)).json().id as string;
    const approver = await stale(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'approve_role_grant');
    await expect(withTransaction(h.pool, (tx) => approveDelegation(tx, approver, asked, 1))).rejects.toMatchObject(FORBIDDEN);
    const rejecter = await stale(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'approve_role_grant');
    await expect(withTransaction(h.pool, (tx) => rejectDelegation(tx, rejecter, asked, 1, 'Synthetic'))).rejects.toMatchObject(FORBIDDEN);
    expect((await h.one<{ state: string }>(`select state from delegation where id = $1`, [asked])).state).toBe('PENDING');

    expect((await approve(admin, asked)).statusCode).toBe(200);
    const revoker = await stale(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'revoke_role');
    await expect(withTransaction(h.pool, (tx) => endDelegation(tx, revoker, 'ADMINISTRATOR', asked, 2, 'Synthetic'))).rejects.toMatchObject(FORBIDDEN);
    const owner = await grantOf(m, 'access', 'delegate');
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'access' and action = 'delegate' and field_group = 'operational')`,
      [A.id, m.assignment],
    );
    await expect(withTransaction(h.pool, (tx) => endDelegation(tx, owner, 'DELEGATOR', asked, 2, 'Synthetic'))).rejects.toMatchObject(FORBIDDEN);
    expect((await h.one<{ state: string }>(`select state from delegation where id = $1`, [asked])).state).toBe('ACTIVE');
  });

  it('access.delegate is in the ceiling of the two reviewers DF03 names, and no role’s default duty (C2 and C3 do not list it)', async () => {
    const holders = BASELINE_ROLES.filter((r) => r.ceiling.includes(DELEGATE)).map((r) => r.code).sort();
    expect(holders).toEqual(['HR_ADMINISTRATOR', 'REPORTING_MANAGER']);
    expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(DELEGATE))).toEqual([]);
    // It reaches an assignment only through an independently approved grant, and the default manager cannot ask.
    const plain = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    expect((await h.call(plain, 'GET', '/v1/access/delegations/options')).statusCode).toBe(403);
    const propose = (roleCode: string, scopeKind: string) =>
      h.call(admin, 'POST', '/v1/access/assignments', { userId: plain.user, roleCode, scopeKind, effectiveFrom: '2026-01-01T00:00:00Z', permissions: [DELEGATE, 'employee.read.operational'] });
    expect((await propose('AUDITOR', 'COMPANY')).json().error).toBe('OUTSIDE_ROLE_CEILING');
    expect((await h.call(admin, 'POST', '/v1/access/assignments', { userId: plain.user, roleCode: 'REPORTING_MANAGER', scopeKind: 'ASSIGNED', effectiveFrom: '2026-01-01T00:00:00Z', permissions: [DELEGATE] })).statusCode).toBe(201);
  });

  it('the pickers offer only the decision permissions held and the colleagues who pass the same eligibility check', async () => {
    const { m, d } = await people();
    const teamOnly = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    const options = (await h.call(m, 'GET', '/v1/access/delegations/options')).json().items as { permission: string; kinds: string[] }[];
    expect(options.map((o) => o.permission)).toContain(LEAVE);
    expect(options.map((o) => o.permission)).not.toContain('employee.read.operational');
    expect(options.find((o) => o.permission === LEAVE)!.kinds).toEqual(expect.arrayContaining(['leave_request']));
    const candidates = ((await h.call(m, 'GET', `/v1/access/delegations/candidates?permission=${LEAVE}`)).json().items as { userId: string }[]).map((c) => c.userId);
    expect(candidates).toContain(d.user);
    expect(candidates).not.toContain(m.user);
    expect(candidates).not.toContain(teamOnly.user);
    expect((await h.call(d, 'GET', '/v1/access/delegations/options')).statusCode).toBe(403);
    expect((await h.call(d, 'GET', `/v1/access/delegations/candidates?permission=${LEAVE}`)).statusCode).toBe(403);
  });
});

describe('routing new tasks (CI10; C4 no automatic transfer)', () => {
  it('a task already open when a delegation starts stays with its reviewer, who still decides it', async () => {
    const { m, d, self, x } = await people();
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    await live(m, d);
    expect(await taskRow(taskId)).toMatchObject({ state: 'PENDING', assignee_user_id: m.user, delegation_id: null });
    expect((await leaveQueue(h, d)).some((t) => t.ownerEmployeeId === x)).toBe(false);
    expect((await decide(m, taskId)).statusCode).toBe(200);
  });

  it('inclusive start, exclusive end: a window not yet begun or already over routes nothing', async () => {
    const { m, d, self, x } = await people();
    const id = await live(m, d, { effectiveFrom: iso(DAY), effectiveTo: iso(2 * DAY) });
    await world.submitLeave(self);
    expect(await openTaskOf(x)).toMatchObject({ assignee_user_id: m.user, delegation_id: null });
    const covers = async (at: string) =>
      (await h.one<{ c: boolean }>(`select hrms_delegation_covers($1, $2, $3, $4::timestamptz) as c`, [A.id, id, x, at])).c;
    const w = await h.one<{ f: Date; t: Date }>(`select effective_from as f, effective_to as t from delegation where id = $1`, [id]);
    expect(await covers(w.f.toISOString())).toBe(true);
    expect(await covers(new Date(w.f.getTime() - 1).toISOString())).toBe(false);
    expect(await covers(new Date(w.t.getTime() - 1).toISOString())).toBe(true);
    expect(await covers(w.t.toISOString())).toBe(false);
  });

  it('ZT04 delegated self task: the delegate’s own request stays with the delegator; the delegate never sees it', async () => {
    const { m, mEmp, d, dEmp } = await people();
    await world.setManager(dEmp, mEmp);
    await live(m, d);
    const dSelf = await h.actor(A, 'EMPLOYEE', { user: d.user });
    await world.submitLeave(dSelf);
    const task = await openTaskOf(dEmp);
    expect(task).toMatchObject({ assignee_user_id: m.user, delegation_id: null });
    expect((await leaveQueue(h, d)).some((t) => t.taskId === task.id)).toBe(false);
    expect((await decide(d, task.id)).statusCode).toBe(404);
    expect(await decisions(task.id)).toBe(0);
    expect((await decide(m, task.id)).statusCode).toBe(200);
  });

  it('ZT04 delegated self task: a delegate linked to the owner in an earlier period, who did not raise the request, does not receive it either', async () => {
    const { m, self, x } = await people();
    const formerSelf = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    await live(m, formerSelf);
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2020-01-01', '2021-01-01')`, [A.id, formerSelf.user, x]);
    await world.submitLeave(self);
    expect(await openTaskOf(x)).toMatchObject({ assignee_user_id: m.user, delegation_id: null });
  });

  it('FR-068 "widen the original reviewer’s scope": the delegation carries only the scope of the assignment it came from', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, extra: [DELEGATE] });
    await h.actor(A, 'HR_ADMINISTRATOR', { user: delegator.user, departmentFilter: A.financeDept });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    await live(delegator, delegate);
    await setFallback(delegator);
    try {
      const inEng = await world.employee();
      const engSelf = await h.actor(A, 'EMPLOYEE', { employeeId: inEng });
      await world.submitLeave(engSelf);
      expect(await openTaskOf(inEng)).toMatchObject({ assignee_user_id: delegate.user });
      const inFin = await world.employee(undefined, { departmentId: A.financeDept });
      const finSelf = await h.actor(A, 'EMPLOYEE', { employeeId: inFin });
      await world.submitLeave(finSelf);
      // The delegator reviews this one through their other assignment, which they did not delegate from.
      expect(await openTaskOf(inFin)).toMatchObject({ assignee_user_id: delegator.user, delegation_id: null });
    } finally {
      await setFallback(hr);
    }
  });

  it('FR-068: a location filter on the delegator’s assignment limits the delegation too', async () => {
    const elsewhere = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, uniq('LOC')])).id;
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: elsewhere, extra: [DELEGATE] });
    await h.actor(A, 'HR_ADMINISTRATOR', { user: delegator.user, locationFilter: A.loc });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    await live(delegator, delegate);
    await setFallback(delegator);
    try {
      const y = await world.employee();
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: y }));
      expect(await openTaskOf(y)).toMatchObject({ assignee_user_id: delegator.user, delegation_id: null });
    } finally {
      await setFallback(hr);
    }
  });

  it('FR-068 "equivalent reviewer authority": a delegate left with only a lower class does not receive the task', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const asAdmin = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.actor(A, 'REPORTING_MANAGER', { user: asAdmin.user, scope: 'ASSIGNED' });
    await live(delegator, asAdmin);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [A.id, asAdmin.assignment]);
    await setFallback(delegator);
    try {
      const y = await world.employee();
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: y }));
      expect(await openTaskOf(y)).toMatchObject({ assignee_user_id: delegator.user, delegation_id: null });
    } finally {
      await setFallback(hr);
    }
  });

  it('DB018 record scope: a delegate whose own filters miss the employee does not receive the task', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const finance = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    await live(delegator, finance);
    await setFallback(delegator);
    try {
      const inEng = await world.employee();
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: inEng }));
      expect(await openTaskOf(inEng)).toMatchObject({ assignee_user_id: delegator.user, delegation_id: null });
      const inFin = await world.employee(undefined, { departmentId: A.financeDept });
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: inFin }));
      const task = await openTaskOf(inFin);
      expect(task.assignee_user_id).toBe(finance.user);
      expect((await decide(finance, task.id)).statusCode).toBe(200);
    } finally {
      await setFallback(hr);
    }
  });

  it('one hop only: a delegate’s own delegation is not followed, even if the data held a chain', async () => {
    const { m, d, self, x } = await people();
    const onward = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    await live(m, d);
    await h.db.query(`alter table delegation disable trigger delegation_guard`);
    try {
      await h.db.query(
        `insert into delegation (company_id, delegator_user_id, delegate_user_id, delegator_assignment_id, permission_id, effective_from, effective_to, approved_by, approved_at, state)
         select $1, $2, $3, $4, p.id, now() - interval '1 hour', now() + interval '5 days', $5, now(), 'ACTIVE' from permission p where p.resource = 'leave' and p.action = 'approve' and p.field_group = 'operational'`,
        [A.id, d.user, onward.user, d.assignment, admin.user],
      );
    } finally {
      await h.db.query(`alter table delegation enable trigger delegation_guard`);
    }
    await world.submitLeave(self);
    expect((await openTaskOf(x)).assignee_user_id).toBe(d.user);
  });
});

describe('synthetic two-step route: requester and independent review (C4; DF03)', () => {
  const KIND = 'zz_delegation_two_step';
  const startAs = (actor: TestActor) =>
    withTransaction(h.pool, async (tx) => {
      const bt = (await tx.query<{ id: string }>(`insert into business_transaction (company_id, kind, state, created_by) values ($1, $2, 'SUBMITTED', $3) returning id`, [A.id, KIND, actor.user])).rows[0]!.id;
      await tx.query(`insert into zz_delegation_two_step_root (company_id, transaction_id) values ($1, $2)`, [A.id, bt]);
      return startApproval(tx, { companyId: A.id, kind: KIND, transactionId: bt, ownerEmployeeId: null, actorUserId: actor.user });
    });
  const approveAs = async (a: TestActor, taskId: string) =>
    withTransaction(h.pool, async (tx) =>
      decideTask(tx, { grant: await grantOf(a, 'employee', 'update'), taskId, decision: 'APPROVE', idempotencyKey: uniq('two-step-'), permission: { resource: 'employee', action: 'update' } }),
    );
  const setList = async (...reviewers: TestActor[]) => {
    await h.db.query(`update workflow_fallback_reviewer set active = false where company_id = $1 and kind = $2`, [A.id, KIND]);
    for (const [i, r] of reviewers.entries()) {
      await h.db.query(
        `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, $2, $3, $4, true)
         on conflict (company_id, kind, user_id) do update set priority = excluded.priority, active = true`,
        [A.id, KIND, r.user, i + 1],
      );
    }
  };
  const UPDATE: PermissionKey = 'employee.update.operational';

  beforeAll(async () => {
    await h.db.query(`create table zz_delegation_two_step_root (company_id uuid not null, transaction_id uuid not null unique)`);
    await h.db.query(`insert into transaction_kind (kind, root_table) values ($1, 'zz_delegation_two_step_root')`, [KIND]);
    await h.db.query(`insert into transaction_state (kind, state, initial, terminal) values ($1, 'SUBMITTED', true, false)`, [KIND]);
    const permission = (await h.one<{ id: string }>(`select id from permission where resource = 'employee' and action = 'update' and field_group = 'operational'`)).id;
    const workflow = (await h.one<{ id: string }>(`insert into workflow_definition (company_id, kind, revision, effective_from, active) values ($1, $2, 1, now() - interval '1 day', true) returning id`, [A.id, KIND])).id;
    for (const sequence of [1, 2]) {
      await h.db.query(`insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule) values ($1, $2, $3, $4, 'HR_FALLBACK_LIST', 'ANY_ONE_ELIGIBLE')`, [A.id, workflow, sequence, permission]);
    }
  });

  it('the requester is never the delegate: the task stays with the delegator', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    await live(delegator, delegate, { permission: UPDATE });
    await setList(delegator);
    const fromDelegate = await startAs(delegate);
    expect(fromDelegate.assigneeUserId).toBe(delegator.user);
    const fromSomeoneElse = await startAs(await h.actor(A, 'HR_ADMINISTRATOR'));
    expect(fromSomeoneElse.assigneeUserId).toBe(delegate.user);
  });

  it('a requester linked after routing cannot decide through the delegation (C4 "no conflict")', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    await setList(delegator);
    const started = await startAs(delegate);
    expect(started.assigneeUserId).toBe(delegator.user);
    const id = await live(delegator, delegate, { permission: UPDATE });
    // A task routed to the delegate by hand, as a stale route could leave it: the decision check still refuses.
    await h.db.query(`update approval_task set state = 'SUPERSEDED' where company_id = $1 and id = $2`, [A.id, started.taskId]);
    const forced = (await h.one<{ id: string }>(
      `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, delegation_id, state)
       select company_id, instance_id, workflow_id, step_id, $3, $4, 'PENDING' from approval_task where company_id = $1 and id = $2 returning id`,
      [A.id, started.taskId, delegate.user, id],
    )).id;
    await expect(approveAs(delegate, forced)).rejects.toMatchObject({ statusCode: 403, code: 'DELEGATE_CONFLICT' });
    expect(await decisions(forced)).toBe(0);
  });

  it('a later step goes to neither the delegate who decided nor the delegator whose authority they used', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    const third = await h.actor(A, 'HR_ADMINISTRATOR');
    await live(delegator, delegate, { permission: UPDATE });
    await setList(delegator, delegate, third);
    const started = await startAs(await h.actor(A, 'HR_ADMINISTRATOR'));
    expect(started.assigneeUserId).toBe(delegate.user);
    expect((await approveAs(delegate, started.taskId)).outcome).toBe('NEXT_STEP');
    const step2 = await h.one<{ assignee_user_id: string }>(`select assignee_user_id from approval_task where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [A.id, started.instanceId]);
    expect(step2.assignee_user_id).toBe(third.user);
  });

  it('nor does a later step reach the requester as a delegate', async () => {
    const first = await h.actor(A, 'HR_ADMINISTRATOR');
    const second = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const requester = await h.actor(A, 'HR_ADMINISTRATOR');
    await setList(first, second);
    const started = await startAs(requester);
    expect(started.assigneeUserId).toBe(first.user);
    await live(second, requester, { permission: UPDATE });
    await approveAs(first, started.taskId);
    const step2 = await h.one<{ assignee_user_id: string; delegation_id: string | null }>(`select assignee_user_id, delegation_id from approval_task where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [A.id, started.instanceId]);
    expect(step2).toMatchObject({ assignee_user_id: second.user, delegation_id: null });
  });

  it('a task with no employee owner whose delegation ended is listed and rerouted only by an unrestricted company scope', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    const rerouter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE] });
    const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept, extra: [REROUTE] });
    const id = await live(delegator, delegate, { permission: UPDATE });
    await setList(delegator);
    const started = await startAs(await h.actor(A, 'HR_ADMINISTRATOR'));
    expect(started.assigneeUserId).toBe(delegate.user);
    const listed = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/workflows/stranded-tasks')).json().items as { taskId: string }[]).map((t) => t.taskId);
    const reroute = (a: TestActor) => h.call(a, 'POST', `/v1/workflows/tasks/${started.taskId}/reroute`, { reason: 'Delegation ended (synthetic)' });
    expect(await listed(rerouter)).not.toContain(started.taskId);
    expect((await reroute(rerouter)).json().error).toBe('TASK_NOT_STRANDED');

    expect((await end(delegator, id)).json().openTasks).toBe(1);

    expect(await listed(filtered)).not.toContain(started.taskId);
    expect((await reroute(filtered)).statusCode).toBe(404);
    expect(await listed(rerouter)).toContain(started.taskId);
    const res = await reroute(rerouter);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assigneeUserId).toBe(delegator.user);
    expect(await taskRow(started.taskId)).toMatchObject({ state: 'SUPERSEDED', delegation_id: id });
  });

  it('a delegation never gives the same person two steps: step 2’s reviewer keeps the task when their delegate already decided', async () => {
    const first = await h.actor(A, 'HR_ADMINISTRATOR');
    const second = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    await live(second, first, { permission: UPDATE });
    await setList(first, second);
    const started = await startAs(await h.actor(A, 'HR_ADMINISTRATOR'));
    expect(started.assigneeUserId).toBe(first.user);
    await approveAs(first, started.taskId);
    const step2 = await h.one<{ assignee_user_id: string; delegation_id: string | null }>(`select assignee_user_id, delegation_id from approval_task where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [A.id, started.instanceId]);
    expect(step2).toMatchObject({ assignee_user_id: second.user, delegation_id: null });
  });
});

describe('the decision (C4 "Delegated task"; CI10; line 95)', () => {
  it('the delegate decides; history keeps delegator, delegate and the actual actor', async () => {
    const { m, d, self, x } = await people();
    const id = await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await leaveQueue(h, d)).map((t) => t.taskId)).toContain(taskId);
    const res = await decide(d, taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state).toBe('APPROVED');
    const decision = await h.one<{ actor_user_id: string; acting_assignment_id: string }>(`select actor_user_id, acting_assignment_id from approval_decision where company_id = $1 and task_id = $2`, [A.id, taskId]);
    expect(decision).toEqual({ actor_user_id: d.user, acting_assignment_id: d.assignment });
    const audit = (await auditOf('approval_task', taskId)).find((a) => a.action === 'DELEGATED_DECISION')!;
    expect(audit.actor_user_id).toBe(d.user);
    expect(audit.after_values!.operational).toMatchObject({ delegationId: id, delegatorUserId: m.user, delegateUserId: d.user, actorUserId: d.user, decision: 'APPROVE' });
    expect(await taskRow(taskId)).toMatchObject({ state: 'APPROVED', delegation_id: id });

    // The delegation shows what was decided under it, and by whom: to its parties and an administrator in scope, without the employee.
    const history = await h.call(m, 'GET', `/v1/me/delegations/${id}/decisions`);
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toEqual([expect.objectContaining({ taskId, kind: 'leave_request', stepAction: 'approve', decision: 'APPROVE', actor: expect.objectContaining({ userId: d.user }) })]);
    expect(history.body).not.toContain(x);
    expect((await h.call(d, 'GET', `/v1/me/delegations/${id}/decisions`)).statusCode).toBe(200);
    expect((await h.call(admin, 'GET', `/v1/access/delegations/${id}/decisions`)).json().items).toHaveLength(1);
    const stranger = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await world.employee() });
    expect((await h.call(stranger, 'GET', `/v1/me/delegations/${id}/decisions`)).statusCode).toBe(404);
    expect((await h.call(stranger, 'GET', `/v1/access/delegations/${id}/decisions`)).statusCode).toBe(403);
    const financeAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await h.call(financeAdmin, 'GET', `/v1/access/delegations/${id}/decisions`)).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
  });

  it('the delegator cannot decide the delegated task: it reads as someone else’s', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await decide(m, taskId)).statusCode).toBe(404);
    expect((await leaveQueue(h, m)).some((t) => t.taskId === taskId)).toBe(false);
    expect(await decisions(taskId)).toBe(0);
  });

  it('ZT04: a delegate linked to the owner, even formerly, is refused with no state, decision or success audit', async () => {
    // A link in an earlier period (the employee's own account holds the link in force); routing cannot see one made later.
    const formerSelf = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    const { m, self, x } = await people();
    await live(m, formerSelf);
    await world.submitLeave(self);
    const task = await openTaskOf(x);
    expect(task.assignee_user_id).toBe(formerSelf.user);
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2020-01-01', '2021-01-01')`, [A.id, formerSelf.user, x]);
    const res = await decide(formerSelf, task.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect(await decisions(task.id)).toBe(0);
    expect(await taskRow(task.id)).toMatchObject({ state: 'PENDING' });
    expect((await auditOf('approval_task', task.id)).some((a) => a.action === 'DELEGATED_DECISION')).toBe(false);
  });

  it('ZT04: when the delegator resolves to the owner the delegated decision is refused too', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    // m cannot hold x's current link, so a link in an earlier period names m as this employee.
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2020-01-01', '2021-01-01')`, [A.id, m.user, x]);
    const res = await decide(d, taskId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(taskId)).toBe(0);
  });

  it('CI10: the delegated permission must equal the step permission', async () => {
    const { m, d, self, x } = await people();
    const id = await live(m, d, { permission: 'expense.manager_decide.operational' });
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await taskRow(taskId)).assignee_user_id).toBe(m.user);
    // Not routable through the engine; a task written directly must still not be decidable.
    await h.db.query(`update approval_task set state = 'SUPERSEDED' where company_id = $1 and id = $2`, [A.id, taskId]);
    const forced = (await h.one<{ id: string }>(
      `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, delegation_id, state)
       select company_id, instance_id, workflow_id, step_id, $3, $4, 'PENDING' from approval_task where company_id = $1 and id = $2 returning id`,
      [A.id, taskId, d.user, id],
    )).id;
    const res = await decide(d, forced);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(forced)).toBe(0);
  });

  it('FR-068 "equivalent reviewer authority": the delegate acts from an assignment of the delegator’s class, not a lower one', async () => {
    const delegator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [DELEGATE] });
    const asAdmin = await h.actor(A, 'HR_ADMINISTRATOR');
    const asManager = await h.actor(A, 'REPORTING_MANAGER', { user: asAdmin.user, scope: 'ASSIGNED' });
    await live(delegator, asAdmin);
    await setFallback(delegator);
    try {
      const y = await world.employee();
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: y }));
      const task = await openTaskOf(y);
      expect(task.assignee_user_id).toBe(asAdmin.user);
      const lower = await decide(asManager, task.id);
      expect(lower.statusCode).toBe(403);
      expect(lower.json().error).toBe('DELEGATE_NOT_ELIGIBLE');
      expect(await decisions(task.id)).toBe(0);
      expect((await decide(asAdmin, task.id)).statusCode).toBe(200);
    } finally {
      await setFallback(hr);
    }
  });

  it('C4 "delegator authority remains active": a revoked grant of the delegator stops the delegate', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, m.assignment]);
    const res = await decide(d, taskId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(taskId)).toBe(0);
    expect((await leaveQueue(h, d)).some((t) => t.taskId === taskId)).toBe(false);
  });

  it('DB018 "original entitlement remains required": a withdrawn DB109 entry of the delegator stops the delegate', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'leave' and action = 'approve' and field_group = 'operational')`,
      [A.id, m.assignment],
    );
    expect((await decide(d, taskId)).json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(taskId)).toBe(0);
  });

  it('C4 "delegator authority remains active": a deactivated delegator or an inactive role stops the delegate', async () => {
    const first = await people();
    await live(first.m, first.d);
    await world.submitLeave(first.self);
    const firstTask = await openTaskOf(first.x);
    await h.db.query(`update user_account set active = false where id = $1`, [first.m.user]);
    expect((await decide(first.d, firstTask.id)).json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(firstTask.id)).toBe(0);

    const delegator = await h.customActor(A, { scope: 'COMPANY', permissions: [DELEGATE, LEAVE] });
    const delegate = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    await live(delegator, delegate);
    await setFallback(delegator);
    try {
      const y = await world.employee();
      await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: y }));
      const task = await openTaskOf(y);
      expect(task.assignee_user_id).toBe(delegate.user);
      await h.db.query(`update role set active = false where company_id = $1 and id = (select role_id from role_assignment where id = $2)`, [A.id, delegator.assignment]);
      expect((await decide(delegate, task.id)).json().error).toBe('DELEGATION_NOT_LIVE');
      expect(await decisions(task.id)).toBe(0);
    } finally {
      await setFallback(hr);
    }
  });

  it('a delegator who is no longer the employee’s manager no longer lends authority: the delegate stops and the new manager is not assigned automatically', async () => {
    const { m, d, self, x } = await people();
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    const newManagerEmp = await world.employee();
    await world.setManager(x, newManagerEmp, today);
    expect((await decide(d, taskId)).json().error).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(taskId)).toBe(0);
    expect(await taskRow(taskId)).toMatchObject({ state: 'PENDING', assignee_user_id: d.user });
    expect((await h.call(d, 'GET', `/v1/employees/${x}`)).statusCode).toBe(404);
  });

  it('the delegate’s own authority is re-resolved too: a narrowed delegate is refused', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'leave' and action = 'approve' and field_group = 'operational')`,
      [A.id, d.assignment],
    );
    expect((await decide(d, taskId)).statusCode).toBe(403);
    expect(await decisions(taskId)).toBe(0);
  });
});

describe('ZT05 delegation expiry and revocation while signed in', () => {
  /** The delegated task, its owner readable by the delegate, then `stop` applied: everything the delegate had now fails. */
  async function deniedAfter(stop: (id: string, m: TestActor) => Promise<unknown>) {
    const { m, d, self, x } = await people();
    const id = await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    const countBefore = await openTaskCount(d);
    expect((await h.call(d, 'GET', `/v1/employees/${x}`)).statusCode).toBe(200);
    expect(((await h.call(d, 'GET', '/v1/me/delegated-tasks')).json().items as { taskId: string }[]).map((t) => t.taskId)).toContain(taskId);

    await stop(id, m);

    expect((await h.call(d, 'GET', '/v1/leave/tasks')).body).not.toContain(x);
    expect(await openTaskCount(d)).toBe(countBefore - 1);
    expect((await h.call(d, 'GET', `/v1/employees/${x}`)).statusCode).toBe(404);
    expect((await h.call(d, 'GET', `/v1/employees/${x}/leave-requests`)).statusCode).toBe(404);
    expect((await h.call(d, 'GET', '/v1/me/delegated-tasks')).json().items).toEqual([]);
    const res = await decide(d, taskId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DELEGATION_NOT_LIVE');
    expect(res.body).not.toContain(x);
    expect(await decisions(taskId)).toBe(0);
    expect((await auditOf('approval_task', taskId)).some((a) => a.action === 'DELEGATED_DECISION')).toBe(false);
    const leave = await h.one<{ state: string }>(`select lr.state from leave_request lr where lr.company_id = $1 and lr.employee_id = $2 order by lr.created_at desc limit 1`, [A.id, x]);
    expect(leave.state).toBe('SUBMITTED');
    // BRD silent on what follows: nothing moves by itself (C4), so the task stays open and is listed for routing repair.
    expect(await taskRow(taskId)).toMatchObject({ state: 'PENDING', assignee_user_id: d.user });
    const stranded = (await h.call(hr, 'GET', '/v1/workflows/stranded-tasks')).json().items as { taskId: string; delegationId: string | null }[];
    expect(stranded.find((t) => t.taskId === taskId)?.delegationId).toBe(id);
    return { taskId, d, m, x, id };
  }

  it('an expired delegation stops the next read and decision, and the window has passed without the state changing', async () => {
    const { id } = await deniedAfter((delegationId) => expire(delegationId));
    expect((await h.one<{ state: string }>(`select state from delegation where id = $1`, [id])).state).toBe('ACTIVE');
    // An expired delegation cannot be ended again; it is over.
    expect((await h.call(admin, 'POST', `/v1/access/delegations/${id}/end`, { expectedVersion: 3, reason: 'Late' })).json().error).toBe('INVALID_STATE');
  });

  it('an ended delegation stops the next read and decision, and the end is audited with the open task count', async () => {
    const { id, m } = await deniedAfter(async (delegationId, delegator) => {
      const ended = await end(delegator, delegationId);
      expect(ended.statusCode, ended.body).toBe(200);
      expect(ended.json()).toEqual({ id: delegationId, state: 'ENDED', openTasks: 1 });
    });
    const last = (await auditOf('delegation', id)).at(-1)!;
    expect(last).toMatchObject({ action: 'END', actor_user_id: m.user, reason: 'Back early (synthetic)' });
    expect(last.after_values!.operational).toMatchObject({ state: 'ENDED', openTasks: 1 });
    expect((await end(m, id, 3)).json().error).toBe('INVALID_STATE');
  });

  it('a company-scope delegate keeps their independent read, but not the task, after the end', async () => {
    const { m, self, x } = await people();
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = await live(m, delegate);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await leaveQueue(h, delegate)).map((t) => t.taskId)).toContain(taskId);
    const countBefore = await openTaskCount(delegate);
    expect((await end(admin, id)).statusCode).toBe(200);
    expect((await leaveQueue(h, delegate)).map((t) => t.taskId)).not.toContain(taskId);
    expect(await openTaskCount(delegate)).toBe(countBefore - 1);
    expect(((await h.call(delegate, 'GET', '/v1/me/delegated-tasks')).json().items as { taskId: string }[]).map((t) => t.taskId)).not.toContain(taskId);
    expect((await h.call(delegate, 'GET', `/v1/employees/${x}`)).statusCode).toBe(200);
    const res = await decide(delegate, taskId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('DELEGATION_NOT_LIVE');
  });

  it('the F2 task widgets count a delegated task only while it is live', async () => {
    const { m, self } = await people();
    const d = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = await live(m, d);
    await world.submitLeave(self);
    const count = async () => {
      const p = new SqlParams();
      const sql = `select count(*) as n ${myPendingTasks(await grantOf(d, 'leave', 'approve'), p, ['leave_request'])}`;
      const metric = await countOf(h.pool, sql, p);
      return metric.status === 'OK' ? metric.value : null;
    };
    expect(await count()).toBe(1);
    expect((await end(m, id)).statusCode).toBe(200);
    expect(await count()).toBe(0);
  });

  it('only the delegator or the revocation duty can end it; someone else’s reads as missing', async () => {
    const { m, d } = await people();
    const id = await live(m, d);
    expect((await end(d, id)).statusCode).toBe(403);
    const otherDelegator = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: [DELEGATE] });
    expect((await end(otherDelegator, id)).statusCode).toBe(404);
    expect((await end(m, id, 7)).json().error).toBe('STALE_VERSION');
    expect((await end(admin, id)).json().state).toBe('ENDED');
    expect((await auditOf('delegation', id)).at(-1)).toMatchObject({ action: 'END', actor_user_id: admin.user });
  });

  it('a reminder stops for the former delegate, the escalation still reaches the fallback list, and queued notices are not delivered', async () => {
    // Company scope: the delegate still covers the employee, so only the delegation can stop these.
    const { m, self, x } = await people();
    const d = await h.actor(A, 'HR_ADMINISTRATOR');
    const id = await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await end(m, id)).statusCode).toBe(200);
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(d)).some((n) => n.category === 'LEAVE_SUBMITTED')).toBe(false);
    // The request's notice named the delegate when it was raised; delivery re-checked and stopped it.
    expect((await h.db.query(`select 1 from notification where company_id = $1 and recipient_user_id = $2 and category = 'LEAVE_SUBMITTED' and state = 'DELIVERED'`, [A.id, d.user])).rowCount).toBe(0);

    await withTransaction(h.pool, async (tx) => {
      await tx.query(`set local session_replication_role = replica`);
      await tx.query(`update approval_task set created_at = now() - interval '20 days' where company_id = $1 and id = $2`, [A.id, taskId]);
    });
    await runReminders(h.pool, A.id);
    const sent = async (category: string) =>
      (
        await h.db.query<{ u: string }>(
          `select n.recipient_user_id as u from notification n join notification_event ev on ev.company_id = n.company_id and ev.id = n.event_id
            where n.company_id = $1 and n.category = $2 and ev.event_key = $3`,
          [A.id, category, `${category}:${taskId}`],
        )
      ).rows.map((r) => r.u);
    expect(await sent('APPROVAL_REMINDER')).toEqual([]);
    expect(await sent('APPROVAL_ESCALATION')).toContain(hr.user);
  });

  it('DF12: each party is told; a live delegate receives the request’s notice as its reviewer', async () => {
    const { m, d, self } = await people();
    const id = await live(m, d);
    await world.submitLeave(self);
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(d)).some((n) => n.category === 'LEAVE_SUBMITTED')).toBe(true);
    expect((await inbox(d)).find((n) => n.category === 'DELEGATION_CHANGED')?.title).toBe('Delegation approved');
    expect((await inbox(m)).find((n) => n.category === 'DELEGATION_CHANGED')?.body).toContain('leave request');
    expect((await end(m, id)).statusCode).toBe(200);
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(d)).map((n) => n.title)).toContain('Delegation ended');
  });
});

describe('reroute of a task whose delegation ended (C4)', () => {
  it('a live delegated task is not stranded; once ended, a reroute supersedes it with a new task for the reviewer and keeps the history', async () => {
    const { m, d, self, x } = await people();
    const rerouter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE] });
    const id = await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    const reroute = () => h.call(rerouter, 'POST', `/v1/workflows/tasks/${taskId}/reroute`, { reason: 'Delegation ended (synthetic)' });
    expect((await reroute()).json().error).toBe('TASK_NOT_STRANDED');
    expect((await end(m, id)).statusCode).toBe(200);
    const res = await reroute();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assigneeUserId).toBe(m.user);
    expect(await taskRow(taskId)).toMatchObject({ state: 'SUPERSEDED', assignee_user_id: d.user, delegation_id: id });
    expect(await taskRow(res.json().taskId)).toMatchObject({ state: 'PENDING', assignee_user_id: m.user, delegation_id: null });
    expect((await decide(m, res.json().taskId)).statusCode).toBe(200);
  });

  it('a new live delegation applies to the rerouted task', async () => {
    const { m, d, self, x } = await people();
    const next = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED' });
    const rerouter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE] });
    const first = await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    expect((await end(m, first)).statusCode).toBe(200);
    const second = await live(m, next);
    const res = await h.call(rerouter, 'POST', `/v1/workflows/tasks/${taskId}/reroute`, { reason: 'Delegation ended (synthetic)' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await taskRow(res.json().taskId)).toMatchObject({ assignee_user_id: next.user, delegation_id: second });
  });
});

describe('reads a delegate needs (I-52; DF16; DF03 no confidential grant)', () => {
  it('an assigned-scope delegate reads the task’s owner while live, never through My Team, and sees no private reason without their own grant', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    const secret = `Private synthetic reason ${uniq('r')}`;
    const start = '2027-03-01';
    const submitted = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: start, endDate: start, reason: secret });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect((await openTaskOf(x)).assignee_user_id).toBe(d.user);

    const queue = await h.call(d, 'GET', '/v1/leave/tasks');
    expect(queue.body).toContain(x);
    expect(queue.body).not.toContain(secret);
    const requests = await h.call(d, 'GET', `/v1/employees/${x}/leave-requests`);
    expect(requests.statusCode).toBe(200);
    expect(requests.body).not.toContain(secret);
    // DF16: reach through a delegated task is not team membership.
    expect((await h.call(d, 'GET', '/v1/my-team')).body).not.toContain(x);
    expect((await h.call(d, 'GET', `/v1/my-team/${x}`)).statusCode).toBe(404);
    // The grant is the delegate's own: with it, the same read shows the reason (their assignment, not the delegation).
    const withReason = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', extra: ['leave.read.reason'] });
    const other = await people();
    await live(other.m, withReason);
    const s2 = await h.call(other.self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: start, endDate: start, reason: secret });
    expect(s2.statusCode, s2.body).toBe(201);
    expect((await h.call(withReason, 'GET', `/v1/employees/${other.x}/leave-requests`)).body).toContain(secret);
  });

  it('a task of another role of the same delegate is not listed under this role (BR-046)', async () => {
    const { m, d, self, x } = await people();
    await live(m, d);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    const elsewhere = await h.actor(A, 'EMPLOYEE', { user: d.user });
    expect(((await h.call(d, 'GET', '/v1/me/delegated-tasks')).json().items as { taskId: string; delegator: { userId: string } }[]).find((t) => t.taskId === taskId)?.delegator.userId).toBe(m.user);
    expect((await h.call(elsewhere, 'GET', '/v1/me/delegated-tasks')).json().items).toEqual([]);
  });

  it('the delegated task list follows the row scope of the selected assignment (I-52)', async () => {
    const { m, self, x } = await people();
    const delegate = await h.actor(A, 'HR_ADMINISTRATOR');
    const narrower = await h.actor(A, 'HR_ADMINISTRATOR', { user: delegate.user, departmentFilter: A.financeDept });
    await live(m, delegate);
    await world.submitLeave(self);
    const { id: taskId } = await openTaskOf(x);
    const listed = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/me/delegated-tasks')).json().items as { taskId: string }[]).map((t) => t.taskId);
    expect(await listed(delegate)).toContain(taskId);
    expect(await listed(narrower)).not.toContain(taskId);
  });
});

describe('races between a decision and a revocation (ZT05; line 95)', () => {
  async function delegatedTask() {
    const p = await people();
    const id = await live(p.m, p.d);
    await world.submitLeave(p.self);
    const { id: taskId } = await openTaskOf(p.x);
    return { ...p, id, taskId, adminGrant: await grantOf(admin, 'access', 'revoke_role'), decideGrant: await grantOf(p.d, 'leave', 'approve') };
  }
  const decideDirect = (grant: AccessGrant, taskId: string, onDecided?: () => Promise<void>) =>
    withTransaction(h.pool, (tx) =>
      decideTask(tx, { grant, taskId, decision: 'APPROVE', idempotencyKey: uniq('race-'), permission: { resource: 'leave', action: 'approve' }, ...(onDecided ? { onDecided } : {}) }),
    );

  it('an end that commits first refuses the decision waiting on it', async () => {
    const t = await delegatedTask();
    const ended = deferred();
    const release = deferred();
    const ending = withTransaction(h.pool, async (tx) => {
      const r = await endDelegation(tx, t.adminGrant, 'ADMINISTRATOR', t.id, 2, 'Synthetic race');
      ended.resolve();
      await release.promise;
      return r;
    });
    await ended.promise;
    const deciding = decideDirect(t.decideGrant, t.taskId);
    const outcome = deciding.then(
      () => 'decided',
      (err: { code?: string }) => err.code,
    );
    await untilSomeoneWaits();
    release.resolve();
    await ending;
    expect(await outcome).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(t.taskId)).toBe(0);
  });

  it('a decision that holds the delegation first stands; the end waits for it and then ends with no task open', async () => {
    const t = await delegatedTask();
    const recorded = deferred();
    const release = deferred();
    const deciding = decideDirect(t.decideGrant, t.taskId, async () => {
      recorded.resolve();
      await release.promise;
    });
    await recorded.promise;
    const ending = withTransaction(h.pool, (tx) => endDelegation(tx, t.adminGrant, 'ADMINISTRATOR', t.id, 2, 'Synthetic race'));
    await untilSomeoneWaits();
    release.resolve();
    expect((await deciding).outcome).toBe('APPROVED');
    expect((await ending).state).toBe('ENDED');
    expect((await ending).openTasks).toBe(0);
    expect(await decisions(t.taskId)).toBe(1);
  });

  it('a revocation of the delegator’s grant that commits first refuses the decision waiting on it', async () => {
    const t = await delegatedTask();
    const revoker = await grantOf(admin, 'access', 'revoke_role');
    const version = (await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [t.m.assignment])).version;
    const revoked = deferred();
    const release = deferred();
    const revoking = withTransaction(h.pool, async (tx) => {
      await endGrant(tx, revoker, t.m.assignment, version, 'Synthetic race', 'REVOKE');
      revoked.resolve();
      await release.promise;
    });
    await revoked.promise;
    const outcome = decideDirect(t.decideGrant, t.taskId).then(
      () => 'decided',
      (err: { code?: string }) => err.code,
    );
    await untilSomeoneWaits();
    release.resolve();
    await revoking;
    expect(await outcome).toBe('DELEGATION_NOT_LIVE');
    expect(await decisions(t.taskId)).toBe(0);
  });

  it('a submission waiting on an end that commits first stays with the reviewer', async () => {
    const t = await delegatedTask();
    expect((await taskRow(t.taskId)).assignee_user_id).toBe(t.d.user);
    const ended = deferred();
    const release = deferred();
    const ending = withTransaction(h.pool, async (tx) => {
      const r = await endDelegation(tx, t.adminGrant, 'ADMINISTRATOR', t.id, 2, 'Synthetic race');
      ended.resolve();
      await release.promise;
      return r;
    });
    await ended.promise;
    const submitting = world.submitLeave(t.self);
    await untilSomeoneWaits();
    release.resolve();
    // The end counted the one task routed before it; the one routed after it never reached the delegate.
    expect((await ending).openTasks).toBe(1);
    await submitting;
    expect(await openTaskOf(t.x)).toMatchObject({ assignee_user_id: t.m.user, delegation_id: null });
  });
});
