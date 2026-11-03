// Bank file templates, manifests, the restricted file and the salary payment ledger over HTTP (FR-102; DB112-DB114;
// DB118; H2 payment states; BR-052; CI27; CI28; DF07; ZT38). Synthetic employees, banks, accounts and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  createRun,
  criterion,
  CRITERIA,
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
  trailText,
  verifiedBank,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { activateTemplate, prepareManifest } from './bank.js';

const BANK_REVIEW = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'] as const;
// The treasury roles read template configuration by default (registration); these are their ceiling duties.
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
  lineCount: number;
  totalAmount: string;
  contentHash: string | null;
  ledger: { paymentState: string; lines: number; amount: string; netConfirmed: string }[];
}
interface Line {
  id: string;
  allocationKey: string;
  employeeId: string;
  holdId: string | null;
  amount: string;
  paymentState: string;
}

describe.runIf(isModuleActive('payroll-outputs'))('bank files and the salary payment ledger (FR-102, H2, DF07)', () => {
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
  let releaser: TestActor;
  let periods: Record<string, string>;
  let templateId: string;
  let criterionId: string;
  const people: Record<string, TestActor> = {};
  let uploader: TestActor;
  let verifier: TestActor;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount: string, bank: 'VERIFIED' | 'UNVERIFIED' = 'VERIFIED') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: amount, components: [{ code: 'BK_BASIC', amount }] });
    people[e] = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    if (bank === 'VERIFIED') await verifiedBank(h, A, bankReviewer, e, people[e]);
    else await bankRevision(h, A, e);
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
  const activeTemplate = async (code: string, def: object, opts: { currencyCode?: string } = {}) => {
    const t = await ok<{ id: string; version: number }>(
      await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', {
        templateCode: code,
        name: 'Synthetic test layout',
        currencyCode: opts.currencyCode ?? 'INR',
        bankSpecificationReference: 'SYNTH-SPEC-REF-1',
        testOnly: true,
        formatDefinition: def,
      }),
      201,
    );
    const sample = await ok<{ sampleHash: string }>(await h.call(tApprover, 'GET', `/v1/payroll-outputs/bank-templates/${t.id}/sample`));
    const v = await ok<{ version: number }>(
      await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: sample.sampleHash, validationReference: 'SYNTH-BANK-ACCEPTANCE', expectedVersion: t.version }),
    );
    await ok(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: v.version }));
    return t.id;
  };
  const prepare = (a: TestActor, runId: string, body: Record<string, unknown> = {}) => h.call(a, 'POST', `/v1/payroll-outputs/runs/${runId}/bank-manifests`, { templateId, ...body });
  const batch = async (a: TestActor, id: string) => ok<Batch>(await h.call(a, 'GET', `/v1/payroll-outputs/bank-manifests/${id}`));
  const lines = async (a: TestActor, id: string) => (await ok<{ items: Line[] }>(await h.call(a, 'GET', `/v1/payroll-outputs/bank-manifests/${id}/lines`))).items;
  const authorize = async (a: TestActor, id: string) => {
    const b = await ok<Batch>(await h.call(a, 'GET', `/v1/payroll-outputs/bank-manifests/${id}`));
    return h.call(a, 'POST', `/v1/payroll-outputs/bank-manifests/${id}/authorize`, { expectedVersion: b.version });
  };
  const position = async (recordId: string) => ok<{ earned: string; held: string; reserved: string; paid: string; ready: string }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/records/${recordId}/payment`));
  const outcome = (a: TestActor, batchId: string, list: { lineId: string; outcome: string; eventKey: string }[]) =>
    h.call(a, 'POST', `/v1/payroll-outputs/bank-manifests/${batchId}/outcomes`, { outcomes: list.map((o) => ({ ...o, evidenceReference: 'SYNTH-BANK-STATEMENT-1' })) });

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
    // Template configuration is company-wide and C2 keeps Treasury Approver in ASSIGNED scope, so an HR Administrator
    // assignment (whose ceiling holds these duties) validates and activates.
    tApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: T_APPROVER });
    // The preparer also holds the authorisation and outcome duties, so independence (not the grant) refuses them.
    bankPrep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(B_PREPARE, B_OUTCOME, ['payroll_bank.authorize.amount']) });
    uploader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENTS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    bankAuth = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    bankAuth2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    outcomes = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_PROPOSE });
    releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await head(h, configA, configB, { code: 'BK_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    templateId = await activeTemplate('SYNTH_CSV', DEF);
    criterionId = await criterion(h, configA, configB);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('activates a template only with a specification reference and an independent sample validation (DB112, H8)', async () => {
    // No format is presumed: unknown settings, unsupported layouts and a detail without amount or account are refused.
    for (const bad of [{ ...DEF, layout: 'FIXED_WIDTH' }, { ...DEF, padding: 'ZERO' }, { ...DEF, detail: [{ source: 'AMOUNT' }] }, { ...DEF, delimiter: 'STAR' }]) {
      const res = await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', {
        templateCode: 'SYNTH_BAD',
        name: 'x',
        currencyCode: 'INR',
        bankSpecificationReference: 'SYNTH-SPEC',
        testOnly: true,
        formatDefinition: bad,
      });
      expect(res.json().error, JSON.stringify(bad)).toBe('INVALID_TEMPLATE_DEFINITION');
    }
    const t = await ok<{ id: string; version: number; state: string; templateVersion: number }>(
      await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', {
        templateCode: 'SYNTH_TWO',
        name: 'Synthetic layout two',
        currencyCode: 'INR',
        bankSpecificationReference: 'SYNTH-SPEC-REF-2',
        testOnly: true,
        formatDefinition: DEF,
      }),
      201,
    );
    expect(t.state).toBe('DRAFT');
    // The treasury operator holds no validation or activation duty; nor does the author.
    expect((await h.call(author, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: t.version })).statusCode).toBe(403);
    const sample = await ok<{ label: string; sampleHash: string; content: string }>(await h.call(tApprover, 'GET', `/v1/payroll-outputs/bank-templates/${t.id}/sample`));
    expect(sample.label).toBe('SAMPLE_NOT_PAYABLE');
    expect(sample.content).toContain('SAMPLE-NOT-PAYABLE');
    // Activation needs the validated sample first.
    expect((await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: t.version })).json().error).toBe('SAMPLE_NOT_VALIDATED');
    // The validation is bound to this revision's own sample.
    expect(
      (await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: 'a'.repeat(64), validationReference: 'SYNTH-ACCEPT', expectedVersion: t.version })).json()
        .error,
    ).toBe('SAMPLE_MISMATCH');
    // An author holding the validation duty still never validates their own template.
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(['payroll_bank_template.read.operational'], T_AUTHOR, T_APPROVER) });
    const own = await ok<{ id: string; version: number }>(
      await h.call(both, 'POST', '/v1/payroll-outputs/bank-templates', { templateCode: 'SYNTH_OWN', name: 'x', currencyCode: 'INR', bankSpecificationReference: 'S', testOnly: true, formatDefinition: DEF }),
      201,
    );
    const ownSample = await ok<{ sampleHash: string }>(await h.call(both, 'GET', `/v1/payroll-outputs/bank-templates/${own.id}/sample`));
    expect(
      (await h.call(both, 'POST', `/v1/payroll-outputs/bank-templates/${own.id}/sample-validation`, { sampleHash: ownSample.sampleHash, validationReference: 'S', expectedVersion: own.version })).json().error,
    ).toBe('NOT_INDEPENDENT');
    const validated = await ok<{ version: number; sampleHash: string }>(
      await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: sample.sampleHash, validationReference: 'SYNTH-ACCEPT', expectedVersion: t.version }),
    );
    expect(validated.sampleHash).toBe(sample.sampleHash);
    // A synthetic test-only template is never activated in production.
    const env = process.env.NODE_ENV;
    await h.db.query('begin');
    try {
      process.env.NODE_ENV = 'production';
      const g = await grantOf(h, tApprover, 'payroll_bank_template', 'activate', ['operational']);
      await expect(activateTemplate(h.db, g, t.id, { expectedVersion: validated.version })).rejects.toMatchObject({ code: 'TEST_TEMPLATE_NOT_ACTIVATABLE' });
    } finally {
      process.env.NODE_ENV = env;
      await h.db.query('rollback');
    }
    const active = await ok<{ state: string }>(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: validated.version }));
    expect(active.state).toBe('ACTIVE');
    // A revision never changes in place.
    await expect(h.db.query(`update payroll_bank_template set format_definition = '{}'::jsonb where id = $1`, [t.id])).rejects.toThrow(/never changes/);
    await expect(h.db.query(`delete from payroll_bank_template where id = $1`, [t.id])).rejects.toThrow();
  });

  it('prepares, independently authorises and issues a final manifest of processed records only; nothing is ever marked paid by a file (FR-102, CI28)', async () => {
    const dept = await department('BK_MAIN');
    const e1 = await paid(dept, '30000');
    const e2 = await paid(dept, '45000.50');
    const e3 = await paid(dept, '20000', 'UNVERIFIED');
    // Before processing there is no bank output.
    const draft = await createRun(h, preparer, periods['2026-01']!, { departmentIds: [dept] });
    await calculate(h, preparer, draft.id);
    expect((await h.call(bankPrep, 'GET', `/v1/payroll-outputs/runs/${draft.id}/bank-preview`)).json().error).toBe('RUN_NOT_PROCESSED');
    expect((await prepare(bankPrep, draft.id)).json().error).toBe('RUN_NOT_PROCESSED');
    await submitAndApprove(h, { preparer, reviewer, approver }, draft.id);
    await processRun(h, processor, draft.id);
    const runId = draft.id;
    const rec = { e1: (await record(h, processor, runId, e1)).id, e2: (await record(h, processor, runId, e2)).id, e3: (await record(h, processor, runId, e3)).id };

    // The non-payable preview: labelled, nothing stored, no bank values; the unverified instruction is held (safety block).
    const preview = await ok<{ label: string; payable: boolean; lineCount: number; totalAmount: string; excluded: { held: number }; errors: unknown[] }>(
      await h.call(bankPrep, 'GET', `/v1/payroll-outputs/runs/${runId}/bank-preview?templateId=${templateId}`),
    );
    expect(preview).toMatchObject({ label: 'NON_PAYABLE_PREVIEW', payable: false, lineCount: 2, totalAmount: '75000.5000', excluded: { held: 1 }, errors: [] });
    expect(JSON.stringify(preview)).not.toContain('000987654321');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_bank_batch where run_id = $1`, [runId])).n).toBe(0);

    // Access: no grant, the Employee context and a scope that misses run members are refused.
    expect((await h.call(hr, 'GET', `/v1/payroll-outputs/runs/${runId}/bank-preview`)).statusCode).toBe(403);
    expect((await prepare(people[e1]!, runId)).statusCode).toBe(403);
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_PREPARE, departmentFilter: A.dept });
    expect((await prepare(narrow, runId)).json().error).toBe('SCOPE_INCOMPLETE');
    // Nobody prepares a manifest containing their own salary.
    const linked = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_PREPARE, user: people[e2]!.user });
    expect((await prepare(linked, runId)).json().error).toBe('SELF_INCLUDED');

    const b = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect(b).toMatchObject({ state: 'VALIDATED', lineCount: 2, totalAmount: '75000.5000', contentHash: null });
    const ls = await lines(bankPrep, b.id);
    expect(ls.map((l) => [l.employeeId, l.amount, l.paymentState, l.holdId]).sort()).toEqual(
      [
        [e1, '30000.0000', 'READY', null],
        [e2, '45000.5000', 'READY', null],
      ].sort(),
    );
    expect(ls.every((l) => /^PAY-[0-9a-f-]{36}-1$/.test(l.allocationKey))).toBe(true);
    // One manifest awaits authorisation per run; nothing is reserved yet.
    expect((await prepare(bankPrep, runId)).json().error).toBe('MANIFEST_OPEN');
    expect(await position(rec.e1)).toMatchObject({ earned: '30000.0000', reserved: '0.0000', paid: '0.0000', ready: '30000.0000' });
    // The file exists only after authorisation.
    expect((await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/issue`)).json().error).toBe('NOT_AUTHORIZED');

    // Independent authorisation: never the preparer (who holds the duty too); the lines are reserved atomically.
    expect((await authorize(bankPrep, b.id)).json().error).toBe('NOT_INDEPENDENT');
    expect((await authorize(outcomes, b.id)).statusCode).toBe(403);
    const auth = await ok<Batch>(await authorize(bankAuth, b.id));
    expect(auth.state).toBe('AUTHORIZED');
    expect(auth.ledger).toEqual([{ paymentState: 'RESERVED', lines: 2, amount: '75000.5000', netConfirmed: '0.0000' }]);
    expect(await position(rec.e1)).toMatchObject({ reserved: '30000.0000', paid: '0.0000', ready: '0.0000' });
    // CI27: a reserved amount is not unreserved for a hold (the core's capacity joins the payment ledger).
    const doc = await evidenceDocument(h, uploader, verifier, e1);
    const holdTry = (scope: string, amount?: string) =>
      h.call(maker, 'POST', `/v1/payroll/records/${rec.e1}/holds`, {
        criterionId: criterionId,
        scope,
        ...(amount ? { amount } : {}),
        reason: 'Synthetic contractual hold',
        effectiveDate: '2099-01-01',
        reviewDueOn: '2099-01-10',
        releaseCriterion: 'Synthetic release condition',
        evidenceReference: 'SYNTH-HOLD-CASE',
        evidenceDocumentIds: [doc],
      });
    expect((await holdTry('FULL')).json().error).toBe('NOTHING_TO_HOLD');
    expect((await holdTry('PARTIAL', '1.00')).json().error).toBe('HOLD_EXCEEDS_UNRESERVED');
    // Everything is reserved or held: no second manifest.
    expect((await prepare(bankPrep, runId)).json().error).toBe('NOTHING_PAYABLE');

    // The restricted file: generated once, the same bytes on every download; still nothing paid.
    const issued = await ok<Batch & { replayed: boolean }>(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/issue`));
    expect(issued).toMatchObject({ state: 'ISSUED', replayed: false });
    expect((await ok<{ replayed: boolean }>(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/issue`))).replayed).toBe(true);
    const f1 = await h.call(bankAuth, 'GET', `/v1/payroll-outputs/bank-manifests/${b.id}/file`);
    const f2 = await h.call(bankAuth, 'GET', `/v1/payroll-outputs/bank-manifests/${b.id}/file`);
    expect(f1.statusCode).toBe(200);
    expect(f1.body).toBe(f2.body);
    const rows = f1.body.trim().split('\n');
    expect(rows[0]).toMatch(/^H,2026-01-SYNTH_CSV-1,20991231$/);
    expect(rows.slice(1, -1).sort()).toEqual(
      ls.map((l) => `D,${l.allocationKey},Synthetic Holder,000987654321,SYNTH0002,${l.amount === '30000.0000' ? '30000.00' : '45000.50'},INR`).sort(),
    );
    expect(rows.at(-1)).toBe('T,2,75000.50');
    // The bank-file download duty is separate from the amount duties.
    expect((await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${b.id}/file`)).statusCode).toBe(403);
    // The stored file is sealed: no clear bank value rests in the file store reference.
    const after = await batch(bankPrep, b.id);
    expect(after.ledger).toEqual([{ paymentState: 'RESERVED', lines: 2, amount: '75000.5000', netConfirmed: '0.0000' }]);
    expect(await position(rec.e2)).toMatchObject({ reserved: '45000.5000', paid: '0.0000' });

    // Outcomes only from evidence, by an independent recorder; idempotent evidence keys.
    const l1 = ls.find((l) => l.employeeId === e1)!;
    const l2 = ls.find((l) => l.employeeId === e2)!;
    const k1 = key('ev-');
    const k2 = key('ev-');
    // The preparer never records outcomes, nor does the beneficiary.
    expect((await outcome(bankPrep, b.id, [{ lineId: l1.id, outcome: 'CONFIRMED', eventKey: k1 }])).json().error).toBe('NOT_INDEPENDENT');
    const beneficiary = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME, user: people[e1]!.user });
    expect((await outcome(beneficiary, b.id, [{ lineId: l1.id, outcome: 'CONFIRMED', eventKey: k1 }])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    await ok(await outcome(outcomes, b.id, [{ lineId: l1.id, outcome: 'CONFIRMED', eventKey: k1 }]));
    const first = await ok<{ results: { replayed: boolean }[] }>(await outcome(outcomes, b.id, [{ lineId: l2.id, outcome: 'UNKNOWN', eventKey: k2 }]));
    expect(first.results[0]!.replayed).toBe(false);
    expect((await ok<{ results: { replayed: boolean }[] }>(await outcome(outcomes, b.id, [{ lineId: l2.id, outcome: 'UNKNOWN', eventKey: k2 }]))).results[0]!.replayed).toBe(true);
    // The same evidence never records a different outcome.
    expect((await outcome(outcomes, b.id, [{ lineId: l2.id, outcome: 'FAILED', eventKey: k2 }])).json().error).toBe('EVIDENCE_KEY_REUSED');
    // A confirmed line cannot be confirmed again.
    expect((await outcome(outcomes, b.id, [{ lineId: l1.id, outcome: 'CONFIRMED', eventKey: key('ev-') }])).json().error).toBe('INVALID_TRANSITION');
    expect((await ok<{ results: { replayed: boolean }[] }>(await outcome(outcomes, b.id, [{ lineId: l1.id, outcome: 'CONFIRMED', eventKey: k1 }]))).results[0]!.replayed).toBe(true);
    // UNKNOWN stays pending: nothing to repay.
    expect(await position(rec.e2)).toMatchObject({ reserved: '45000.5000', paid: '0.0000', ready: '0.0000' });
    expect((await prepare(bankPrep, runId)).json().error).toBe('NOTHING_PAYABLE');
    expect(await position(rec.e1)).toMatchObject({ reserved: '0.0000', paid: '30000.0000', ready: '0.0000' });
    // A definitive failure frees the reservation; the replacement is a new allocation key, independently authorised.
    await ok(await outcome(outcomes, b.id, [{ lineId: l2.id, outcome: 'FAILED', eventKey: key('ev-') }]));
    expect(await position(rec.e2)).toMatchObject({ reserved: '0.0000', paid: '0.0000', ready: '45000.5000' });
    const r2 = await ok<Batch>(await prepare(bankPrep, runId, { supersedesBatchId: b.id }), 201);
    expect(r2).toMatchObject({ lineCount: 1, totalAmount: '45000.5000' });
    const r2l = await lines(bankPrep, r2.id);
    expect(r2l[0]!.allocationKey).toBe(l2.allocationKey.replace(/-1$/, '-2'));
    await ok(await authorize(bankAuth2, r2.id));

    // Reversal: bounded by the unreversed confirmed amount; a partial reversal frees only its amount.
    const rev = (amount: string, eventKey: string) =>
      h.call(outcomes, 'POST', `/v1/payroll-outputs/bank-lines/${l1.id}/reversal`, { amount, eventKey, evidenceReference: 'SYNTH-RETURN-1', reason: 'Synthetic return by the bank' });
    expect((await rev('30000.01', key('rv-'))).json().error).toBe('EXCEEDS_CONFIRMED');
    const rk = key('rv-');
    expect(await ok<{ paymentState: string; reversedAmount: string }>(await rev('100.00', rk))).toMatchObject({ paymentState: 'CONFIRMED', reversedAmount: '100.0000' });
    expect((await ok<{ replayed: boolean }>(await rev('100.00', rk))).replayed).toBe(true);
    expect(await position(rec.e1)).toMatchObject({ paid: '29900.0000', ready: '100.0000' });

    // The ledger changes only through events; events are append-only; nothing is deleted.
    await expect(h.db.query(`update payroll_bank_line set payment_state = 'CONFIRMED', confirmed_amount = payable_amount where id = $1`, [r2l[0]!.id])).rejects.toThrow(/payment events/);
    await expect(h.db.query(`update payroll_payment_event set amount = 1 where bank_line_id = $1`, [l1.id])).rejects.toThrow();
    await expect(h.db.query(`delete from payroll_bank_batch where id = $1`, [b.id])).rejects.toThrow();
    await expect(h.db.query(`update payroll_bank_batch set content_hash = $2 where id = $1`, [b.id, 'b'.repeat(64)])).rejects.toThrow(/immutable/);

    // Audit operational values and outbox payloads carry no bank values or amounts.
    const trail = await trailText(h, A.id);
    for (const secret of ['000987654321', 'SYNTH0002', '45000.5', '75000.5']) {
      expect(trail.operational).not.toContain(secret);
      expect(trail.outbox).not.toContain(secret);
    }
  });

  it("never shows the caller's own payment position or manifest line in the Admin context (H1, I-43)", async () => {
    const dept = await department('BK_SELF');
    const e1 = await paid(dept, '30000');
    const e2 = await paid(dept, '20000');
    const { runId, records } = await processed('2026-09', dept, [e1, e2]);
    const b = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect((await lines(bankPrep, b.id)).map((l) => l.employeeId).sort()).toEqual([e1, e2].sort());
    // The same person as employee e2, holding the bank read duty in an Admin assignment.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_bank.read.amount'], user: people[e2]!.user });
    expect((await lines(self, b.id)).map((l) => l.employeeId)).toEqual([e1]);
    const own = await h.call(self, 'GET', `/v1/payroll-outputs/records/${records[e2]}/payment`);
    expect([own.statusCode, own.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);
    expect(own.body).not.toContain('20000');
    // Anyone else's position stays readable, and the employee's own view is untouched by this rule.
    expect(await ok(await h.call(self, 'GET', `/v1/payroll-outputs/records/${records[e1]}/payment`))).toMatchObject({ earned: '30000.0000', record: { employeeId: e1 } });
  });

  it('pays a released safety block as its own allocation with the verified instruction, and validates every row (H2, CI27, CI28)', async () => {
    const dept = await department('BK_SAFE');
    const e = await paid(dept, '20000', 'UNVERIFIED');
    const f = await paid(dept, '12345.67');
    const { runId, records } = await processed('2026-02', dept, [e, f]);
    // A template without decimals cannot carry 12345.67: no manifest, a recoverable exception list instead.
    const whole = await activeTemplate('SYNTH_WHOLE', { ...DEF, amountDecimals: 0 });
    const refused = await h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${runId}/bank-manifests`, { templateId: whole });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'BANK_FILE_VALIDATION_FAILED' });
    expect(JSON.stringify(refused.json())).toContain('AMOUNT_PRECISION');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_bank_batch where run_id = $1`, [runId])).n).toBe(0);
    // Excluding needs a reason.
    expect((await h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${runId}/bank-manifests`, { templateId: whole, excludeEmployeeIds: [f] })).json().error).toBe('EXCLUSION_REASON_REQUIRED');
    // Nothing else is payable: the safety-blocked net is held.
    expect(
      (await h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${runId}/bank-manifests`, { templateId: whole, excludeEmployeeIds: [f], exclusionReason: 'Synthetic: paid by the next file' })).json()
        .error,
    ).toBe('NOTHING_PAYABLE');
    // Release of the safety block after the Admin verifies the instruction: a REL allocation bound to the hold.
    const block = await h.one<{ id: string; version: number }>(`select id, version from payroll_hold where payroll_record_id = $1 and hold_kind = 'PAYMENT_SAFETY_BLOCK'`, [records[e]]);
    await ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, { reason: 'Synthetic instruction verified', evidenceReference: 'SYNTH-CALLBACK-1', expectedVersion: block.version }));
    const bt = await ok<Batch>(await prepare(bankPrep, runId), 201);
    const bl = await lines(bankPrep, bt.id);
    expect(bl.map((l) => [l.employeeId, l.holdId, l.amount]).sort()).toEqual(
      [
        [e, block.id, '20000.0000'],
        [f, null, '12345.6700'],
      ].sort(),
    );
    expect(bl.find((l) => l.holdId)!.allocationKey).toBe(`REL-${block.id}-1`);
    // Changed state invalidates the prepared manifest: a cancelled manifest frees its READY lines, nothing is reserved.
    const c = await ok<Batch>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${bt.id}`));
    await ok(await h.call(bankPrep, 'POST', `/v1/payroll-outputs/bank-manifests/${bt.id}/cancel`, { reason: 'Synthetic re-preparation', expectedVersion: c.version }));
    expect((await lines(bankPrep, bt.id)).every((l) => l.paymentState === 'CANCELLED')).toBe(true);
    const again = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect((await lines(bankPrep, again.id)).map((l) => l.allocationKey).sort()).toEqual(bl.map((l) => l.allocationKey.replace(/-1$/, '-2')).sort());

    // Concurrency: two authorisers at once, one wins; the reservation happens once.
    const [x, y] = await Promise.all([authorize(bankAuth, again.id), authorize(bankAuth2, again.id)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_payment_event ev join payroll_bank_line l on l.id = ev.bank_line_id where l.batch_id = $1`, [again.id])).n).toBe(2);
    // Concurrent replays of the same evidence record one outcome.
    const l = (await lines(bankPrep, again.id))[0]!;
    const k = key('ev-');
    const [p, q] = await Promise.all([outcome(outcomes, again.id, [{ lineId: l.id, outcome: 'CANCELLED', eventKey: k }]), outcome(outcomes, again.id, [{ lineId: l.id, outcome: 'CANCELLED', eventKey: k }])]);
    expect([p.statusCode, q.statusCode]).toEqual([200, 200]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_payment_event where bank_line_id = $1`, [l.id])).n).toBe(2);
    // Another run's line or a crafted id is not found.
    expect((await outcome(outcomes, again.id, [{ lineId: '00000000-0000-4000-8000-000000000009', outcome: 'CONFIRMED', eventKey: key('ev-') }])).statusCode).toBe(404);
    expect((await h.call(bankPrep, 'GET', '/v1/payroll-outputs/bank-manifests/00000000-0000-4000-8000-000000000009')).statusCode).toBe(404);
  });

  it('refuses stale authorisations, run actors as releasers, early outcomes, reused evidence, unbounded reversals and other companies (H5, DF07, CI27)', async () => {
    const dept = await department('BK_MORE');
    const g1 = await paid(dept, '10000');
    const g2 = await paid(dept, '8000.25');
    const g3 = await paid(dept, '5000');
    const { runId, records } = await processed('2026-03', dept, [g1, g2, g3]);

    // Another company never sees or acts on this company's run, manifests, lines or records.
    const B = await h.makeCompany();
    const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: grants(B_PREPARE, B_AUTHORIZE, B_OUTCOME) });
    expect((await h.call(foreign, 'GET', `/v1/payroll-outputs/runs/${runId}/bank-preview`)).statusCode).toBe(404);
    expect((await prepare(foreign, runId)).statusCode).toBe(404);
    expect((await h.call(foreign, 'GET', `/v1/payroll-outputs/records/${records[g2]}/payment`)).statusCode).toBe(404);

    // A synthetic test-only template is never used for a final manifest in production, even when already active.
    const env = process.env.NODE_ENV;
    await h.db.query('begin');
    try {
      process.env.NODE_ENV = 'production';
      const g = await grantOf(h, bankPrep, 'payroll_bank', 'prepare', ['amount']);
      await expect(prepareManifest(h.db, g, runId, { templateId })).rejects.toMatchObject({ code: 'TEST_TEMPLATE_NOT_ACTIVATABLE' });
    } finally {
      process.env.NODE_ENV = env;
      await h.db.query('rollback');
    }

    // H5 "changed hold state invalidates draft authorization": a hold proposed after preparation makes the manifest
    // stale; the authorisation recomputes it under the record locks and refuses, reserving nothing.
    const b = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect(b).toMatchObject({ lineCount: 3, totalAmount: '23000.2500' });
    const doc = await evidenceDocument(h, uploader, verifier, g1);
    await reviewers(h, hr, 'payroll_hold', [await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_DECIDE })]);
    await ok(
      await h.call(maker, 'POST', `/v1/payroll/records/${records[g1]}/holds`, {
        criterionId,
        scope: 'FULL',
        reason: 'Synthetic contractual hold',
        effectiveDate: '2099-01-01',
        reviewDueOn: '2099-01-10',
        releaseCriterion: 'Synthetic release condition',
        evidenceReference: 'SYNTH-HOLD-CASE-2',
        evidenceDocumentIds: [doc],
      }),
      201,
    );
    expect((await authorize(bankAuth, b.id)).json().error).toBe('MANIFEST_STALE');
    expect((await batch(bankPrep, b.id)).ledger).toEqual([{ paymentState: 'READY', lines: 3, amount: '23000.2500', netConfirmed: '0.0000' }]);
    expect(await position(records[g2]!)).toMatchObject({ reserved: '0.0000', ready: '8000.2500' });
    const stale = await batch(bankPrep, b.id);
    await ok(await h.call(bankPrep, 'POST', `/v1/payroll-outputs/bank-manifests/${b.id}/cancel`, { reason: 'Synthetic: stale', expectedVersion: stale.version }));
    // The replacement leaves the held record out.
    const b2 = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect(b2).toMatchObject({ lineCount: 2, totalAmount: '13000.2500' });

    // C4 / DF07: the run's preparer, reviewer and approver never release or confirm its payments, whatever they hold.
    for (const a of [preparer, reviewer, approver]) {
      const twin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(B_AUTHORIZE, B_OUTCOME), user: a.user });
      expect((await authorize(twin, b2.id)).json().error).toBe('NOT_INDEPENDENT');
    }
    expect((await h.call(foreign, 'POST', `/v1/payroll-outputs/bank-manifests/${b2.id}/authorize`, { expectedVersion: b2.version })).statusCode).toBe(404);
    await ok(await authorize(bankAuth, b2.id));
    const bl = await lines(bankPrep, b2.id);
    const l2 = bl.find((l) => l.employeeId === g2)!;
    const l3 = bl.find((l) => l.employeeId === g3)!;

    // Before the file is issued only a cancellation can be recorded, in the service and in the database.
    expect((await outcome(outcomes, b2.id, [{ lineId: l2.id, outcome: 'CONFIRMED', eventKey: key('ev-') }])).json().error).toBe('FILE_NOT_ISSUED');
    const directEvent = (lineId: string, kind: string, by: string) =>
      h.db.query(
        `insert into payroll_payment_event (company_id, bank_line_id, sequence, event_kind, event_key, amount, currency_code, event_time, evidence_reference, recorded_by)
         select company_id, id, last_event_sequence + 1, $2, $3, payable_amount, currency_code, now(), 'SYNTH-DIRECT', $4 from payroll_bank_line where id = $1`,
        [lineId, kind, key('db-'), by],
      );
    await expect(directEvent(l2.id, 'CONFIRMED', outcomes.user)).rejects.toThrow(/does not fit/);
    await ok(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${b2.id}/issue`));
    // The database refuses an event recorded by the manifest's preparer.
    await expect(directEvent(l3.id, 'FAILED', bankPrep.user)).rejects.toThrow(/preparer/);
    const approverTwin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME, user: approver.user });
    expect((await outcome(approverTwin, b2.id, [{ lineId: l2.id, outcome: 'CONFIRMED', eventKey: key('ev-') }])).json().error).toBe('NOT_INDEPENDENT');
    expect((await outcome(foreign, b2.id, [{ lineId: l2.id, outcome: 'CONFIRMED', eventKey: key('ev-') }])).statusCode).toBe(404);

    // Reversals: never of an unconfirmed line; the same evidence never records on another line; a replay by a
    // caller who is not independent is refused rather than reported as replayed.
    const rev = (a: TestActor, lineId: string, amount: string, eventKey: string) =>
      h.call(a, 'POST', `/v1/payroll-outputs/bank-lines/${lineId}/reversal`, { amount, eventKey, evidenceReference: 'SYNTH-RETURN-2', reason: 'Synthetic return by the bank' });
    expect((await rev(outcomes, l2.id, '1.00', key('rv-'))).json().error).toBe('INVALID_TRANSITION');
    const kc = key('ev-');
    await ok(await outcome(outcomes, b2.id, [{ lineId: l2.id, outcome: 'CONFIRMED', eventKey: kc }]));
    expect((await outcome(outcomes, b2.id, [{ lineId: l3.id, outcome: 'CONFIRMED', eventKey: kc }])).json().error).toBe('EVIDENCE_KEY_REUSED');
    expect((await outcome(bankPrep, b2.id, [{ lineId: l2.id, outcome: 'CONFIRMED', eventKey: kc }])).json().error).toBe('NOT_INDEPENDENT');
    expect((await rev(foreign, l2.id, '1.00', key('rv-'))).statusCode).toBe(404);
    const rk = key('rv-');
    expect((await rev(bankPrep, l2.id, '1.00', rk)).json().error).toBe('NOT_INDEPENDENT');
    // A full reversal: REVERSED, nothing further to reverse, and the amount is payable again under a new key.
    expect(await ok<{ paymentState: string; reversedAmount: string }>(await rev(outcomes, l2.id, '8000.25', rk))).toMatchObject({ paymentState: 'REVERSED', reversedAmount: '8000.2500' });
    expect((await rev(outcomes, l2.id, '0.01', key('rv-'))).json().error).toBe('INVALID_TRANSITION');
    expect((await rev(outcomes, l2.id, '1.00', kc)).json().error).toBe('EVIDENCE_KEY_REUSED');
    expect(await position(records[g2]!)).toMatchObject({ reserved: '0.0000', paid: '0.0000', ready: '8000.2500' });
    // The other line stays reserved (no outcome yet): only the reversed amount is in the next manifest.
    const b3 = await ok<Batch>(await prepare(bankPrep, runId), 201);
    expect(b3).toMatchObject({ lineCount: 1, totalAmount: '8000.2500' });
    expect((await lines(bankPrep, b3.id))[0]!.allocationKey).toBe(l2.allocationKey.replace(/-\d+$/, '-3'));
  });
});
