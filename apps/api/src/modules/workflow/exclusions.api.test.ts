// Users excluded when an approval starts (its preparer or requester) are kept away from every step, not only the first
// (C4; StartApprovalInput.excludeUserIds; 0052). A synthetic two-step kind decided from the explicit list puts the
// preparer first on that list, so only the start exclusion keeps it away from step 2. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { decideTask, startApproval } from './engine.js';

const KIND = 'zz_two_step_check';
let h: Harness;
let A: Company;
let preparer: TestActor;
let first: TestActor;
let second: TestActor;

const setList = async (reviewers: TestActor[]) => {
  await h.db.query(`update workflow_fallback_reviewer set active = false where company_id = $1 and kind = $2`, [A.id, KIND]);
  for (const [i, r] of reviewers.entries()) {
    await h.db.query(
      `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, $2, $3, $4, true)
       on conflict (company_id, kind, user_id) do update set priority = excluded.priority, active = true`,
      [A.id, KIND, r.user, i + 1],
    );
  }
};
const startPrepared = () =>
  withTransaction(h.pool, async (tx) => {
    // CI12: the transaction and its typed root commit together.
    const bt = (await tx.query<{ id: string }>(`insert into business_transaction (company_id, kind, state, created_by) values ($1, $2, 'SUBMITTED', $3) returning id`, [A.id, KIND, preparer.user])).rows[0]!.id;
    await tx.query(`insert into zz_two_step_check_root (company_id, transaction_id) values ($1, $2)`, [A.id, bt]);
    return startApproval(tx, { companyId: A.id, kind: KIND, transactionId: bt, ownerEmployeeId: null, actorUserId: preparer.user, excludeUserIds: [preparer.user] });
  });
const approve = async (a: TestActor, taskId: string) => {
  const grant = (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'employee', action: 'update', fieldGroups: ['operational'] })) as AccessGrant;
  return withTransaction(h.pool, (tx) => decideTask(tx, { grant, taskId, decision: 'APPROVE', idempotencyKey: uniq('exclusion-key-'), permission: { resource: 'employee', action: 'update' } }));
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  preparer = await h.actor(A, 'HR_ADMINISTRATOR');
  first = await h.actor(A, 'HR_ADMINISTRATOR');
  second = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`create table zz_two_step_check_root (company_id uuid not null, transaction_id uuid not null unique)`);
  await h.db.query(`insert into transaction_kind (kind, root_table) values ($1, 'zz_two_step_check_root')`, [KIND]);
  await h.db.query(`insert into transaction_state (kind, state, initial, terminal) values ($1, 'SUBMITTED', true, false)`, [KIND]);
  const permission = (await h.one<{ id: string }>(`select id from permission where resource = 'employee' and action = 'update' and field_group = 'operational'`)).id;
  const workflow = (
    await h.one<{ id: string }>(`insert into workflow_definition (company_id, kind, revision, effective_from, active) values ($1, $2, 1, now() - interval '1 day', true) returning id`, [A.id, KIND])
  ).id;
  for (const sequence of [1, 2]) {
    await h.db.query(
      `insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule) values ($1, $2, $3, $4, 'HR_FALLBACK_LIST', 'ANY_ONE_ELIGIBLE')`,
      [A.id, workflow, sequence, permission],
    );
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('start exclusions hold at every step (C4)', () => {
  it('the preparer, first on the list, receives neither step; step 2 goes to the next eligible reviewer', async () => {
    await setList([preparer, first, second]);
    const started = await startPrepared();
    expect(started.assigneeUserId).toBe(first.user);
    expect((await approve(first, started.taskId)).outcome).toBe('NEXT_STEP');
    const step2 = await h.one<{ assignee_user_id: string }>(`select assignee_user_id from approval_task where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [
      A.id,
      started.instanceId,
    ]);
    expect(step2.assignee_user_id).toBe(second.user);
  });

  it('with nobody else left for step 2, the decision is refused instead of reaching the excluded preparer', async () => {
    await setList([preparer, first]);
    const started = await startPrepared();
    await expect(approve(first, started.taskId)).rejects.toMatchObject({ statusCode: 422, code: 'NO_ELIGIBLE_REVIEWER' });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_task where company_id = $1 and instance_id = $2`, [A.id, started.instanceId])).n).toBe(1);
  });
});
