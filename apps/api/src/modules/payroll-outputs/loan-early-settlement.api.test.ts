// FR-034 loan early settlement and FR-052 "already paid" (docs/03 I-48 items 12 and 14, I-40 item 2, I-81 items 1, 2 and 5; decided
// under owner delegation, 6 Nov 2026; migration 0186). An early settlement closes a disbursed loan in full from a recorded repayment
// (outside payroll, or through the paid full-and-final settlement) and/or a waiver or write-off, entered by one person and decided by
// another; a waiver needs a right no role holds by default. A settlement never pays again a component the final period's approved or
// processed monthly payroll already paid. Synthetic employees, amounts and evidence only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { HR_SETTLEMENT, publishedTemplate } from '../lifecycle/lifecycle.fixtures.js';
import {
  APPROVE,
  approvedExit,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  createRun,
  DOCUMENTS,
  evidenceDocument,
  head,
  INPUT_APPROVE,
  key,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  today,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

const L = (a: string) => `payroll_loan.${a}.loan` as PermissionKey;
const DECIDE: PermissionKey[] = [L('read'), L('decide')];
const DISBURSE: PermissionKey[] = [L('read'), L('disburse')];
const MAKER: PermissionKey[] = [L('read'), L('request')];
const RECOVER: PermissionKey[] = [L('read'), L('recover')];

interface Loan {
  id: string;
  state: string;
  version: number;
  outstanding: string;
  settledEarly: string;
  waived: string;
  closeReason: string | null;
  earlySettlements: { id: string; state: string; version: number; repaidAmount: string; waivedAmount: string; waiverKind: string | null }[];
}

describe.runIf(isModuleActive('payroll-outputs') && isModuleActive('lifecycle'))('loan early settlement and settlement against payroll (FR-034, FR-052)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let inputApprover: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let decider: TestActor;
  let waiver: TestActor;
  let disburser: TestActor;
  let maker: TestActor;
  let recoverer: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let prep: TestActor;
  let rev: TestActor;
  let appr: TestActor;
  let rel: TestActor;
  let payer: TestActor;
  let periods: Record<string, string>;
  let month: string;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const loanOf = async (id: string) => ok<Loan>(await h.call(decider, 'GET', `/v1/payroll-outputs/loans/${id}`));
  const borrower = async (code: string) => {
    const dept = await department(code);
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '40000', components: [{ code: 'ES_BASIC', amount: '40000' }] });
    await bankRevision(h, A, e);
    return { dept, e };
  };
  const disbursedLoan = async (e: string, principal: string) => {
    const req = await ok<{ id: string }>(await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${e}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal, purpose: 'Synthetic loan' }), 201);
    const l = await loanOf(req.id);
    await ok(await h.call(decider, 'POST', `/v1/payroll-outputs/loans/${req.id}/decision`, { decision: 'APPROVE', recoveryComponentCode: 'ES_RECOVERY', installments: [{ dueMonth: month, amount: principal }], expectedVersion: l.version }));
    await ok(
      await h.call(disburser, 'POST', `/v1/payroll-outputs/loans/${req.id}/disbursement`, {
        disbursementDate: await today(h, A),
        evidenceKey: key('disb-'),
        evidenceReference: 'SYNTH-TRANSFER',
        evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, e)],
        expectedVersion: (await loanOf(req.id)).version,
      }),
    );
    return req.id;
  };
  const record = async (a: TestActor, loanId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/payroll-outputs/loans/${loanId}/early-settlement`, { reason: 'Employee settles the loan early (synthetic)', expectedVersion: (await loanOf(loanId)).version, ...body });
  const direct = async (e: string, amount: string, over: Record<string, unknown> = {}) => ({
    repaidAmount: amount,
    repaymentRoute: 'DIRECT_REPAYMENT',
    repaymentDate: await today(h, A),
    evidenceKey: key('repay-'),
    evidenceReference: 'SYNTH-RECEIPT-1',
    evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, e)],
    ...over,
  });
  const decideRecord = async (a: TestActor, loanId: string, body: Record<string, unknown>) => {
    const r = (await loanOf(loanId)).earlySettlements.find((x) => x.state === 'PROPOSED')!;
    return h.call(a, 'POST', `/v1/payroll-outputs/loan-settlements/${r.id}/decision`, { expectedVersion: r.version, ...body });
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    inputApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
    waiver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DECIDE, L('waive')] });
    disburser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DISBURSE });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: MAKER });
    recoverer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: RECOVER });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rev = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    appr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rel = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    payer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['settlement.read.amount', 'settlement.record_payment.amount'] });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_input_batch', [inputApprover]);
    await reviewers(h, hr, 'settlement', [rev, appr]);
    await head(h, configA, configB, { code: 'ES_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'ES_RECOVERY', headType: 'DEDUCTION', basis: 'INPUT', sequence: 2 });
    await h.db.query(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, 'ES_LEAVE_ENC', 'Leave encashment (synthetic)', 'EARNING', true)`, [A.id]);
    periods = (await calendar(h, configA, configB, [...months(2026), ...months(2027)])).periods;
    month = (await today(h, A)).slice(0, 7);
    await publishedTemplate(h, hr, 'EXIT_LN', 'EXIT', [{ code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-034 an early settlement closes a disbursed loan in full from a recorded repayment, decided by someone else', async () => {
    const { e } = await borrower('ES_DIRECT');
    const loanId = await disbursedLoan(e, '3000.00');
    // The amounts are entered, never computed: they must add up to the balance, with the route and its evidence.
    expect((await record(disburser, loanId, await direct(e, '2000.00'))).json()).toMatchObject({ error: 'SETTLEMENT_NOT_BALANCED', details: { balance: '3000.0000' } });
    expect((await record(disburser, loanId, { repaidAmount: '3000.00' })).json().error).toBe('REPAYMENT_ROUTE_REQUIRED');
    expect((await record(disburser, loanId, await direct(e, '3000.00', { repaymentDate: '2099-01-01' }))).json().error).toBe('REPAYMENT_IN_FUTURE');
    expect((await record(disburser, loanId, await direct(e, '3000.00', { evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, e, { verify: false })] }))).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    // Only the disbursement duty records it.
    expect((await record(decider, loanId, await direct(e, '3000.00'))).statusCode).toBe(403);
    const recorded = await record(disburser, loanId, await direct(e, '3000.00'));
    expect(recorded.statusCode, recorded.body).toBe(201);
    expect(recorded.json()).toMatchObject({ state: 'DISBURSED', outstanding: '3000.0000', earlySettlements: [{ state: 'PROPOSED', repaidAmount: '3000.0000', waivedAmount: '0.0000' }] });
    expect((await record(disburser, loanId, await direct(e, '3000.00'))).json().error).toBe('SETTLEMENT_PENDING');
    // Whoever recorded it never decides it, even holding the decision duty.
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...new Set([...DECIDE, ...DISBURSE])], user: disburser.user });
    expect((await decideRecord(both, loanId, { decision: 'APPROVE' })).json().error).toBe('NOT_INDEPENDENT');
    const closed = await decideRecord(decider, loanId, { decision: 'APPROVE' });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ state: 'CLOSED', outstanding: '0.0000', settledEarly: '3000.0000', waived: '0.0000', closeReason: 'Settled early' });
    // The database writes settled amounts only through an approved settlement, once.
    await expect(h.db.query(`update payroll_loan set settled_amount = 1 where id = $1`, [loanId])).rejects.toThrow(/written once, by an approved loan settlement/);
    await expect(h.db.query(`update payroll_loan_settlement set repaid_amount = 1 where loan_id = $1`, [loanId])).rejects.toThrow(/never changes/);
  });

  it('FR-034 a waiver or write-off needs the separate waive right, which no role holds by default', async () => {
    expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(L('waive'))).map((r) => r.code)).toEqual([]);
    expect(BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!.ceiling).toContain(L('waive'));
    const { e } = await borrower('ES_WAIVE');
    const loanId = await disbursedLoan(e, '1000.00');
    expect((await record(disburser, loanId, await direct(e, '400.00', { waivedAmount: '600.00' }))).json().error).toBe('WAIVER_KIND_REQUIRED');
    expect((await record(disburser, loanId, await direct(e, '400.00', { waivedAmount: '600.00', waiverKind: 'WAIVER' }))).statusCode).toBe(201);
    // The decision duty alone does not forgive a balance (FR-002); nothing changes on the refusal.
    expect((await decideRecord(decider, loanId, { decision: 'APPROVE' })).statusCode).toBe(403);
    expect(await loanOf(loanId)).toMatchObject({ state: 'DISBURSED', earlySettlements: [{ state: 'PROPOSED' }] });
    const closed = await decideRecord(waiver, loanId, { decision: 'APPROVE' });
    expect(closed.json()).toMatchObject({ state: 'CLOSED', outstanding: '0.0000', settledEarly: '400.0000', waived: '600.0000', closeReason: 'Settled early, rest waived or written off' });
    // A write-off of the whole balance, rejected with a reason: the loan stays and payroll goes on recovering it.
    const second = await disbursedLoan((await borrower('ES_WRITE_OFF')).e, '500.00');
    expect((await record(disburser, second, { repaidAmount: '0', waivedAmount: '500.00', waiverKind: 'WRITE_OFF' })).statusCode).toBe(201);
    expect((await decideRecord(waiver, second, { decision: 'REJECT' })).json().error).toBe('REASON_REQUIRED');
    expect((await decideRecord(waiver, second, { decision: 'REJECT', reason: 'Recover through payroll (synthetic)' })).json()).toMatchObject({ state: 'DISBURSED', outstanding: '500.0000' });
  });

  it('FR-034 a payroll deduction still awaiting recognition stops an early settlement until the recovery is recognised', async () => {
    const { dept, e } = await borrower('ES_AWAIT');
    const loanId = await disbursedLoan(e, '2000.00');
    const batch = await ok<{ id: string }>(
      await h.call(preparer, 'POST', `/v1/payroll/periods/${periods[month]}/input-batches`, {
        lines: [{ employeeId: e, componentCode: 'ES_RECOVERY', inputKind: 'OTHER_INPUT', amount: '500.00', currencyCode: 'INR', effectiveDate: `${month}-05`, reference: uniq('LOAN-') }],
      }),
      201,
    );
    const b = await ok<{ version: number }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${batch.id}`));
    await ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${batch.id}/submit`, { expectedVersion: b.version }));
    const t = ((await h.call(inputApprover, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } | null }[]).find((x) => x.batch?.id === batch.id)!;
    await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${t.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    expect((await record(disburser, loanId, await direct(e, '1500.00'))).json().error).toBe('RECOVERY_AWAITING_RECOGNITION');
    await ok(await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${run.id}/loan-recoveries`));
    expect((await record(disburser, loanId, await direct(e, '2000.00'))).json()).toMatchObject({ error: 'SETTLEMENT_NOT_BALANCED', details: { balance: '1500.0000' } });
    expect((await record(disburser, loanId, await direct(e, '1500.00'))).statusCode).toBe(201);
    expect((await decideRecord(decider, loanId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'CLOSED', settledEarly: '1500.0000' });
  });

  it('FR-052 the final period’s approved payroll pays a component once: the settlement refuses it when entered, and again at submission when the run is approved later', async () => {
    const { dept, e } = await borrower('ES_FINAL');
    const loanId = await disbursedLoan(e, '5000.00');
    const lwd = await today(h, A);
    await approvedExit(h, A, e, '2026-01-10', lwd);
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [e])).id;
    // The final period's run is calculated (not yet approved): nothing is paid yet, so the line is accepted.
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const created = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const put = (lines: Record<string, unknown>[], version: number) => h.call(prep, 'PUT', `/v1/settlements/${created.id}/lines`, { lines, expectedVersion: version });
    const withBasic = await put([{ componentCode: 'ES_BASIC', amount: '40000.00' }, { componentCode: 'ES_RECOVERY', amount: '-5000.00' }], created.version);
    expect(withBasic.statusCode, withBasic.body).toBe(200);
    let detail = (await h.call(prep, 'GET', `/v1/settlements/${created.id}`)).json();
    expect(detail.balances.finalPeriodPayroll).toEqual([
      expect.objectContaining({ runId: run.id, runState: 'CALCULATED', components: [{ componentCode: 'ES_BASIC', headType: 'EARNING', alreadyPaid: false }] }),
    ]);
    // The run is approved for payment: now ES_BASIC counts as paid, so the settlement cannot go on with it.
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    expect((await h.call(prep, 'POST', `/v1/settlements/${created.id}/submit`, { expectedVersion: withBasic.json().version })).json()).toMatchObject({
      error: 'ALREADY_PAID_IN_PAYROLL',
      details: { components: ['ES_BASIC'] },
    });
    expect((await put([{ componentCode: 'ES_BASIC', amount: '1.00' }], withBasic.json().version)).json().error).toBe('ALREADY_PAID_IN_PAYROLL');
    // A deduction is not "paid", and an earning the monthly run did not pay is fine.
    const corrected = await put([{ componentCode: 'ES_LEAVE_ENC', amount: '8000.00' }, { componentCode: 'ES_RECOVERY', amount: '-5000.00' }], withBasic.json().version);
    expect(corrected.statusCode, corrected.body).toBe(200);
    detail = corrected.json();
    expect(detail.balances.finalPeriodPayroll[0]).toMatchObject({ runState: 'APPROVED', components: [{ componentCode: 'ES_BASIC', alreadyPaid: true }] });
    expect((await h.call(prep, 'POST', `/v1/settlements/${created.id}/submit`, { expectedVersion: detail.version })).statusCode).toBe(200);
    const rt = ((await h.call(rev, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; settlement: { id: string } }[]).find((x) => x.settlement.id === created.id)!;
    await ok(await h.call(rev, 'POST', `/v1/settlements/tasks/${rt.taskId}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    const at = ((await h.call(appr, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; settlement: { id: string } }[]).find((x) => x.settlement.id === created.id)!;
    await ok(await h.call(appr, 'POST', `/v1/settlements/tasks/${at.taskId}/approve`, { decision: 'APPROVE', idempotencyKey: key() }));
    const clearance = (await h.call(hr, 'POST', `/v1/employees/${e}/processes`, { processCode: 'EXIT_LN', exitCaseId: exitId })).json();
    await ok(await h.call(hr, 'POST', `/v1/employee-process-tasks/${clearance.tasks[0].id}/complete`, { expectedVersion: 1 }));
    await ok(await h.call(rel, 'POST', `/v1/settlements/${created.id}/release-eligibility`, { expectedVersion: (await ok<{ version: number }>(await h.call(rel, 'GET', `/v1/settlements/${created.id}`))).version }));

    // I-40 item 2: the settlement's loan recovery counts once the settlement's payment is recorded.
    const viaSettlement = { repaidAmount: '5000.00', repaymentRoute: 'FINAL_SETTLEMENT', settlementId: created.id };
    expect((await record(disburser, loanId, viaSettlement)).json().error).toBe('SETTLEMENT_NOT_PAID');
    const paid = await h.call(payer, 'POST', `/v1/settlements/${created.id}/payment`, {
      paymentDate: lwd,
      evidenceKey: key('ff-pay-'),
      evidenceReference: 'SYNTH-NEFT-9',
      evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, e)],
      expectedVersion: (await ok<{ version: number }>(await h.call(rel, 'GET', `/v1/settlements/${created.id}`))).version,
    });
    expect(paid.json(), paid.body).toMatchObject({ state: 'PAID' });
    expect((await record(disburser, loanId, { ...viaSettlement, repaidAmount: '4000.00', waivedAmount: '1000.00', waiverKind: 'WAIVER' })).json().error).toBe('SETTLEMENT_RECOVERY_MISMATCH');
    expect((await record(disburser, loanId, viaSettlement)).statusCode).toBe(201);
    expect((await decideRecord(decider, loanId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'CLOSED', outstanding: '0.0000', settledEarly: '5000.0000' });
  });
});
