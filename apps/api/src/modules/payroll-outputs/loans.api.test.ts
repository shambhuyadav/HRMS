// Loans and salary advances over HTTP (FR-034; H3 TN15; C4; DF07). Synthetic employees, amounts and evidence only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  createRun,
  DOCUMENTS,
  evidenceDocument,
  getRun,
  head,
  INPUT_APPROVE,
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
  submitAndApprove,
  taskOf,
  today,
  trailText,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { outstandingLoans } from './loans.js';

const L = (a: string) => `payroll_loan.${a}.loan` as PermissionKey;
const DECIDE: PermissionKey[] = [L('read'), L('decide')];
const DISBURSE: PermissionKey[] = [L('read'), L('disburse')];
const MAKER: PermissionKey[] = [L('read'), L('request'), L('decide')];
const RECOVER: PermissionKey[] = [L('read'), L('recover')];

interface Loan {
  id: string;
  state: string;
  version: number;
  principal: string;
  recovered: string;
  awaitingRecognition: string;
  outstanding: string;
  installments: { sequence: number; dueMonth: string; amount: string }[];
  recoveries: { periodCode: string; amount: string }[];
}

describe.runIf(isModuleActive('payroll-outputs'))('loans and advances (FR-034, TN15)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let inputApprover: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let decider: TestActor;
  let disburser: TestActor;
  let maker: TestActor;
  let recoverer: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const loanOf = async (a: TestActor, id: string) => ok<Loan>(await h.call(a, 'GET', `/v1/payroll-outputs/loans/${id}`));
  const decide = async (a: TestActor, id: string, body: Record<string, unknown>) => {
    const l = await loanOf(decider, id);
    return h.call(a, 'POST', `/v1/payroll-outputs/loans/${id}/decision`, { expectedVersion: l.version, ...body });
  };
  /** An approved recovery input of the month through the core's input approval. */
  const approvedRecovery = async (month: string, employeeId: string, amount: string, over: { period?: string; currency?: string; effectiveDate?: string } = {}) => {
    const batch = await ok<{ id: string; lines: { id: string }[] }>(
      await h.call(preparer, 'POST', `/v1/payroll/periods/${over.period ?? periods[month]}/input-batches`, {
        lines: [{ employeeId, componentCode: 'LN_RECOVERY', inputKind: 'OTHER_INPUT', amount, currencyCode: over.currency ?? 'INR', effectiveDate: over.effectiveDate ?? `${month}-10`, reference: uniq('LOAN-') }],
      }),
      201,
    );
    const b = await ok<{ version: number }>(await h.call(preparer, 'GET', `/v1/payroll/input-batches/${batch.id}`));
    await ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${batch.id}/submit`, { expectedVersion: b.version }));
    const t = ((await h.call(inputApprover, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } | null }[]).find((x) => x.batch?.id === batch.id)!;
    await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${t.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    return { batchId: batch.id, inputId: batch.lines[0]!.id };
  };
  /** The approved recovery input, then the calculated run. */
  const recoveryMonth = async (dept: string, month: string, employeeId: string, amount: string) => {
    await approvedRecovery(month, employeeId, amount);
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    return run.id;
  };
  /** The independent reversal of an approved recovery input (FR-031; DF03). */
  const reverseLine = async (input: { batchId: string; inputId: string }) => {
    const b = await ok<{ version: number }>(await h.call(inputApprover, 'GET', `/v1/payroll/input-batches/${input.batchId}`));
    return h.call(inputApprover, 'POST', `/v1/payroll/input-batches/${input.batchId}/reverse`, { inputIds: [input.inputId], reason: 'Wrong recovery amount (synthetic)', expectedVersion: b.version });
  };
  const borrower = async (code: string) => {
    const dept = await department(code);
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '40000', components: [{ code: 'LN_BASIC', amount: '40000' }] });
    await bankRevision(h, A, e);
    return { dept, e };
  };
  /** A loan approved with the recovery head LN_RECOVERY, due in full this month. */
  const approvedLoan = async (e: string, principal: string) => {
    const req = await ok<{ id: string }>(await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${e}/loans`, { loanKind: 'LOAN', currencyCode: 'INR', principal, purpose: 'Synthetic loan' }), 201);
    const month = (await today(h, A)).slice(0, 7);
    await ok(await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: [{ dueMonth: month, amount: principal }] }));
    return req.id;
  };
  const disburse = async (e: string, loanId: string) =>
    ok(
      await h.call(disburser, 'POST', `/v1/payroll-outputs/loans/${loanId}/disbursement`, {
        disbursementDate: await today(h, A),
        evidenceKey: key('disb-'),
        evidenceReference: 'SYNTH-TRANSFER',
        evidenceDocumentIds: [await evidenceDocument(h, uploader, verifier, e)],
        expectedVersion: (await loanOf(decider, loanId)).version,
      }),
    );
  const disbursedLoan = async (e: string, principal: string) => {
    const id = await approvedLoan(e, principal);
    await disburse(e, id);
    return id;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    inputApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
    disburser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DISBURSE });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: MAKER });
    recoverer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: RECOVER });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_input_batch', [inputApprover]);
    await head(h, configA, configB, { code: 'LN_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'LN_RECOVERY', headType: 'DEDUCTION', basis: 'INPUT', sequence: 2 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('requests, decides independently, disburses on evidence and recovers only from processed payroll (FR-034)', async () => {
    const dept = await department('LN_MAIN');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '50000', components: [{ code: 'LN_BASIC', amount: '50000' }] });
    await bankRevision(h, A, e);
    const me = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: await person(h, A, hr) });

    // TN15 own request: no interest without a configured rate, a configured payroll currency only, idempotent.
    const body = { loanKind: 'LOAN', currencyCode: 'INR', principal: '6000.00', purpose: 'Synthetic household purchase' };
    expect((await h.call(me, 'POST', '/v1/me/loans', { ...body, interestRate: '1.5' })).json().error).toBe('INTEREST_NOT_CONFIGURED');
    expect((await h.call(me, 'POST', '/v1/me/loans', { ...body, currencyCode: 'USD' })).json().error).toBe('CURRENCY_NOT_CONFIGURED');
    const k = key('loan-');
    const req = await ok<{ id: string; state: string; replayed: boolean; outstanding: string }>(await h.call(me, 'POST', '/v1/me/loans', { ...body, idempotencyKey: k }), 201);
    expect(req).toMatchObject({ state: 'REQUESTED', replayed: false, outstanding: '6000.0000' });
    expect((await ok<{ id: string; replayed: boolean }>(await h.call(me, 'POST', '/v1/me/loans', { ...body, idempotencyKey: k }))).id).toBe(req.id);
    // Own records only; another employee sees nothing; the Employee context never decides or reads the Admin list.
    expect((await ok<{ items: unknown[]; interest: { status: string } }>(await h.call(other, 'GET', '/v1/me/loans'))).items).toEqual([]);
    expect((await h.call(other, 'POST', `/v1/me/loans/${req.id}/withdraw`, { reason: 'x', expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(me, 'GET', '/v1/payroll-outputs/loans')).statusCode).toBe(403);
    expect((await h.call(me, 'POST', `/v1/payroll-outputs/loans/${req.id}/decision`, { decision: 'APPROVE', expectedVersion: 1 })).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', `/v1/payroll-outputs/loans/${req.id}`)).statusCode).toBe(403);
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE, departmentFilter: A.dept });
    expect((await h.call(narrow, 'GET', `/v1/payroll-outputs/loans/${req.id}`)).statusCode).toBe(404);
    // The beneficiary never decides, even holding the duty in an Admin assignment.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE, user: me.user });
    expect((await decide(self, req.id, { decision: 'REJECT', reason: 'x' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');

    // Terms: an input-valued deduction head, instalments from the current month on, recovering exactly the principal.
    const sched = [
      { dueMonth: '2026-11', amount: '3000.00' },
      { dueMonth: '2026-12', amount: '3000.00' },
    ];
    expect((await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_BASIC', installments: sched })).json().error).toBe('RECOVERY_HEAD_REQUIRED');
    expect((await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: [sched[0]] })).json().error).toBe('SCHEDULE_NOT_BALANCED');
    expect((await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: [{ dueMonth: '2026-01', amount: '3000.00' }, sched[1]] })).json().error).toBe(
      'INVALID_DUE_MONTH',
    );
    const approved = await ok<Loan>(await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: sched }));
    expect(approved).toMatchObject({ state: 'APPROVED', installments: [{ sequence: 1, dueMonth: '2026-11', amount: '3000.0000' }, { sequence: 2, dueMonth: '2026-12', amount: '3000.0000' }] });
    expect((await decide(decider, req.id, { decision: 'REJECT', reason: 'x' })).json().error).toBe('INVALID_STATE');
    // No schedule edits: the instalments and decision are fixed in the database.
    await expect(h.db.query(`update payroll_loan_installment set amount = 1 where loan_id = $1`, [req.id])).rejects.toThrow();
    await expect(h.db.query(`update payroll_loan set recovery_component_id = null where id = $1`, [req.id])).rejects.toThrow();
    await expect(h.db.query(`update payroll_loan set recovered_amount = 100 where id = $1`, [req.id])).rejects.toThrow(/recognised recoveries/);

    // An Admin-entered request: its maker never decides it; one live loan per recovery head; a rejection needs a reason.
    const adv = await ok<{ id: string }>(await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${e}/loans`, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '1000.00', purpose: 'Synthetic advance' }), 201);
    expect((await decide(maker, adv.id, { decision: 'REJECT', reason: 'x' })).json().error).toBe('NOT_INDEPENDENT');
    expect((await decide(decider, adv.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: [{ dueMonth: '2026-11', amount: '1000.00' }] })).json().error).toBe(
      'RECOVERY_HEAD_IN_USE',
    );
    expect((await decide(decider, adv.id, { decision: 'REJECT' })).json().error).toBe('REASON_REQUIRED');
    expect(await ok<Loan>(await decide(decider, adv.id, { decision: 'REJECT', reason: 'Synthetic: one loan at a time' }))).toMatchObject({ state: 'REJECTED' });

    // Disbursement: only from released, verified evidence, by someone other than the decider; idempotent evidence key.
    const unverified = await evidenceDocument(h, uploader, verifier, e, { verify: false });
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const dk = key('disb-');
    const disburse = async (a: TestActor, over: Record<string, unknown> = {}) => {
      const l = await loanOf(decider, req.id);
      return h.call(a, 'POST', `/v1/payroll-outputs/loans/${req.id}/disbursement`, {
        disbursementDate: '2026-10-20',
        evidenceKey: dk,
        evidenceReference: 'SYNTH-TRANSFER-1',
        evidenceDocumentIds: [doc],
        expectedVersion: l.version,
        ...over,
      });
    };
    const deciderToo = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DISBURSE, user: decider.user });
    expect((await disburse(deciderToo)).json().error).toBe('NOT_INDEPENDENT');
    expect((await disburse(disburser, { evidenceDocumentIds: [unverified] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await disburse(disburser, { disbursementDate: '2099-01-01' })).json().error).toBe('DISBURSEMENT_IN_FUTURE');
    expect(await ok<Loan & { replayed: boolean }>(await disburse(disburser))).toMatchObject({ state: 'DISBURSED', replayed: false, outstanding: '6000.0000' });
    expect((await ok<{ replayed: boolean }>(await disburse(disburser))).replayed).toBe(true);

    // Recovery: never from an unprocessed run; once per processed record; the balance falls; fully recovered closes it.
    const nov = await recoveryMonth(dept, '2026-11', e, '3000.00');
    expect((await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${nov}/loan-recoveries`)).json().error).toBe('RUN_NOT_PROCESSED');
    await submitAndApprove(h, { preparer, reviewer, approver }, nov);
    await processRun(h, processor, nov);
    expect(await ok(await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${nov}/loan-recoveries`))).toMatchObject({ recognised: 1, closed: 0, exceptions: [], done: true });
    expect(await ok(await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${nov}/loan-recoveries`))).toMatchObject({ recognised: 0, done: true });
    expect(await loanOf(decider, req.id)).toMatchObject({ state: 'DISBURSED', recovered: '3000.0000', outstanding: '3000.0000', recoveries: [{ periodCode: '2026-11', amount: '3000.0000' }] });
    // The database binds a recovery to the processed line of the loan's head, at its exact amount, within the balance.
    const rec = await h.one<{ payroll_record_id: string; payroll_line_id: string; run_id: string }>(`select payroll_record_id, payroll_line_id, run_id from payroll_loan_recovery where loan_id = $1`, [req.id]);
    await expect(
      h.db.query(
        `insert into payroll_loan_recovery (company_id, loan_id, employee_id, payroll_record_id, run_id, payroll_line_id, amount, currency_code, recorded_by)
         values ($1, $2, $3, $4, $5, (select id from payroll_line where record_id = $4 and component_id <> (select recovery_component_id from payroll_loan where id = $2) limit 1), 1, 'INR', $6)`,
        [A.id, req.id, e, rec.payroll_record_id, rec.run_id, recoverer.user],
      ),
    ).rejects.toThrow();
    await expect(h.db.query(`update payroll_loan_recovery set amount = 1 where loan_id = $1`, [req.id])).rejects.toThrow();
    const dec = await recoveryMonth(dept, '2026-12', e, '3000.00');
    await submitAndApprove(h, { preparer, reviewer, approver }, dec);
    await processRun(h, processor, dec);
    // Two connections at once: the recovery is recognised once and the loan closed once.
    const both = await Promise.all([0, 1].map(async () => ok<{ recognised: number; closed: number }>(await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${dec}/loan-recoveries`))));
    expect(both.reduce((n, r) => n + r.recognised, 0)).toBe(1);
    expect(both.reduce((n, r) => n + r.closed, 0)).toBe(1);
    // TN15: terms, schedule, recoveries and the remaining balance; no reviewer identities.
    const own = await ok<{ items: (Loan & Record<string, unknown>)[]; interest: { status: string }; earlySettlement: { status: string } }>(await h.call(me, 'GET', '/v1/me/loans'));
    const mine = own.items.find((i) => i.id === req.id)!;
    expect(mine).toMatchObject({ state: 'CLOSED', recovered: '6000.0000', outstanding: '0.0000', installments: [{ dueMonth: '2026-11' }, { dueMonth: '2026-12' }] });
    expect(mine.recoveries.map((r) => r.periodCode)).toEqual(['2026-11', '2026-12']);
    expect(Object.keys(mine)).not.toContain('decidedBy');
    expect(own).toMatchObject({ interest: { status: 'NOT_CONFIGURED' }, earlySettlement: { status: 'NOT_CONFIGURED' } });
    expect(own.items.find((i) => i.id === adv.id)).toMatchObject({ state: 'REJECTED', decisionReason: 'Synthetic: one loan at a time' });
    // The employee withdraws an undecided request of their own only.
    const w = await ok<{ id: string; version: number }>(await h.call(me, 'POST', '/v1/me/loans', { ...body, principal: '500.00' }), 201);
    expect(await ok(await h.call(me, 'POST', `/v1/me/loans/${w.id}/withdraw`, { reason: 'Synthetic: no longer needed', expectedVersion: w.version }))).toMatchObject({ state: 'WITHDRAWN' });

    // No principal, schedule or purpose in operational audit values or the outbox.
    const trail = await trailText(h, A.id);
    for (const t of [trail.operational, trail.outbox]) {
      expect(t).not.toContain('6000');
      expect(t).not.toContain('Synthetic household purchase');
    }
  });

  it('never recognises a recovery above the outstanding balance, keeps other companies out and only moves forward (FR-034)', async () => {
    const dept = await department('LN_OVER');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '40000', components: [{ code: 'LN_BASIC', amount: '40000' }] });
    await bankRevision(h, A, e);
    const req = await ok<{ id: string }>(
      await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${e}/loans`, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '1000.00', purpose: 'Synthetic advance two' }),
      201,
    );

    // Another company's Admin holding every loan duty reads, enters, decides or disburses nothing of this company.
    const B = await h.makeCompany();
    const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...new Set([...MAKER, ...DISBURSE, ...RECOVER])] });
    expect((await h.call(foreign, 'GET', `/v1/payroll-outputs/loans/${req.id}`)).statusCode).toBe(404);
    expect((await h.call(foreign, 'POST', `/v1/payroll-outputs/loans/${req.id}/decision`, { decision: 'REJECT', reason: 'x', expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(foreign, 'POST', `/v1/payroll-outputs/employees/${e}/loans`, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '1.00', purpose: 'x' })).statusCode).toBe(404);
    expect((await ok<{ items: unknown[] }>(await h.call(foreign, 'GET', '/v1/payroll-outputs/loans'))).items).toEqual([]);

    await ok(await decide(decider, req.id, { decision: 'APPROVE', recoveryComponentCode: 'LN_RECOVERY', installments: [{ dueMonth: '2026-11', amount: '1000.00' }] }));
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const disburse = async (a: TestActor, evidenceKey: string) =>
      h.call(a, 'POST', `/v1/payroll-outputs/loans/${req.id}/disbursement`, {
        disbursementDate: '2026-10-21',
        evidenceKey,
        evidenceReference: 'SYNTH-TRANSFER-2',
        evidenceDocumentIds: [doc],
        expectedVersion: (await loanOf(decider, req.id)).version,
      });
    expect((await disburse(foreign, key('disb-'))).statusCode).toBe(404);
    const dk = key('disb-');
    await ok(await disburse(disburser, dk));
    // Recorded once: a second disbursement under another key is refused; a disbursed loan is never cancelled.
    expect((await disburse(disburser, key('disb-'))).json().error).toBe('INVALID_STATE');
    expect((await h.call(decider, 'POST', `/v1/payroll-outputs/loans/${req.id}/cancel`, { reason: 'x', expectedVersion: (await loanOf(decider, req.id)).version })).json().error).toBe('INVALID_STATE');
    await expect(h.db.query(`update payroll_loan set state = 'APPROVED' where id = $1`, [req.id])).rejects.toThrow(/invalid loan transition/);

    // Another company reads nothing of a run either.
    const run = await recoveryMonth(dept, '2026-11', e, '100.00');
    expect((await h.call(foreign, 'POST', `/v1/payroll-outputs/runs/${run}/loan-recoveries`)).statusCode).toBe(404);
  });

  describe('a recovery deduction never exceeds what is outstanding (FR-034)', () => {
    const recognise = async (runId: string) => ok<Record<string, unknown>>(await h.call(recoverer, 'POST', `/v1/payroll-outputs/runs/${runId}/loan-recoveries`));
    const revise = async (runId: string) => {
      const r = await getRun(h, preparer, runId);
      return (await ok<{ id: string }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${runId}/revise`, { reason: 'Wrong recovery input (synthetic)', expectedVersion: r.version }), 201)).id;
    };
    const codes = async (runId: string, e: string) => (await record(h, preparer, runId, e)).exceptions.map((x) => x.code);
    const finish = async (runId: string) => {
      await submitAndApprove(h, { preparer, reviewer, approver }, runId);
      await processRun(h, processor, runId);
    };
    const verify = async (runId: string) => ok<{ identical: boolean }>(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/verify`));

    it('blocks a line above the balance; only reversing the input clears it, and the employee is never wedged', async () => {
      const { dept, e } = await borrower('LN_BLOCK');
      const loanId = await disbursedLoan(e, '1000.00');
      const wrong = await approvedRecovery('2026-03', e, '1500.00');
      const run = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);

      // Calculated, not failed: the figures can be read, and the exception names the head and loan, never an amount.
      const rec = await record(h, preparer, run.id, e);
      expect(rec).toMatchObject({ calculationStatus: 'CALCULATED', deductions: '1500.0000', net: '38500.0000' });
      const blocked = rec.exceptions.find((x) => x.code === 'LOAN_RECOVERY_EXCEEDS_OUTSTANDING')!;
      expect(blocked).toMatchObject({ severity: 'BLOCKING', resolvable: false, detail: { componentCode: 'LN_RECOVERY', loanId } });
      expect(JSON.stringify(blocked.detail)).not.toContain('1500');
      expect(await getRun(h, preparer, run.id)).toMatchObject({ exceptions: { unresolved: 1 } });

      // No note clears it, and approval is refused.
      const noted = await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${blocked.id}/resolve`, { resolution: 'Synthetic note' });
      expect(noted.json().error).toBe('NOT_RESOLVABLE');
      const r = await getRun(h, preparer, run.id);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: r.version }));
      await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
      const approval = await taskOf(h, approver, run.id, 'APPROVAL');
      expect((await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approval}/approve`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('EXCEPTIONS_UNRESOLVED');

      // The input cannot be reversed under the snapshot. A return alone does not help: the same input blocks again.
      expect((await reverseLine(wrong)).json().error).toBe('RUN_IN_PROGRESS');
      const returned = await ok<{ nextRunId: string }>(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approval}/approve`, { decision: 'RETURN', reason: 'Recovery above the balance (synthetic)', idempotencyKey: key() }));
      await calculate(h, preparer, returned.nextRunId);
      expect(await codes(returned.nextRunId, e)).toContain('LOAN_RECOVERY_EXCEEDS_OUTSTANDING');

      // Returned again, reversed and re-entered: the employee is paid with the right recovery.
      const third = await revise(returned.nextRunId);
      await ok(await reverseLine(wrong));
      await approvedRecovery('2026-03', e, '1000.00');
      await calculate(h, preparer, third);
      expect(await codes(third, e)).toEqual(expect.not.arrayContaining(['LOAN_RECOVERY_EXCEEDS_OUTSTANDING', 'LOAN_RECOVERY_NOT_DISBURSED']));
      await finish(third);
      expect(await recognise(third)).toMatchObject({ recognised: 1, closed: 1, exceptions: [] });
      expect(await loanOf(decider, loanId)).toMatchObject({ state: 'CLOSED', recovered: '1000.0000', awaitingRecognition: '0.0000', outstanding: '0.0000' });
    });

    it('nets off what is processed but not yet recognised: two consecutive runs never together exceed the balance', async () => {
      const { dept, e } = await borrower('LN_TWICE');
      const loanId = await disbursedLoan(e, '1000.00');
      const march = await recoveryMonth(dept, '2026-03', e, '600.00');
      // Calculated, not processed: no balance has moved, and a returned revision never moves one.
      expect(await loanOf(decider, loanId)).toMatchObject({ awaitingRecognition: '0.0000', outstanding: '1000.0000' });
      await finish(march);
      // Processed and not recognised: every balance read is already net of it, the settlement's too.
      expect(await loanOf(decider, loanId)).toMatchObject({ recovered: '0.0000', awaitingRecognition: '600.0000', outstanding: '400.0000' });
      expect(await outstandingLoans(h.pool, A.id, e)).toEqual([expect.objectContaining({ id: loanId, principal: '1000.0000', recovered: '0.0000', awaitingRecognition: '600.0000', outstanding: '400.0000' })]);

      const wrong = await approvedRecovery('2026-04', e, '600.00');
      const april = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
      await calculate(h, preparer, april.id);
      expect(await codes(april.id, e)).toContain('LOAN_RECOVERY_EXCEEDS_OUTSTANDING');
      // The exception reads live balances; the rerun-identical check compares the snapshot's lines only, before and
      // after the balance moves.
      expect(await verify(april.id)).toMatchObject({ identical: true });
      expect(await recognise(march)).toMatchObject({ recognised: 1, closed: 0 });
      expect(await verify(april.id)).toMatchObject({ identical: true });
      // Recognising moves the amount, not the balance.
      expect(await loanOf(decider, loanId)).toMatchObject({ recovered: '600.0000', awaitingRecognition: '0.0000', outstanding: '400.0000' });

      // Exactly the balance passes.
      const next = await revise(april.id);
      await ok(await reverseLine(wrong));
      await approvedRecovery('2026-04', e, '400.00');
      await calculate(h, preparer, next);
      expect(await codes(next, e)).toEqual(expect.not.arrayContaining(['LOAN_RECOVERY_EXCEEDS_OUTSTANDING']));
      await finish(next);
      expect(await loanOf(decider, loanId)).toMatchObject({ awaitingRecognition: '400.0000', outstanding: '0.0000' });
      expect(await recognise(next)).toMatchObject({ recognised: 1, closed: 1 });
      expect(await outstandingLoans(h.pool, A.id, e)).toEqual([]);
    });

    it('checks again at processing: runs calculated together cannot both take the same balance', async () => {
      const { dept, e } = await borrower('LN_FLIGHT');
      const loanId = await disbursedLoan(e, '1000.00');
      const may = await recoveryMonth(dept, '2026-05', e, '800.00');
      const june = await recoveryMonth(dept, '2026-06', e, '800.00');
      for (const run of [may, june]) expect(await codes(run, e)).toEqual(expect.not.arrayContaining(['LOAN_RECOVERY_EXCEEDS_OUTSTANDING']));
      await submitAndApprove(h, { preparer, reviewer, approver }, may);
      await submitAndApprove(h, { preparer, reviewer, approver }, june);
      await processRun(h, processor, may);
      // The second processing is refused before anything is frozen; the processor returns it for a new revision.
      const approved = await getRun(h, processor, june);
      const refused = await h.call(processor, 'POST', `/v1/payroll/runs/${june}/process`, { expectedVersion: approved.version });
      expect([refused.statusCode, refused.json().error, refused.json().details]).toEqual([409, 'LOAN_BALANCE_CHANGED', { records: 1 }]);
      expect(await getRun(h, processor, june)).toMatchObject({ state: 'APPROVED', progress: { processing: { started: false, frozen: 0 } } });
      expect(await loanOf(decider, loanId)).toMatchObject({ awaitingRecognition: '800.0000', outstanding: '200.0000' });
      const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${june}/return`, { reason: 'Balance changed (synthetic)', expectedVersion: approved.version }), 201);
      await calculate(h, preparer, next.id);
      expect(await codes(next.id, e)).toContain('LOAN_RECOVERY_EXCEEDS_OUTSTANDING');
    });

    it('needs a disbursed loan behind a deduction on its head; a head without a decided loan is an ordinary input', async () => {
      // Approved, not disbursed: nothing is outstanding yet. Once disbursed, a new revision passes without any reversal.
      const approvedOnly = await borrower('LN_NOT_DISB');
      const loanId = await approvedLoan(approvedOnly.e, '1000.00');
      const run = await recoveryMonth(approvedOnly.dept, '2026-07', approvedOnly.e, '100.00');
      const rec = await record(h, preparer, run, approvedOnly.e);
      expect(rec).toMatchObject({ calculationStatus: 'CALCULATED' });
      expect(rec.exceptions.find((x) => x.code === 'LOAN_RECOVERY_NOT_DISBURSED')).toMatchObject({ severity: 'BLOCKING', resolvable: false, detail: { componentCode: 'LN_RECOVERY', loanId, loanState: 'APPROVED' } });
      const next = await revise(run);
      await disburse(approvedOnly.e, loanId);
      await calculate(h, preparer, next);
      expect(await codes(next, approvedOnly.e)).not.toContain('LOAN_RECOVERY_NOT_DISBURSED');

      // Approved and cancelled before disbursement: never lent, so never recovered.
      const cancelled = await borrower('LN_CANCELLED');
      const c = await approvedLoan(cancelled.e, '1000.00');
      await ok(await h.call(decider, 'POST', `/v1/payroll-outputs/loans/${c}/cancel`, { reason: 'Not needed (synthetic)', expectedVersion: (await loanOf(decider, c)).version }));
      const cRun = await recoveryMonth(cancelled.dept, '2026-07', cancelled.e, '100.00');
      expect((await record(h, preparer, cRun, cancelled.e)).exceptions.find((x) => x.code === 'LOAN_RECOVERY_NOT_DISBURSED')).toMatchObject({ detail: { loanId: c, loanState: 'CANCELLED' } });

      // No loan at all, or an undecided request (which has no recovery head): an ordinary deduction, untouched.
      const plain = await borrower('LN_PLAIN');
      const requested = await borrower('LN_REQUESTED');
      await ok(await h.call(maker, 'POST', `/v1/payroll-outputs/employees/${requested.e}/loans`, { loanKind: 'ADVANCE', currencyCode: 'INR', principal: '50.00', purpose: 'Synthetic request' }), 201);
      for (const p of [plain, requested]) {
        const r = await recoveryMonth(p.dept, '2026-07', p.e, '700.00');
        const view = await record(h, preparer, r, p.e);
        expect(view.deductions).toBe('700.0000');
        expect(view.exceptions.filter((x) => x.code.startsWith('LOAN_RECOVERY'))).toEqual([]);
      }
    });

    it('takes a live loan over a closed one on the same head, and a closed loan alone leaves nothing to recover', async () => {
      const { dept, e } = await borrower('LN_NEXT');
      const first = await disbursedLoan(e, '500.00');
      const march = await recoveryMonth(dept, '2026-08', e, '500.00');
      await finish(march);
      expect(await recognise(march)).toMatchObject({ recognised: 1, closed: 1 });
      // Closed: its balance is nil, so a further deduction on the head is refused (the loan is named).
      const run = await recoveryMonth(dept, '2026-09', e, '100.00');
      expect((await record(h, preparer, run, e)).exceptions.find((x) => x.code === 'LOAN_RECOVERY_NOT_DISBURSED')).toMatchObject({ detail: { loanId: first, loanState: 'CLOSED' } });
      // A new loan on the same head: it governs, and the closed loan's recognised line is not counted against it.
      const second = await disbursedLoan(e, '300.00');
      expect(await loanOf(decider, second)).toMatchObject({ awaitingRecognition: '0.0000', outstanding: '300.0000' });
      const next = await revise(run);
      await calculate(h, preparer, next);
      expect(await codes(next, e)).toEqual(expect.not.arrayContaining(['LOAN_RECOVERY_NOT_DISBURSED', 'LOAN_RECOVERY_EXCEEDS_OUTSTANDING']));
      await finish(next);
      expect(await loanOf(decider, second)).toMatchObject({ awaitingRecognition: '100.0000', outstanding: '200.0000' });
      expect(await recognise(next)).toMatchObject({ recognised: 1, closed: 0 });
      expect(await loanOf(decider, first)).toMatchObject({ state: 'CLOSED', recovered: '500.0000' });
    });

    it('does not take a deduction processed before the disbursement for a recovery', async () => {
      const { dept, e } = await borrower('LN_EARLIER');
      const earlier = await recoveryMonth(dept, '2026-10', e, '300.00');
      await finish(earlier);
      const loanId = await disbursedLoan(e, '1000.00');
      expect(await loanOf(decider, loanId)).toMatchObject({ awaitingRecognition: '0.0000', outstanding: '1000.0000' });
      expect(await recognise(earlier)).toMatchObject({ recognised: 0, exceptions: [] });
      expect(await loanOf(decider, loanId)).toMatchObject({ recovered: '0.0000', recoveries: [] });
    });

    it('blocks a deduction in another currency than the loan, which could never be recognised', async () => {
      const { periods: usd } = await calendar(h, configA, configB, [{ code: 'USD-2026-05', start: '2026-05-01', end: '2026-05-31' }], { currency: 'USD' });
      const dept = await department('LN_USD');
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
      await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '4000', currency: 'USD', components: [{ code: 'LN_BASIC', amount: '4000' }] });
      await disbursedLoan(e, '1000.00');
      await approvedRecovery('USD-2026-05', e, '10.00', { period: usd['USD-2026-05']!, currency: 'USD', effectiveDate: '2026-05-10' });
      const run = await createRun(h, preparer, usd['USD-2026-05']!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      expect(await codes(run.id, e)).toContain('LOAN_RECOVERY_CURRENCY_MISMATCH');
    });

    it('still reports and refuses a line above the balance that a run processed before this check left behind', async () => {
      const { dept, e } = await borrower('LN_LEGACY');
      const loanId = await disbursedLoan(e, '2000.00');
      const run = await recoveryMonth(dept, '2026-11', e, '1500.00');
      await finish(run);
      // The state such a run could leave: a balance of 1,000 under a processed 1,500 line, written past the loan's
      // guard because no route can produce it any more.
      await h.db.query('begin');
      await h.db.query('alter table payroll_loan disable trigger payroll_loan_guard');
      await h.db.query(`update payroll_loan set recovered_amount = 1000 where id = $1`, [loanId]);
      await h.db.query('alter table payroll_loan enable trigger payroll_loan_guard');
      await h.db.query('commit');
      for (let i = 0; i < 2; i++) {
        expect(await recognise(run)).toMatchObject({ recognised: 0, closed: 0, exceptions: [{ loanId, code: 'RECOVERY_EXCEEDS_OUTSTANDING' }], remaining: 0, done: true });
      }
      // The read never goes below nil; the next deduction on this loan is refused until the correction is settled.
      expect(await loanOf(decider, loanId)).toMatchObject({ state: 'DISBURSED', recovered: '1000.0000', awaitingRecognition: '1500.0000', outstanding: '0.0000', recoveries: [] });
      const line = await h.one<{ id: string; record_id: string }>(
        `select pl.id, pl.record_id from payroll_line pl join payroll_record r on r.id = pl.record_id
          where r.run_id = $1 and r.employee_id = $2 and pl.component_id = (select recovery_component_id from payroll_loan where id = $3)`,
        [run, e, loanId],
      );
      await expect(
        h.db.query(
          `insert into payroll_loan_recovery (company_id, loan_id, employee_id, payroll_record_id, run_id, payroll_line_id, amount, currency_code, recorded_by)
           values ($1, $2, $3, $4, $5, $6, 1500, 'INR', $7)`,
          [A.id, loanId, e, line.record_id, run, line.id, recoverer.user],
        ),
      ).rejects.toThrow(/outstanding balance/);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_loan_recovery where loan_id = $1`, [loanId])).n).toBe(0);
    });
  });

  it('pages the loan list with the total of every loan in scope, never the caller’s own (FR-056)', async () => {
    const dept = await department('LN_PAGE');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    const me = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    for (let i = 0; i < 27; i++) {
      await ok(await h.call(me, 'POST', '/v1/me/loans', { loanKind: 'ADVANCE', currencyCode: 'INR', principal: `${100 + i}.00`, purpose: `Synthetic request ${i}` }), 201);
    }
    type Loans = { items: { id: string; employeeId: string }[]; total: number; page?: number; pageSize?: number };
    const list = (q: string, a: TestActor = decider) => h.call(a, 'GET', `/v1/payroll-outputs/loans?employeeId=${e}${q}`).then((r) => ok<Loans>(r));
    const all = await list('');
    expect(all.total).toBe(27);
    expect(all.items).toHaveLength(27);
    expect(all).not.toHaveProperty('page');
    const p1 = await list('&page=1&pageSize=25');
    const p2 = await list('&page=2&pageSize=25');
    expect(p1).toMatchObject({ total: 27, page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(p2).toMatchObject({ total: 27, page: 2, pageSize: 25 });
    expect(p2.items).toHaveLength(2);
    // The pages continue the same newest-first order without overlap.
    expect([...p1.items, ...p2.items].map((x) => x.id)).toEqual(all.items.map((x) => x.id));
    expect(await list('&page=3&pageSize=25')).toEqual({ items: [], total: 27, page: 3, pageSize: 25 });
    // Row scope applies to the total; the beneficiary's own Admin assignment never lists their own loans.
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE, departmentFilter: A.dept });
    expect(await list('&page=1&pageSize=25', narrow)).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE, user: me.user });
    expect((await list('&page=1&pageSize=25', self)).total).toBe(0);
  });
});
