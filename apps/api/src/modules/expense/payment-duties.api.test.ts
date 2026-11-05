// The payment duties C3 and C5 name (0131): batch DRAFT then READY, a separate confirm_outcome action, an explicitly assigned
// outcome actor, and a separate payment export right. I-49's exclusions hold for all of them. Synthetic INR amounts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { revokedAfterGuard } from '../../test/after-guard.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { releaseNaming } from './payment.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let approver: TestActor;
let preparer: TestActor;
let releaser: TestActor;
let confirmer: TestActor;
let manager: TestActor;
let employee: TestActor;

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PREPARE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];
const RELEASE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.release.operational'];
const CONFIRM: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.confirm_outcome.operational'];

const today = () => new Date().toISOString().slice(0, 10);
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const act = (a: TestActor, pi: string, path: string, body?: object) => h.call(a, 'POST', `/v1/expense/payments/${pi}/${path}`, body);
const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('duty-key-'), ...body });

async function approvedClaim(amount = '100') {
  const uploaded = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic duty receipt ${uniq('d')}\n%%EOF\n`).toString('base64') });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const created = await h.call(employee, 'POST', '/v1/expense/claims', {
    purpose: 'Payment duties (synthetic)',
    currency: 'INR',
    lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today(), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Duty check (synthetic)', receipt: { receiptId: uploaded.json().receiptId } }],
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().claimId as string;
  expect((await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version })).statusCode).toBe(200);
  expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
  const lines = (await view(approver, id)).lines as { id: string; claimedAmount: string }[];
  const res = await decide(approver, await taskOf(approver, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
  expect(res.json().state).toBe('APPROVED');
  return id;
}
const prepare = async (claimId: string, amount = '100', a: TestActor = preparer) => {
  const res = await h.call(a, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate: today(), idempotencyKey: uniq('duty-pay-') });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { instructionId: string; state: string; batchState: string };
};
const readied = async (claimId: string) => {
  const { instructionId } = await prepare(claimId);
  expect((await act(preparer, instructionId, 'ready')).statusCode).toBe(200);
  return instructionId;
};
const released = async (claimId: string, outcomeActor: TestActor = confirmer) => {
  const pi = await readied(claimId);
  expect((await releaseNaming(h, releaser, pi, outcomeActor)).statusCode).toBe(200);
  return pi;
};
const batchOf = (pi: string) =>
  h.one<{ id: string; transaction_id: string; state: string; ready_by: string | null; ready_at: Date | null; transaction_state: string }>(
    `select b.id, b.transaction_id, b.state, b.ready_by, b.ready_at, bt.state as transaction_state
       from payment_instruction i join payment_batch b on b.company_id = i.company_id and b.id = i.batch_id
       join business_transaction bt on bt.company_id = b.company_id and bt.id = b.transaction_id where i.id = $1`,
    [pi],
  );
const instructionOf = (pi: string) => h.one<{ state: string; outcome_actor_id: string | null; outcome_assigned_by: string | null }>(`select state, outcome_actor_id, outcome_assigned_by from payment_instruction where id = $1`, [pi]);
const auditActions = async (pi: string) => (await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'payment_instruction' and record_key = $2 order by occurred_at`, [A.id, pi])).rows.map((r) => r.action);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
  preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
  releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: RELEASE });
  confirmer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, approver.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  const employeeId = await person();
  await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('payment batch DRAFT then READY (C5)', () => {
  it('a preparation reserves the amount in a DRAFT batch; only READY is released; the catalogue holds the step', async () => {
    const id = await approvedClaim();
    const prepared = await prepare(id);
    expect(prepared).toMatchObject({ state: 'PREPARED', batchState: 'DRAFT' });
    expect(await batchOf(prepared.instructionId)).toMatchObject({ state: 'DRAFT', transaction_state: 'DRAFT', ready_by: null, ready_at: null });
    expect((await view(employee, id)).payment.pending).toBe('100.0000');

    const refused = await releaseNaming(h, releaser, prepared.instructionId, confirmer);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('BATCH_NOT_READY');
    expect((await instructionOf(prepared.instructionId)).state).toBe('PREPARED');

    const ready = await act(preparer, prepared.instructionId, 'ready');
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json()).toMatchObject({ state: 'PREPARED', batchState: 'READY' });
    const batch = await batchOf(prepared.instructionId);
    expect(batch).toMatchObject({ state: 'READY', transaction_state: 'READY', ready_by: preparer.user });
    expect(batch.ready_at).not.toBeNull();
    expect((await act(preparer, prepared.instructionId, 'ready')).json().error).toBe('INVALID_STATE');
    expect((await releaseNaming(h, releaser, prepared.instructionId, confirmer)).statusCode).toBe(200);
    expect(await batchOf(prepared.instructionId)).toMatchObject({ state: 'RELEASED', ready_by: preparer.user });
    expect(await auditActions(prepared.instructionId)).toEqual(['PREPARE', 'READY', 'RELEASE']);
  });

  it('only the person who prepared it marks it ready, under the prepare duty', async () => {
    const id = await approvedClaim();
    const { instructionId } = await prepare(id);
    const otherPreparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    const other = await act(otherPreparer, instructionId, 'ready');
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('NOT_THE_PREPARER');
    expect((await act(releaser, instructionId, 'ready')).statusCode).toBe(403); // no prepare duty
    expect((await batchOf(instructionId)).state).toBe('DRAFT');
  });

  it('a draft is not counted or listed as waiting for release', async () => {
    const id = await approvedClaim();
    const { instructionId } = await prepare(id);
    const listed = async () => ((await h.call(releaser, 'GET', '/v1/expense/payments?state=PREPARED&releasableByMe=true')).json().items as { id: string }[]).map((i) => i.id);
    expect(await listed()).not.toContain(instructionId);
    await act(preparer, instructionId, 'ready');
    expect(await listed()).toContain(instructionId);
  });

  it('the database starts a batch DRAFT, keeps it from skipping READY, and lets only the preparer mark it', async () => {
    const id = await approvedClaim();
    const { instructionId } = await prepare(id);
    const { id: batch, transaction_id: transaction } = await batchOf(instructionId);
    // The batch and its transaction move together here, so only the batch's own guard stands in the way.
    const mark = (by: string, at: string) =>
      withTransaction(h.pool, async (tx) => {
        await tx.query(`update business_transaction set state = 'READY' where id = $1`, [transaction]);
        await tx.query(`update payment_batch set state = 'READY', ready_by = $2, ready_at = ${at} where id = $1`, [batch, by]);
      });
    /** A whole batch root written past the service, as the catalogue and the batch's checks judge it. */
    const newBatch = (state: string, extra: { column: string; value: string } | null = null) =>
      withTransaction(h.pool, async (tx) => {
        const bt = (await tx.query<{ id: string }>(`insert into business_transaction (company_id, kind, state) values ($1, 'payment_batch', $2) returning id`, [A.id, state])).rows[0]!.id;
        await tx.query(`insert into payment_batch (company_id, transaction_id, state, prepared_by, currency_code${extra ? `, ${extra.column}` : ''}) values ($1, $2, $3, $4, 'INR'${extra ? ', $5' : ''})`, [
          A.id,
          bt,
          state,
          preparer.user,
          ...(extra ? [extra.value] : []),
        ]);
      });
    await expectSqlError(h.db.query(`update payment_batch set state = 'RELEASED' where id = $1`, [batch]), CHECK_VIOLATION);
    await expectSqlError(mark(releaser.user, 'now()'), CHECK_VIOLATION);
    await expectSqlError(mark(preparer.user, `now() - interval '1 hour'`), CHECK_VIOLATION);
    // READY is no longer an initial state of the catalogue, and a draft has not been marked.
    await expectSqlError(newBatch('READY'), CHECK_VIOLATION);
    await expectSqlError(newBatch('DRAFT', { column: 'ready_by', value: preparer.user }), CHECK_VIOLATION);
    // The instruction cannot be released while its batch is a draft, even naming an independent actor.
    await expectSqlError(
      h.db.query(`update payment_instruction set state = 'RELEASED', released_by = $2, outcome_actor_id = $2, outcome_assigned_by = $2, outcome_assigned_at = now() where id = $1`, [instructionId, releaser.user]),
      CHECK_VIOLATION,
    );

    await mark(preparer.user, 'now()');
    // Who marked it stays as it was, and nothing more goes into a batch that is ready.
    await expectSqlError(h.db.query(`update payment_batch set ready_by = $2 where id = $1`, [batch, releaser.user]), CHECK_VIOLATION);
    const other = await h.one<{ id: string; employee_id: string }>(`select id, employee_id from expense_obligation where claim_id = $1`, [await approvedClaim()]);
    await expectSqlError(
      withTransaction(h.pool, async (tx) => {
        const late = (
          await tx.query<{ id: string }>(
            `insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date) values ($1, $2, $3, 10, 'INR', 'PREPARED', $4, current_date) returning id`,
            [A.id, batch, other.employee_id, uniq('direct-key-')],
          )
        ).rows[0]!.id;
        await tx.query(`insert into payment_allocation (company_id, instruction_id, obligation_id, employee_id, currency_code, amount) values ($1, $2, $3, $4, 'INR', 10)`, [A.id, late, other.id, other.employee_id]);
      }),
      CHECK_VIOLATION,
    );
  });
});

describe('confirm_outcome is its own action, with an explicitly assigned actor (C3; C5 "authorised outcome actor"; DF07)', () => {
  it('is a ceiling only: no baseline role holds it as a default duty, and only the role with the release ceiling may hold it', () => {
    for (const key of ['payment.confirm_outcome.operational', 'payment.export.operational'] as const) {
      expect(BASELINE_ROLES.filter((r) => r.ceiling.includes(key)).map((r) => r.code)).toEqual(BASELINE_ROLES.filter((r) => r.ceiling.includes('payment.release.operational')).map((r) => r.code));
      expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(key))).toEqual([]);
    }
  });

  it('the release duty alone no longer records an outcome; the named holder does', async () => {
    const pi = await released(await approvedClaim());
    const withoutDuty = await act(releaser, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') });
    expect(withoutDuty.statusCode).toBe(403);
    expect((await instructionOf(pi)).state).toBe('RELEASED');
    const done = await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().state).toBe('CONFIRMED');
    expect(await instructionOf(pi)).toMatchObject({ state: 'CONFIRMED', outcome_actor_id: confirmer.user, outcome_assigned_by: releaser.user });
  });

  it('holding the duty is not enough: anyone but the named actor is refused, on a replay too', async () => {
    const id = await approvedClaim();
    const pi = await released(id);
    const another = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
    const evidenceKey = uniq('bank-ref-');
    const refused = await act(another, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('OUTCOME_ACTOR_NOT_ASSIGNED');
    expect((await view(employee, id)).payment.netPaid).toBe('0.0000');
    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey })).statusCode).toBe(200);
    expect((await act(another, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey })).json().error).toBe('OUTCOME_ACTOR_NOT_ASSIGNED');
    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey })).json().replayed).toBe(true);
  });

  it('the release names someone: no name is refused, and so is anyone without the duty, the row scope or independence', async () => {
    const id = await approvedClaim();
    const pi = await readied(id);
    expect((await act(releaser, pi, 'release')).statusCode).toBe(400);
    const notEligible = async (a: TestActor | string) => {
      const res = await act(releaser, pi, 'release', { outcomeActorUserId: typeof a === 'string' ? a : a.user });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toBe('OUTCOME_ACTOR_NOT_ELIGIBLE');
    };
    await notEligible(hr); // no confirmation duty
    await notEligible(releaser); // the releaser holds only the release duty
    await notEligible(await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM, departmentFilter: A.financeDept })); // out of row scope
    // The duty in one assignment and the scope in another do not combine (C1).
    const split = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM, departmentFilter: A.financeDept });
    await h.actor(A, 'HR_ADMINISTRATOR', { user: split.user });
    await notEligible(split);
    // I-49: the preparer, the claim's deciders and the claimant are never named, even holding the duty.
    const preparerToo = await h.actor(A, 'HR_ADMINISTRATOR', { user: preparer.user, extra: CONFIRM });
    const approverToo = await h.actor(A, 'HR_ADMINISTRATOR', { user: approver.user, extra: CONFIRM });
    const managerToo = await h.actor(A, 'HR_ADMINISTRATOR', { user: manager.user, extra: CONFIRM });
    const claimantToo = await h.actor(A, 'HR_ADMINISTRATOR', { user: employee.user, extra: CONFIRM });
    for (const a of [preparerToo, approverToo, managerToo, claimantToo]) await notEligible(a);
    await notEligible('00000000-0000-4000-8000-000000000000');
    expect((await instructionOf(pi)).state).toBe('PREPARED');
    const eligible = (await h.call(releaser, 'GET', `/v1/expense/payments/${pi}/outcome-actors`)).json().items as { userId: string; accountKey: string }[];
    expect(eligible.map((u) => u.userId)).toContain(confirmer.user);
    for (const a of [hr, releaser, split, preparerToo, approverToo, managerToo, claimantToo]) expect(eligible.map((u) => u.userId)).not.toContain(a.user);
    expect(eligible.every((u) => typeof u.accountKey === 'string')).toBe(true);
    expect((await h.call(preparer, 'GET', `/v1/expense/payments/${pi}/outcome-actors`)).statusCode).toBe(403);
  });

  it('DF07: the releaser may be the outcome actor when independent and holding both duties', async () => {
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...RELEASE, 'payment.confirm_outcome.operational'] });
    const pi = await readied(await approvedClaim());
    expect((await releaseNaming(h, both, pi)).json()).toMatchObject({ state: 'RELEASED', outcomeActorUserId: both.user });
    expect((await act(both, pi, 'outcome', { outcome: 'FAILED', evidenceKey: uniq('bank-ref-') })).json().state).toBe('FAILED');
  });

  it('a named actor who later lost the grant is refused inside the transaction', async () => {
    const leaving = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
    const pi = await released(await approvedClaim(), leaving);
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = 'payment' and action = 'confirm_outcome')`,
      [A.id, leaving.assignment],
    );
    expect((await act(leaving, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(403);
    expect((await instructionOf(pi)).state).toBe('RELEASED');
  });

  it('the outcome can be reassigned while it is awaited, with a reason, by an independent release holder; the audit keeps who it was', async () => {
    const id = await approvedClaim();
    const pi = await released(id);
    const next = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
    const body = { outcomeActorUserId: next.user, reason: 'The first actor left (synthetic)' };
    expect((await act(confirmer, pi, 'outcome-actor', body)).statusCode).toBe(403); // no release duty
    expect((await act(releaser, pi, 'outcome-actor', { outcomeActorUserId: next.user })).statusCode).toBe(400); // no reason
    expect((await act(releaser, pi, 'outcome-actor', { ...body, outcomeActorUserId: hr.user })).json().error).toBe('OUTCOME_ACTOR_NOT_ELIGIBLE');
    expect((await act(releaser, pi, 'outcome-actor', { ...body, outcomeActorUserId: confirmer.user })).json().error).toBe('NO_CHANGE');
    const preparerReleases = await h.actor(A, 'HR_ADMINISTRATOR', { user: preparer.user, extra: RELEASE });
    expect((await act(preparerReleases, pi, 'outcome-actor', body)).json().error).toBe('SEGREGATION_OF_DUTIES');

    const moved = await act(releaser, pi, 'outcome-actor', body);
    expect(moved.statusCode, moved.body).toBe(200);
    const audit = await h.one<{ before_values: { operational: { outcomeActorUserId: string } }; after_values: { operational: { outcomeActorUserId: string } }; reason: string }>(
      `select before_values, after_values, reason from audit_event where company_id = $1 and record_key = $2 and action = 'ASSIGN_OUTCOME_ACTOR'`,
      [A.id, pi],
    );
    expect(audit).toMatchObject({ before_values: { operational: { outcomeActorUserId: confirmer.user } }, after_values: { operational: { outcomeActorUserId: next.user } }, reason: body.reason });
    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).json().error).toBe('OUTCOME_ACTOR_NOT_ASSIGNED');
    expect((await act(next, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
    expect((await act(releaser, pi, 'outcome-actor', { ...body, outcomeActorUserId: confirmer.user })).json().error).toBe('INVALID_STATE');
  });

  it('an instruction released before this rule names nobody: nobody records its outcome until someone is assigned', async () => {
    const pi = await released(await approvedClaim());
    await h.db.query(`alter table payment_instruction disable trigger payment_instruction_guard`);
    await h.db.query(`update payment_instruction set outcome_actor_id = null, outcome_assigned_by = null, outcome_assigned_at = null where id = $1`, [pi]);
    await h.db.query(`alter table payment_instruction enable trigger payment_instruction_guard`);
    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).json().error).toBe('OUTCOME_ACTOR_NOT_ASSIGNED');
    expect((await act(releaser, pi, 'outcome-actor', { outcomeActorUserId: confirmer.user, reason: 'Released before the rule (synthetic)' })).statusCode).toBe(200);
    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
  });

  it('the database holds the assignment too: outcome only by the named actor, names never change after the outcome, nobody excluded is named', async () => {
    const pi = await released(await approvedClaim());
    // The whole outcome at once (event, instruction state and the claim's derived state), so only the named-actor rule stands in the way.
    const settle = (by: string) =>
      withTransaction(h.pool, async (tx) => {
        await tx.query(`insert into payment_event (company_id, instruction_id, event_key, event_kind, amount, recorded_by) values ($1, $2, $3, 'CONFIRMED', 100, $4)`, [A.id, pi, uniq('direct-event-'), by]);
        await tx.query(`update payment_instruction set state = 'CONFIRMED' where id = $1`, [pi]);
        await tx.query(
          `update expense_claim c set payment_state = hrms_expense_claim_payment_state(c.company_id, c.id)
             from payment_allocation a join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id
            where a.instruction_id = $1 and c.company_id = o.company_id and c.id = o.claim_id`,
          [pi],
        );
      });
    const stranger = await h.actor(A, 'HR_ADMINISTRATOR');
    await expectSqlError(settle(stranger.user), CHECK_VIOLATION);
    const name = (user: string, by = releaser.user) =>
      h.db.query(`update payment_instruction set outcome_actor_id = $2, outcome_assigned_by = $3, outcome_assigned_at = now() where id = $1`, [pi, user, by]);
    for (const excluded of [preparer.user, approver.user, manager.user, employee.user]) await expectSqlError(name(excluded), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update payment_instruction set outcome_actor_id = $2, outcome_assigned_by = $3, outcome_assigned_at = now() - interval '1 hour' where id = $1`, [pi, stranger.user, releaser.user]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update payment_instruction set outcome_actor_id = null where id = $1`, [pi]), CHECK_VIOLATION);

    expect((await act(confirmer, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
    await expectSqlError(name(stranger.user), CHECK_VIOLATION);
    const unreleased = await readied(await approvedClaim());
    await expectSqlError(h.db.query(`update payment_instruction set outcome_actor_id = $2, outcome_assigned_by = $2, outcome_assigned_at = now() where id = $1`, [unreleased, stranger.user]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update payment_instruction set state = 'RELEASED', released_by = $2 where id = $1`, [unreleased, releaser.user]), CHECK_VIOLATION); // a release names someone
  });

  it('the claim’s payments show the batch state and who the outcome is assigned to', async () => {
    const id = await approvedClaim();
    const first = await prepare(id, '40');
    const listed = async () => (await h.call(preparer, 'GET', `/v1/expense/claims/${id}/payments`)).json().items as Record<string, unknown>[];
    expect(await listed()).toMatchObject([{ id: first.instructionId, batchState: 'DRAFT', outcomeActorUserId: null, outcomeActorAccountKey: null }]);
    await act(preparer, first.instructionId, 'ready');
    await releaseNaming(h, releaser, first.instructionId, confirmer);
    const [row] = await listed();
    expect(row).toMatchObject({ batchState: 'RELEASED', outcomeActorUserId: confirmer.user });
    expect(typeof row!.outcomeActorAccountKey).toBe('string');
  });
});

describe('each new step re-checks authority inside its transaction (docs/09 §6.5)', () => {
  it('marking ready: a preparer revoked after the route guard changes nothing', async () => {
    const leaving = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    const { instructionId } = await prepare(await approvedClaim(), '100', leaving);
    const res = await revokedAfterGuard(h, A, leaving, () => act(leaving, instructionId, 'ready'));
    expect(res.statusCode, res.body).toBe(403);
    expect((await batchOf(instructionId)).state).toBe('DRAFT');
  });

  it('recording the outcome: the named actor revoked after the route guard records nothing', async () => {
    const leaving = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
    const pi = await released(await approvedClaim(), leaving);
    // Only the confirmation duty goes: holding the others does not stand in for it.
    const res = await revokedAfterGuard(h, A, leaving, () => act(leaving, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') }), { resource: 'payment', action: 'confirm_outcome' });
    expect(res.statusCode, res.body).toBe(403);
    expect((await instructionOf(pi)).state).toBe('RELEASED');
  });

  it('reassigning the outcome: a release holder revoked after the route guard moves nothing', async () => {
    const leaving = await h.actor(A, 'HR_ADMINISTRATOR', { extra: RELEASE });
    const pi = await released(await approvedClaim());
    const next = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIRM });
    const res = await revokedAfterGuard(h, A, leaving, () => act(leaving, pi, 'outcome-actor', { outcomeActorUserId: next.user, reason: 'Synthetic' }));
    expect(res.statusCode, res.body).toBe(403);
    expect((await instructionOf(pi)).outcome_actor_id).toBe(confirmer.user);
  });
});

describe('payment outputs have their own export right (C3 Payment "export")', () => {
  it('the payable ageing and reconciliation need payment.export; expense.export alone does not open them', async () => {
    const expenseOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.export.operational', 'payment.read.operational'] });
    const paymentOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payment.export.operational', 'payment.read.operational'] });
    const request = (a: TestActor, reportCode: string, filters: object = {}) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });
    const period = { from: today(), to: today() };
    expect((await request(expenseOnly, 'EXPENSE_PAYABLE_AGEING')).statusCode).toBe(403);
    expect((await request(expenseOnly, 'EXPENSE_PAYMENT_RECONCILIATION', period)).statusCode).toBe(403);
    expect((await request(paymentOnly, 'EXPENSE_PAYABLE_AGEING')).statusCode).toBe(202);
    expect((await request(paymentOnly, 'EXPENSE_PAYMENT_RECONCILIATION', period)).statusCode).toBe(202);
    expect((await request(paymentOnly, 'EXPENSE_REGISTER', period)).statusCode).toBe(403);
  });
});
