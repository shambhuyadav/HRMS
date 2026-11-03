// Payroll payment release outside decideTask re-resolves its authority inside its own transaction, after its locks
// (docs/09 §6.5; I-25; docs/09 §13.2 item 4): manifest authorisation (the release that reserves every line), the
// restricted file's issue and the payment outcomes. An authority narrowed between the route guard and the transaction
// (a withdrawn DB109 entry, a revoked assignment, a deactivated user) refuses the action with 403 and records nothing;
// an eligible actor with current authority then completes it. Synthetic employees, banks and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { memoryFileStore } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  calculate,
  calendar,
  CONFIG,
  createRun,
  grantOf,
  grants,
  head,
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
  verifiedBank,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { authorizeManifest, issueManifest, recordOutcomes } from './bank.js';

const BANK_REVIEW: PermissionKey[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'];
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
  detail: [
    { source: 'LITERAL', value: 'D' },
    { source: 'ALLOCATION_KEY' },
    { source: 'HOLDER_NAME', maxLength: 40 },
    { source: 'ACCOUNT_IDENTIFIER' },
    { source: 'ROUTING_REFERENCE' },
    { source: 'AMOUNT' },
    { source: 'CURRENCY_CODE' },
  ],
  trailer: [{ source: 'LITERAL', value: 'T' }, { source: 'RECORD_COUNT' }, { source: 'TOTAL_AMOUNT' }],
};

interface Batch {
  id: string;
  state: string;
  version: number;
}

describe.runIf(isModuleActive('payroll-outputs'))('payment release re-checks its authority inside its transaction (docs/09 §6.5)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let bankReviewer: TestActor;
  let bankPrep: TestActor;
  let templateId: string;
  let periods: Record<string, string>;

  const forbidden = { statusCode: 403, code: 'FORBIDDEN' };
  /** Withdraws one DB109 entry of an assignment, as an access administrator would between the guard and the action. */
  const withdraw = async (a: TestActor, permission: PermissionKey) => {
    const [resource, action, fieldGroup] = permission.split('.');
    await h.db.query(
      `update role_assignment_permission set active = false
        where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
      [A.id, a.assignment, resource, action, fieldGroup],
    );
  };
  const revoke = (a: TestActor) => h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, a.assignment]);
  const batch = async (id: string) => ok<Batch>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${id}`));
  const lines = async (id: string) => (await ok<{ items: { id: string; paymentState: string }[] }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${id}/lines`))).items;
  const paymentEvents = async (batchId: string) =>
    (
      await h.one<{ n: number }>(
        `select count(*)::int as n from payroll_payment_event e join payroll_bank_line l on l.company_id = e.company_id and l.id = e.bank_line_id where l.batch_id = $1`,
        [batchId],
      )
    ).n;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    bankReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: BANK_REVIEW });
    bankPrep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_PREPARE });
    const author = await h.actor(A, 'TREASURY_OPERATOR', { extra: T_AUTHOR });
    // Template configuration is company-wide and C2 keeps Treasury Approver in ASSIGNED scope, so an HR Administrator
    // assignment (whose ceiling holds these duties) validates and activates.
    const tApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: T_APPROVER });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await head(h, configA, configB, { code: 'RK_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    const t = await ok<{ id: string; version: number }>(
      await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', {
        templateCode: 'RK_CSV',
        name: 'Synthetic test layout',
        currencyCode: 'INR',
        bankSpecificationReference: 'SYNTH-SPEC-REF-RK',
        testOnly: true,
        formatDefinition: DEF,
      }),
      201,
    );
    const sample = await ok<{ sampleHash: string }>(await h.call(tApprover, 'GET', `/v1/payroll-outputs/bank-templates/${t.id}/sample`));
    const v = await ok<{ version: number }>(
      await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: sample.sampleHash, validationReference: 'SYNTH-BANK-ACCEPTANCE', expectedVersion: t.version }),
    );
    await ok(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: v.version }));
    templateId = t.id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('authorisation, the file issue and outcomes are refused under an authority narrowed after the guard; current authority completes them', async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'RK_PAY', 'RK_PAY', true) returning id`, [A.id])).id;
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: '30000', components: [{ code: 'RK_BASIC', amount: '30000' }] });
    await verifiedBank(h, A, bankReviewer, e);
    const run = await createRun(h, preparer, periods['2026-01']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    const prepared = await ok<Batch>(await h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${run.id}/bank-manifests`, { templateId }), 201);
    expect(prepared.state).toBe('VALIDATED');

    // Authorisation reserves the lines: refused after a DB109 entry is withdrawn, and after the assignment is revoked.
    const withdrawn = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    const wg = await grantOf(h, withdrawn, 'payroll_bank', 'authorize', ['amount']);
    await withdraw(withdrawn, 'payroll_bank.authorize.amount');
    await expect(withTransaction(h.pool, (tx) => authorizeManifest(tx, wg, prepared.id, { expectedVersion: prepared.version }))).rejects.toMatchObject(forbidden);
    const revoked = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    const rg = await grantOf(h, revoked, 'payroll_bank', 'authorize', ['amount']);
    await revoke(revoked);
    await expect(withTransaction(h.pool, (tx) => authorizeManifest(tx, rg, prepared.id, { expectedVersion: prepared.version }))).rejects.toMatchObject(forbidden);
    expect((await batch(prepared.id)).state).toBe('VALIDATED');
    expect(await paymentEvents(prepared.id)).toBe(0);
    expect((await lines(prepared.id)).map((l) => l.paymentState)).toEqual(['READY']);
    const authorizer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    expect((await ok<Batch>(await h.call(authorizer, 'POST', `/v1/payroll-outputs/bank-manifests/${prepared.id}/authorize`, { expectedVersion: prepared.version }))).state).toBe('AUTHORIZED');
    expect(await paymentEvents(prepared.id)).toBe(1); // the line's RESERVED event

    // The restricted file: refused once the downloader's user is deactivated after the guard; nothing is generated.
    const deactivated = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    const dg = await grantOf(h, deactivated, 'payroll_bank', 'download', ['bank']);
    await h.db.query(`update user_account set active = false where id = $1`, [deactivated.user]);
    await expect(withTransaction(h.pool, (tx) => issueManifest(tx, memoryFileStore(), dg, prepared.id))).rejects.toMatchObject(forbidden);
    expect((await batch(prepared.id)).state).toBe('AUTHORIZED');
    expect((await ok<Batch>(await h.call(authorizer, 'POST', `/v1/payroll-outputs/bank-manifests/${prepared.id}/issue`))).state).toBe('ISSUED');

    // A payment outcome: refused after the recorder's duty is withdrawn; the line stays reserved with no new event.
    const [line] = await lines(prepared.id);
    const confirmed = { lineId: line!.id, outcome: 'CONFIRMED' as const, eventKey: key('ev-'), evidenceReference: 'SYNTH-BANK-STATEMENT-1' };
    const lapsed = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME });
    const og = await grantOf(h, lapsed, 'payroll_bank', 'record_outcome', ['amount']);
    await withdraw(lapsed, 'payroll_bank.record_outcome.amount');
    const events = await paymentEvents(prepared.id);
    await expect(withTransaction(h.pool, (tx) => recordOutcomes(tx, og, prepared.id, { outcomes: [confirmed] }))).rejects.toMatchObject(forbidden);
    expect((await lines(prepared.id)).map((l) => l.paymentState)).toEqual(['RESERVED']);
    expect(await paymentEvents(prepared.id)).toBe(events);
    const recorder = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME });
    await ok(await h.call(recorder, 'POST', `/v1/payroll-outputs/bank-manifests/${prepared.id}/outcomes`, { outcomes: [confirmed] }));
    expect((await lines(prepared.id)).map((l) => l.paymentState)).toEqual(['CONFIRMED']);
  });
});
