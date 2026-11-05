// BR-050, BR-051 and BR-052 (BRD lines 1915-1919) and ZT38 hold and bank output (line 5444), each from its own text. Amounts are worked by
// hand: for every record, earned = held + reserved + paid + ready. Runs against the real routes and database; each database refusal is a
// direct write, so the database is saying no. Synthetic employees, banks, accounts and amounts only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  approvedExit,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  createRun,
  CRITERIA,
  criterion as activeCriterion,
  DOCUMENTS,
  evidenceDocument,
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
  submitAndApprove,
  verifiedBank,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

const BANK_REVIEW = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'] as const;
const T_AUTHOR: PermissionKey[] = ['payroll_bank_template.manage.operational'];
const T_APPROVER: PermissionKey[] = ['payroll_bank_template.read.operational', 'payroll_bank_template.validate.operational', 'payroll_bank_template.activate.operational'];
const B_PREPARE: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.prepare.amount'];
const B_AUTHORIZE: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.authorize.amount', 'payroll_bank.download.bank'];
const B_OUTCOME: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.record_outcome.amount'];

/** A synthetic delimited layout (a test transcription, not any bank's specification). */
const DEF = {
  layout: 'DELIMITED',
  delimiter: 'COMMA',
  lineEnding: 'LF',
  amountDecimals: 2,
  decimalSeparator: '.',
  dateFormat: 'YYYYMMDD',
  fileExtension: 'csv',
  header: [{ source: 'LITERAL', value: 'H' }, { source: 'BATCH_REFERENCE' }, { source: 'PAYMENT_DATE' }],
  detail: [{ source: 'LITERAL', value: 'D' }, { source: 'ALLOCATION_KEY' }, { source: 'HOLDER_NAME', maxLength: 40 }, { source: 'ACCOUNT_IDENTIFIER' }, { source: 'ROUTING_REFERENCE' }, { source: 'AMOUNT' }, { source: 'CURRENCY_CODE' }],
  trailer: [{ source: 'LITERAL', value: 'T' }, { source: 'RECORD_COUNT' }, { source: 'TOTAL_AMOUNT' }],
};

interface Line {
  id: string;
  allocationKey: string;
  employeeId: string;
  holdId: string | null;
  amount: string;
  paymentState: string;
}

describe.runIf(isModuleActive('payroll-outputs'))('holds and bank output, from the rules', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let bankReviewer: TestActor;
  let author: TestActor;
  let tApprover: TestActor;
  let bankPrep: TestActor;
  let bankAuth: TestActor;
  let bankAuth2: TestActor;
  let outcomes: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let releaser: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;
  let templateId: string;
  let policy: string;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount: string, bank: 'VERIFIED' | 'UNVERIFIED' | 'INVALID' | 'NONE' = 'VERIFIED') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: amount, components: [{ code: 'HB_BASIC', amount }] });
    if (bank === 'VERIFIED') await verifiedBank(h, A, bankReviewer, e);
    else if (bank === 'UNVERIFIED') await bankRevision(h, A, e);
    else if (bank === 'INVALID') await bankRevision(h, A, e, { valid: false });
    return e;
  };
  const processed = async (month: string, dept: string, employees: string[]) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    const ids: Record<string, string> = {};
    for (const e of employees) ids[e] = (await record(h, processor, run.id, e)).id;
    return { runId: run.id, records: ids };
  };
  const activeTemplate = async (code: string, def: object, currencyCode = 'INR') => {
    const t = await ok<{ id: string; version: number }>(
      await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', { templateCode: code, name: 'Synthetic test layout', currencyCode, bankSpecificationReference: 'SYNTH-SPEC-REF-1', testOnly: true, formatDefinition: def }),
      201,
    );
    const sample = await ok<{ sampleHash: string }>(await h.call(tApprover, 'GET', `/v1/payroll-outputs/bank-templates/${t.id}/sample`));
    const v = await ok<{ version: number }>(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: sample.sampleHash, validationReference: 'SYNTH-BANK-ACCEPTANCE', expectedVersion: t.version }));
    await ok(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: v.version }));
    return t.id;
  };
  const holdBody = (extra: Record<string, unknown>) => ({
    scope: 'FULL',
    reason: 'Synthetic contractual hold reason',
    effectiveDate: '2099-01-01',
    reviewDueOn: '2099-01-10',
    releaseCriterion: 'Synthetic release condition met',
    evidenceReference: 'SYNTH-HOLD-CASE',
    ...extra,
  });
  const propose = (recordId: string, body: Record<string, unknown>) => h.call(maker, 'POST', `/v1/payroll/records/${recordId}/holds`, holdBody(body));
  const holdTask = async (a: TestActor, holdId: string) => ((await h.call(a, 'GET', '/v1/payroll/holds/tasks/mine')).json().items as { taskId: string; hold: { id: string } | null }[]).find((x) => x.hold?.id === holdId)?.taskId;
  const holdOf = async (id: string) => ok<{ id: string; state: string; version: number; holdAmount: string; record: { payable: string; held: string; unreserved: string } }>(await h.call(releaser, 'GET', `/v1/payroll/holds/${id}`));
  const activeHold = async (recordId: string, employee: string, body: Record<string, unknown>) => {
    const doc = await evidenceDocument(h, uploader, verifier, employee);
    const proposal = await ok<{ id: string }>(await propose(recordId, { criterionId: policy, evidenceDocumentIds: [doc], ...body }), 201);
    await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${(await holdTask(decider, proposal.id))!}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    return proposal.id;
  };
  const release = async (holdId: string) =>
    ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${holdId}/release`, { reason: 'Release condition met (synthetic)', evidenceReference: 'SYNTH-RELEASE-1', expectedVersion: (await holdOf(holdId)).version }));
  const holdsOn = async (recordId: string) => (await h.db.query<{ id: string; hold_kind: string; state: string; hold_amount: string; reason_code: string }>(`select id, hold_kind, state, hold_amount, reason_code from payroll_hold where payroll_record_id = $1 order by created_at`, [recordId])).rows;
  const prepare = (runId: string, body: Record<string, unknown> = {}) => h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${runId}/bank-manifests`, { templateId, ...body });
  const lines = async (batchId: string) => (await ok<{ items: Line[] }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${batchId}/lines`))).items;
  const authorize = async (a: TestActor, batchId: string) => {
    const b = await ok<{ version: number }>(await h.call(a, 'GET', `/v1/payroll-outputs/bank-manifests/${batchId}`));
    return h.call(a, 'POST', `/v1/payroll-outputs/bank-manifests/${batchId}/authorize`, { expectedVersion: b.version });
  };
  const issueAndRead = async (a: TestActor, batchId: string) => {
    await ok(await h.call(a, 'POST', `/v1/payroll-outputs/bank-manifests/${batchId}/issue`));
    const file = await h.call(a, 'GET', `/v1/payroll-outputs/bank-manifests/${batchId}/file`);
    expect(file.statusCode, file.body).toBe(200);
    return file.body.trim().split('\n');
  };
  const outcome = (batchId: string, list: { lineId: string; outcome: string; eventKey?: string }[]) =>
    h.call(outcomes, 'POST', `/v1/payroll-outputs/bank-manifests/${batchId}/outcomes`, { outcomes: list.map((o) => ({ eventKey: key('ev-'), ...o, evidenceReference: 'SYNTH-BANK-STATEMENT-1' })) });
  const position = async (recordId: string) => {
    const p = await ok<{ earned: string; held: string; reserved: string; paid: string; ready: string }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/records/${recordId}/payment`));
    return { earned: p.earned, held: p.held, reserved: p.reserved, paid: p.paid, ready: p.ready };
  };
  const figures = (earned: string, held: string, reserved: string, paid: string, ready: string) => ({ earned, held, reserved, paid, ready });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    bankReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...BANK_REVIEW] });
    author = await h.actor(A, 'TREASURY_OPERATOR', { extra: T_AUTHOR });
    tApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: T_APPROVER });
    // The preparer also holds the authorisation and outcome duties, so independence (not the grant) refuses them.
    bankPrep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(B_PREPARE, B_OUTCOME, ['payroll_bank.authorize.amount']) });
    bankAuth = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    bankAuth2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    outcomes = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME });
    // The maker could decide in principle; only independence keeps it from its own proposal.
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(HOLD_PROPOSE, HOLD_DECIDE) });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_DECIDE });
    releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await reviewers(h, hr, 'payroll_hold', [maker, decider]);
    await head(h, configA, configB, { code: 'HB_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    templateId = await activeTemplate('HB_CSV', DEF);
    policy = await activeCriterion(h, configA, configB, { scopeMode: 'FULL_OR_PARTIAL', maxReviewDays: 30 });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('holds are separate from earned salary (BR-050)', () => {
    it('BR-050: a hold needs an activated policy: none, an unknown one and a draft one are all refused', async () => {
      const dept = await department('BR50_POLICY');
      const e = await paid(dept, '30000');
      const { records } = await processed('2026-01', dept, [e]);
      const doc = await evidenceDocument(h, uploader, verifier, e);
      expect((await propose(records[e]!, { criterionId: randomUUID(), evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
      const draft = await ok<{ id: string }>(
        await h.call(configA, 'POST', '/v1/payroll/hold-criteria', { code: 'BR50_DRAFT', category: 'CONTRACTUAL', applicability: 'Synthetic', scopeMode: 'FULL_OR_PARTIAL', maxReviewDays: 30, evidenceReference: 'SYNTH-1', validationReference: 'SYNTH-2' }),
        201,
      );
      expect((await propose(records[e]!, { criterionId: draft.id, evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
      expect(await holdsOn(records[e]!)).toEqual([]);
    });

    it('BR-050: a hold needs a positive amount within the unpaid unreserved balance, a review date and a release criterion, in the record’s currency', async () => {
      const dept = await department('BR50_FIELDS');
      const e = await paid(dept, '30000');
      const { records } = await processed('2026-02', dept, [e]);
      const recordId = records[e]!;
      const doc = await evidenceDocument(h, uploader, verifier, e);
      const base = { criterionId: policy, evidenceDocumentIds: [doc] };
      const partial = (amount: string) => propose(recordId, { ...base, scope: 'PARTIAL', amount });
      expect((await partial('0')).json().error).toBe('INVALID_AMOUNT');
      expect((await partial('-1')).statusCode).toBe(400);
      expect((await partial('30000.01')).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
      // Each required field: the request is refused without it.
      for (const field of ['reviewDueOn', 'releaseCriterion']) {
        const { [field]: _dropped, ...body } = holdBody({ ...base, scope: 'PARTIAL', amount: '100.00' }) as Record<string, unknown>;
        expect((await h.call(maker, 'POST', `/v1/payroll/records/${recordId}/holds`, body)).statusCode, field).toBe(400);
      }
      expect((await propose(recordId, { ...base, scope: 'PARTIAL', amount: '100.00', releaseCriterion: '   ' })).json().error).toBe('RELEASE_CRITERION_REQUIRED');
      // A review date past the criterion's interval.
      expect((await propose(recordId, { ...base, scope: 'PARTIAL', amount: '100.00', reviewDueOn: '2099-03-01' })).json().error).toBe('REVIEW_DATE_INVALID');
      expect(await holdsOn(recordId)).toEqual([]);
      // Exactly the whole balance is the upper edge, in the record's currency.
      const whole = await ok<{ id: string; holdAmount: string; record: { unreserved: string } }>(await partial('30000.00'), 201);
      expect(whole).toMatchObject({ holdAmount: '30000.0000', record: { unreserved: '0.0000' } });
      expect((await h.one<{ currency_code: string }>(`select currency_code from payroll_hold where id = $1`, [whole.id])).currency_code).toBe('INR');
      // Reserved by the proposal, so nothing further fits.
      expect((await partial('0.01')).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
      // The database refuses another currency whatever the path, on a new hold and on this one.
      await expect(h.db.query(`update payroll_hold set currency_code = 'USD' where id = $1`, [whole.id])).rejects.toThrow(/a hold case is immutable/);
      const directHold = async (currency: string) => {
        const tx = (await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'payroll_hold', $2, 'APPROVED_ACTIVE') returning id`, [A.id, e])).id;
        return h.db.query(
          `insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, policy_revision, reason_code, scope, hold_amount, currency_code,
                                     state, proposed_by, effective_date, review_due_on, release_criterion, evidence_reference)
           select company_id, employee_id, id, run_id, $2, 'PAYMENT_SAFETY_BLOCK', 'H2_BANK_SAFETY', 'BANK_MISSING', 'FULL', 1, $3, 'APPROVED_ACTIVE', $4, '2099-01-01', '2099-01-10', 'x', 'x' from payroll_record where id = $1`,
          [recordId, tx, currency, maker.user],
        );
      };
      await h.db.query('begin');
      try {
        await h.db.query('savepoint own_currency');
        // Control: in the record's own currency this write is accepted, so it is the currency being refused.
        expect((await directHold('INR')).rowCount).toBe(1);
        await h.db.query('rollback to savepoint own_currency');
        await expect(directHold('USD')).rejects.toThrow(/a hold is in the currency of its payroll record/);
      } finally {
        await h.db.query('rollback');
      }
    });

    it('BR-050: a hold takes effect only by independent approval: the maker gets no task, even holding the duty', async () => {
      const dept = await department('BR50_INDEP');
      const e = await paid(dept, '20000');
      const { records } = await processed('2026-03', dept, [e]);
      const doc = await evidenceDocument(h, uploader, verifier, e);
      const proposal = await ok<{ id: string; state: string }>(await propose(records[e]!, { criterionId: policy, scope: 'PARTIAL', amount: '500.00', evidenceDocumentIds: [doc] }), 201);
      expect(proposal.state).toBe('PROPOSED');
      expect(await holdTask(maker, proposal.id)).toBeUndefined();
      const task = (await holdTask(decider, proposal.id))!;
      expect((await h.call(maker, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(404);
      expect((await holdOf(proposal.id)).state).toBe('PROPOSED');
      await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
      expect((await holdOf(proposal.id)).state).toBe('APPROVED_ACTIVE');
      expect((await h.one<{ proposed_by: string; approved_by: string }>(`select proposed_by, approved_by from payroll_hold where id = $1`, [proposal.id]))).toEqual({ proposed_by: maker.user, approved_by: decider.user });
    });

    it('BR-050: a hold preserves the liability and erases nothing: the record is unchanged and the released amount is paid in full', async () => {
      const dept = await department('BR50_LIABILITY');
      const e = await paid(dept, '30000');
      const { runId, records } = await processed('2026-04', dept, [e]);
      const recordId = records[e]!;
      const before = await record(h, processor, runId, e);
      const holdId = await activeHold(recordId, e, { scope: 'PARTIAL', amount: '1000.00' });
      expect(await position(recordId)).toEqual(figures('30000.0000', '1000.0000', '0.0000', '0.0000', '29000.0000'));
      expect(await record(h, processor, runId, e)).toEqual(before);
      await release(holdId);
      expect(await position(recordId)).toEqual(figures('30000.0000', '0.0000', '0.0000', '0.0000', '30000.0000'));
      expect(await record(h, processor, runId, e)).toEqual(before);
      // The released thousand is its own allocation beside the rest; together they are the whole salary.
      const b = await ok<{ id: string; totalAmount: string }>(await prepare(runId), 201);
      expect(b.totalAmount).toBe('30000.0000');
      expect((await lines(b.id)).map((l) => [l.holdId, l.amount]).sort()).toEqual(
        [
          [holdId, '1000.0000'],
          [null, '29000.0000'],
        ].sort(),
      );
    });
  });

  describe('safety blocks, separation and legal holds (BR-051)', () => {
    it('BR-051: an unknown or invalid bank instruction places a safety block, not a forfeiture: the salary stays owed and is paid once the block is released', async () => {
      const dept = await department('BR51_BLOCK');
      const missing = await paid(dept, '10000', 'NONE');
      const invalid = await paid(dept, '11000', 'INVALID');
      const unverified = await paid(dept, '12000', 'UNVERIFIED');
      const { runId, records } = await processed('2026-05', dept, [missing, invalid, unverified]);
      const kinds = async (e: string) => (await holdsOn(records[e]!)).map((x) => [x.hold_kind, x.state, x.reason_code, x.hold_amount]);
      expect(await kinds(missing)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_MISSING', '10000.0000']]);
      expect(await kinds(invalid)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_INVALID', '11000.0000']]);
      expect(await kinds(unverified)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_UNVERIFIED', '12000.0000']]);
      // Earned in full, all of it held, none of it gone.
      expect(await record(h, processor, runId, missing)).toMatchObject({ net: '10000.0000', earnings: '10000.0000', calculationStatus: 'CALCULATED' });
      expect(await position(records[missing]!)).toEqual(figures('10000.0000', '10000.0000', '0.0000', '0.0000', '0.0000'));
      // Once the instruction is verified and the block released, the same amount is payable and goes into a file.
      const blockId = (await holdsOn(records[unverified]!))[0]!.id;
      await release(blockId);
      expect(await position(records[unverified]!)).toEqual(figures('12000.0000', '0.0000', '0.0000', '0.0000', '12000.0000'));
      const b = await ok<{ id: string; totalAmount: string }>(await prepare(runId), 201);
      expect((await lines(b.id)).map((l) => [l.employeeId, l.holdId, l.amount])).toEqual([[unverified, blockId, '12000.0000']]);
      await ok(await h.call(bankPrep, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/cancel`, { reason: 'Synthetic: end of the check', expectedVersion: (await ok<{ version: number }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${b.id}`))).version }));
    });

    it('BR-051: a separation before the service period excludes the employee; one inside it prorates what was earned, with nothing forfeited', async () => {
      const dept = await department('BR51_LEAVER');
      const stays = await paid(dept, '31000');
      const leftBefore = await paid(dept, '31000');
      const leavesInside = await paid(dept, '31000');
      await approvedExit(h, A, leftBefore, '2026-05-01', '2026-06-30');
      await approvedExit(h, A, leavesInside, '2026-06-20', '2026-07-12');
      const preview = await ok<{ members: { employeeId: string }[] }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: periods['2026-07'], departmentIds: [dept] }));
      expect(preview.members.map((m) => m.employeeId).sort()).toEqual([stays, leavesInside].sort());
      const { runId, records } = await processed('2026-07', dept, [stays, leavesInside]);
      expect((await h.call(processor, 'GET', `/v1/payroll/runs/${runId}/records/${leftBefore}`)).statusCode).toBe(404);
      // 12 of July's 31 days: 31000 x 12 / 31 = 12000.
      expect(await record(h, processor, runId, leavesInside)).toMatchObject({ paidUnits: '12.0000', earnings: '12000.0000', net: '12000.0000' });
      expect(await position(records[leavesInside]!)).toEqual(figures('12000.0000', '0.0000', '0.0000', '0.0000', '12000.0000'));
      expect(await holdsOn(records[leavesInside]!)).toEqual([]);
      expect(await record(h, processor, runId, stays)).toMatchObject({ earnings: '31000.0000' });
    });

    it('BR-051: a legal or disciplinary hold is disabled by default and needs a privately validated policy, independently activated', async () => {
      // A company that has configured nothing has no criterion of any kind.
      const fresh = await h.makeCompany();
      const freshAdmin = await h.actor(fresh, 'HR_ADMINISTRATOR', { extra: CRITERIA });
      expect((await ok<{ items: unknown[] }>(await h.call(freshAdmin, 'GET', '/v1/payroll/hold-criteria'))).items).toEqual([]);
      const spec = { code: 'BR51_LEGAL', category: 'LEGAL_DISCIPLINARY', applicability: 'Synthetic legal direction', scopeMode: 'FULL_ONLY', maxReviewDays: 15, evidenceReference: 'SYNTH-DIRECTION-1' };
      // No validation reference, no policy.
      expect((await h.call(configA, 'POST', '/v1/payroll/hold-criteria', spec)).statusCode).toBe(400);
      const draft = await ok<{ id: string; version: number }>(await h.call(configA, 'POST', '/v1/payroll/hold-criteria', { ...spec, validationReference: 'SYNTH-COUNSEL-REVIEW-1' }), 201);
      const dept = await department('BR51_LEGAL');
      const e = await paid(dept, '15000');
      const { records } = await processed('2026-08', dept, [e]);
      const doc = await evidenceDocument(h, uploader, verifier, e);
      expect((await propose(records[e]!, { criterionId: draft.id, evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
      expect((await h.call(configA, 'POST', `/v1/payroll/hold-criteria/${draft.id}/activate`, { expectedVersion: draft.version })).json().error).toBe('SELF_APPROVAL');
      await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${draft.id}/activate`, { expectedVersion: draft.version }));
      await ok(await propose(records[e]!, { criterionId: draft.id, evidenceDocumentIds: [doc] }), 201);
    });
  });

  describe('final bank files (BR-052)', () => {
    it('BR-052: a final file holds payable READY allocations only: held and blocked salaries are not in it', async () => {
      const dept = await department('BR52_READY');
      const ready = await paid(dept, '30000');
      const blocked = await paid(dept, '20000', 'UNVERIFIED');
      const heldFully = await paid(dept, '25000');
      const { runId, records } = await processed('2026-09', dept, [ready, blocked, heldFully]);
      await activeHold(records[heldFully]!, heldFully, { scope: 'FULL' });
      const b = await ok<{ id: string; lineCount: number; totalAmount: string; state: string }>(await prepare(runId), 201);
      expect(b).toMatchObject({ state: 'VALIDATED', lineCount: 1, totalAmount: '30000.0000' });
      const ls = await lines(b.id);
      expect(ls.map((l) => [l.employeeId, l.paymentState, l.amount])).toEqual([[ready, 'READY', '30000.0000']]);
      // A prepared manifest has no payable file; only an authorised one does.
      expect((await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/issue`)).json().error).toBe('NOT_AUTHORIZED');
      await ok(await authorize(bankAuth, b.id));
      const rows = await issueAndRead(bankAuth, b.id);
      expect(rows.slice(1, -1)).toHaveLength(1);
      expect(rows[1]).toContain(ls[0]!.allocationKey);
      expect(rows.at(-1)).toBe('T,1,30000.00');
    });

    it('BR-052: different currencies or templates use separate batches: a template in another currency is refused, and a second template is its own manifest', async () => {
      const dept = await department('BR52_SEPARATE');
      const e1 = await paid(dept, '10000');
      const e2 = await paid(dept, '20000');
      const { runId } = await processed('2026-10', dept, [e1, e2]);
      const foreign = await activeTemplate('HB_USD', DEF, 'USD');
      const mixed = await prepare(runId, { templateId: foreign });
      expect([mixed.statusCode, mixed.json().error]).toEqual([422, 'CURRENCY_MISMATCH']);
      const other = await activeTemplate('HB_CSV_TWO', DEF);
      const first = await ok<{ id: string }>(await prepare(runId, { excludeEmployeeIds: [e2], exclusionReason: 'Synthetic: paid through the other layout' }), 201);
      await ok(await authorize(bankAuth, first.id));
      const second = await ok<{ id: string }>(await prepare(runId, { templateId: other }), 201);
      expect(second.id).not.toBe(first.id);
      const [a, b] = [await lines(first.id), await lines(second.id)];
      expect(a.map((l) => l.employeeId)).toEqual([e1]);
      expect(b.map((l) => l.employeeId)).toEqual([e2]);
      const stored = (await h.db.query<{ id: string; template_id: string; currency_code: string }>(`select id, template_id, currency_code from payroll_bank_batch where run_id = $1 order by batch_revision`, [runId])).rows;
      expect(stored).toEqual([
        { id: first.id, template_id: templateId, currency_code: 'INR' },
        { id: second.id, template_id: other, currency_code: 'INR' },
      ]);
      // The database holds a batch to its template's currency whatever the path.
      await expect(h.db.query(`update payroll_bank_batch set currency_code = 'USD' where id = $1`, [second.id])).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    });

    it('BR-052: pending instructions reserve capacity, an unknown outcome stays pending, and a replacement needs a definitive failure and independent approval', async () => {
      const dept = await department('BR52_PENDING');
      const e = await paid(dept, '40000');
      const { runId, records } = await processed('2026-11', dept, [e]);
      const recordId = records[e]!;
      const b = await ok<{ id: string }>(await prepare(runId), 201);
      const line = (await lines(b.id))[0]!;
      // Authorised: reserved. Nothing is free for another manifest.
      await ok(await authorize(bankAuth, b.id));
      expect(await position(recordId)).toEqual(figures('40000.0000', '0.0000', '40000.0000', '0.0000', '0.0000'));
      expect((await prepare(runId)).json().error).toBe('NOTHING_PAYABLE');
      await issueAndRead(bankAuth, b.id);
      // Unknown: still reserved, and still no replacement.
      await ok(await outcome(b.id, [{ lineId: line.id, outcome: 'UNKNOWN' }]));
      expect(await position(recordId)).toEqual(figures('40000.0000', '0.0000', '40000.0000', '0.0000', '0.0000'));
      expect((await prepare(runId, { supersedesBatchId: b.id })).json().error).toBe('NOTHING_PAYABLE');
      // A definitive failure with its evidence frees it once; the replacement is a new allocation, never the old key.
      await ok(await outcome(b.id, [{ lineId: line.id, outcome: 'FAILED' }]));
      expect(await position(recordId)).toEqual(figures('40000.0000', '0.0000', '0.0000', '0.0000', '40000.0000'));
      const replacement = await ok<{ id: string }>(await prepare(runId, { supersedesBatchId: b.id }), 201);
      const next = (await lines(replacement.id))[0]!;
      expect(next.allocationKey).not.toBe(line.allocationKey);
      expect(next.amount).toBe('40000.0000');
      // Its authorisation is independent again: not its preparer.
      expect((await authorize(bankPrep, replacement.id)).json().error).toBe('NOT_INDEPENDENT');
      await ok(await authorize(bankAuth2, replacement.id));
      await issueAndRead(bankAuth2, replacement.id);
      // Confirmed: paid, and it can never be repeated.
      await ok(await outcome(replacement.id, [{ lineId: next.id, outcome: 'CONFIRMED' }]));
      expect(await position(recordId)).toEqual(figures('40000.0000', '0.0000', '0.0000', '40000.0000', '0.0000'));
      expect((await prepare(runId, { supersedesBatchId: replacement.id })).json().error).toBe('NOTHING_PAYABLE');
    });
  });

  describe('hold and bank output', () => {
    it('ZT38: full, partial and safety holds, independent release, an invalid row, duplicate generation and replacement, unknown and confirmed payments reconcile, and held or paid lines are absent from the new file', async () => {
      const dept = await department('ZT38');
      const full = await paid(dept, '30000');
      const part = await paid(dept, '20000');
      const safety = await paid(dept, '15000', 'UNVERIFIED');
      const invalid = await paid(dept, '12345.67');
      const confirmed = await paid(dept, '10000');
      const unknown = await paid(dept, '9000');
      const everyone = [full, part, safety, invalid, confirmed, unknown];
      const { runId, records } = await processed('2026-12', dept, everyone);
      await activeHold(records[full]!, full, { scope: 'FULL' });
      const partialHold = await activeHold(records[part]!, part, { scope: 'PARTIAL', amount: '1000.00' });
      const block = (await holdsOn(records[safety]!))[0]!;
      expect(block).toMatchObject({ hold_kind: 'PAYMENT_SAFETY_BLOCK', reason_code: 'BANK_UNVERIFIED', hold_amount: '15000.0000' });

      // An invalid row: this layout has no decimals, so 12345.67 cannot be written. The whole manifest is refused and nothing is stored.
      const noDecimals = await activeTemplate('HB_WHOLE', { ...DEF, amountDecimals: 0 });
      const refused = await prepare(runId, { templateId: noDecimals });
      expect([refused.statusCode, refused.json().error]).toEqual([422, 'BANK_FILE_VALIDATION_FAILED']);
      expect(JSON.stringify(refused.json())).toContain('AMOUNT_PRECISION');
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_bank_batch where run_id = $1`, [runId])).n).toBe(0);

      // The first file: the partial hold's balance and everyone unheld. Full and safety holds are absent.
      const first = await ok<{ id: string; lineCount: number; totalAmount: string }>(await prepare(runId), 201);
      expect(first).toMatchObject({ lineCount: 4, totalAmount: '50345.6700' }); // 19000 + 12345.67 + 10000 + 9000
      const firstLines = await lines(first.id);
      const of = (e: string) => firstLines.find((l) => l.employeeId === e)!;
      expect(firstLines.map((l) => l.employeeId).sort()).toEqual([part, invalid, confirmed, unknown].sort());
      expect(of(part).amount).toBe('19000.0000');
      await ok(await authorize(bankAuth, first.id));
      const firstFile = await issueAndRead(bankAuth, first.id);
      expect(firstFile.at(-1)).toBe('T,4,50345.67');

      // Duplicate generation: the same issue again replays, with the same bytes and the same recorded hash.
      const hashOf = async (id: string) => (await h.one<{ content_hash: string }>(`select content_hash from payroll_bank_batch where id = $1`, [id])).content_hash;
      const hash = await hashOf(first.id);
      expect(await ok<{ replayed: boolean }>(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${first.id}/issue`))).toMatchObject({ replayed: true });
      expect((await h.call(bankAuth, 'GET', `/v1/payroll-outputs/bank-manifests/${first.id}/file`)).body.trim().split('\n')).toEqual(firstFile);
      expect(await hashOf(first.id)).toBe(hash);

      // Outcomes from evidence: confirmed, unknown, and a definitive failure of the row that did not go through.
      await ok(await outcome(first.id, [
        { lineId: of(part).id, outcome: 'CONFIRMED' },
        { lineId: of(confirmed).id, outcome: 'CONFIRMED' },
        { lineId: of(unknown).id, outcome: 'UNKNOWN' },
        { lineId: of(invalid).id, outcome: 'FAILED' },
      ]));
      const expected: Record<string, ReturnType<typeof figures>> = {
        [full]: figures('30000.0000', '30000.0000', '0.0000', '0.0000', '0.0000'),
        [part]: figures('20000.0000', '1000.0000', '0.0000', '19000.0000', '0.0000'),
        [safety]: figures('15000.0000', '15000.0000', '0.0000', '0.0000', '0.0000'),
        [invalid]: figures('12345.6700', '0.0000', '0.0000', '0.0000', '12345.6700'),
        [confirmed]: figures('10000.0000', '0.0000', '0.0000', '10000.0000', '0.0000'),
        [unknown]: figures('9000.0000', '0.0000', '9000.0000', '0.0000', '0.0000'),
      };
      for (const e of everyone) expect(await position(records[e]!), e).toEqual(expected[e]);

      // Independent release: not by the maker of the hold; the releaser, of the partial hold and of the safety block.
      const holdVersion = (await holdOf(partialHold)).version;
      expect((await h.call(maker, 'POST', `/v1/payroll/holds/${partialHold}/release`, { reason: 'Synthetic', evidenceReference: 'SYNTH', expectedVersion: holdVersion })).statusCode).toBe(403);
      await release(partialHold);
      await release(block.id);

      // The replacement file: the failed row under a new key, and the two released amounts. Nothing held, pending or paid is in it.
      const replacement = await ok<{ id: string; lineCount: number; totalAmount: string }>(await prepare(runId, { supersedesBatchId: first.id }), 201);
      expect(replacement).toMatchObject({ lineCount: 3, totalAmount: '28345.6700' }); // 12345.67 + 1000 + 15000
      const newLines = await lines(replacement.id);
      expect(newLines.map((l) => [l.employeeId, l.amount]).sort()).toEqual(
        [
          [invalid, '12345.6700'],
          [part, '1000.0000'],
          [safety, '15000.0000'],
        ].sort(),
      );
      expect(newLines.map((l) => l.employeeId)).not.toContain(full);
      expect(newLines.map((l) => l.employeeId)).not.toContain(confirmed);
      expect(newLines.map((l) => l.employeeId)).not.toContain(unknown);
      const oldKeys = new Set(firstLines.map((l) => l.allocationKey));
      for (const l of newLines) expect(oldKeys.has(l.allocationKey), l.allocationKey).toBe(false);
      expect(newLines.find((l) => l.employeeId === part)!.holdId).toBe(partialHold);
      expect(newLines.find((l) => l.employeeId === safety)!.holdId).toBe(block.id);
      expect((await authorize(bankPrep, replacement.id)).json().error).toBe('NOT_INDEPENDENT');
      await ok(await authorize(bankAuth2, replacement.id));
      const newFile = await issueAndRead(bankAuth2, replacement.id);
      expect(newFile.at(-1)).toBe('T,3,28345.67');
      for (const paidOrPending of [of(part), of(confirmed), of(unknown)]) expect(newFile.join('\n')).not.toContain(paidOrPending.allocationKey);

      // The ledger reconciles for every record and in total: earned = held + reserved + paid + ready, to the paisa.
      const final: Record<string, ReturnType<typeof figures>> = {
        [full]: figures('30000.0000', '30000.0000', '0.0000', '0.0000', '0.0000'),
        [part]: figures('20000.0000', '0.0000', '1000.0000', '19000.0000', '0.0000'),
        [safety]: figures('15000.0000', '0.0000', '15000.0000', '0.0000', '0.0000'),
        [invalid]: figures('12345.6700', '0.0000', '12345.6700', '0.0000', '0.0000'),
        [confirmed]: figures('10000.0000', '0.0000', '0.0000', '10000.0000', '0.0000'),
        [unknown]: figures('9000.0000', '0.0000', '9000.0000', '0.0000', '0.0000'),
      };
      const cents = (s: string) => Math.round(Number(s) * 10_000);
      let total = 0;
      for (const e of everyone) {
        const p = await position(records[e]!);
        expect(p, e).toEqual(final[e]);
        expect(cents(p.held) + cents(p.reserved) + cents(p.paid) + cents(p.ready), e).toBe(cents(p.earned));
        total += cents(p.earned);
      }
      expect(total).toBe(cents('96345.6700'));
    });
  });
});
