// Delegation history and independence (docs/03 I-57 item 7; C4 "Preserve delegator, delegate and actual actor in history"; RBAC
// instruction line 95; FR-003; FR-068; DF02; DF03; DF07; H2; H4; BR-050). A decision a delegate takes under a delegation is taken in
// the delegator's name: decision histories name the delegator beside the delegate who acted, and payroll and expense independence
// checks treat the decision as the delegator's too (0256). Synthetic people, amounts and documents only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { decisionHistory } from '../hiring/common.js';
import { decisionTrail } from '../lifecycle/common.js';
import {
  APPROVE,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  CRITERIA,
  createRun,
  criterion,
  DOCUMENTS,
  evidenceDocument,
  getRun,
  grants,
  head,
  HOLD_DECIDE,
  HOLD_PROPOSE,
  HOLD_RELEASE,
  key,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  taskOf,
  today,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { leaveTasks } from './leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let admin: TestActor;

const DELEGATE: PermissionKey = 'access.delegate.operational';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A delegation through its routes: requested by the delegator, approved by an independent System Administrator. */
async function delegate(from: TestActor, to: TestActor, permission: string) {
  const asked = await h.call(from, 'POST', '/v1/access/delegations', { delegateUserId: to.user, permission, effectiveFrom: iso(-60_000), effectiveTo: iso(5 * 86_400_000) });
  expect(asked.statusCode, asked.body).toBe(201);
  const id = asked.json().id as string;
  const approved = await h.call(admin, 'POST', `/v1/access/delegations/${id}/approve`, { expectedVersion: 1 });
  expect(approved.statusCode, approved.body).toBe(200);
  return id;
}
const taskRow = (taskId: string) => h.one<{ assignee_user_id: string; delegation_id: string | null }>(`select assignee_user_id, delegation_id from approval_task where id = $1`, [taskId]);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('decision histories name the person a delegate decided for (I-57 item 7)', () => {
  it('FR-003, FR-068: a delegated decision shows the delegate as the decider and the delegator it was taken for; an own decision shows nobody else', async () => {
    const world = leaveTasks(h, A, hr);
    await world.activatePolicies();
    const mEmp = await world.employee();
    const dEmp = await world.employee();
    const m = await h.actor(A, 'REPORTING_MANAGER', { employeeId: mEmp, extra: [DELEGATE] });
    const d = await h.actor(A, 'REPORTING_MANAGER', { employeeId: dEmp, scope: 'ASSIGNED' });
    const x = await world.employee(mEmp);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
    const decideLeave = async (a: TestActor) => {
      const task = ((await h.call(a, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === x)!;
      const res = await h.call(a, 'POST', `/v1/leave/tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('history-') });
      expect(res.statusCode, res.body).toBe(200);
      return task.taskId;
    };
    const transactionOf = async (taskId: string) =>
      (await h.one<{ id: string }>(`select i.transaction_id as id from approval_task t join approval_instance i on i.id = t.instance_id where t.id = $1`, [taskId])).id;

    // Decided by the manager in their own right: nobody else is named.
    await world.submitLeave(self);
    const own = await transactionOf(await decideLeave(m));
    expect((await decisionHistory(h.pool, A.id, own)).map((x) => [x.decidedBy.userId, x.onBehalfOf])).toEqual([[m.user, null]]);
    expect((await decisionTrail(h.pool, A.id, [own], { actors: true })).map((x) => [x.actorUserId, x.onBehalfOfUserId])).toEqual([[m.user, null]]);

    // Decided by the delegate under a live delegation: the delegator is named beside them.
    await delegate(m, d, 'leave.approve.operational');
    await world.submitLeave(self);
    const taskId = await decideLeave(d);
    expect((await taskRow(taskId)).delegation_id).not.toBeNull();
    const delegated = await transactionOf(taskId);
    const [entry] = await decisionHistory(h.pool, A.id, delegated);
    const code = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;
    expect(entry).toMatchObject({ decision: 'APPROVE', decidedBy: { userId: d.user, employeeCode: await code(dEmp) }, onBehalfOf: { userId: m.user, employeeCode: await code(mEmp) } });
    expect((await decisionTrail(h.pool, A.id, [delegated], { actors: true })).map((x) => [x.actorUserId, x.onBehalfOfUserId])).toEqual([[d.user, m.user]]);
    // Without actors the trail names nobody.
    expect(await decisionTrail(h.pool, A.id, [delegated])).toEqual([expect.not.objectContaining({ onBehalfOfUserId: expect.anything() })]);
  });
});

describe.runIf(isModuleActive('payroll'))('payroll independence includes the delegator of a run decision (I-57 item 7, C4, H4)', () => {
  it('FR-030, BR-050: a delegated review is the delegator’s too: they neither approve the run, decide its holds, nor release them', async () => {
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    // X reviews and approves runs and decides and releases holds; D reviews runs for X while X is away.
    const x = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(REVIEW, APPROVE, HOLD_DECIDE, HOLD_RELEASE, [DELEGATE]) });
    const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    const y = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    const maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_PROPOSE });
    const decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_DECIDE });
    const releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    const uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    const verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_run', [x]);
    // X first on the approval list: without I-57 item 7 the approval would come back to X.
    await reviewers(h, hr, 'payroll_run_approval', [x, y]);
    await reviewers(h, hr, 'payroll_hold', [x, decider]);
    await head(h, configA, configB, { code: 'DI_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    const periods = (await calendar(h, configA, configB, months(2026))).periods;
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'DI_DEPT', 'DI_DEPT', true) returning id`, [A.id])).id;
    const paid = async (amount: string) => {
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'DI_BASIC', amount }] });
      return e;
    };
    const held = await paid('30000');
    const blocked = await paid('25000');
    await bankRevision(h, A, held);

    await delegate(x, d, 'payroll_run.review.amount');
    const run = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: (await getRun(h, preparer, run.id)).version }));
    // The review goes to D under the delegation; D reviews it in X's name.
    const reviewTask = await taskOf(h, d, run.id, 'REVIEW');
    expect(await taskRow(reviewTask)).toMatchObject({ assignee_user_id: d.user, delegation_id: expect.any(String) });
    await ok(await h.call(d, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    // The approval skips X, whose review it already was, and goes to the next on the list.
    const approvalTask = await taskOf(h, y, run.id, 'APPROVAL');
    expect((await taskRow(approvalTask)).assignee_user_id).toBe(y.user);
    // Even an approval task with X (as one routed before this rule could be) is refused at the decision.
    const reassign = async (to: string) => {
      await h.db.query(`alter table approval_task disable trigger approval_task_guard`);
      try {
        await h.db.query(`update approval_task set assignee_user_id = $2 where id = $1`, [approvalTask, to]);
      } finally {
        await h.db.query(`alter table approval_task enable trigger approval_task_guard`);
      }
    };
    await reassign(x.user);
    expect((await h.call(x, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('NOT_INDEPENDENT');
    await reassign(y.user);
    expect(await ok(await h.call(y, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() }))).toMatchObject({ state: 'APPROVED' });
    await processRun(h, processor, run.id);

    // X never releases a hold of this run: the safety block of the employee without a bank instruction.
    const holdsOn = async (employeeId: string) =>
      (await h.db.query<{ id: string; hold_kind: string; version: number }>(`select id, hold_kind, version from payroll_hold where payroll_record_id = $1 order by created_at`, [(await record(h, processor, run.id, employeeId)).id])).rows;
    const block = (await holdsOn(blocked))[0]!;
    const release = (a: TestActor, holdId: string, version: number) => h.call(a, 'POST', `/v1/payroll/holds/${holdId}/release`, { reason: 'Synthetic release', evidenceReference: 'SYNTH-DI-1', expectedVersion: version });
    expect((await release(x, block.id, block.version)).json().error).toBe('NOT_INDEPENDENT');
    // Someone independent gets as far as the bank check.
    expect((await release(releaser, block.id, block.version)).json().error).toBe('BANK_NOT_VERIFIED');

    // A policy hold on the run's record goes to a decider other than X, and the database refuses X as its decider too.
    const firstBlock = (await holdsOn(held))[0]!;
    await ok(await release(releaser, firstBlock.id, firstBlock.version));
    const crit = await criterion(h, configA, configB);
    const doc = await evidenceDocument(h, uploader, verifier, held);
    const start = await today(h, A);
    const proposal = await ok<{ id: string }>(
      await h.call(maker, 'POST', `/v1/payroll/records/${(await record(h, processor, run.id, held)).id}/holds`, {
        criterionId: crit,
        scope: 'PARTIAL',
        amount: '500.00',
        reason: 'Synthetic contractual hold',
        effectiveDate: start,
        reviewDueOn: start,
        releaseCriterion: 'Synthetic release condition',
        evidenceReference: 'SYNTH-DI-2',
        evidenceDocumentIds: [doc],
      }),
      201,
    );
    const holdTask = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/payroll/holds/tasks/mine')).json().items as { taskId: string; hold: { id: string } | null }[]).find((t) => t.hold?.id === proposal.id);
    expect(await holdTask(x)).toBeUndefined();
    expect(await holdTask(decider)).toBeDefined();
    await expect(
      h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE', approved_by = $2, approved_at = now(), unresolved_since = null where id = $1`, [proposal.id, x.user]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('delegated decisions included') });
  });
});

describe('expense payments are independent of the delegator of a claim decision (I-57 item 7, DF07, C4)', () => {
  it('FR-077, DF07: the person a delegate approved a claim for neither prepares nor releases its payment', async () => {
    const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
    const PAY: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational', 'payment.release.operational'];
    const x = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DECIDE, ...PAY, DELEGATE] });
    const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'] });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, x.user]);
    const newPerson = async () => {
      const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      return e.id as string;
    };
    const managerEmp = await newPerson();
    const employeeId = await newPerson();
    await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId });
    const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
    if (policy.state === 'DRAFT') expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
    await delegate(x, d, 'expense.finance_decide.operational');

    const day = new Date().toISOString().slice(0, 10);
    const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
    const taskFor = async (a: TestActor, claimId: string) => {
      const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
      return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
    };
    const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('di-key-'), ...body });
    const uploaded = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ${uniq('di')}\n%%EOF\n`).toString('base64') });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const created = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Delegated independence (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: day, merchant: 'Synthetic Merchant', grossAmount: '100', claimedAmount: '100', description: 'Synthetic', receipt: { receiptId: uploaded.json().receiptId } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const claimId = created.json().claimId as string;
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: (await view(employee, claimId)).version })).statusCode).toBe(200);
    expect((await decide(manager, await taskFor(manager, claimId), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    // The finance step is X's, routed to D under the delegation: D approves the amounts in X's name.
    const financeTask = await taskFor(d, claimId);
    expect(await taskRow(financeTask)).toMatchObject({ assignee_user_id: d.user, delegation_id: expect.any(String) });
    const lines = (await view(d, claimId)).lines as { id: string; claimedAmount: string }[];
    expect((await decide(d, financeTask, { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) })).json().state).toBe('APPROVED');

    // X did not act, but the approval was taken in X's name: X neither prepares nor releases the payment (database rule too).
    const pay = (a: TestActor) => h.call(a, 'POST', '/v1/expense/payments', { claimId, amount: '100', paymentDate: day, idempotencyKey: uniq('di-pay-') });
    expect((await pay(x)).json().error).toBe('SEGREGATION_OF_DUTIES');
    const obligation = (await h.one<{ id: string }>(`select id from expense_obligation where claim_id = $1`, [claimId])).id;
    expect((await h.one<{ c: boolean }>(`select hrms_payment_preparer_conflict($1, $2, $3) as c`, [A.id, obligation, x.user])).c).toBe(true);
    expect((await h.one<{ c: boolean }>(`select hrms_payment_preparer_conflict($1, $2, $3) as c`, [A.id, obligation, preparer.user])).c).toBe(false);
    const prepared = await pay(preparer);
    expect(prepared.statusCode, prepared.body).toBe(201);
    const instructionId = prepared.json().instructionId as string;
    expect((await h.call(preparer, 'POST', `/v1/expense/payments/${instructionId}/ready`)).statusCode).toBe(200);
    expect((await h.call(x, 'POST', `/v1/expense/payments/${instructionId}/release`, { outcomeActorUserId: x.user })).json().error).toBe('SEGREGATION_OF_DUTIES');
    expect((await h.one<{ c: boolean }>(`select hrms_payment_release_conflict($1, $2, $3) as c`, [A.id, instructionId, x.user])).c).toBe(true);
    // Nor may X be named to record its outcome: the release rule lists nobody conflicted.
    const actors = await h.call(x, 'GET', `/v1/expense/payments/${instructionId}/outcome-actors`);
    expect(actors.statusCode, actors.body).toBe(200);
    expect((actors.json().items as { userId: string }[]).map((a) => a.userId)).not.toContain(x.user);
  });
});
