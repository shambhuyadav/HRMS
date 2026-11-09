// Salary holds over HTTP and the daily review job (FR-101; DB110; H2 hold criteria and hold case states; H4 hold
// fields; BR-050; BR-051; CI27 hold part; ZT38 hold part). Synthetic employees, banks and amounts only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { listHolds, runPayrollHoldReviews } from './holds.js';
import {
  addDays,
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
  grantOf,
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
  today,
  trailText,
  verifiedBank,
  VERIFY_DOCUMENTS,
} from './payroll.fixtures.js';

const BANK_REVIEW = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'] as const;

describe.runIf(isModuleActive('payroll'))('salary holds (FR-101, DB110, H2)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let releaser: TestActor;
  let bankReviewer: TestActor;
  let uploader: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;
  let systemUser: string;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount: string) => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'HD_BASIC', amount }] });
    return e;
  };
  /** Calculates, approves and processes a run of a department for a month; returns the record id per employee. */
  const processed = async (month: string, dept: string, employees: string[]) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    const ids: Record<string, string> = {};
    for (const e of employees) ids[e] = (await record(h, processor, run.id, e)).id;
    return { runId: run.id, records: ids };
  };
  const holdTask = async (a: TestActor, holdId: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/holds/tasks/mine')).json().items as { taskId: string; hold: { id: string } | null }[]).find((x) => x.hold?.id === holdId)?.taskId;
  const propose = (a: TestActor, recordId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/payroll/records/${recordId}/holds`, {
      scope: 'FULL',
      reason: 'Synthetic contractual hold reason',
      effectiveDate: '2099-01-01',
      reviewDueOn: '2099-01-10',
      releaseCriterion: 'Synthetic release condition met',
      evidenceReference: 'SYNTH-HOLD-CASE',
      ...body,
    });
  const holdOf = async (a: TestActor, id: string) => ok<{ id: string; state: string; version: number; holdAmount: string; record: { payable: string; held: string; unreserved: string } }>(await h.call(a, 'GET', `/v1/payroll/holds/${id}`));
  const holdsOn = async (recordId: string) =>
    (await h.db.query<{ id: string; hold_kind: string; state: string; hold_amount: string; reason_code: string }>(`select id, hold_kind, state, hold_amount, reason_code from payroll_hold where payroll_record_id = $1 order by created_at`, [recordId])).rows;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    systemUser = SYSTEM_ACTOR_ID;
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(CONFIG, CRITERIA) });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(HOLD_PROPOSE, HOLD_DECIDE, HOLD_RELEASE) });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_DECIDE });
    releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    bankReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants([...BANK_REVIEW], HOLD_RELEASE) });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_hold', [maker, decider]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await head(h, configA, configB, { code: 'HD_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('keeps contractual and legal holds disabled until a validated criterion is active (H2)', async () => {
    const dept = await department('HD_CRIT');
    const e = await paid(dept, '30000');
    await bankRevision(h, A, e);
    const { records } = await processed('2026-01', dept, [e]);
    const doc = await evidenceDocument(h, uploader, verifier, e);
    // No criterion exists by default.
    expect((await ok<{ items: unknown[] }>(await h.call(configA, 'GET', '/v1/payroll/hold-criteria'))).items).toEqual([]);
    expect((await propose(maker, records[e]!, { criterionId: randomUUID(), evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
    // H2: a missing timesheet, an input discrepancy or a separation is never a hold criterion.
    for (const code of ['MISSING_TIMESHEET', 'INPUT_DISCREPANCY', 'SEPARATION', 'BANK_MISSING']) {
      const res = await h.call(configA, 'POST', '/v1/payroll/hold-criteria', {
        code,
        category: 'CONTRACTUAL',
        applicability: 'x',
        scopeMode: 'FULL_ONLY',
        maxReviewDays: 10,
        evidenceReference: 'x',
        validationReference: 'x',
      });
      expect(res.json().error).toBe('NOT_A_HOLD_CRITERION');
    }
    const draft = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/hold-criteria', {
        code: 'HD_LEGAL',
        category: 'LEGAL_DISCIPLINARY',
        applicability: 'Synthetic legal direction',
        scopeMode: 'FULL_ONLY',
        maxReviewDays: 15,
        evidenceReference: 'SYNTH-DIRECTION-1',
        validationReference: 'SYNTH-COUNSEL-REVIEW-1',
      }),
      201,
    );
    // A draft criterion holds nothing; its author never activates it.
    expect((await propose(maker, records[e]!, { criterionId: draft.id, evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
    expect((await h.call(configA, 'POST', `/v1/payroll/hold-criteria/${draft.id}/activate`, { expectedVersion: draft.version })).json().error).toBe('SELF_APPROVAL');
    await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${draft.id}/activate`, { expectedVersion: draft.version }));
    // A later revision replaces it; the earlier one is retired, never deleted.
    const r2 = await ok<{ id: string; version: number; revision: number }>(
      await h.call(configA, 'POST', '/v1/payroll/hold-criteria', {
        code: 'HD_LEGAL',
        category: 'LEGAL_DISCIPLINARY',
        applicability: 'Synthetic legal direction, revised',
        scopeMode: 'FULL_OR_PARTIAL',
        maxReviewDays: 15,
        evidenceReference: 'SYNTH-DIRECTION-2',
        validationReference: 'SYNTH-COUNSEL-REVIEW-2',
      }),
      201,
    );
    expect(r2.revision).toBe(2);
    await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${r2.id}/activate`, { expectedVersion: r2.version }));
    const all = (await ok<{ items: { id: string; state: string }[] }>(await h.call(configA, 'GET', '/v1/payroll/hold-criteria'))).items;
    expect(all.find((c) => c.id === draft.id)?.state).toBe('RETIRED');
    expect(all.find((c) => c.id === r2.id)?.state).toBe('ACTIVE');
    // A partial hold needs a criterion that allows it.
    const fullOnly = await criterion(h, configA, configB, { scopeMode: 'FULL_ONLY' });
    expect((await propose(maker, records[e]!, { criterionId: fullOnly, scope: 'PARTIAL', amount: '100.00', evidenceDocumentIds: [doc] })).json().error).toBe('PARTIAL_HOLD_DISABLED');
  });

  it('holds full or part of the unpaid, unreserved entitlement, decided independently and never by the beneficiary', async () => {
    const dept = await department('HD_POLICY');
    const e = await paid(dept, '30000');
    await bankRevision(h, A, e);
    const beneficiaryAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(HOLD_DECIDE, HOLD_RELEASE), employeeId: e });
    const { runId, records } = await processed('2026-02', dept, [e]);
    const recordId = records[e]!;
    const before = await record(h, processor, runId, e);
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_OR_PARTIAL', maxReviewDays: 30 });
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const unverified = await evidenceDocument(h, uploader, verifier, e, { verify: false });
    // The bank block placed at processing already reserves the whole net (UNVERIFIED migrated revision): nothing is
    // left to hold until it is released.
    const block = (await holdsOn(recordId))[0]!;
    expect(block).toMatchObject({ hold_kind: 'PAYMENT_SAFETY_BLOCK', reason_code: 'BANK_UNVERIFIED', hold_amount: '30000.0000' });
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'FULL', evidenceDocumentIds: [doc] })).json().error).toBe('NOTHING_TO_HOLD');
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1.00', evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
    const b0 = await holdOf(releaser, block.id);
    await ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, { reason: 'Bank details verified with the employee (synthetic)', evidenceReference: 'SYNTH-CALL-1', expectedVersion: b0.version }));
    // Amount bounds: > 0 and at most the unreserved entitlement; the evidence is a released, verified document.
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '0', evidenceDocumentIds: [doc] })).json().error).toBe('INVALID_AMOUNT');
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '30000.01', evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'FULL', amount: '10.00', evidenceDocumentIds: [doc] })).json().error).toBe('AMOUNT_NOT_ALLOWED');
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1000.00', evidenceDocumentIds: [unverified] })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1000.00', reviewDueOn: '2099-03-01', evidenceDocumentIds: [doc] })).json().error).toBe('REVIEW_DATE_INVALID');
    const k = key('hold-');
    const partial = await ok<{ id: string; state: string; holdAmount: string; record: { held: string; unreserved: string } }>(
      await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1000.00', evidenceDocumentIds: [doc], idempotencyKey: k }),
      201,
    );
    expect(partial).toMatchObject({ state: 'PROPOSED', holdAmount: '1000.0000', record: { held: '1000.0000', unreserved: '29000.0000' } });
    // A replay returns the same proposal (no second hold).
    expect(await ok(await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1000.00', evidenceDocumentIds: [doc], idempotencyKey: k }))).toMatchObject({ id: partial.id, replayed: true });
    // The maker is first on the deciders' list but never decides their own proposal; the beneficiary never decides.
    expect(await holdTask(maker, partial.id)).toBeUndefined();
    expect(await holdTask(beneficiaryAdmin, partial.id)).toBeUndefined();
    const task = (await holdTask(decider, partial.id))!;
    expect((await h.call(beneficiaryAdmin, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(404);
    expect((await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'REJECT', idempotencyKey: key() })).json().error).toBe('REASON_REQUIRED');
    // REJECTED never blocks: the capacity it reserved is free again.
    expect(await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'REJECT', reason: 'Not supported by the evidence (synthetic)', idempotencyKey: key() }))).toMatchObject({
      state: 'REJECTED',
    });
    // Whatever the path, a rejected proposal never blocks again (H2: closed hold states are final).
    await expect(
      h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE', approved_at = now(), approved_by = $2, closed_at = null where id = $1`, [partial.id, decider.user]),
    ).rejects.toThrow(/cannot move from REJECTED to APPROVED_ACTIVE/);
    const full =await ok<{ id: string; holdAmount: string }>(await propose(maker, recordId, { criterionId: crit, scope: 'FULL', evidenceDocumentIds: [doc] }), 201);
    expect(full.holdAmount).toBe('30000.0000');
    // H7 outstanding (I-80): the released bank block (30,000 not yet paid) and the full proposal (30,000) hold the same salary of a
    // 30,000 record: 30,000 is owed once, never 60,000; the rejected proposal held nothing.
    const owed = await ok<{ totals: { currencyCode: string; reserved: string; confirmed: string; outstanding: string }[] }>(await h.call(releaser, 'GET', `/v1/payroll/holds?employeeId=${e}`));
    expect(owed.totals).toEqual([{ currencyCode: 'INR', reserved: '0.0000', confirmed: '0.0000', outstanding: '30000.0000' }]);
    // The released block alone: still owed until its payment is confirmed.
    expect((await ok<typeof owed>(await h.call(releaser, 'GET', `/v1/payroll/holds?employeeId=${e}&state=RELEASED`))).totals).toEqual([
      { currencyCode: 'INR', reserved: '0.0000', confirmed: '0.0000', outstanding: '30000.0000' },
    ]);
    // Nothing is left to hold beside a full proposal.
    expect((await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '1.00', evidenceDocumentIds: [doc] })).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
    // The database refuses the beneficiary as the decider whatever the path, not only through the approval engine.
    await h.db.query('begin');
    try {
      await h.db.query(`update business_transaction set state = 'APPROVED_ACTIVE' where id = (select transaction_id from payroll_hold where id = $1)`, [full.id]);
      await expect(
        h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE', approved_at = now(), approved_by = $2, unresolved_since = null where id = $1`, [full.id, beneficiaryAdmin.user]),
      ).rejects.toThrow(/beneficiary of a hold never decides it/);
    } finally {
      await h.db.query('rollback');
    }
    // Nor the maker of the hold.
    await h.db.query('begin');
    try {
      await h.db.query(`update business_transaction set state = 'APPROVED_ACTIVE' where id = (select transaction_id from payroll_hold where id = $1)`, [full.id]);
      await expect(
        h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE', approved_at = now(), approved_by = $2, unresolved_since = null where id = $1`, [full.id, maker.user]),
      ).rejects.toThrow(/maker of a hold never decides it/);
    } finally {
      await h.db.query('rollback');
    }
    await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${(await holdTask(decider, full.id))!}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    expect((await holdOf(decider, full.id)).state).toBe('APPROVED_ACTIVE');
    // The database refuses held amounts beyond the payable amount, whatever the path (checked at commit, CI27).
    await h.db.query('begin');
    try {
      const tx = (await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'payroll_hold', $2, 'APPROVED_ACTIVE') returning id`, [A.id, e])).id;
      await h.db.query(
        `insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, policy_revision, reason_code, scope, hold_amount, currency_code,
                                   state, proposed_by, effective_date, review_due_on, release_criterion, evidence_reference)
         values ($1, $2, $3, $4, $5, 'PAYMENT_SAFETY_BLOCK', 'H2_BANK_SAFETY', 'BANK_MISSING', 'FULL', 1, 'INR', 'APPROVED_ACTIVE', $6, '2026-02-28', '2026-02-28', 'x', 'x')`,
        [A.id, e, recordId, runId, tx, maker.user],
      );
      await expect(h.db.query('commit')).rejects.toThrow(/held amounts exceed the payable amount/);
    } finally {
      await h.db.query('rollback').catch(() => undefined);
    }
    // A hold never changes the payroll record it holds.
    expect(await record(h, processor, runId, e)).toMatchObject({ net: before.net, earnings: before.earnings, lines: before.lines, bankStatus: before.bankStatus });
    // Release: not by the maker, never by the beneficiary; an independent eligible Admin with evidence.
    const active = await holdOf(releaser, full.id);
    const release = (a: TestActor, extra: Record<string, unknown> = {}) =>
      h.call(a, 'POST', `/v1/payroll/holds/${full.id}/release`, { reason: 'Release condition met (synthetic)', evidenceReference: 'SYNTH-RELEASE-1', expectedVersion: active.version, ...extra });
    expect((await release(maker)).json().error).toBe('NOT_INDEPENDENT');
    expect((await release(beneficiaryAdmin)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    const releaseDoc = await evidenceDocument(h, uploader, verifier, e);
    const released = await ok<{ state: string; record: { held: string; unreserved: string }; evidence: { revision: number }[]; safetyBlockId: string | null }>(
      await release(releaser, { evidenceDocumentIds: [releaseDoc] }),
    );
    expect(released).toMatchObject({ state: 'RELEASED', record: { held: '0', unreserved: '30000.0000' }, safetyBlockId: null });
    // The proposal's evidence and the release's evidence are kept apart (revisions 1 and 2 of the case).
    expect(released.evidence.map((x) => x.revision).sort()).toEqual([1, 2]);
    // Amounts are audited only under the hold group and never travel in the outbox or notifications.
    await dispatchOutbox(h.pool);
    const trail = await trailText(h, A.id);
    expect(trail.operational).not.toContain('30000.00');
    expect(trail.outbox).not.toContain('30000.00');
    expect(trail.notifications).not.toContain('30000');
    expect(trail.notifications).not.toContain('Synthetic contractual hold reason');
    const proposeAudit = await h.one<{ after_values: { hold?: { amount: string } } }>(`select after_values from audit_event where record_key = $1 and action = 'PROPOSE'`, [partial.id]);
    expect(proposeAudit.after_values.hold?.amount).toBe('1000.00');
  });

  it('blocks payment automatically without a verified bank instruction, keeps the salary payable and releases it independently', async () => {
    const dept = await department('HD_BANK');
    const missing = await paid(dept, '10000');
    const invalid = await paid(dept, '11000');
    const migrated = await paid(dept, '12000');
    const verified = await paid(dept, '13000');
    await bankRevision(h, A, invalid, { valid: false });
    const migratedRevision = await bankRevision(h, A, migrated);
    await verifiedBank(h, A, bankReviewer, verified);
    const { runId, records } = await processed('2026-03', dept, [missing, invalid, migrated, verified]);
    const kinds = async (e: string) => (await holdsOn(records[e]!)).map((x) => [x.hold_kind, x.state, x.reason_code, x.hold_amount]);
    expect(await kinds(missing)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_MISSING', '10000.0000']]);
    expect(await kinds(invalid)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_INVALID', '11000.0000']]);
    expect(await kinds(migrated)).toEqual([['PAYMENT_SAFETY_BLOCK', 'APPROVED_ACTIVE', 'BANK_UNVERIFIED', '12000.0000']]);
    expect(await kinds(verified)).toEqual([]);
    // The verified record froze its bank reference; the earned salary of every record is unchanged and payable.
    const v = await record(h, processor, runId, verified);
    expect(v).toMatchObject({ bankStatus: 'VERIFIED', net: '13000.0000' });
    expect(v.bankRevisionId).toBeTruthy();
    expect(await record(h, processor, runId, missing)).toMatchObject({ bankStatus: 'MISSING', bankRevisionId: null, net: '10000.0000' });
    // The employee is told the payment waits for bank details, never an amount.
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: missing });
    await dispatchOutbox(h.pool);
    const inbox = (await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(inbox.find((n) => n.category === 'PAYROLL_HOLD_STATUS')?.body).toBe('Payment of your 2026-03 salary is on hold until approved bank details are on record.');
    const blockOf = async (e: string) => (await holdsOn(records[e]!))[0]!.id;
    const release = async (a: TestActor, holdId: string) => {
      const current = await holdOf(releaser, holdId);
      return h.call(a, 'POST', `/v1/payroll/holds/${holdId}/release`, { reason: 'Bank instruction verified (synthetic)', evidenceReference: 'SYNTH-BANK-CHECK', expectedVersion: current.version });
    };
    // Missing and invalid instructions cannot be released until a valid approved revision exists.
    expect((await release(releaser, await blockOf(missing))).json()).toMatchObject({ error: 'BANK_NOT_VERIFIED', details: { bankStatus: 'MISSING' } });
    expect((await release(releaser, await blockOf(invalid))).json()).toMatchObject({ error: 'BANK_NOT_VERIFIED', details: { bankStatus: 'INVALID' } });
    // The employee then changes bank details through the approved workflow: the approver of that change does not also
    // release the payment against it; another eligible Admin does.
    await verifiedBank(h, A, bankReviewer, missing, employee);
    expect((await release(bankReviewer, await blockOf(missing))).json().error).toBe('NOT_INDEPENDENT');
    expect(await ok(await release(releaser, await blockOf(missing)))).toMatchObject({ state: 'RELEASED', releaseBankCheck: 'WORKFLOW_VERIFIED' });
    // A released block never blocks again, whatever the path (H2: closed hold states are final).
    await expect(h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE' where id = $1`, [await blockOf(missing)])).rejects.toThrow(/cannot move from RELEASED to APPROVED_ACTIVE/);
    // A migrated (unverified) revision is verified by the releasing Admin; the release records which revision.
    const migratedRelease = await ok<{ state: string; releaseBankRevisionId: string; releaseBankCheck: string }>(await release(releaser, await blockOf(migrated)));
    expect(migratedRelease).toMatchObject({ state: 'RELEASED', releaseBankRevisionId: migratedRevision, releaseBankCheck: 'ADMIN_VERIFIED' });
    // That verification counts from then on: next month the instruction is VERIFIED and nothing is blocked.
    const april = await processed('2026-04', dept, [missing, invalid, migrated, verified]);
    expect(await record(h, processor, april.runId, migrated)).toMatchObject({ bankStatus: 'VERIFIED', bankRevisionId: migratedRevision });
    expect(await holdsOn(april.records[migrated]!)).toEqual([]);
    expect(await holdsOn(april.records[missing]!)).toEqual([]);
    expect((await holdsOn(april.records[invalid]!)).map((x) => x.reason_code)).toEqual(['BANK_INVALID']);
  });

  it('keeps the run’s preparer, reviewer and approver out of its hold decisions and releases (C4, H4)', async () => {
    const dept = await department('HD_SOD');
    const e = await paid(dept, '12000');
    await bankRevision(h, A, e);
    const runApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(APPROVE, HOLD_DECIDE, HOLD_RELEASE) });
    await reviewers(h, hr, 'payroll_run_approval', [runApprover]);
    await reviewers(h, hr, 'payroll_hold', [runApprover, decider]);
    try {
      const run = await createRun(h, preparer, periods['2026-07']!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      await submitAndApprove(h, { preparer, reviewer, approver: runApprover }, run.id);
      await processRun(h, processor, run.id);
      const recordId = (await record(h, processor, run.id, e)).id;
      const block = (await holdsOn(recordId))[0]!;
      const body = { reason: 'Bank instruction verified (synthetic)', evidenceReference: 'SYNTH-BANK-CHECK', expectedVersion: (await holdOf(releaser, block.id)).version };
      // The approver of the run does not release the payment of its records; an independent releaser does.
      expect((await h.call(runApprover, 'POST', `/v1/payroll/holds/${block.id}/release`, body)).json().error).toBe('NOT_INDEPENDENT');
      await ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, body));
      // A policy hold of the record is never routed to the run's approver, though first on the deciders' list.
      const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_OR_PARTIAL' });
      const doc = await evidenceDocument(h, uploader, verifier, e);
      const proposal = await ok<{ id: string }>(await propose(maker, recordId, { criterionId: crit, scope: 'PARTIAL', amount: '100.00', evidenceDocumentIds: [doc] }), 201);
      expect(await holdTask(runApprover, proposal.id)).toBeUndefined();
      expect(await holdTask(decider, proposal.id)).toBeDefined();
      // The database refuses such a decision whatever the path.
      await h.db.query('begin');
      try {
        await h.db.query(`update business_transaction set state = 'APPROVED_ACTIVE' where id = (select transaction_id from payroll_hold where id = $1)`, [proposal.id]);
        await expect(
          h.db.query(`update payroll_hold set state = 'APPROVED_ACTIVE', approved_at = now(), approved_by = $2, unresolved_since = null where id = $1`, [proposal.id, runApprover.user]),
        ).rejects.toThrow(/independently of the payroll run/);
      } finally {
        await h.db.query('rollback');
      }
    } finally {
      await reviewers(h, hr, 'payroll_run_approval', [approver]);
      await reviewers(h, hr, 'payroll_hold', [maker, decider]);
    }
  });

  it('approves a hold only under a criterion that is still active when it is decided', async () => {
    const dept = await department('HD_RETIRED');
    const e = await paid(dept, '18000');
    await bankRevision(h, A, e);
    const { records } = await processed('2026-08', dept, [e]);
    // Release the automatic block first, so part of the record can be held (the releasing Admin verifies the revision).
    const block = (await holdsOn(records[e]!))[0]!;
    await ok(
      await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, { reason: 'Verified (synthetic)', evidenceReference: 'SYNTH-2', expectedVersion: (await holdOf(releaser, block.id)).version }),
    );
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_OR_PARTIAL' });
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const proposal = await ok<{ id: string }>(await propose(maker, records[e]!, { criterionId: crit, scope: 'PARTIAL', amount: '800.00', evidenceDocumentIds: [doc] }), 201);
    // The company retires the criterion before the decision (BR-050: no activated policy, nothing new is withheld).
    const c = (await ok<{ items: { id: string; version: number }[] }>(await h.call(configA, 'GET', '/v1/payroll/hold-criteria'))).items.find((x) => x.id === crit)!;
    await ok(await h.call(configB, 'POST', `/v1/payroll/hold-criteria/${crit}/retire`, { reason: 'Policy withdrawn (synthetic)', expectedVersion: c.version }));
    const task = (await holdTask(decider, proposal.id))!;
    expect((await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('HOLD_CRITERION_NOT_ACTIVE');
    expect((await holdOf(decider, proposal.id)).state).toBe('PROPOSED');
    // A rejection stays possible and frees what the proposal reserved.
    expect(await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${task}/decision`, { decision: 'REJECT', reason: 'Criterion retired (synthetic)', idempotencyKey: key() }))).toMatchObject({
      state: 'REJECTED',
    });
    expect((await holdOf(decider, proposal.id)).record).toMatchObject({ held: '0', unreserved: '18000.0000' });
  });

  it('serialises concurrent proposals on one record and reads altered or foreign identifiers as missing', async () => {
    const dept = await department('HD_RACE');
    const e = await paid(dept, '20000');
    await verifiedBank(h, A, bankReviewer, e);
    const { runId, records } = await processed('2026-06', dept, [e]);
    const recordId = records[e]!;
    // A verified bank instruction: processing placed no block, the whole net is unreserved.
    expect(await holdsOn(recordId)).toEqual([]);
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_ONLY' });
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const maker2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_PROPOSE });
    // Two makers propose a full hold at the same moment on two connections: the second sees what the first reserved.
    const [a, b] = await Promise.all([propose(maker, recordId, { criterionId: crit, evidenceDocumentIds: [doc] }), propose(maker2, recordId, { criterionId: crit, evidenceDocumentIds: [doc] })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect([a, b].find((x) => x.statusCode === 409)!.json().error).toBe('NOTHING_TO_HOLD');
    const live = await holdsOn(recordId);
    expect(live.map((x) => [x.hold_kind, x.state, x.hold_amount])).toEqual([['POLICY_HOLD', 'PROPOSED', '20000.0000']]);
    // Altered identifiers: a random hold, a record id used as a hold id, a hold id used as a record id, another run's
    // record under this employee's path, and another company's administrator all read as missing.
    const fake = '00000000-0000-4000-8000-000000000000';
    expect((await h.call(decider, 'GET', `/v1/payroll/holds/${fake}`)).statusCode).toBe(404);
    expect((await h.call(decider, 'GET', `/v1/payroll/holds/${recordId}`)).statusCode).toBe(404);
    expect((await propose(maker, live[0]!.id, { criterionId: crit, evidenceDocumentIds: [doc] })).statusCode).toBe(404);
    expect((await h.call(releaser, 'POST', `/v1/payroll/holds/${recordId}/release`, { reason: 'x', evidenceReference: 'x', expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(processor, 'GET', `/v1/payroll/runs/${runId}/records/${fake}`)).statusCode).toBe(404);
    const B = await h.makeCompany();
    const bAdmin = await h.actor(B, 'HR_ADMINISTRATOR', { extra: grants(HOLD_PROPOSE, HOLD_DECIDE, HOLD_RELEASE) });
    expect((await h.call(bAdmin, 'GET', `/v1/payroll/holds/${live[0]!.id}`)).statusCode).toBe(404);
    expect((await h.call(bAdmin, 'GET', `/v1/payroll/records/${recordId}/hold-balance`)).statusCode).toBe(404);
    expect((await h.call(bAdmin, 'POST', `/v1/payroll/holds/${live[0]!.id}/release`, { reason: 'x', evidenceReference: 'x', expectedVersion: 1 })).statusCode).toBe(404);
  });

  it('reviews unresolved holds daily, escalates after 2 business days and then every 5, and pays or forgives nothing on expiry', async () => {
    const dept = await department('HD_REVIEW');
    const e = await paid(dept, '20000');
    const blocked = await paid(dept, '15000');
    await bankRevision(h, A, e);
    const { records } = await processed('2026-05', dept, [e, blocked]);
    // Release e's automatic block so a policy hold can be proposed (the bank was verified by the releasing Admin).
    const block = (await holdsOn(records[e]!))[0]!;
    await ok(
      await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, {
        reason: 'Verified (synthetic)',
        evidenceReference: 'SYNTH-1',
        expectedVersion: (await holdOf(releaser, block.id)).version,
      }),
    );
    const crit = await criterion(h, configA, configB, { maxReviewDays: 20 });
    const doc = await evidenceDocument(h, uploader, verifier, e);
    const start = await today(h, A);
    const proposal = await ok<{ id: string }>(
      await propose(maker, records[e]!, { criterionId: crit, scope: 'PARTIAL', amount: '500.00', effectiveDate: start, reviewDueOn: addDays(start, 10), evidenceDocumentIds: [doc] }),
      201,
    );
    // A fixed Monday as the day the cases became unresolved keeps the business-day arithmetic of the test exact.
    const monday = '2030-01-07';
    const safety = (await holdsOn(records[blocked]!))[0]!;
    await h.db.query(`update payroll_hold set unresolved_since = $2 where id = any($1::uuid[])`, [[proposal.id, safety.id], monday]);
    const events = async (topic: string, holdId: string) =>
      (await h.db.query<{ dedupe_key: string; payload: Record<string, unknown> }>(`select dedupe_key, payload from outbox_event where topic = $1 and aggregate_id = $2 order by created_at, seq`, [topic, holdId])).rows;
    const run = (day: string) => runPayrollHoldReviews(h.pool, A.id, day, systemUser);
    // The proposal day itself: the decider already has the assignment notice; the safety block alerts reviewers that day.
    await run(monday);
    expect(await events('payroll_hold.reminder', proposal.id)).toEqual([]);
    expect((await events('payroll_hold.review_due', safety.id)).map((x) => x.payload.date)).toEqual([monday]);
    expect(await events('payroll_hold.escalation', proposal.id)).toEqual([]);
    for (let d = 1; d <= 16; d++) await run(addDays(monday, d));
    // Reruns never duplicate.
    await run(addDays(monday, 16));
    const reminders = await events('payroll_hold.reminder', proposal.id);
    expect(reminders).toHaveLength(16);
    expect(reminders.every((r) => typeof r.payload.taskId === 'string')).toBe(true);
    expect((await events('payroll_hold.review_due', safety.id)).length).toBe(17);
    // Business days after Mon 7 Jan 2030: Tue 8 (1), Wed 9 (2) -> first escalation; then 5 more -> Wed 16 (7); Wed 23 (12).
    const escalations = (await events('payroll_hold.escalation', proposal.id)).map((x) => [x.payload.number, x.payload.waitingDays]);
    expect(escalations).toEqual([
      [1, 2],
      [2, 7],
      [3, 12],
    ]);
    // Notifications name the employee code and period, never an amount or reason.
    await dispatchOutbox(h.pool);
    const deciderInbox = (await h.call(decider, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(deciderInbox.some((n) => n.category === 'PAYROLL_HOLD_REMINDER')).toBe(true);
    // Other unresolved cases of the company escalate too; every escalation names only the employee code and period.
    const escalated = ((await h.call(maker, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[])
      .filter((n) => n.category === 'PAYROLL_HOLD_ESCALATION')
      .map((n) => n.body);
    expect(escalated.some((b) => /^The salary hold for .+ \(2026-05\) has been unresolved for \d+ business days\.$/.test(b))).toBe(true);
    expect(escalated.every((b) => /^The salary hold for [^ ]+ \(\d{4}-\d{2}\) has been unresolved for \d+ business days\.$/.test(b))).toBe(true);
    expect(JSON.stringify(deciderInbox)).not.toContain('500.00');

    // Approved, it is resolved (no more reminders) until its review date: then it expires for review, alerting reviewers,
    // and pays, forgives or deletes nothing.
    await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${(await holdTask(decider, proposal.id))!}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    const due = addDays(start, 10);
    const result = await run(due);
    expect(result.expired).toBe(1);
    const expired = await holdOf(decider, proposal.id);
    expect(expired).toMatchObject({ state: 'EXPIRED_REVIEW', holdAmount: '500.0000', record: { held: '500.0000' } });
    expect((await events('payroll_hold.review_due', proposal.id)).map((x) => x.payload.date)).toEqual([due]);
    // An independent renewal sets a new review date within the criterion's interval.
    const renew = (a: TestActor, reviewDueOn: string) => h.call(a, 'POST', `/v1/payroll/holds/${proposal.id}/renew-review`, { reviewDueOn, reason: 'Still pending (synthetic)', expectedVersion: expired.version });
    expect((await renew(maker, addDays(start, 5))).json().error).toBe('NOT_INDEPENDENT');
    expect((await renew(decider, addDays(start, 60))).json().error).toBe('REVIEW_DATE_INVALID');
    expect(await ok(await renew(decider, addDays(start, 5)))).toMatchObject({ state: 'APPROVED_ACTIVE' });
  });

  it('shows the employee only the status of their own held salary: period, state and dates, never a reason or amount (H7)', async () => {
    const dept = await department('HD_OWN');
    const mine = await paid(dept, '20000');
    const other = await paid(dept, '21000');
    const { records } = await processed('2026-07', dept, [mine, other]);
    const me = await h.actor(A, 'EMPLOYEE', { employeeId: mine });
    const colleague = await h.actor(A, 'EMPLOYEE', { employeeId: other });
    const block = (await holdsOn(records[mine]!))[0]!;
    const colleagueBlock = (await holdsOn(records[other]!))[0]!;
    type OwnHolds = { items: Record<string, unknown>[]; total: number };
    const own = await ok<OwnHolds>(await h.call(me, 'GET', '/v1/me/payroll-holds'));
    expect(own.total).toBe(1);
    expect(own.items).toEqual([
      { id: block.id, periodCode: '2026-07', serviceStart: expect.any(String), serviceEnd: expect.any(String), state: 'ON_HOLD', heldFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), releasedAt: null },
    ]);
    // Status only: the kind, reason, criterion, release criterion, evidence, actors and the amount never appear.
    const text = JSON.stringify(own);
    for (const hidden of ['reason', 'Reason', 'holdKind', 'SAFETY', 'BANK_', 'criterion', 'evidence', 'scope', 'amount', 'Amount', '20000', 'proposedBy', 'approvedBy']) {
      expect(text).not.toContain(hidden);
    }
    // Own only: another employee's hold reads as missing, and the colleague's list holds only their own.
    expect((await h.call(me, 'GET', `/v1/me/payroll-holds/${colleagueBlock.id}`)).statusCode).toBe(404);
    expect((await h.call(colleague, 'GET', `/v1/me/payroll-holds/${block.id}`)).statusCode).toBe(404);
    expect((await ok<OwnHolds>(await h.call(colleague, 'GET', '/v1/me/payroll-holds'))).items.map((x) => x.id)).toEqual([colleagueBlock.id]);
    expect(await ok(await h.call(me, 'GET', `/v1/me/payroll-holds/${block.id}`))).toEqual(own.items[0]);
    // Served only in the Employee OWN context (BR-055): an administrator linked to the employee is refused.
    const linkedAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_DECIDE, user: me.user });
    expect((await h.call(linkedAdmin, 'GET', '/v1/me/payroll-holds')).statusCode).toBe(403);
    // Released: RELEASED with the release time; a proposal not yet decided is never shown, an approved one is.
    await verifiedBank(h, A, bankReviewer, mine, me);
    const current = await holdOf(releaser, block.id);
    await ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, { reason: 'Bank instruction verified (synthetic)', evidenceReference: 'SYNTH-OWN-1', expectedVersion: current.version }));
    const crit = await criterion(h, configA, configB, { scopeMode: 'FULL_ONLY' });
    const doc = await evidenceDocument(h, uploader, verifier, mine);
    const proposal = await ok<{ id: string }>(await propose(maker, records[mine]!, { criterionId: crit, evidenceDocumentIds: [doc] }), 201);
    const afterRelease = await ok<OwnHolds>(await h.call(me, 'GET', '/v1/me/payroll-holds'));
    expect(afterRelease.total).toBe(1);
    expect(afterRelease.items[0]).toMatchObject({ id: block.id, state: 'RELEASED', releasedAt: expect.any(String) });
    expect((await h.call(me, 'GET', `/v1/me/payroll-holds/${proposal.id}`)).statusCode).toBe(404);
    await ok(await h.call(decider, 'POST', `/v1/payroll/hold-tasks/${(await holdTask(decider, proposal.id))!}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    const held = await ok<OwnHolds>(await h.call(me, 'GET', '/v1/me/payroll-holds?page=1&pageSize=25'));
    expect(held).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(held.items.find((x) => x.id === proposal.id)).toMatchObject({ state: 'ON_HOLD', releasedAt: null });
    expect(JSON.stringify(held)).not.toContain('Synthetic contractual hold reason');
  });

  it('pages the hold list with the total of every hold in scope (FR-056)', async () => {
    type Holds = { items: { id: string; employeeId: string }[]; total: number; page?: number; pageSize?: number; totals?: unknown[] };
    const all = await ok<Holds>(await h.call(releaser, 'GET', '/v1/payroll/holds'));
    expect(all.total).toBeGreaterThan(0);
    // Below the 500 cap the unpaged answer is every hold, with its total.
    expect(all.items).toHaveLength(all.total);
    expect(all).not.toHaveProperty('page');
    const first = await ok<Holds>(await h.call(releaser, 'GET', '/v1/payroll/holds?page=1&pageSize=25'));
    expect(first).toMatchObject({ total: all.total, page: 1, pageSize: 25 });
    expect(first.items.map((x) => x.id)).toEqual(all.items.slice(0, 25).map((x) => x.id));
    const past = Math.ceil(all.total / 25) + 1;
    // H7 totals cover every matching hold, past the last page too (no manifest exists here: nothing reserved or paid).
    const none = [{ currencyCode: 'INR', reserved: '0.0000', confirmed: '0.0000', outstanding: expect.stringMatching(/^\d+\.\d{4}$/) }];
    expect(await ok<Holds>(await h.call(releaser, 'GET', `/v1/payroll/holds?page=${past}&pageSize=25`))).toEqual({ items: [], total: all.total, page: past, pageSize: 25, totals: none });
    expect(all.totals).toEqual(none);
    // Filters and row scope apply to the total: one employee's holds; HR limited to another department sees none.
    const one = all.items[0]!.employeeId;
    const filtered = await ok<Holds>(await h.call(releaser, 'GET', `/v1/payroll/holds?employeeId=${one}&page=1&pageSize=25`));
    expect(filtered.total).toBe(all.items.filter((x) => x.employeeId === one).length);
    const scoped = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE, departmentFilter: A.financeDept });
    expect(await ok<Holds>(await h.call(scoped, 'GET', '/v1/payroll/holds?page=1&pageSize=25'))).toEqual({ items: [], total: 0, page: 1, pageSize: 25, totals: [] });
    // Without the hold amount group the totals are omitted (the route itself needs that group: H7 amounts are confidential).
    const g = await grantOf(h, releaser, 'payroll_hold', 'read', ['hold']);
    const withoutAmounts = await listHolds(h.db, { ...g, allowedFieldGroups: g.allowedFieldGroups.filter((x) => x !== 'hold') }, { page: 1, pageSize: 25 });
    expect(withoutAmounts).not.toHaveProperty('totals');
    expect(withoutAmounts.total).toBe(all.total);
  });
});
