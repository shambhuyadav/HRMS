// Confirmation exceptions (DF11 employee override and extension-limit exception; C4). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { decideException, proposeException, withdrawException } from './exceptions.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let hrReasons: TestActor;
let manager: TestActor;
let managerEmp: string;

async function probationer(): Promise<string> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: '2026-01-31' }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  return e.id;
}
const openCase = async (employeeId: string) => (await h.call(hr, 'POST', '/v1/confirmations', { employeeId })).json().caseId as string;
const getCase = async (id: string) => (await h.call(hr, 'GET', `/v1/confirmations/${id}`)).json();
const propose = (a: TestActor, caseId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/confirmations/${caseId}/exceptions`, { reason: 'Synthetic justification', ...body });
const decide = (a: TestActor, id: string, decision: string) => h.call(a, 'POST', `/v1/confirmation-exceptions/${id}/decision`, { decision, reason: 'Synthetic decision' });
const extend = async (caseId: string) => {
  const c = await getCase(caseId);
  const rec = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: c.version, recommendation: 'EXTEND', extensionMonths: 1, reason: 'Synthetic extension' });
  if (rec.statusCode !== 200) return rec;
  const task = ((await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === c.employeeId)!;
  return h.call(hr, 'POST', `/v1/confirmations/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: uniq('conf-x-') });
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  hrReasons = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['confirmation.read.reason'] });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [A.id, hr.user]);
  const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('employee due-date override (DF11 highest priority)', () => {
  it('needs an independent decision, then becomes the case due date with history', async () => {
    const caseId = await openCase(await probationer());
    expect((await getCase(caseId)).dueDate).toBe('2026-04-30');
    const p = await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-06-30' });
    expect(p.statusCode).toBe(201);
    const id = p.json().exceptionId as string;
    // Proposing does nothing yet; a second open proposal of the same kind is refused.
    expect((await getCase(caseId)).dueDate).toBe('2026-04-30');
    expect((await propose(hr2, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-07-31' })).json().error).toBe('OPEN_PROPOSAL_EXISTS');
    // The proposer cannot approve it; another eligible HR user can.
    expect((await decide(hr, id, 'APPROVE')).json().error).toBe('INDEPENDENT_APPROVER_REQUIRED');
    const pending = (await h.call(hr, 'GET', '/v1/confirmation-exceptions/pending')).json().items as { id: string; ownProposal: boolean; reason?: string }[];
    expect(pending.find((x) => x.id === id)).toMatchObject({ ownProposal: true });
    expect(pending.find((x) => x.id === id)!.reason).toBeUndefined();
    const approved = await decide(hr2, id, 'APPROVE');
    expect(approved.json()).toMatchObject({ state: 'APPROVED', applied: { dueDate: { from: '2026-04-30', to: '2026-06-30' } } });
    expect((await getCase(caseId)).dueDate).toBe('2026-06-30');
    expect((await decide(hr2, id, 'APPROVE')).statusCode).toBe(409);
    // The private justification shows only with the confirmation reason grant.
    expect(((await h.call(hr, 'GET', `/v1/confirmations/${caseId}/exceptions`)).json().items[0] as Record<string, unknown>).reason).toBeUndefined();
    expect((await h.call(hrReasons, 'GET', `/v1/confirmations/${caseId}/exceptions`)).json().items[0]).toMatchObject({ reason: 'Synthetic justification', decisionReason: 'Synthetic decision' });
    const audit = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and record_key = $2 and action = 'DUE_DATE_OVERRIDE'`, [A.id, caseId]);
    expect(audit.n).toBe(1);
  });

  it('refuses a date before joining, an unchanged date, a case under review, and anyone acting on their own case', async () => {
    const employeeId = await probationer();
    const caseId = await openCase(employeeId);
    expect((await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-01-01' })).json().error).toBe('RULE_VIOLATION');
    expect((await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-04-30' })).json().error).toBe('NO_CHANGE');
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId });
    expect((await propose(self, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-05-31' })).json().error).toBe('SELF_ACTION');
    const id = (await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-05-31' })).json().exceptionId as string;
    expect((await decide(self, id, 'APPROVE')).json().error).toBe('SELF_ACTION');
    // A recommendation under review keeps its date: the override cannot apply until the case is open again.
    const c = await getCase(caseId);
    await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: c.version, recommendation: 'EXTEND', extensionMonths: 1, reason: 'Synthetic' });
    expect((await decide(hr2, id, 'APPROVE')).json().error).toBe('CASE_NOT_OPEN');
    expect((await decide(hr2, id, 'REJECT')).json().state).toBe('REJECTED');
  });
});

describe('extension-limit exception (DF11)', () => {
  it('allows one more extension only after an independently approved exception', async () => {
    const caseId = await openCase(await probationer());
    expect((await propose(hr, caseId, { kind: 'EXTRA_EXTENSION' })).json().error).toBe('LIMIT_NOT_REACHED');
    expect((await extend(caseId)).statusCode).toBe(200);
    expect((await extend(caseId)).statusCode).toBe(200);
    expect((await extend(caseId)).json().error).toBe('EXTENSION_LIMIT_REACHED');
    const id = (await propose(hr2, caseId, { kind: 'EXTRA_EXTENSION' })).json().exceptionId as string;
    expect((await decide(hr, id, 'APPROVE')).json()).toMatchObject({ state: 'APPROVED', applied: { extensionLimit: { from: 2, to: 3 } } });
    expect((await extend(caseId)).statusCode).toBe(200);
    expect((await getCase(caseId)).extensionCount).toBe(3);
    expect((await extend(caseId)).json().error).toBe('EXTENSION_LIMIT_REACHED');
  });

  it('replays a retried decision carrying the same idempotency key (ZT07)', async () => {
    const caseId = await openCase(await probationer());
    const id = (await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-05-29' })).json().exceptionId as string;
    const key = uniq('conf-exc-');
    const body = { decision: 'APPROVE', reason: 'Synthetic decision', idempotencyKey: key };
    expect((await h.call(hr2, 'POST', `/v1/confirmation-exceptions/${id}/decision`, body)).json()).toMatchObject({ state: 'APPROVED', replayed: false });
    expect((await h.call(hr2, 'POST', `/v1/confirmation-exceptions/${id}/decision`, body)).json()).toMatchObject({ state: 'APPROVED', replayed: true });
    // Another decision may not reuse the key.
    const other = (await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-06-15' })).json().exceptionId as string;
    expect((await h.call(hr2, 'POST', `/v1/confirmation-exceptions/${other}/decision`, body)).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lets the proposer withdraw a waiting proposal, nobody else', async () => {
    const caseId = await openCase(await probationer());
    const id = (await propose(hr, caseId, { kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-05-15' })).json().exceptionId as string;
    expect((await h.call(hr2, 'POST', `/v1/confirmation-exceptions/${id}/withdraw`)).statusCode).toBe(404);
    expect((await h.call(hr, 'POST', `/v1/confirmation-exceptions/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect((await decide(hr2, id, 'APPROVE')).statusCode).toBe(409);
  });
});

describe('authority inside the transaction (docs/09 §6.5)', () => {
  // What the route guard resolved just before the transaction opened, then the entry withdrawn meanwhile.
  const stale = async (a: TestActor, action: string) => {
    const guard = (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'confirmation', action, fieldGroups: ['operational'] })) as AccessGrant;
    const setEntry = (active: boolean) =>
      h.db.query(
        `update role_assignment_permission set active = $3 where company_id = $1 and role_assignment_id = $2
            and permission_id = (select id from permission where resource = 'confirmation' and action = $4 and field_group = 'operational')`,
        [A.id, a.assignment, active, action],
      );
    return { guard, setEntry };
  };
  const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from confirmation_exception where id = $1`, [id])).state;

  it('proposes, decides and withdraws only under the authority current inside the transaction', async () => {
    const caseId = await openCase(await probationer());
    const body = { kind: 'DUE_DATE_OVERRIDE' as const, proposedDueDate: '2026-12-31', reason: 'Synthetic justification' };

    const proposer = await h.actor(A, 'HR_ADMINISTRATOR');
    const propose1 = await stale(proposer, 'propose_exception');
    await propose1.setEntry(false);
    await expect(withTransaction(h.pool, (tx) => proposeException(tx, propose1.guard, caseId, body))).rejects.toMatchObject({ statusCode: 403 });
    await propose1.setEntry(true);

    const id = (await withTransaction(h.pool, (tx) => proposeException(tx, propose1.guard, caseId, body))).exceptionId as string;

    await propose1.setEntry(false);
    await expect(withTransaction(h.pool, (tx) => withdrawException(tx, propose1.guard, id))).rejects.toMatchObject({ statusCode: 403 });
    await propose1.setEntry(true);
    expect(await stateOf(id)).toBe('PROPOSED');

    const decider = await h.actor(A, 'HR_ADMINISTRATOR');
    const decide1 = await stale(decider, 'approve_exception');
    await decide1.setEntry(false);
    await expect(withTransaction(h.pool, (tx) => decideException(tx, decide1.guard, id, { decision: 'APPROVE', reason: 'Synthetic decision' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await stateOf(id)).toBe('PROPOSED');
    await decide1.setEntry(true);
    expect((await withTransaction(h.pool, (tx) => decideException(tx, decide1.guard, id, { decision: 'APPROVE', reason: 'Synthetic decision' }))).state).toBe('APPROVED');
  });
});
