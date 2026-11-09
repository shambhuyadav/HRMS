// Exit, settlement and offboarding rules decided under owner delegation, 6 Nov 2026 (docs/03 I-81; migrations 0185): HR-entered
// resignations and records kept after the last working date (FR-051), offboarding at separation (FR-055), a settlement's payment
// recorded from evidence and the disbursement month (FR-053, FR-054), what an approved withdrawal does to a settlement (FR-051,
// FR-053), uploaded-list selection (FR-054) and "send" as in-app delivery (FR-054, FR-018, DF09). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { approvedExit, approvedLeave, DOCUMENTS, evidenceDocument, VERIFY_DOCUMENTS } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { separateDueExits } from './exit.js';
import { addDays, HR_SETTLEMENT, HR_SETTLEMENT_EXPORT, key, person, publishedTemplate, today as businessDate } from './lifecycle.fixtures.js';

const PAY: PermissionKey[] = ['settlement.read.amount', 'settlement.record_payment.amount'];
const SEND: PermissionKey[] = ['settlement.read.amount', 'settlement.send.amount'];

describe.runIf(isModuleActive('lifecycle'))('exit, settlement and offboarding decisions (I-81)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let exitHr: TestActor;
  let exitHr2: TestActor;
  let hrEntry: TestActor;
  let prep: TestActor;
  let rev: TestActor;
  let appr: TestActor;
  let rel: TestActor;
  let payer: TestActor;
  let sender: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let managerEmp: string;
  let manager: TestActor;
  let today: string;
  const staff: Record<string, { emp: string; actor: TestActor }> = {};

  const csv = (rows: string[][]) => Buffer.from(`${rows.map((r) => r.join(',')).join('\r\n')}\r\n`).toString('base64');
  const get = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/settlements/${id}`)).json();
  const exitTasks = async (a: TestActor) =>
    (await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; exitCase: { id: string } | null }[];
  const exitTaskFor = async (a: TestActor, exitCaseId: string, kind = 'exit_case') => (await exitTasks(a)).find((t) => t.kind === kind && t.exitCase?.id === exitCaseId);
  const settlementTasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; settlement: { id: string } | null }[];
  const recommendAndApprove = async (exitId: string) => {
    const mt = (await exitTaskFor(manager, exitId))!;
    expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: today, idempotencyKey: key() })).json().state).toBe('RECOMMENDED');
    const approver = (await exitTaskFor(exitHr, exitId)) ? exitHr : exitHr2;
    const ht = (await exitTaskFor(approver, exitId))!;
    expect((await h.call(approver, 'POST', `/v1/exit-cases/tasks/${ht.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
  };
  const resigned = async (name: string) => {
    const s = staff[name]!;
    const id = (await h.call(s.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().exitCaseId as string;
    await recommendAndApprove(id);
    return id;
  };
  /** A settlement with one earning line, taken as far as `until`. */
  const settlementUntil = async (name: string, exitId: string, until: 'SUBMITTED' | 'APPROVED' | 'RELEASE_ELIGIBLE') => {
    const created = await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const lines = await h.call(prep, 'PUT', `/v1/settlements/${id}/lines`, { lines: [{ componentCode: 'FF_BASIC', amount: '1000.00' }], expectedVersion: created.json().version });
    expect(lines.statusCode, lines.body).toBe(200);
    expect((await h.call(prep, 'POST', `/v1/settlements/${id}/submit`, { expectedVersion: lines.json().version })).statusCode).toBe(200);
    if (until === 'SUBMITTED') return id;
    const rt = (await settlementTasks(rev)).find((t) => t.settlement?.id === id)!;
    expect((await h.call(rev, 'POST', `/v1/settlements/tasks/${rt.taskId}/review`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('REVIEWED');
    const at = (await settlementTasks(appr)).find((t) => t.settlement?.id === id)!;
    expect((await h.call(appr, 'POST', `/v1/settlements/tasks/${at.taskId}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
    if (until === 'APPROVED') return id;
    const clearance = (await h.call(exitHr, 'POST', `/v1/employees/${staff[name]!.emp}/processes`, { processCode: 'EXIT_D', exitCaseId: exitId })).json();
    expect((await h.call(exitHr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 })).statusCode).toBe(200);
    const marked = await h.call(rel, 'POST', `/v1/settlements/${id}/release-eligibility`, { expectedVersion: (await get(rel, id)).version });
    expect(marked.json().state, marked.body).toBe('RELEASE_ELIGIBLE');
    return id;
  };
  const payment = async (a: TestActor, id: string, emp: string, over: Record<string, unknown> = {}) =>
    h.call(a, 'POST', `/v1/settlements/${id}/payment`, {
      paymentDate: today,
      evidenceKey: key('ff-pay-'),
      evidenceReference: 'SYNTH-NEFT-0001',
      evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, emp)],
      expectedVersion: (await get(rel, id)).version,
      ...over,
    });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    exitHr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['exit.read.reason'] });
    exitHr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    hrEntry = await h.actor(A, 'HR_ADMINISTRATOR');
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT });
    rev = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    appr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rel = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...HR_SETTLEMENT_EXPORT, 'settlement.record_payment.amount'] });
    payer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PAY });
    sender = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SEND });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    managerEmp = await person(h, A, exitHr, { name: 'Maya Manager (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    for (const name of ['entered', 'paid', 'submitted', 'eligible', 'listed', 'other', 'leaverTask', 'later']) {
      const emp = await person(h, A, exitHr, { managerId: managerEmp, name: `${name} person (synthetic)` });
      staff[name] = { emp, actor: await h.actor(A, 'EMPLOYEE', { employeeId: emp }) };
    }
    for (const [code, kind] of [
      ['FF_BASIC', 'EARNING'],
      ['FF_LOAN', 'DEDUCTION'],
    ] as const) {
      await h.db.query(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, $2, $3, $4, true)`, [A.id, code, `${code} (synthetic)`, kind]);
    }
    expect((await h.call(exitHr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hrEntry.user, priority: 1 }, { userId: exitHr.user, priority: 2 }, { userId: exitHr2.user, priority: 3 }] })).statusCode).toBe(200);
    expect((await h.call(exitHr, 'PUT', '/v1/workflows/settlement/fallback-reviewers', { reviewers: [{ userId: rev.user, priority: 1 }, { userId: appr.user, priority: 2 }] })).statusCode).toBe(200);
    await publishedTemplate(h, exitHr, 'EXIT_D', 'EXIT', [{ code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-051 HR enters a resignation given outside the system: verified evidence, the same route, and whoever entered it never decides it', async () => {
    const s = staff.entered!;
    const enter = (a: TestActor, body: Record<string, unknown>) =>
      h.call(a, 'POST', `/v1/employees/${s.emp}/resignation`, { proposedLastWorkingDate: today, evidenceReference: 'Letter received 6 Nov (synthetic)', ...body });
    // A reporting manager does not hold the exit management duty; evidence must be released and independently verified.
    expect((await enter(manager, { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, s.emp)] })).statusCode).toBe(403);
    expect((await enter(hrEntry, { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, s.emp, { verify: false })] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await enter(hrEntry, { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, staff.other!.emp)] })).json().error).toBe('INVALID_EVIDENCE');
    const created = await enter(hrEntry, { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, s.emp)] });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ state: 'SUBMITTED', origin: 'HR' });
    const exitId = created.json().exitCaseId as string;
    expect((await h.call(exitHr, 'GET', `/v1/exit-cases/${exitId}`)).json()).toMatchObject({ origin: 'HR', enteredBy: hrEntry.user });
    // One open resignation, whoever entered it; the employee sees it as their own.
    expect((await h.call(s.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().error).toBe('OPEN_EXIT_EXISTS');
    expect(((await h.call(s.actor, 'GET', '/v1/me/exit-cases')).json().items as { id: string }[]).map((x) => x.id)).toContain(exitId);
    // The manager recommends; the HR step skips the person who entered it although first on the list.
    const mt = (await exitTaskFor(manager, exitId))!;
    expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: today, idempotencyKey: key() })).json().state).toBe('RECOMMENDED');
    expect(await exitTaskFor(hrEntry, exitId)).toBeUndefined();
    const ht = (await exitTaskFor(exitHr, exitId))!;
    expect((await h.call(exitHr, 'POST', `/v1/exit-cases/tasks/${ht.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
    // The origin and evidence are fixed in the database.
    await expect(h.db.query(`update exit_case set evidence_reference = 'changed' where id = $1`, [exitId])).rejects.toThrow(/origin and evidence/);
    await expect(h.db.query(`update exit_case set request_origin = 'EMPLOYEE' where id = $1`, [exitId])).rejects.toThrow(/origin and evidence|exit_case_origin_facts/);
  });

  it('FR-051 leave approved after the last working date is kept, never cancelled by the exit, and listed for HR', async () => {
    const lwd = addDays(today, -20);
    const s = staff.later!;
    const before = await approvedLeave(h, A, s.emp, 'ANNUAL', addDays(lwd, -3), addDays(lwd, -2), '2');
    const after = await approvedLeave(h, A, s.emp, 'ANNUAL', addDays(lwd, 2), addDays(lwd, 3), '2');
    await approvedExit(h, A, s.emp, addDays(lwd, -30), lwd);
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [s.emp])).id;
    expect(await separateDueExits(h.pool, A.id, today, SYSTEM_ACTOR_ID)).toMatchObject({ separated: 1 });
    const detail = (await h.call(exitHr, 'GET', `/v1/exit-cases/${exitId}`)).json();
    expect(detail.afterLastWorkingDate).toEqual({ treatment: 'KEPT', items: [{ kind: 'LEAVE_REQUEST', id: after, startDate: addDays(lwd, 2), endDate: addDays(lwd, 3) }] });
    expect((await h.one<{ s: string }>(`select string_agg(state, ',' order by start_date) as s from leave_request where id = any($1::uuid[])`, [[before, after]])).s).toBe('APPROVED,APPROVED');
  });

  it('FR-055 separation ends the leaver’s other assignments, keeps own self-service, reroutes their open tasks and drops them as a reviewer', async () => {
    const leaver = staff.leaverTask!;
    const asHr = await h.actor(A, 'HR_ADMINISTRATOR', { user: leaver.actor.user });
    // A proposal still waiting is revoked too.
    const proposalRole = await h.one<{ id: string }>(`select id from role where company_id = $1 and code = 'PAYROLL_OPERATOR'`, [A.id]);
    const proposal = (
      await h.one<{ id: string }>(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by) values ($1, $2, $3, 'COMPANY', now(), 'PENDING', $4) returning id`,
        [A.id, leaver.actor.user, proposalRole.id, SYSTEM_ACTOR_ID],
      )
    ).id;
    // The leaver is first on the exit list: another employee's resignation waits for their HR decision.
    expect((await h.call(exitHr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: asHr.user, priority: 1 }, { userId: exitHr2.user, priority: 2 }] })).statusCode).toBe(200);
    try {
      await offboarding(asHr, proposal);
    } finally {
      // The ordinary list again for the tests below, whatever happened here.
      expect((await h.call(exitHr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: exitHr.user, priority: 1 }, { userId: exitHr2.user, priority: 2 }] })).statusCode).toBe(200);
    }
  });

  async function offboarding(asHr: TestActor, proposal: string) {
    const leaver = staff.leaverTask!;
    const other = staff.other!;
    const otherExit = (await h.call(other.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().exitCaseId as string;
    const mt = (await exitTaskFor(manager, otherExit))!;
    await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: today, idempotencyKey: key() });
    const leaverTask = (await exitTaskFor(asHr, otherExit))!;
    expect(leaverTask).toBeDefined();

    const lwd = addDays(today, -1);
    await approvedExit(h, A, leaver.emp, addDays(lwd, -30), lwd);
    const leaverExit = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [leaver.emp])).id;
    expect(await separateDueExits(h.pool, A.id, today, SYSTEM_ACTOR_ID)).toMatchObject({ separated: 1 });

    // Access closure is auditable and destroys nothing (FR-055): the assignment ends at the start of the day after the date.
    const hrAssignment = await h.one<{ state: string; ended: boolean }>(`select state, effective_to <= now() as ended from role_assignment where id = $1`, [asHr.assignment]);
    expect(hrAssignment).toEqual({ state: 'ACTIVE', ended: true });
    expect(await h.one<{ state: string; decision_reason: string }>(`select state, decision_reason from role_assignment where id = $1`, [proposal])).toEqual({
      state: 'REVOKED',
      decision_reason: `Ended at separation (exit case ${leaverExit})`,
    });
    expect((await h.call(asHr, 'GET', '/v1/exit-cases')).statusCode).toBe(403);
    // BR-053: the Employee OWN assignment survives, with the account and its link.
    expect((await h.one<{ ended: boolean }>(`select effective_to is not null as ended from role_assignment where id = $1`, [leaver.actor.assignment])).ended).toBe(false);
    expect((await h.call(leaver.actor, 'GET', '/v1/me/exit-cases')).statusCode).toBe(200);
    expect((await h.call(leaver.actor, 'GET', '/v1/me/deliveries')).statusCode).toBe(200);
    // The open task went to whoever the step's rule now selects; the superseded one is kept.
    expect(await h.one<{ state: string }>(`select state from approval_task where id = $1`, [leaverTask.taskId])).toEqual({ state: 'SUPERSEDED' });
    expect(await exitTaskFor(exitHr2, otherExit)).toBeDefined();
    const audit = await h.one<{ after: string }>(`select after_values::text as after from audit_event where company_id = $1 and record_key = $2 and action = 'SEPARATE'`, [A.id, leaverExit]);
    expect(JSON.parse(audit.after).operational).toMatchObject({ assignmentsEnded: 1, assignmentsRevoked: 1, tasksRerouted: 1, tasksStranded: 0 });

    // A leaver is no reviewer even through an assignment the separation could not end (here one granted afterwards).
    await h.actor(A, 'HR_ADMINISTRATOR', { user: leaver.actor.user });
    const later = staff.listed!;
    const laterExit = (await h.call(later.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: today })).json().exitCaseId as string;
    const lt = (await exitTaskFor(manager, laterExit))!;
    await h.call(manager, 'POST', `/v1/exit-cases/tasks/${lt.taskId}/recommend`, { recommendedLastWorkingDate: today, idempotencyKey: key() });
    const routed = await h.one<{ assignee: string }>(
      `select t.assignee_user_id as assignee from approval_task t join approval_instance i on i.id = t.instance_id join exit_case x on x.transaction_id = i.transaction_id
        where x.id = $1 and t.state = 'PENDING'`,
      [laterExit],
    );
    expect(routed.assignee).toBe(exitHr2.user);
    const hrDecide = (await exitTaskFor(exitHr2, laterExit))!;
    expect((await h.call(exitHr2, 'POST', `/v1/exit-cases/tasks/${hrDecide.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().state).toBe('APPROVED');
  }

  let paidId: string;
  let paidExit: string;

  it('FR-053 a release-eligible settlement is recorded as paid from evidence by someone independent; the payment date is the disbursement month', async () => {
    const s = staff.paid!;
    paidExit = await resigned('paid');
    const id = await settlementUntil('paid', paidExit, 'APPROVED');
    // Approval is not payment, and release eligibility comes first (FR-053).
    expect((await payment(payer, id, s.emp)).json().error).toBe('INVALID_STATE');
    const clearance = (await h.call(exitHr, 'POST', `/v1/employees/${s.emp}/processes`, { processCode: 'EXIT_D', exitCaseId: paidExit })).json();
    await h.call(exitHr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 });
    expect((await h.call(rel, 'POST', `/v1/settlements/${id}/release-eligibility`, { expectedVersion: (await get(rel, id)).version })).json().state).toBe('RELEASE_ELIGIBLE');
    expect((await get(rel, id))).toMatchObject({ state: 'RELEASE_ELIGIBLE', paymentStatus: 'NOT_PAID', paymentDate: null });
    // The release marker, the approver and anyone without the right are refused (C4; FR-002).
    expect((await payment(rel, id, s.emp)).json().error).toBe('NOT_INDEPENDENT');
    expect((await payment(exitHr, id, s.emp)).statusCode).toBe(403);
    expect((await payment(payer, id, s.emp, { paymentDate: addDays(today, 1) })).json().error).toBe('PAYMENT_IN_FUTURE');
    expect((await payment(payer, id, s.emp, { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, s.emp, { verify: false })] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    const evidenceKey = key('ff-pay-');
    const paid = await payment(payer, id, s.emp, { evidenceKey });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ state: 'PAID', paymentStatus: 'PAID', paymentDate: today, payment: { paidBy: payer.user, reference: 'SYNTH-NEFT-0001' }, replayed: false });
    paidId = id;
    expect((await payment(payer, id, s.emp, { evidenceKey })).json()).toMatchObject({ state: 'PAID', replayed: true });
    // The disbursement month filter (CL-241) reads the recorded payment date.
    const month = today.slice(0, 7);
    expect(((await h.call(rel, 'GET', `/v1/settlements?disbursementMonth=${month}`)).json().items as { id: string }[]).map((i) => i.id)).toEqual([id]);
    expect((await h.call(rel, 'GET', '/v1/settlements?disbursementMonth=2001-01')).json().items).toEqual([]);
    // A paid settlement is final: no new revision, a fixed payment record, and the exit can no longer be withdrawn.
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${paidExit}/settlements`, {})).json().error).toBe('SETTLEMENT_PAID');
    await expect(h.db.query(`update settlement set payment_reference = 'other' where id = $1`, [id])).rejects.toThrow(/never changes/);
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${paidExit}/withdrawal-request`, { reason: 'Synthetic change of plans' })).json().error).toBe('SETTLEMENT_PAID');
  });

  it('FR-051 FR-053 an approved withdrawal voids a live settlement it can still stop, and waits while release eligibility may mean money is moving', async () => {
    // A submitted settlement: the approved withdrawal voids it and ends its review task.
    const sub = staff.submitted!;
    const subExit = await resigned('submitted');
    const subId = await settlementUntil('submitted', subExit, 'SUBMITTED');
    expect((await settlementTasks(rev)).some((t) => t.settlement?.id === subId)).toBe(true);
    expect((await h.call(sub.actor, 'POST', `/v1/me/exit-cases/${subExit}/withdrawal-request`, { reason: 'Synthetic change of plans' })).statusCode).toBe(201);
    const wt = (await exitTaskFor(exitHr, subExit, 'exit_withdrawal'))!;
    const approved = await h.call(exitHr, 'POST', `/v1/exit-withdrawals/tasks/${wt.taskId}/decision`, { decision: 'APPROVE', reason: 'Retained (synthetic)', idempotencyKey: key() });
    expect(approved.json()).toMatchObject({ state: 'APPROVED', exitState: 'WITHDRAWN' });
    expect(await get(prep, subId)).toMatchObject({ state: 'CANCELLED', cancelReason: 'Exit withdrawn by an approved withdrawal request', lines: [expect.objectContaining({ componentCode: 'FF_BASIC' })] });
    expect((await settlementTasks(rev)).some((t) => t.settlement?.id === subId)).toBe(false);

    // A release-eligible settlement: release and payment wait for a pending withdrawal, and an approved withdrawal waits for the void.
    const el = staff.eligible!;
    const elExit = await resigned('eligible');
    const elId = await settlementUntil('eligible', elExit, 'APPROVED');
    const first = await h.call(el.actor, 'POST', `/v1/me/exit-cases/${elExit}/withdrawal-request`, { reason: 'Synthetic change of plans' });
    expect(first.statusCode).toBe(201);
    const clearance = (await h.call(exitHr, 'POST', `/v1/employees/${el.emp}/processes`, { processCode: 'EXIT_D', exitCaseId: elExit })).json();
    expect((await h.call(exitHr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 })).statusCode).toBe(200);
    expect((await h.call(rel, 'POST', `/v1/settlements/${elId}/release-eligibility`, { expectedVersion: (await get(rel, elId)).version })).json().error).toBe('WITHDRAWAL_PENDING');
    // The employee cancels that request; the settlement becomes eligible; then they ask again.
    expect((await h.call(el.actor, 'POST', `/v1/me/exit-withdrawals/${first.json().withdrawalId}/cancel`)).statusCode).toBe(200);
    expect((await h.call(rel, 'POST', `/v1/settlements/${elId}/release-eligibility`, { expectedVersion: (await get(rel, elId)).version })).json().state).toBe('RELEASE_ELIGIBLE');
    expect((await h.call(el.actor, 'POST', `/v1/me/exit-cases/${elExit}/withdrawal-request`, { reason: 'Synthetic change of plans, again' })).statusCode).toBe(201);
    expect((await payment(payer, elId, el.emp)).json().error).toBe('WITHDRAWAL_PENDING');
    const et = (await exitTaskFor(exitHr, elExit, 'exit_withdrawal'))!;
    const refused = await h.call(exitHr, 'POST', `/v1/exit-withdrawals/tasks/${et.taskId}/decision`, { decision: 'APPROVE', reason: 'Retained (synthetic)', idempotencyKey: key() });
    expect(refused.json().error).toBe('SETTLEMENT_RELEASE_ELIGIBLE');
    // The preparer cannot void it; an independent approver can, with the reason, and the release marker is kept.
    const version = (await get(appr, elId)).version;
    expect((await h.call(exitHr, 'POST', `/v1/settlements/${elId}/void`, { reason: 'x', expectedVersion: version })).statusCode).toBe(403);
    expect((await h.call(prep, 'POST', `/v1/settlements/${elId}/void`, { reason: 'x', expectedVersion: version })).json().error).toBe('NOT_INDEPENDENT');
    const voided = await h.call(appr, 'POST', `/v1/settlements/${elId}/void`, { reason: 'Employee retained; not to be paid (synthetic)', expectedVersion: version });
    expect(voided.json()).toMatchObject({ state: 'CANCELLED', cancelReason: 'Employee retained; not to be paid (synthetic)' });
    expect((await h.one<{ marked: boolean }>(`select release_eligible_at is not null as marked from settlement where id = $1`, [elId])).marked).toBe(true);
    expect((await h.call(exitHr, 'POST', `/v1/exit-withdrawals/tasks/${et.taskId}/decision`, { decision: 'APPROVE', reason: 'Retained (synthetic)', idempotencyKey: key() })).json().exitState).toBe('WITHDRAWN');
  });

  it('FR-054 an uploaded list selects settlements by exact employee code, reporting unknown, out-of-scope, duplicate and blank rows', async () => {
    const outsiderB = await person(h, B, await h.actor(B, 'HR_ADMINISTRATOR'), { name: 'Bo Elsewhere (synthetic)' });
    const codeOf = async (emp: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [emp])).c;
    const paidCode = await codeOf(staff.paid!.emp);
    const noneCode = await codeOf(staff.listed!.emp);
    const outsiderCode = await codeOf(outsiderB);
    const template = await h.call(rel, 'GET', '/v1/settlements/selection/template');
    expect(template.statusCode).toBe(200);
    expect(template.body.trim()).toBe('employee_code');
    const select = (rows: string[][], extra: Record<string, unknown> = {}) => h.call(rel, 'POST', '/v1/settlements/selection', { contentBase64: csv(rows), ...extra });
    expect((await select([['code'], [paidCode]])).json().error).toBe('INVALID_TEMPLATE');
    // A row with more than one cell is not a code (an empty line is no row at all).
    const res = await select([['employee_code'], [` ${paidCode.toLowerCase()} `], [paidCode], [paidCode, 'extra'], ['NO-SUCH-CODE'], [outsiderCode], [noneCode]]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rows).toEqual([
      { row: 2, employeeCode: paidCode, outcome: 'MATCHED', settlements: 1 },
      { row: 3, employeeCode: paidCode, outcome: 'DUPLICATE', settlements: 0 },
      { row: 4, employeeCode: null, outcome: 'INVALID_CODE', settlements: 0 },
      { row: 5, employeeCode: 'NO-SUCH-CODE', outcome: 'NOT_FOUND', settlements: 0 },
      { row: 6, employeeCode: outsiderCode, outcome: 'NOT_FOUND', settlements: 0 },
      { row: 7, employeeCode: noneCode, outcome: 'NO_SETTLEMENT', settlements: 0 },
    ]);
    expect(res.json()).toMatchObject({ total: 6, matched: 1 });
    expect((res.json().items as { id: string; netAmount: string }[]).map((i) => [i.id, i.netAmount])).toEqual([[paidId, '1000.0000']]);
    // The list's other filters still apply, and the ZIP output takes the selection.
    expect((await select([['employee_code'], [paidCode]], { state: 'DRAFT' })).json().rows[0].outcome).toBe('NO_SETTLEMENT');
    expect((await h.call(rel, 'GET', `/v1/settlements/export-archive?ids=${paidId}`)).statusCode).toBe(200);
  });

  it('FR-054 FR-018 DF09 sending a statement is in-app delivery to the employee’s own self-service: reviewed recipient, delivery status, no attachment in the notice', async () => {
    const s = staff.paid!;
    const send = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/settlements/${paidId}/send`, { format: 'PDF', recipientEmployeeId: s.emp, ...body });
    expect((await send(prep, {})).statusCode).toBe(403);
    expect((await send(sender, { recipientEmployeeId: staff.other!.emp })).json().error).toBe('RECIPIENT_MISMATCH');
    const k = key('ff-send-');
    const sent = await send(sender, { idempotencyKey: k });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({ kind: 'SETTLEMENT_STATEMENT', format: 'PDF', channel: 'IN_APP', status: 'DELIVERED', sourceRevision: 1, replayed: false });
    expect((await send(sender, { idempotencyKey: k })).json()).toMatchObject({ id: sent.json().id, replayed: true });
    // The employee reads their own delivery; nobody else's.
    const mine = (await h.call(s.actor, 'GET', '/v1/me/deliveries')).json().items as { id: string; title: string; status: string }[];
    expect(mine).toEqual([expect.objectContaining({ id: sent.json().id, title: 'Full and final settlement statement', status: 'DELIVERED' })]);
    expect((await h.call(staff.other!.actor, 'GET', `/v1/me/deliveries/${sent.json().id}/file`)).statusCode).toBe(404);
    // Own outputs are read in the Employee OWN context only: an HR assignment has no own-delivery read.
    expect((await h.call(sender, 'GET', '/v1/me/deliveries')).statusCode).toBe(403);
    const file = await h.call(s.actor, 'GET', `/v1/me/deliveries/${sent.json().id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.body.startsWith('%PDF')).toBe(true);
    expect(((await h.call(sender, 'GET', `/v1/settlements/${paidId}/deliveries`)).json().items as { status: string }[])[0]!.status).toBe('READ');
    // The in-app notice names the kind of document only: no amount, no attachment, and nothing is e-mailed.
    await dispatchOutbox(h.pool);
    const notice = ((await h.call(s.actor, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).find((n) => n.category === 'ESS_DOCUMENT_DELIVERED')!;
    expect(notice.body).toContain('full and final settlement statement');
    expect(notice.body).not.toMatch(/1000/);
    // A delivery is fixed once sent; only the first reading is recorded, once.
    await expect(h.db.query(`update ess_delivery set file_format = 'XLSX' where id = $1`, [sent.json().id])).rejects.toThrow(/fixed once sent/);
    await expect(h.db.query(`update ess_delivery set first_read_at = now() + interval '1 day' where id = $1`, [sent.json().id])).rejects.toThrow(/recorded once/);
  });
});
