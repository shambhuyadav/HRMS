// Direct-write constraint tests for migration 0002: typed transactions, approvals, decisions, attachments,
// audit and imports (CI01, CI02, CI10, CI11, CI12, CI15, CI16; ZT04, ZT07, ZT10–ZT12 database layer).
// Uses a synthetic "test_request" root kind registered only inside the test database.
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  type CompanyFixture,
  expectSqlError,
  FK_VIOLATION,
  fixtures,
  SERIALIZATION_FAILURE,
  UNIQUE_VIOLATION,
  uniq,
} from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = testDb.client;
  f = fixtures(db);
  await db.query(`
    insert into transaction_kind (kind, root_table) values ('test_request', 'test_request');
    create table test_request (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references company (id),
      transaction_kind text not null default 'test_request' check (transaction_kind = 'test_request'),
      transaction_id uuid not null,
      unique (company_id, transaction_id),
      foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
        deferrable initially deferred
    );
    insert into transaction_state (kind, state, initial, terminal) values
      ('test_request', 'DRAFT', true, false),
      ('test_request', 'SUBMITTED', false, false),
      ('test_request', 'APPROVED', false, true),
      ('test_request', 'REJECTED', false, true);
    insert into transaction_transition (kind, from_state, to_state) values
      ('test_request', 'DRAFT', 'SUBMITTED'),
      ('test_request', 'SUBMITTED', 'APPROVED'),
      ('test_request', 'SUBMITTED', 'REJECTED');
  `);
});

afterAll(async () => {
  await testDb?.stop();
});

async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    const result = await work();
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

async function newRequest(c: CompanyFixture, owner: string | null, state = 'DRAFT'): Promise<string> {
  return inTransaction(async () => {
    const tx = await f.id(
      `insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'test_request', $2, $3)`,
      [c.company, owner, state],
    );
    await db.query('insert into test_request (company_id, transaction_id) values ($1, $2)', [c.company, tx]);
    return tx;
  });
}

async function newWorkflow(c: CompanyFixture, permission: string, revision = 1): Promise<{ workflow: string; step: string }> {
  const workflow = await f.id(
    `insert into workflow_definition (company_id, kind, revision, effective_from, active)
     values ($1, 'test_request', $2, '2026-01-01T00:00:00Z', false)`,
    [c.company, revision],
  );
  const step = await f.id(
    `insert into workflow_step (company_id, workflow_id, sequence, permission_id, selection_rule, completion_rule)
     values ($1, $2, 1, $3, 'DIRECT_MANAGER', 'ANY_ONE_ELIGIBLE')`,
    [c.company, workflow, permission],
  );
  return { workflow, step };
}

const submit = (tx: string) => db.query(`update business_transaction set state = 'SUBMITTED' where id = $1`, [tx]);

const newInstance = (c: CompanyFixture, tx: string, workflow: string, revision = 1) =>
  f.id(
    `insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state)
     values ($1, 'test_request', $2, $3, $4, 'ACTIVE')`,
    [c.company, tx, revision, workflow],
  );

const newTask = (c: CompanyFixture, instance: string, workflow: string, step: string, assignee: string, delegation: string | null = null) =>
  f.id(
    `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, delegation_id, state)
     values ($1, $2, $3, $4, $5, $6, 'PENDING')`,
    [c.company, instance, workflow, step, assignee, delegation],
  );

const currentVersion = async (tx: string) =>
  (await f.one<{ version: number }>('select version from business_transaction where id = $1', [tx])).version;

const decide = (c: CompanyFixture, task: string, actor: string, assignment: string, decision: string, reason: string | null, expectedVersion: number) =>
  db.query(
    `insert into approval_decision (company_id, task_id, actor_user_id, acting_assignment_id, decision, reason, expected_version, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.company, task, actor, assignment, decision, reason, expectedVersion, uniq('idem-key-')],
  );

describe('typed transactions (CI12, CI15, ZT10)', () => {
  let a: CompanyFixture;
  beforeEach(async () => {
    a = await f.makeCompany();
  });

  it('rejects a transaction without its typed root at commit', async () => {
    await expectSqlError(
      inTransaction(() =>
        db.query(`insert into business_transaction (company_id, kind, state) values ($1, 'test_request', 'DRAFT')`, [a.company]),
      ),
      CHECK_VIOLATION,
    );
  });

  it('rejects a transaction of an unregistered kind', async () => {
    // The state guard fires first (no initial state catalogued for the kind); the kind FK is the backstop.
    await expectSqlError(
      db.query(`insert into business_transaction (company_id, kind, state) values ($1, 'unknown_kind', 'DRAFT')`, [a.company]),
      CHECK_VIOLATION,
    );
  });

  it('requires an initial state and only catalogued transitions', async () => {
    await expectSqlError(newRequest(a, null, 'APPROVED'), CHECK_VIOLATION);
    const tx = await newRequest(a, null);
    await expectSqlError(db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [tx]), CHECK_VIOLATION);
    await submit(tx);
    await db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [tx]);
    await expectSqlError(db.query(`update business_transaction set state = 'REJECTED' where id = $1`, [tx]), CHECK_VIOLATION);
    await expectSqlError(db.query(`update business_transaction set state = 'NOT_A_STATE' where id = $1`, [tx]), CHECK_VIOLATION);
  });

  it('rejects a second root for the same transaction', async () => {
    const tx = await newRequest(a, null);
    await expectSqlError(db.query('insert into test_request (company_id, transaction_id) values ($1, $2)', [a.company, tx]), UNIQUE_VIOLATION);
  });
});

describe('approval instances, tasks and decisions (CI01, CI02, CI10, ZT04, ZT11)', () => {
  let a: CompanyFixture;
  let owner: string;
  let ownerUser: string;
  let manager: string;
  let managerAssignment: string;
  let permission: string;
  let wf: { workflow: string; step: string };
  let tx: string;

  beforeEach(async () => {
    a = await f.makeCompany();
    const ownerEmp = await f.makeEmployee(a, 'OWNER');
    owner = ownerEmp;
    ownerUser = await f.makeUser();
    await f.linkUser(a, ownerUser, ownerEmp);
    manager = await f.makeUser();
    managerAssignment = await f.makeActiveAssignment(a, manager);
    permission = await f.makePermission();
    wf = await newWorkflow(a, permission);
    tx = await newRequest(a, owner);
    await submit(tx);
  });

  it('pins the current revision and allows one active instance', async () => {
    await expectSqlError(newInstance(a, tx, wf.workflow, 2), CHECK_VIOLATION);
    await newInstance(a, tx, wf.workflow);
    await db.query('update business_transaction set revision = 2 where id = $1', [tx]);
    await expectSqlError(newInstance(a, tx, wf.workflow, 2), UNIQUE_VIOLATION);
  });

  it('rejects a task whose step belongs to another workflow', async () => {
    const other = await newWorkflow(a, permission, 2);
    const instance = await newInstance(a, tx, wf.workflow);
    await expectSqlError(newTask(a, instance, wf.workflow, other.step, manager), FK_VIOLATION);
  });

  it('accepts one valid decision and rejects a second', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    await decide(a, task, manager, managerAssignment, 'APPROVE', null, await currentVersion(tx));
    await expectSqlError(decide(a, task, manager, managerAssignment, 'APPROVE', null, await currentVersion(tx)), UNIQUE_VIOLATION);
  });

  it('rejects a decision by someone other than the assignee', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    const other = await f.makeUser();
    const otherAssignment = await f.makeActiveAssignment(a, other);
    await expectSqlError(decide(a, task, other, otherAssignment, 'APPROVE', null, await currentVersion(tx)), FK_VIOLATION);
  });

  it('rejects self decision even when the owner is the assignee', async () => {
    const ownerAssignment = await f.makeActiveAssignment(a, ownerUser);
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, ownerUser);
    await expectSqlError(decide(a, task, ownerUser, ownerAssignment, 'APPROVE', null, await currentVersion(tx)), CHECK_VIOLATION);
  });

  it('rejects an acting assignment that belongs to another user', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    const otherAssignment = await f.makeActiveAssignment(a, await f.makeUser());
    await expectSqlError(decide(a, task, manager, otherAssignment, 'APPROVE', null, await currentVersion(tx)), CHECK_VIOLATION);
  });

  it('requires a reason to reject or return', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    await expectSqlError(decide(a, task, manager, managerAssignment, 'REJECT', '  ', await currentVersion(tx)), CHECK_VIOLATION);
  });

  it('rejects a stale expected version', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    const stale = await currentVersion(tx);
    await db.query('update business_transaction set updated_by = null where id = $1', [tx]); // concurrent change bumps version
    await expectSqlError(decide(a, task, manager, managerAssignment, 'APPROVE', null, stale), SERIALIZATION_FAILURE);
  });

  it('rejects a decision on a superseded revision', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    await db.query('update business_transaction set revision = 2 where id = $1', [tx]);
    await expectSqlError(decide(a, task, manager, managerAssignment, 'APPROVE', null, await currentVersion(tx)), CHECK_VIOLATION);
  });

  it('keeps decisions append-only and final tasks final', async () => {
    const instance = await newInstance(a, tx, wf.workflow);
    const task = await newTask(a, instance, wf.workflow, wf.step, manager);
    await decide(a, task, manager, managerAssignment, 'APPROVE', null, await currentVersion(tx));
    await expectSqlError(db.query(`update approval_decision set decision = 'REJECT' where task_id = $1`, [task]), CHECK_VIOLATION);
    await db.query(`update approval_task set state = 'APPROVED', decided_at = now() where id = $1`, [task]);
    await expectSqlError(db.query(`update approval_task set state = 'PENDING', decided_at = null where id = $1`, [task]), CHECK_VIOLATION);
  });

  it('requires a delegated task to be assigned to the delegate (CI10)', async () => {
    const delegate = await f.makeUser();
    const approver = await f.makeUser();
    const delegation = await f.asGrantBootstrap(() =>
      f.id(
        `insert into delegation (company_id, delegator_user_id, delegate_user_id, permission_id, effective_from, effective_to, approved_by)
         values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z', $5)`,
        [a.company, manager, delegate, permission, approver],
      ),
    );
    const instance = await newInstance(a, tx, wf.workflow);
    await expectSqlError(newTask(a, instance, wf.workflow, wf.step, await f.makeUser(), delegation), FK_VIOLATION);
    await expect(newTask(a, instance, wf.workflow, wf.step, delegate, delegation)).resolves.toBeTypeOf('string');
  });

  it('freezes a workflow definition once an instance uses it', async () => {
    await newInstance(a, tx, wf.workflow);
    await expectSqlError(db.query('update workflow_step set sequence = 2 where id = $1', [wf.step]), CHECK_VIOLATION);
    await expectSqlError(db.query('update workflow_definition set revision = 9 where id = $1', [wf.workflow]), CHECK_VIOLATION);
    await expect(db.query(`update workflow_definition set effective_to = '2027-01-01T00:00:00Z' where id = $1`, [wf.workflow])).resolves.toBeDefined();
  });
});

describe('attachments, audit and imports (CI11, CI16, ZT12)', () => {
  let a: CompanyFixture;
  let user: string;
  const checksum = 'a'.repeat(64);

  beforeEach(async () => {
    a = await f.makeCompany();
    user = await f.makeUser();
  });

  const attachment = (employee: string | null) =>
    f.id(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum)
       values ($1, $2, $3, $4, 'application/pdf', $5)`,
      [a.company, user, employee, uniq('opaque-ref-'), checksum],
    );

  it('rejects an employee document whose attachment belongs to another employee', async () => {
    const e1 = await f.makeEmployee(a, 'DOC1');
    const e2 = await f.makeEmployee(a, 'DOC2');
    const docType = await f.id(
      `insert into reference_value (company_id, category, code, label, active) values ($1, 'DOCUMENT_TYPE', 'ID_PROOF', 'Identity proof', true)`,
      [a.company],
    );
    const att = await attachment(e2);
    const doc = (employee: string) =>
      db.query(`insert into employee_document (company_id, employee_id, document_type_id, attachment_id) values ($1, $2, $3, $4)`, [
        a.company,
        employee,
        docType,
        att,
      ]);
    await expectSqlError(doc(e1), FK_VIOLATION);
    await expect(doc(e2)).resolves.toBeDefined();
  });

  it('enforces audit shape and append-only history', async () => {
    const audit = (action: string, before: object | null, after: object | null) =>
      f.id(
        `insert into audit_event (company_id, resource_code, record_key, actor_user_id, action, before_values, after_values)
         values ($1, 'employee', gen_random_uuid(), $2, $3, $4, $5)`,
        [a.company, user, action, before, after],
      );
    await expectSqlError(audit('UPDATE', null, { grade: 'G2' }), CHECK_VIOLATION);
    await expectSqlError(audit('CREATE', null, null), CHECK_VIOLATION);
    const event = await audit('UPDATE', { grade: 'G1' }, { grade: 'G2' });
    await expectSqlError(db.query(`update audit_event set reason = 'x' where id = $1`, [event]), CHECK_VIOLATION);
    await expectSqlError(db.query('delete from audit_event where id = $1', [event]), CHECK_VIOLATION);
  });

  it('refuses to commit an import job whose counts do not reconcile', async () => {
    const job = await f.id(
      `insert into import_job (company_id, kind, state, attachment_id, submitted_by, idempotency_key)
       values ($1, 'employee_create', 'PREVIEWED', $2, $3, $4)`,
      [a.company, await attachment(null), user, uniq('import-key-')],
    );
    await db.query(
      `insert into import_row (company_id, job_id, row_number, state, business_key) values ($1, $2, 1, 'ACCEPTED', 'E1')`,
      [a.company, job],
    );
    await db.query(
      `insert into import_row (company_id, job_id, row_number, state, error_code, business_key)
       values ($1, $2, 2, 'REJECTED', 'UNKNOWN_DEPARTMENT', 'E2')`,
      [a.company, job],
    );
    await expectSqlError(
      db.query(`update import_job set state = 'COMMITTED', accepted_count = 2, rejected_count = 0 where id = $1`, [job]),
      CHECK_VIOLATION,
    );
    await expect(
      db.query(`update import_job set state = 'COMMITTED', accepted_count = 1, rejected_count = 1 where id = $1`, [job]),
    ).resolves.toBeDefined();
  });

  it('deduplicates an import replay by idempotency key', async () => {
    const att = await attachment(null);
    const key = uniq('import-key-');
    const job = () =>
      db.query(
        `insert into import_job (company_id, kind, state, attachment_id, submitted_by, idempotency_key)
         values ($1, 'employee_create', 'UPLOADED', $2, $3, $4)`,
        [a.company, att, user, key],
      );
    await job();
    await expectSqlError(job(), UNIQUE_VIOLATION);
  });
});
