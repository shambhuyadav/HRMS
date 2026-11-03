// Decisions re-resolve the decider's permission inside the decision transaction (docs/09 §6.5; DF02; C4): a narrowing
// committed between the route guard and the decision is never missed. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { decideTask } from './engine.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;

/** What the route guard of POST /v1/profile-changes/tasks/:id/decision resolves before its transaction opens. */
const guardGrant = async (a: TestActor) =>
  (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'employee', action: 'update', fieldGroups: ['operational'] })) as AccessGrant;
const decideWith = (grant: AccessGrant, taskId: string) =>
  withTransaction(h.pool, (tx) => decideTask(tx, { grant, taskId, decision: 'APPROVE', idempotencyKey: uniq('recheck-'), permission: { resource: 'employee', action: 'update' } }));
const decisionCount = async (taskId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where company_id = $1 and task_id = $2`, [A.id, taskId])).n;

/** An employee's pending profile change routed to the given HR reviewer; returns the reviewer's task id. */
async function pendingTask(reviewer: TestActor): Promise<string> {
  await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] });
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
  expect((await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: `Renamed ${uniq('R')} (synthetic)` })).statusCode).toBe(201);
  const items = (await h.call(reviewer, 'GET', '/v1/profile-changes/tasks/mine')).json().items as { taskId: string }[];
  return items.at(-1)!.taskId;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('the decision transaction re-checks the decider (docs/09 §6.5)', () => {
  it('refuses a decision whose DB109 entry was withdrawn after the guard ran, and records nothing', async () => {
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR');
    const taskId = await pendingTask(reviewer);
    const grant = await guardGrant(reviewer);
    expect(grant.allowed).toBe(true);
    await h.db.query(
      `update role_assignment_permission set active = false
        where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'employee' and action = 'update' and field_group = 'operational')`,
      [A.id, reviewer.assignment],
    );
    await expect(decideWith(grant, taskId)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(await decisionCount(taskId)).toBe(0);
  });

  it('refuses a decision by an assignment revoked after the guard ran', async () => {
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR');
    const taskId = await pendingTask(reviewer);
    const grant = await guardGrant(reviewer);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, reviewer.assignment]);
    await expect(decideWith(grant, taskId)).rejects.toMatchObject({ statusCode: 403 });
    expect(await decisionCount(taskId)).toBe(0);
  });

  it('refuses a decision by a user deactivated after the guard ran', async () => {
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR');
    const taskId = await pendingTask(reviewer);
    const grant = await guardGrant(reviewer);
    await h.db.query(`update user_account set active = false where id = $1`, [reviewer.user]);
    await expect(decideWith(grant, taskId)).rejects.toMatchObject({ statusCode: 403 });
    expect(await decisionCount(taskId)).toBe(0);
  });

  it('still decides when nothing narrowed in between (positive control)', async () => {
    const taskId = await pendingTask(hr2);
    const res = await h.call(hr2, 'POST', `/v1/profile-changes/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('recheck-') });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('APPROVED');
    expect(await decisionCount(taskId)).toBe(1);
  });
});
