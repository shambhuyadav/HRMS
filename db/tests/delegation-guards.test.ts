// Direct writes cannot create or widen a delegation, and a delegated decision passes C4 "Delegated task" at the data layer
// (migration 0090; DF03; DB018; CI10; ZT04; ZT05). This client is not a bootstrap session unless a test says so, so every
// statement goes through the guards the way plain SQL over the application's connection would. Refusals are matched on the
// guard's own message where one exists, so a test cannot pass because some other constraint objected. Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, type CompanyFixture, EXCLUSION_VIOLATION, expectSqlError, fixtures, uniq } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;
let a: CompanyFixture;
let permission: string;
let delegator: string;
let delegatorAssignment: string;
let delegate: string;
let approver: string;

const NOT_PENDING = /a delegation starts PENDING/;
const NO_APPROVER = /a pending delegation has no approver/;
const NAMES_REQUESTER = /names its requester and the delegator assignment/;
const OWN_ASSIGNMENT = /the delegator assignment belongs to the delegator/;
const FROZEN = /keeps its parties, permission, window and request/;
const FIXED = /the decision and end of a delegation are fixed/;
const NOT_ALLOWED = /delegation state .* is not allowed/;
const NO_DUTY = /does not hold the approval duty/;
const STAMP = /stamped with the time of the approving transaction/;
const END_STAMP = /stamped with the time of the ending transaction/;
const CHAIN = /a delegate cannot delegate again/;

const refusedWith = (promise: Promise<unknown>, message: RegExp) => expect(promise).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(message) });

/** A role of the given baseline code holding `permission`, and an approved assignment of it for `user`. */
async function holder(user: string, opts: { code?: string; accessClass?: string; scope?: string; permissions?: string[] } = {}): Promise<string> {
  const code = opts.code ?? uniq('ROLE_');
  const role = (
    await f.one<{ id: string }>(
      `insert into role (company_id, code, name, active, access_class) values ($1, $2, $2, true, $3)
       on conflict (company_id, code) do update set name = excluded.name returning id`,
      [a.company, code, opts.accessClass ?? 'OTHER'],
    )
  ).id;
  const stranger = await f.makeUser();
  return f.asGrantBootstrap(async () => {
    const assignment = await f.id(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
       values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', 'ACTIVE', $5, now())`,
      [a.company, user, role, opts.scope ?? 'COMPANY', stranger],
    );
    for (const p of opts.permissions ?? [permission]) {
      await db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'ALLOW') on conflict do nothing`, [a.company, role, p]);
      await db.query(`insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`, [a.company, assignment, p]);
    }
    return assignment;
  });
}

const pending = (over: { delegator?: string; delegate?: string; assignment?: string; from?: string; to?: string; requester?: string | null; state?: string; approvedBy?: string | null } = {}) =>
  f.id(
    `insert into delegation (company_id, delegator_user_id, delegate_user_id, delegator_assignment_id, permission_id, effective_from, effective_to, state, approved_by, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      a.company,
      over.delegator ?? delegator,
      over.delegate ?? delegate,
      'assignment' in over ? over.assignment : delegatorAssignment,
      permission,
      over.from ?? '2026-01-01T00:00:00Z',
      over.to ?? '2026-01-20T00:00:00Z',
      over.state ?? 'PENDING',
      over.approvedBy ?? null,
      'requester' in over ? over.requester : (over.delegator ?? delegator),
    ],
  );
const approve = (id: string, by = approver) => db.query(`update delegation set state = 'ACTIVE', approved_by = $2, approved_at = now() where id = $1`, [id, by]);
const stateOf = async (id: string) => (await f.one<{ state: string }>(`select state from delegation where id = $1`, [id])).state;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = testDb.client;
  f = fixtures(db);
  await db.query(`
    insert into transaction_kind (kind, root_table) values ('test_delegated', 'test_delegated');
    create table test_delegated (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references company (id),
      transaction_kind text not null default 'test_delegated' check (transaction_kind = 'test_delegated'),
      transaction_id uuid not null,
      unique (company_id, transaction_id),
      foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id) deferrable initially deferred
    );
    insert into transaction_state (kind, state, initial, terminal) values ('test_delegated', 'SUBMITTED', true, false);
  `);
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  a = await f.makeCompany();
  permission = await f.makePermission();
  delegator = await f.makeUser();
  delegate = await f.makeUser();
  approver = await f.makeUser();
  delegatorAssignment = await holder(delegator);
  const duty = (await f.one<{ id: string }>(`select id from permission where resource = 'access' and action = 'approve_role_grant' and field_group = 'operational'`)).id;
  await holder(approver, { permissions: [duty] });
});

describe('a delegation starts as a request (DB018; DF03)', () => {
  it('refuses a directly written usable delegation, an approver on a request, and a request without its requester or assignment', async () => {
    await refusedWith(pending({ state: 'ACTIVE', approvedBy: approver }), NOT_PENDING);
    await refusedWith(pending({ approvedBy: approver }), NO_APPROVER);
    await refusedWith(pending({ requester: null }), NAMES_REQUESTER);
    await refusedWith(pending({ assignment: null as unknown as string }), NAMES_REQUESTER);
    await refusedWith(pending({ assignment: await holder(delegate) }), OWN_ASSIGNMENT);
    expect(await stateOf(await pending())).toBe('PENDING');
  });

  it('the bootstrap path is explicit, and the CHECKs and the rules still bind it', async () => {
    const delegateAssignment = await holder(delegate);
    const third = await f.makeUser();
    await f.asGrantBootstrap(async () => {
      await expectSqlError(pending({ approvedBy: delegate }), CHECK_VIOLATION);
      await expectSqlError(pending({ approvedBy: delegator }), CHECK_VIOLATION);
      await expectSqlError(pending({ to: '2026-02-15T00:00:00Z', approvedBy: approver }), CHECK_VIOLATION);
      // A fixture that names an approver gets a usable row.
      expect(await stateOf(await pending({ approvedBy: approver }))).toBe('ACTIVE');
      await refusedWith(pending({ delegator: delegate, delegate: third, assignment: delegateAssignment, approvedBy: approver }), CHAIN);
    });
  });
});

describe('independent approval (C4; CI09 by analogy; DF02; DF03)', () => {
  it('the delegator, the delegate and the requester cannot approve, whatever duty they hold', async () => {
    const id = await pending({ requester: await f.makeUser() });
    const duty = (await f.one<{ id: string }>(`select id from permission where resource = 'access' and action = 'approve_role_grant' and field_group = 'operational'`)).id;
    await holder(delegator, { permissions: [duty] });
    await holder(delegate, { permissions: [duty] });
    await expectSqlError(approve(id, delegator), CHECK_VIOLATION);
    await expectSqlError(approve(id, delegate), CHECK_VIOLATION);
    const requester = (await f.one<{ created_by: string }>(`select created_by from delegation where id = $1`, [id])).created_by;
    await holder(requester, { permissions: [duty] });
    await expectSqlError(approve(id, requester), CHECK_VIOLATION);
    expect(await stateOf(id)).toBe('PENDING');
    await expect(approve(id)).resolves.toBeDefined();
    expect(await stateOf(id)).toBe('ACTIVE');
  });

  it('the approver must hold the duty in company scope, and an approval names the transaction time', async () => {
    const id = await pending();
    await refusedWith(approve(id, await f.makeUser()), NO_DUTY);
    await refusedWith(db.query(`update delegation set state = 'ACTIVE', approved_by = $2, approved_at = now() - interval '1 day' where id = $1`, [id, approver]), STAMP);
    expect(await stateOf(id)).toBe('PENDING');
  });

  it('an approval needs its approver', async () => {
    const id = await pending();
    await expectSqlError(db.query(`update delegation set state = 'ACTIVE' where id = $1`, [id]), CHECK_VIOLATION);
    // DB018 "approved_by required": the constraint itself, which binds a bootstrap write that passes the guard.
    await f.asGrantBootstrap(() => expectSqlError(pending({ state: 'ACTIVE', from: '2026-02-01T00:00:00Z', to: '2026-02-02T00:00:00Z' }), CHECK_VIOLATION));
  });

  it('parties, permission, window and request are frozen from the start; decisions once recorded', async () => {
    const id = await pending();
    const other = await f.makeUser();
    await refusedWith(db.query(`update delegation set delegate_user_id = $2 where id = $1`, [id, other]), FROZEN);
    await refusedWith(db.query(`update delegation set effective_to = effective_to + interval '1 day' where id = $1`, [id]), FROZEN);
    await refusedWith(db.query(`update delegation set effective_to = effective_to - interval '1 day' where id = $1`, [id]), FROZEN);
    await refusedWith(db.query(`update delegation set permission_id = $2 where id = $1`, [id, await f.makePermission()]), FROZEN);
    await approve(id);
    await refusedWith(db.query(`update delegation set delegate_user_id = $2 where id = $1`, [id, other]), FROZEN);
    await refusedWith(db.query(`update delegation set approved_by = $2 where id = $1`, [id, other]), FIXED);
    await expectSqlError(db.query(`delete from delegation where id = $1`, [id]), CHECK_VIOLATION);
  });
});

describe('state moves (DB018; ZT05)', () => {
  const finish = (id: string, state: string, reason: string | null = 'Synthetic reason') =>
    db.query(`update delegation set state = $2, ended_by = $3, ended_at = now(), end_reason = $4 where id = $1`, [id, state, delegator, reason]);

  it('only pending -> approved, rejected or withdrawn, and approved -> ended; the rest are final', async () => {
    const asked = await pending();
    await refusedWith(finish(asked, 'ENDED'), NOT_ALLOWED);
    await finish(asked, 'WITHDRAWN');
    await refusedWith(approve(asked), NOT_ALLOWED);

    const rejected = await pending({ from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' });
    await expectSqlError(db.query(`update delegation set state = 'REJECTED', decided_by = $2, decided_at = now() where id = $1`, [rejected, approver]), CHECK_VIOLATION);
    await db.query(`update delegation set state = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = 'No cover needed' where id = $1`, [rejected, approver]);
    await refusedWith(approve(rejected), NOT_ALLOWED);

    const running = await pending({ from: '2026-04-01T00:00:00Z', to: '2026-04-02T00:00:00Z' });
    await approve(running);
    await refusedWith(db.query(`update delegation set state = 'WITHDRAWN', ended_by = $2, ended_at = now(), end_reason = 'x' where id = $1`, [running, delegator]), NOT_ALLOWED);
    await expectSqlError(finish(running, 'ENDED', '  '), CHECK_VIOLATION);
    await refusedWith(db.query(`update delegation set state = 'ENDED', ended_by = $2, ended_at = now() - interval '1 day', end_reason = 'x' where id = $1`, [running, delegator]), END_STAMP);
    await finish(running, 'ENDED');
    await refusedWith(db.query(`update delegation set state = 'ACTIVE' where id = $1`, [running]), NOT_ALLOWED);
    await refusedWith(db.query(`update delegation set end_reason = 'Rewritten' where id = $1`, [running]), FIXED);
  });

  it('at most 30 calendar days, end after start (DF03)', async () => {
    await expectSqlError(pending({ to: '2026-01-31T00:00:01Z' }), CHECK_VIOLATION);
    await expectSqlError(pending({ to: '2026-01-01T00:00:00Z' }), CHECK_VIOLATION);
    await expect(pending({ to: '2026-01-31T00:00:00Z' })).resolves.toBeTypeOf('string');
  });

  it('one open delegation per delegator, permission and period; adjoining periods and a closed one do not count', async () => {
    const first = await pending({ to: '2026-01-10T00:00:00Z' });
    const other = await f.makeUser();
    await expectSqlError(pending({ delegate: other, from: '2026-01-09T00:00:00Z', to: '2026-01-12T00:00:00Z' }), EXCLUSION_VIOLATION);
    await expect(pending({ delegate: other, from: '2026-01-10T00:00:00Z', to: '2026-01-12T00:00:00Z' })).resolves.toBeTypeOf('string');
    await db.query(`update delegation set state = 'WITHDRAWN', ended_by = $2, ended_at = now(), end_reason = 'x' where id = $1`, [first, delegator]);
    await expect(pending({ delegate: other, from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' })).resolves.toBeTypeOf('string');
  });

  it('no redelegation (CI10): within one permission and period, in either order, a request counting as much as an approved one', async () => {
    const third = await f.makeUser();
    const delegateAssignment = await holder(delegate);
    await pending();
    await refusedWith(pending({ delegator: delegate, delegate: third, assignment: delegateAssignment }), CHAIN);
    const fourth = await f.makeUser();
    await refusedWith(pending({ delegator: fourth, delegate: delegator, assignment: await holder(fourth) }), CHAIN);
    // Another period is not a chain.
    await expect(pending({ delegator: delegate, delegate: third, assignment: delegateAssignment, from: '2026-02-01T00:00:00Z', to: '2026-02-02T00:00:00Z' })).resolves.toBeTypeOf('string');
  });
});

describe('a delegated decision (C4 "Delegated task"; CI10; ZT04; ZT05)', () => {
  let ownerEmployee: string;
  let transaction: string;
  let workflow: string;
  let step: string;
  let instance: string;
  let delegateAssignment: string;

  const NOT_EFFECTIVE = /delegation is not effective/;
  const NO_AUTHORITY = /the delegator no longer holds this authority/;
  const OTHER_PERMISSION = /is not this step's permission/;
  const LOWER = /not of equivalent authority/;
  const REQUESTER = /a requester cannot decide through a delegation/;
  const DELEGATED_SELF = /delegated self decision is prohibited/;
  const SELF = /self decision is prohibited/;

  const liveNow = async (over: Parameters<typeof pending>[0] = {}) => {
    const id = await pending({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(), ...over });
    await approve(id);
    return id;
  };
  const task = (delegation: string, assignee = delegate) =>
    f.id(
      `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, delegation_id, state) values ($1, $2, $3, $4, $5, $6, 'PENDING')`,
      [a.company, instance, workflow, step, assignee, delegation],
    );
  const decide = async (taskId: string, assignment = delegateAssignment, actor = delegate) =>
    db.query(
      `insert into approval_decision (company_id, task_id, actor_user_id, acting_assignment_id, decision, expected_version, idempotency_key)
       values ($1, $2, $3, $4, 'APPROVE', (select version from business_transaction where id = $5), $6)`,
      [a.company, taskId, actor, assignment, transaction, uniq('idem-key-')],
    );

  beforeEach(async () => {
    ownerEmployee = await f.makeEmployee(a, uniq('OWN'));
    await db.query('begin');
    transaction = await f.id(`insert into business_transaction (company_id, kind, owner_employee_id, state, created_by) values ($1, 'test_delegated', $2, 'SUBMITTED', $3)`, [
      a.company,
      ownerEmployee,
      await f.makeUser(),
    ]);
    await db.query('insert into test_delegated (company_id, transaction_id) values ($1, $2)', [a.company, transaction]);
    await db.query('commit');
    workflow = await f.id(`insert into workflow_definition (company_id, kind, revision, effective_from, active) values ($1, 'test_delegated', 1, '2026-01-01T00:00:00Z', false)`, [a.company]);
    step = await f.id(`insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule) values ($1, $2, 1, $3, 'DIRECT_MANAGER', 'ANY_ONE_ELIGIBLE')`, [
      a.company,
      workflow,
      permission,
    ]);
    instance = await f.id(`insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state) values ($1, 'test_delegated', $2, 1, $3, 'ACTIVE')`, [
      a.company,
      transaction,
      workflow,
    ]);
    delegateAssignment = await holder(delegate);
  });

  it('accepts a live delegation', async () => {
    const taskId = await task(await liveNow());
    await expect(decide(taskId)).resolves.toBeDefined();
  });

  it('ZT05: refuses it once expired, not yet begun or ended', async () => {
    const expired = await f.asGrantBootstrap(() => pending({ approvedBy: approver, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }));
    await refusedWith(decide(await task(expired)), NOT_EFFECTIVE);
    await db.query(`update approval_task set state = 'SUPERSEDED' where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [a.company, instance]);

    const future = await f.asGrantBootstrap(() => pending({ approvedBy: approver, from: new Date(Date.now() + 86_400_000).toISOString(), to: new Date(Date.now() + 2 * 86_400_000).toISOString() }));
    await refusedWith(decide(await task(future)), NOT_EFFECTIVE);
    await db.query(`update approval_task set state = 'SUPERSEDED' where company_id = $1 and instance_id = $2 and state = 'PENDING'`, [a.company, instance]);

    const ended = await liveNow({ to: new Date(Date.now() + 3_600_000).toISOString() });
    const taskId = await task(ended);
    await db.query(`update delegation set state = 'ENDED', ended_by = $2, ended_at = now(), end_reason = 'Synthetic' where id = $1`, [ended, delegator]);
    await refusedWith(decide(taskId), NOT_EFFECTIVE);
  });

  it('refuses a request that was never approved', async () => {
    const asked = await pending({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
    await refusedWith(decide(await task(asked)), NOT_EFFECTIVE);
  });

  it('CI10: refuses a delegated permission that is not the step permission', async () => {
    const other = await f.makePermission();
    await holder(delegator, { permissions: [other] });
    const id = await f.id(
      `insert into delegation (company_id, delegator_user_id, delegate_user_id, delegator_assignment_id, permission_id, effective_from, effective_to, state, created_by)
       values ($1, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '1 day', 'PENDING', $2)`,
      [a.company, delegator, delegate, delegatorAssignment, other],
    );
    await approve(id);
    await refusedWith(decide(await task(id)), OTHER_PERMISSION);
  });

  it('C4 "delegator authority remains active": refuses after the delegator loses the assignment or its DB109 entry', async () => {
    const id = await liveNow();
    const taskId = await task(id);
    await db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2 and permission_id = $3`, [a.company, delegatorAssignment, permission]);
    await refusedWith(decide(taskId), NO_AUTHORITY);
  });

  it('C4 "delegator authority remains active": refuses after the delegator’s assignment is revoked', async () => {
    const taskId = await task(await liveNow());
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [a.company, delegatorAssignment]);
    await refusedWith(decide(taskId), NO_AUTHORITY);
  });

  it('C4 "delegator authority remains active": refuses after the role stops allowing the permission', async () => {
    const taskId = await task(await liveNow());
    await db.query(
      `update role_permission set effect = 'DENY' where company_id = $1 and permission_id = $2
          and role_id = (select role_id from role_assignment where company_id = $1 and id = $3)`,
      [a.company, permission, delegatorAssignment],
    );
    await refusedWith(decide(taskId), NO_AUTHORITY);
  });

  it('own scope covers nobody: an own-scope delegator lends nothing', async () => {
    const ownDelegator = await f.makeUser();
    const ownAssignment = await holder(ownDelegator, { scope: 'OWN' });
    const id = await liveNow({ delegator: ownDelegator, assignment: ownAssignment });
    await refusedWith(decide(await task(id)), NO_AUTHORITY);
  });

  it('FR-068 "widen the original reviewer’s scope": refuses when the delegator’s assignment does not cover the owner', async () => {
    const teamDelegator = await f.makeUser();
    const teamAssignment = await holder(teamDelegator, { code: 'REPORTING_MANAGER', accessClass: 'MANAGER', scope: 'TEAM' });
    const id = await liveNow({ delegator: teamDelegator, assignment: teamAssignment });
    await refusedWith(decide(await task(id)), NO_AUTHORITY);
  });

  it('FR-068: an employee filter on the delegator’s assignment limits the delegation too', async () => {
    const filteredDelegator = await f.makeUser();
    const filteredAssignment = await holder(filteredDelegator);
    const elsewhere = await f.makeEmployee(a, uniq('ELSE'));
    await f.asGrantBootstrap(() => db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, employee_id) values ($1, $2, 'EMPLOYEE', $3)`, [a.company, filteredAssignment, elsewhere]));
    const id = await liveNow({ delegator: filteredDelegator, assignment: filteredAssignment });
    await refusedWith(decide(await task(id)), NO_AUTHORITY);
  });

  it('the delegator’s team scope does cover a current direct report', async () => {
    const managerEmployee = await f.makeEmployee(a, uniq('MGR'));
    const teamDelegator = await f.makeUser();
    await f.linkUser(a, teamDelegator, managerEmployee);
    const teamAssignment = await holder(teamDelegator, { code: 'REPORTING_MANAGER', accessClass: 'MANAGER', scope: 'TEAM' });
    await db.query(`insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [a.company, ownerEmployee, managerEmployee]);
    const delegateManager = await holder(delegate, { code: 'REPORTING_MANAGER', accessClass: 'MANAGER', scope: 'ASSIGNED' });
    const id = await liveNow({ delegator: teamDelegator, assignment: teamAssignment });
    await expect(decide(await task(id), delegateManager)).resolves.toBeDefined();
  });

  it('ZT04: refuses when the delegate is linked to the owner, in any period', async () => {
    const taskId = await task(await liveNow());
    await db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2020-01-01', '2021-01-01')`, [a.company, delegate, ownerEmployee]);
    await refusedWith(decide(taskId), SELF);
  });

  it('ZT04: refuses when the delegator is linked to the owner', async () => {
    const taskId = await task(await liveNow());
    await db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2020-01-01', '2021-01-01')`, [a.company, delegator, ownerEmployee]);
    await refusedWith(decide(taskId), DELEGATED_SELF);
  });

  it('C4 "no conflict": refuses anyone the approval excluded', async () => {
    const taskId = await task(await liveNow());
    await db.query(`update approval_instance set excluded_user_ids = $3 where company_id = $1 and id = $2`, [a.company, instance, [delegate]]);
    await refusedWith(decide(taskId), REQUESTER);
  });

  it('C4 "no conflict": refuses the requester of the transaction and whoever started its approval', async () => {
    const id = await liveNow();
    const fresh = async (requester: string | null, starter: string | null) => {
      await db.query('begin');
      transaction = await f.id(`insert into business_transaction (company_id, kind, owner_employee_id, state, created_by) values ($1, 'test_delegated', $2, 'SUBMITTED', $3)`, [a.company, ownerEmployee, requester]);
      await db.query('insert into test_delegated (company_id, transaction_id) values ($1, $2)', [a.company, transaction]);
      await db.query('commit');
      instance = await f.id(
        `insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state, created_by) values ($1, 'test_delegated', $2, 1, $3, 'ACTIVE', $4)`,
        [a.company, transaction, workflow, starter],
      );
      return task(id);
    };
    await refusedWith(decide(await fresh(delegate, null)), REQUESTER);
    await refusedWith(decide(await fresh(null, delegate)), REQUESTER);
    await expect(decide(await fresh(null, null))).resolves.toBeDefined();
  });

  it('DF03 "cannot introduce Admin eligibility": refuses an acting assignment of a lower class than the delegator’s', async () => {
    const adminDelegator = await f.makeUser();
    const adminAssignment = await holder(adminDelegator, { code: 'HR_ADMINISTRATOR', accessClass: 'ADMIN' });
    const id = await liveNow({ delegator: adminDelegator, assignment: adminAssignment });
    const taskId = await task(id);
    await refusedWith(decide(taskId), LOWER);
    const adminDelegate = await holder(delegate, { code: 'HR_ADMINISTRATOR', accessClass: 'ADMIN' });
    await expect(decide(taskId, adminDelegate)).resolves.toBeDefined();
  });

  it('ZT05: a decision written while an end is uncommitted waits for it, and is then refused', async () => {
    const id = await liveNow();
    const taskId = await task(id);
    const other = new pg.Client({ connectionString: testDb.connectionString });
    await other.connect();
    try {
      await other.query('begin');
      await other.query(`update delegation set state = 'ENDED', ended_by = $2, ended_at = now(), end_reason = 'Synthetic' where id = $1`, [id, delegator]);
      const refused = refusedWith(decide(taskId), NOT_EFFECTIVE);
      let waiting = 0;
      for (let i = 0; i < 400 && waiting === 0; i++) {
        waiting = (await other.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0]!.n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBeGreaterThan(0);
      await other.query('commit');
      await refused;
    } finally {
      await other.end();
    }
  });

  it('a task without a delegation is untouched by these checks', async () => {
    const plain = await f.id(
      `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, state) values ($1, $2, $3, $4, $5, 'PENDING')`,
      [a.company, instance, workflow, step, delegate],
    );
    await expect(decide(plain)).resolves.toBeDefined();
  });
});
