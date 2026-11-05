// Tax declarations and investment proofs over HTTP (FR-036 declaration checking; FR-108; H3 TN08, TN09; H1; H4; BR-053; BR-055;
// ZT39): the NOT_CONFIGURED state until a rule pack is activated, sealed values, the cutoff, regimes and categories only from the
// active pack, scan and evidence rules, independent review and that nothing reaches payroll. No tax is calculated. Regimes,
// categories, dates and amounts are clearly synthetic fixtures, not any jurisdiction's rules.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { AccessGrant } from '../access/authorize.js';
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
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  trailText,
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { activatePack, createOwnDeclaration, createPack, decideDeclaration as decideDeclarationNow, decideProof as decideProofNow, submitOwnDeclaration, submitOwnProof } from './service.js';

const REVIEWER: PermissionKey[] = ['tax_declaration.read.tax', 'tax_declaration.review.tax'];

interface Declaration {
  id: string;
  state: string;
  version: number;
  regimeCode: string;
  lines: { categoryCode: string; amount: string }[];
  employeeExplanation: string | null;
  followsDeclarationId: string | null;
  rulePackId: string;
  reason?: string;
}
interface Proof {
  id: string;
  state: string;
  claimedAmount: string;
  acceptedAmount: string | null;
  rejectedAmount: string | null;
  employeeExplanation: string | null;
  evidence: { documentId: string; scanState: string; verificationState: string }[];
  replayed?: boolean;
}

describe.runIf(isModuleActive('tax-declarations'))('tax declarations and proofs (FR-036, FR-108, TN08, TN09)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let reviewer: TestActor;
  let plainHr: TestActor;
  let verifier: TestActor;
  let employeeId: string;
  let employee: TestActor;
  let otherId: string;
  let other: TestActor;

  const packBody = (overrides: Record<string, unknown> = {}) => ({
    code: uniq('SYNTHPACK').toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    fiscalPeriodCode: 'FY-SYNTH',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    cutoffDate: '2099-12-31',
    currencyCode: 'INR',
    currencyMinorUnit: 2,
    sourceReference: 'SYNTH-PACK-SOURCE (test fixture, no real rules)',
    validationReference: 'SYNTH-PACK-VALIDATION',
    regimes: [
      { code: 'SYNTH_REGIME_A', name: 'Synthetic regime A', categories: [{ code: 'SYNTH_CAT_1', name: 'Synthetic category 1' }, { code: 'SYNTH_CAT_2', name: 'Synthetic category 2' }] },
      { code: 'SYNTH_REGIME_B', name: 'Synthetic regime B', categories: [] },
    ],
    ...overrides,
  });
  const activePackFor = async (overrides: Record<string, unknown> = {}) => {
    const draft = await ok<{ id: string; version: number }>(await h.call(configA, 'POST', '/v1/payroll/tax-rule-packs', packBody(overrides)), 201);
    return ok<{ id: string; state: string }>(await h.call(configB, 'POST', `/v1/payroll/tax-rule-packs/${draft.id}/activate`, { expectedVersion: draft.version }));
  };
  const draft = (a: TestActor, fiscalPeriodCode: string, lines = [{ categoryCode: 'SYNTH_CAT_1', amount: '1234.50' }], regimeCode = 'SYNTH_REGIME_A') =>
    h.call(a, 'POST', '/v1/me/tax-declarations', { fiscalPeriodCode, regimeCode, lines });
  const submit = (a: TestActor, d: { id: string; version: number }) => h.call(a, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version });
  const declarationTask = async (a: TestActor, id: string) =>
    ((await h.call(a, 'GET', '/v1/tax-declarations/tasks/mine')).json().items as { taskId: string; declaration: { id: string } }[]).find((t) => t.declaration.id === id)?.taskId;
  const proofTask = async (a: TestActor, id: string) =>
    ((await h.call(a, 'GET', '/v1/tax-proofs/tasks/mine')).json().items as { taskId: string; proof: { id: string } }[]).find((t) => t.proof.id === id)?.taskId;
  const decideDeclaration = async (a: TestActor, id: string, body: Record<string, unknown>) => {
    const taskId = await declarationTask(a, id);
    expect(taskId, `task of declaration ${id}`).toBeDefined();
    return h.call(a, 'POST', `/v1/tax-declaration-tasks/${taskId}/decision`, { idempotencyKey: key('tax-'), ...body });
  };
  const decideProof = async (a: TestActor, id: string, body: Record<string, unknown>) => {
    const taskId = await proofTask(a, id);
    expect(taskId, `task of proof ${id}`).toBeDefined();
    return h.call(a, 'POST', `/v1/tax-proof-tasks/${taskId}/decision`, { idempotencyKey: key('tax-'), ...body });
  };
  /** A fresh employee in the Employee OWN context, for a fresh fiscal period (each scenario keeps to its own rows). */
  const newEmployee = async () => {
    const id = await person(h, A, hr, { joiningDate: '2026-01-05' });
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };
  const pdf = (text = `synthetic proof ${uniq('doc')}`) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1').toString('base64');
  /** The employee's own upload (TN05), released by the development scanner. */
  const ownDocument = async (a: TestActor, id: string, content = pdf()) =>
    ok<{ id: string; scanState: string }>(await h.call(a, 'POST', `/v1/employees/${id}/documents`, { documentType: 'GENERAL', fileName: 'proof.pdf', contentBase64: content }), 201);
  const verified = async (a: TestActor, id: string) => {
    const doc = await ownDocument(a, id);
    await ok(await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
    return doc.id;
  };
  const proofBody = (declarationId: string, documentIds: string[], overrides: Record<string, unknown> = {}) => ({
    declarationId,
    categoryCode: 'SYNTH_CAT_1',
    claimedAmount: '1000.00',
    evidenceDocumentIds: documentIds,
    idempotencyKey: key('tax-proof-'),
    ...overrides,
  });
  /** A declaration through to the given review outcome, for a fresh employee and fiscal period. */
  const reviewed = async (period: string, outcome: 'ACCEPT' | 'SUBMITTED' = 'ACCEPT') => {
    const e = await newEmployee();
    const d = await ok<Declaration>(await draft(e.actor, period), 201);
    const submitted = await ok<Declaration>(await submit(e.actor, d));
    if (outcome === 'ACCEPT') await ok(await decideDeclaration(reviewer, d.id, { decision: 'ACCEPT' }));
    return { ...e, declaration: submitted };
  };
  const ownDeclaration = async (a: TestActor, id: string) => (await ok<{ items: Declaration[] }>(await h.call(a, 'GET', '/v1/me/tax-declarations'))).items.find((d) => d.id === id)!;
  const ownProof = async (a: TestActor, id: string) => (await ok<{ items: Proof[] }>(await h.call(a, 'GET', '/v1/me/tax-proofs'))).items.find((p) => p.id === id)!;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
    plainHr = await h.actor(A, 'HR_ADMINISTRATOR');
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'tax_declaration', [reviewer]);
    employeeId = await person(h, A, hr, { joiningDate: '2026-01-05' });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId });
    otherId = await person(h, A, hr, { joiningDate: '2026-01-05' });
    other = await h.actor(A, 'EMPLOYEE', { employeeId: otherId });
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('until a rule pack is activated', () => {
    it('ships no pack: both tabs say NOT_CONFIGURED in plain words and link nowhere, even with a draft pack', async () => {
      expect((await h.one<{ n: number }>(`select count(*)::int as n from tax_rule_pack where company_id = $1`, [A.id])).n).toBe(0);
      await ok(await h.call(configA, 'POST', '/v1/payroll/tax-rule-packs', packBody()), 201);
      const tabs = (await ok<{ tabs: { id: string; status: string; unavailable?: { code: string; message: string }; links: unknown[] }[] }>(await h.call(employee, 'GET', '/v1/me/ess'))).tabs;
      for (const id of ['TN08', 'TN09']) {
        const tab = tabs.find((t) => t.id === id)!;
        expect(tab.status, id).toBe('UNAVAILABLE');
        expect(tab.unavailable?.code, id).toBe('NOT_CONFIGURED');
        expect(tab.unavailable?.message, id).toContain('has not activated a tax rule pack');
        expect(tab.links, id).toEqual([]);
      }
    });

    it('answers NOT_CONFIGURED on reads and refuses writes, with empty categories', async () => {
      const declarations = await ok<{ items: unknown[]; openPeriods: unknown[]; configuration: { status: string; code: string }; calculation: { status: string } }>(await h.call(employee, 'GET', '/v1/me/tax-declarations'));
      expect(declarations).toMatchObject({ items: [], openPeriods: [], configuration: { status: 'NOT_CONFIGURED', code: 'TAX_RULE_PACK_NOT_CONFIGURED' }, calculation: { status: 'NOT_CONFIGURED' } });
      expect((await ok<{ configuration: { status: string } }>(await h.call(employee, 'GET', '/v1/me/tax-proofs'))).configuration.status).toBe('NOT_CONFIGURED');
      const refused = await draft(employee, 'FY-SYNTH');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'NOT_CONFIGURED', details: { code: 'TAX_RULE_PACK_NOT_CONFIGURED' } });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from tax_declaration where company_id = $1`, [A.id])).n).toBe(0);
    });
  });

  describe('rule pack registry', () => {
    it('holds no calculation content: the schema has no rate, slab, limit or formula and the API keeps none', async () => {
      const columns = (
        await h.db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'public' and table_name in ('tax_rule_pack', 'tax_rule_pack_regime', 'tax_rule_pack_category', 'tax_declaration', 'tax_proof')`)
      ).rows.map((r) => r.column_name);
      expect(columns.filter((c) => /rate|slab|percent|formula|limit|ceiling|exempt|deduction|tax_amount/i.test(c))).toEqual([]);
      // The route's schema strips what it does not know, so a rate sent with a category goes nowhere.
      const res = await h.call(configA, 'POST', '/v1/payroll/tax-rule-packs', {
        ...packBody({ fiscalPeriodCode: 'FY-NORATE' }),
        regimes: [{ code: 'SYNTH_REGIME_A', name: 'x', categories: [{ code: 'SYNTH_CAT_1', name: 'x', rate: '0.1' }] }],
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.body).not.toContain('rate');
    });

    it('is activated only by someone other than its author, and an employee or plain HR role manages nothing', async () => {
      const d = await ok<{ id: string; version: number; state: string }>(await h.call(configA, 'POST', '/v1/payroll/tax-rule-packs', packBody({ fiscalPeriodCode: 'FY-SELF' })), 201);
      expect(d.state).toBe('DRAFT');
      expect((await h.call(configA, 'POST', `/v1/payroll/tax-rule-packs/${d.id}/activate`, { expectedVersion: d.version })).json().error).toBe('SELF_APPROVAL');
      expect((await h.call(employee, 'POST', '/v1/payroll/tax-rule-packs', packBody())).statusCode).toBe(403);
      expect((await h.call(plainHr, 'POST', `/v1/payroll/tax-rule-packs/${d.id}/activate`, { expectedVersion: d.version })).statusCode).toBe(403);
      const activated = await ok<{ state: string; activatedBy: string }>(await h.call(configB, 'POST', `/v1/payroll/tax-rule-packs/${d.id}/activate`, { expectedVersion: d.version }));
      expect(activated).toMatchObject({ state: 'ACTIVE', activatedBy: configB.user });
    });

    it('is fixed once created and in the database: no changed dates, no new categories, a single active pack per period', async () => {
      const p = await activePackFor({ fiscalPeriodCode: 'FY-FIXED' });
      await expect(h.db.query(`update tax_rule_pack set cutoff_date = '2100-01-01' where id = $1`, [p.id])).rejects.toThrow(/fixed once created/);
      await expect(h.db.query(`insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name) values ($1, $2, 'SYNTH_REGIME_A', 'SYNTH_LATE', 'x')`, [A.id, p.id])).rejects.toThrow(/fixed with its draft/);
      await expect(h.db.query(`delete from tax_rule_pack where id = $1`, [p.id])).rejects.toThrow();
      const next = await activePackFor({ fiscalPeriodCode: 'FY-FIXED' });
      const rows = (await h.db.query<{ id: string; state: string }>(`select id, state from tax_rule_pack where company_id = $1 and fiscal_period_code = 'FY-FIXED' and state <> 'DRAFT'`, [A.id])).rows;
      expect(rows.find((r) => r.id === p.id)!.state).toBe('RETIRED');
      expect(rows.find((r) => r.id === next.id)!.state).toBe('ACTIVE');
    });

    it('never satisfies a RULE_PACK head: the calculation stays blocked under an active pack of the same code', async () => {
      const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
      await head(h, configA, configB, { code: 'HD_RP_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
      await head(h, configA, configB, { code: 'HD_RP_TAX', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'SYNTH_RP_CODE', base: ['HD_RP_BASIC'], sequence: 2 });
      await activePackFor({ code: 'SYNTH_RP_CODE', fiscalPeriodCode: 'FY-RP' });
      const periods = (await calendar(h, configA, configB, months(2031))).periods;
      const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'TAX_RP', 'TAX_RP', true) returning id`, [A.id])).id;
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      await salary(h, prep, e, { effectiveFrom: '2026-01-05', monthlyGross: '50000', components: [{ code: 'HD_RP_BASIC', amount: '50000' }] });
      const run = await createRun(h, prep, periods['2031-01']!, { departmentIds: [dept] });
      await calculate(h, prep, run.id);
      const exceptions = (await h.db.query<{ code: string }>(`select code from payroll_exception where company_id = $1 and run_id = $2`, [A.id, run.id])).rows.map((r) => r.code);
      expect(exceptions).toContain('RULE_PACK_NOT_CONFIGURED');
    });
  });

  describe('TN08 own declaration', () => {
    beforeAll(async () => {
      await activePackFor();
    });

    it('offers the active pack to the employee: the tabs open, without the pack references', async () => {
      const tabs = (await ok<{ tabs: { id: string; status: string; links: { rel: string; href: string }[] }[] }>(await h.call(employee, 'GET', '/v1/me/ess'))).tabs;
      for (const id of ['TN08', 'TN09']) {
        const tab = tabs.find((t) => t.id === id)!;
        expect(tab.status, id).toBe('AVAILABLE');
        for (const l of tab.links) expect(l.href, `${id} ${l.rel}`).toMatch(/^\/v1\/me\//);
      }
      const list = await ok<{ configuration: { status: string }; openPeriods: { fiscalPeriodCode: string; regimes: { code: string; categories: { code: string }[] }[]; sourceReference?: string }[] }>(await h.call(employee, 'GET', '/v1/me/tax-declarations'));
      expect(list.configuration.status).toBe('ACTIVE');
      const period = list.openPeriods.find((p) => p.fiscalPeriodCode === 'FY-SYNTH')!;
      expect(period.regimes.map((r) => r.code)).toEqual(['SYNTH_REGIME_A', 'SYNTH_REGIME_B']);
      expect(period.regimes[0]!.categories.map((c) => c.code)).toEqual(['SYNTH_CAT_1', 'SYNTH_CAT_2']);
      expect(period.sourceReference).toBeUndefined();
    });

    it('takes regime and categories only from the active pack, in its minor unit', async () => {
      const e = await newEmployee();
      expect((await draft(e.actor, 'FY-SYNTH', [], 'NOT_IN_PACK')).json().error).toBe('UNKNOWN_REGIME');
      expect((await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'NOT_IN_PACK', amount: '1' }])).json().error).toBe('UNKNOWN_CATEGORY');
      // A category of another regime is not offered under this one.
      expect((await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_1', amount: '1' }], 'SYNTH_REGIME_B')).json().error).toBe('UNKNOWN_CATEGORY');
      const twice = await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_1', amount: '1' }, { categoryCode: 'SYNTH_CAT_1', amount: '2' }]);
      expect(twice.json().error).toBe('DUPLICATE_CATEGORY');
      expect((await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_1', amount: '1.234' }])).json().error).toBe('INVALID_AMOUNT');
      expect((await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_1', amount: '0' }])).json().error).toBe('INVALID_AMOUNT');
      // A period with no active pack is not configured, whatever the others have.
      expect((await draft(e.actor, 'FY-UNKNOWN')).json().error).toBe('NOT_CONFIGURED');
      // A regime with no categories takes a declaration with no lines.
      expect((await ok<Declaration>(await draft(e.actor, 'FY-SYNTH', [], 'SYNTH_REGIME_B'), 201))).toMatchObject({ regimeCode: 'SYNTH_REGIME_B', lines: [], state: 'DRAFT' });
    });

    it('seals values at rest and keeps them out of audit, events and notices', async () => {
      const amount = '7654321.25';
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_2', amount }]), 201);
      const raw = await h.one<{ sealed_values: string; line_count: number; row_text: string }>(`select sealed_values, line_count, t::text as row_text from tax_declaration t where id = $1`, [d.id]);
      expect(raw.sealed_values).toMatch(/^v1\./);
      expect(raw.row_text).not.toContain(amount);
      expect(raw.row_text).not.toContain('SYNTH_REGIME_A');
      expect(raw.row_text).not.toContain('SYNTH_CAT_2');
      // A sealed value moved to another row does not open.
      const donor = await ok<Declaration>(await draft(employee, 'FY-SYNTH', [{ categoryCode: 'SYNTH_CAT_1', amount: '5' }]), 201);
      const donorSealed = await h.one<{ s: string }>(`select sealed_values as s from tax_declaration where id = $1`, [donor.id]);
      await h.db.query(`update tax_declaration set sealed_values = $2 where id = $1`, [d.id, donorSealed.s]);
      expect((await h.call(e.actor, 'GET', '/v1/me/tax-declarations')).statusCode).toBe(500);
      await h.db.query(`update tax_declaration set sealed_values = $2 where id = $1`, [d.id, raw.sealed_values]);
      const submitted = await ok<Declaration>(await submit(e.actor, await ownDeclaration(e.actor, d.id)));
      await ok(await decideDeclaration(reviewer, d.id, { decision: 'ACCEPT', reason: 'Synthetic private note' }));
      await dispatchOutbox(h.pool);
      const trail = await trailText(h, A.id);
      for (const text of [trail.operational, trail.outbox, trail.notifications]) expect(text).not.toContain(amount);
      expect(trail.notifications).not.toContain('SYNTH_CAT_2');
      const audit = await h.one<{ t: string }>(`select string_agg(coalesce(before_values::text, '') || coalesce(after_values::text, ''), ' ') as t from audit_event where company_id = $1 and record_key = $2`, [A.id, d.id]);
      expect(audit.t).not.toContain(amount);
      expect(submitted.state).toBe('SUBMITTED');
    });

    it('is own-record only: another employee, another company and an administrator get nothing', async () => {
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-SYNTH'), 201);
      expect((await h.call(other, 'PUT', `/v1/me/tax-declarations/${d.id}`, { expectedVersion: d.version, regimeCode: 'SYNTH_REGIME_A', lines: [] })).statusCode).toBe(404);
      expect((await submit(other, d)).statusCode).toBe(404);
      expect(((await ok<{ items: { id: string }[] }>(await h.call(other, 'GET', '/v1/me/tax-declarations'))).items).map((x) => x.id)).not.toContain(d.id);
      const hrOwn = await h.call(hr, 'GET', '/v1/me/tax-declarations');
      expect(hrOwn.statusCode).toBe(403);
      // An Employee role of another company sees nothing of this one.
      const bHr = await h.actor(B, 'HR_ADMINISTRATOR');
      const bEmp = await person(h, B, bHr, { joiningDate: '2026-01-05' });
      const bEmployee = await h.actor(B, 'EMPLOYEE', { employeeId: bEmp });
      expect((await submit(bEmployee, d)).statusCode).toBe(404);
      expect((await ok<{ items: unknown[]; configuration: { status: string } }>(await h.call(bEmployee, 'GET', '/v1/me/tax-declarations')))).toMatchObject({ items: [], configuration: { status: 'NOT_CONFIGURED' } });
      expect((await draft(bEmployee, 'FY-SYNTH')).json().error).toBe('NOT_CONFIGURED');
    });

    it('holds one declaration per period, immutable once submitted', async () => {
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-SYNTH'), 201);
      expect((await draft(e.actor, 'FY-SYNTH')).json()).toMatchObject({ error: 'DECLARATION_EXISTS', details: { declarationId: d.id } });
      const edited = await ok<Declaration>(await h.call(e.actor, 'PUT', `/v1/me/tax-declarations/${d.id}`, { expectedVersion: d.version, regimeCode: 'SYNTH_REGIME_A', lines: [{ categoryCode: 'SYNTH_CAT_2', amount: '10.00' }] }));
      expect(edited.lines).toEqual([{ categoryCode: 'SYNTH_CAT_2', amount: '10.00' }]);
      expect((await submit(e.actor, d)).json().error).toBe('STALE_VERSION');
      const submitted = await ok<Declaration>(await submit(e.actor, edited));
      expect((await h.call(e.actor, 'PUT', `/v1/me/tax-declarations/${d.id}`, { expectedVersion: submitted.version, regimeCode: 'SYNTH_REGIME_A', lines: [] })).json().error).toBe('INVALID_STATE');
      await expect(h.db.query(`update tax_declaration set line_count = 9 where id = $1`, [d.id])).rejects.toThrow(/immutable/);
      await expect(h.db.query(`insert into tax_declaration (company_id, employee_id, transaction_id, rule_pack_id, fiscal_period_code, sealed_values, line_count, state) select company_id, employee_id, gen_random_uuid(), rule_pack_id, fiscal_period_code, sealed_values, 0, 'ACCEPTED' from tax_declaration where id = $1`, [d.id])).rejects.toThrow(/starts as a draft/);
    });

    it('checks the cutoff when a draft is created, saved and submitted', async () => {
      const past = await activePackFor({ fiscalPeriodCode: 'FY-PAST', cutoffDate: '2020-01-01' });
      expect(past.state).toBe('ACTIVE');
      const refused = await draft(employee, 'FY-PAST');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'TAX_CUTOFF_PASSED', details: { cutoffDate: '2020-01-01' } });
      // A draft written before the cutoff is refused after it: the day moves on, the pack does not change.
      await activePackFor({ fiscalPeriodCode: 'FY-CUT', cutoffDate: '2099-06-30' });
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-CUT'), 201);
      const grant = await grantOf(h, e.actor, 'own_tax', 'submit', ['tax']);
      const later: AccessGrant = { ...grant, businessDate: '2099-07-01' };
      await expect(withTransaction(h.pool, (tx) => submitOwnDeclaration(tx, later, d.id, { expectedVersion: d.version }))).rejects.toMatchObject({ code: 'TAX_CUTOFF_PASSED' });
      const onTheDay: AccessGrant = { ...grant, businessDate: '2099-06-30' };
      expect((await withTransaction(h.pool, (tx) => submitOwnDeclaration(tx, onTheDay, d.id, { expectedVersion: d.version }))).state).toBe('SUBMITTED');
    });

    it('needs a reviewer who is not the employee, and refuses to route when only the employee is listed', async () => {
      const dual = await newEmployee();
      const selfReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER, user: dual.actor.user });
      const d = await ok<Declaration>(await draft(dual.actor, 'FY-SYNTH'), 201);
      await reviewers(h, hr, 'tax_declaration', [selfReviewer]);
      const refused = await submit(dual.actor, d);
      await reviewers(h, hr, 'tax_declaration', [reviewer]);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await ownDeclaration(dual.actor, d.id)).state).toBe('DRAFT');
      // Their own record never appears in their review list either.
      const submitted = await ok<Declaration>(await submit(dual.actor, d));
      expect(submitted.state).toBe('SUBMITTED');
      const list = await ok<{ items: { id: string }[] }>(await h.call(selfReviewer, 'GET', '/v1/tax-declarations'));
      expect(list.items.map((x) => x.id)).not.toContain(d.id);
    });
  });

  describe('review', () => {
    it('is confidential: no grant, no list; a payroll role and a plain HR role are refused', async () => {
      const payrollOperator = await h.actor(A, 'PAYROLL_OPERATOR');
      for (const a of [payrollOperator, plainHr, employee]) {
        expect((await h.call(a, 'GET', '/v1/tax-declarations')).statusCode).toBe(403);
        expect((await h.call(a, 'GET', '/v1/tax-proofs')).statusCode).toBe(403);
        expect((await h.call(a, 'GET', '/v1/tax-declarations/tasks/mine')).statusCode).toBe(403);
      }
      // The ceiling grant is the HR Administrator's; it is not a default duty of any role.
      const defaults = (
        await h.db.query<{ code: string }>(
          `select r.code from role_permission rp join role r on r.company_id = rp.company_id and r.id = rp.role_id join permission p on p.id = rp.permission_id
            where rp.company_id = $1 and p.resource = 'tax_declaration' and p.action = 'review' and rp.effect = 'ALLOW'`,
          [A.id],
        )
      ).rows.map((r) => r.code);
      expect(defaults).toEqual(['HR_ADMINISTRATOR']);
    });

    it('accepts idempotently, and a return or rejection needs an employee-visible explanation apart from the private reason', async () => {
      const { actor, declaration } = await reviewed('FY-SYNTH', 'SUBMITTED');
      expect((await decideDeclaration(reviewer, declaration.id, { decision: 'RETURN' })).json().error).toBe('EXPLANATION_REQUIRED');
      const res = await decideDeclaration(reviewer, declaration.id, { decision: 'RETURN', explanation: 'Please split the synthetic amounts', reason: 'SECRET-REVIEWER-NOTE' });
      expect((await ok<{ state: string }>(res)).state).toBe('RETURNED');
      const seen = await h.call(actor, 'GET', '/v1/me/tax-declarations');
      expect(seen.body).toContain('Please split the synthetic amounts');
      expect(seen.body).not.toContain('SECRET-REVIEWER-NOTE');
      const requests = await h.call(actor, 'GET', '/v1/me/requests?kind=tax_declaration');
      expect(requests.body).not.toContain('SECRET-REVIEWER-NOTE');
      // RETURNED ends the row: the employee continues in a new, linked declaration that holds the live key.
      const next = await ok<Declaration>(await draft(actor, 'FY-SYNTH'), 201);
      expect(next.followsDeclarationId).toBe(declaration.id);
      await expect(h.db.query(`update tax_declaration set state = 'ACCEPTED' where id = $1`, [declaration.id])).rejects.toThrow(/cannot become/);
      const submitted = await ok<Declaration>(await submit(actor, next));
      const taskId = (await declarationTask(reviewer, next.id))!;
      const idempotencyKey = key('tax-replay-');
      const once = await ok<{ state: string; replayed: boolean }>(await h.call(reviewer, 'POST', `/v1/tax-declaration-tasks/${taskId}/decision`, { decision: 'ACCEPT', idempotencyKey }));
      const twice = await ok<{ state: string; replayed: boolean }>(await h.call(reviewer, 'POST', `/v1/tax-declaration-tasks/${taskId}/decision`, { decision: 'ACCEPT', idempotencyKey }));
      expect(once).toMatchObject({ state: 'ACCEPTED', replayed: false });
      expect(twice).toMatchObject({ state: 'ACCEPTED', replayed: true });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_decision d join approval_task t on t.id = d.task_id join approval_instance i on i.id = t.instance_id where i.transaction_id = (select transaction_id from tax_declaration where id = $1)`, [submitted.id])).n).toBe(1);
    });

    it('never shows a reviewer a draft: it is the employee\'s own until submitted (H3)', async () => {
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-SYNTH'), 201);
      expect((await ok<{ items: { id: string }[] }>(await h.call(reviewer, 'GET', `/v1/tax-declarations?employeeId=${e.id}`))).items).toEqual([]);
      const submitted = await ok<Declaration>(await submit(e.actor, d));
      expect((await ok<{ items: { id: string; lines: unknown[] }[] }>(await h.call(reviewer, 'GET', `/v1/tax-declarations?employeeId=${e.id}`))).items).toEqual([expect.objectContaining({ id: submitted.id, lines: d.lines })]);
    });

    it('refuses a reviewer linked to the employee after the task reached them', async () => {
      const r = await reviewed('FY-SYNTH', 'SUBMITTED');
      const doc = await verified(r.actor, r.id);
      const proof = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc])), 201);
      const second = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
      await reviewers(h, hr, 'tax_declaration', [second]);
      const rerouted = await reviewed('FY-SYNTH', 'SUBMITTED');
      const reroutedDoc = await verified(rerouted.actor, rerouted.id);
      const reroutedProof = await ok<Proof>(await h.call(rerouted.actor, 'POST', '/v1/me/tax-proofs', proofBody(rerouted.declaration.id, [reroutedDoc])), 201);
      await reviewers(h, hr, 'tax_declaration', [reviewer]);
      expect(proof.state).toBe('SUBMITTED');
      const declarationTaskId = (await declarationTask(second, rerouted.declaration.id))!;
      const proofTaskId = (await proofTask(second, reroutedProof.id))!;
      // A link in the past is enough (C4: whoever is or was the employee).
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2025-01-01', '2026-01-01')`, [A.id, second.user, rerouted.id]);
      expect((await h.call(second, 'POST', `/v1/tax-declaration-tasks/${declarationTaskId}/decision`, { decision: 'ACCEPT', idempotencyKey: key() })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      expect((await h.call(second, 'POST', `/v1/tax-proof-tasks/${proofTaskId}/decision`, { decision: 'REJECT', explanation: 'x', idempotencyKey: key() })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    });

    it('stays within row scope: a reviewer outside the employee reads none and cannot decide', async () => {
      const elsewhere = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER, departmentFilter: A.financeDept });
      const { declaration } = await reviewed('FY-SYNTH', 'SUBMITTED');
      const list = await ok<{ items: { id: string }[] }>(await h.call(elsewhere, 'GET', '/v1/tax-declarations'));
      expect(list.items.map((x) => x.id)).not.toContain(declaration.id);
      // Someone else's task reads as missing.
      const taskId = (await declarationTask(reviewer, declaration.id))!;
      expect((await h.call(elsewhere, 'POST', `/v1/tax-declaration-tasks/${taskId}/decision`, { decision: 'ACCEPT', idempotencyKey: key() })).statusCode).toBe(404);
      await ok(await h.call(reviewer, 'POST', `/v1/tax-declaration-tasks/${taskId}/decision`, { decision: 'ACCEPT', idempotencyKey: key() }));
    });

    it('refuses to accept under a pack that was replaced, and the draft moves to the new pack when saved', async () => {
      await activePackFor({ fiscalPeriodCode: 'FY-SWAP' });
      const inReview = await newEmployee();
      const pending = await ok<Declaration>(await draft(inReview.actor, 'FY-SWAP'), 201);
      await ok(await submit(inReview.actor, pending));
      const drafting = await newEmployee();
      const d = await ok<Declaration>(await draft(drafting.actor, 'FY-SWAP'), 201);
      const replacement = await activePackFor({ fiscalPeriodCode: 'FY-SWAP' });
      expect((await decideDeclaration(reviewer, pending.id, { decision: 'ACCEPT' })).json().error).toBe('TAX_RULE_PACK_CHANGED');
      expect((await submit(drafting.actor, d)).json().error).toBe('TAX_RULE_PACK_CHANGED');
      const saved = await ok<Declaration>(await h.call(drafting.actor, 'PUT', `/v1/me/tax-declarations/${d.id}`, { expectedVersion: d.version, regimeCode: 'SYNTH_REGIME_A', lines: [] }));
      expect(saved.rulePackId).toBe(replacement.id);
      expect((await ok<Declaration>(await submit(drafting.actor, saved))).state).toBe('SUBMITTED');
      // A return stays possible, so the case is never stuck.
      expect((await ok<{ state: string }>(await decideDeclaration(reviewer, pending.id, { decision: 'RETURN', explanation: 'The rule pack was replaced; declare again' }))).state).toBe('RETURNED');
    });
  });

  describe('TN09 investment proofs', () => {
    it('links a proof to the own submitted declaration and its declared categories', async () => {
      const e = await newEmployee();
      const doc = await ownDocument(e.actor, e.id);
      const d = await ok<Declaration>(await draft(e.actor, 'FY-SYNTH'), 201);
      expect((await h.call(e.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc.id]))).json().error).toBe('DECLARATION_NOT_SUBMITTED');
      await ok(await submit(e.actor, d));
      expect((await h.call(other, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc.id]))).statusCode).toBe(404);
      expect((await h.call(e.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc.id], { categoryCode: 'SYNTH_CAT_2' }))).json().error).toBe('CATEGORY_NOT_DECLARED');
      expect((await h.call(e.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc.id], { claimedAmount: '1.234' }))).json().error).toBe('INVALID_AMOUNT');
      const body = proofBody(d.id, [doc.id]);
      const first = await ok<Proof>(await h.call(e.actor, 'POST', '/v1/me/tax-proofs', body), 201);
      expect(first).toMatchObject({ state: 'SUBMITTED', claimedAmount: '1000.00', acceptedAmount: null, rejectedAmount: null });
      // The same submission again is the same proof.
      const again = await ok<Proof>(await h.call(e.actor, 'POST', '/v1/me/tax-proofs', body));
      expect(again).toMatchObject({ id: first.id, replayed: true });
      const raw = await h.one<{ row_text: string }>(`select t::text as row_text from tax_proof t where id = $1`, [first.id]);
      expect(raw.row_text).not.toContain('1000.00');
    });

    it('needs evidence that is the employee\'s own and not refused by the scan', async () => {
      const e = await newEmployee();
      const d = await reviewed('FY-SYNTH');
      expect((await h.call(d.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.declaration.id, []))).json().error).toBe('EVIDENCE_REQUIRED');
      const someoneElses = await ownDocument(e.actor, e.id);
      expect((await h.call(d.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.declaration.id, [someoneElses.id]))).json().error).toBe('INVALID_EVIDENCE');
      const infected = await ownDocument(d.actor, d.id, pdf(EICAR_TEST_STRING));
      expect(infected.scanState).toBe('QUARANTINED');
      expect((await h.call(d.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.declaration.id, [infected.id]))).json().error).toBe('EVIDENCE_UNUSABLE');
    });

    it('accepts only against an accepted declaration, verified evidence and an amount within the claim', async () => {
      const r = await reviewed('FY-SYNTH', 'SUBMITTED');
      const unverified = await ownDocument(r.actor, r.id);
      const p = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [unverified.id])), 201);
      expect((await decideProof(reviewer, p.id, { decision: 'ACCEPT', acceptedAmount: '10.00' })).json().error).toBe('DECLARATION_NOT_ACCEPTED');
      await ok(await decideDeclaration(reviewer, r.declaration.id, { decision: 'ACCEPT' }));
      expect((await decideProof(reviewer, p.id, { decision: 'ACCEPT', acceptedAmount: '10.00' })).json().error).toBe('EVIDENCE_NOT_VERIFIED');
      await ok(await h.call(verifier, 'POST', `/v1/documents/${unverified.id}/verification`, { decision: 'VERIFIED' }));
      expect((await decideProof(reviewer, p.id, { decision: 'ACCEPT' })).json().error).toBe('ACCEPTED_AMOUNT_REQUIRED');
      expect((await decideProof(reviewer, p.id, { decision: 'ACCEPT', acceptedAmount: '1000.01' })).json().error).toBe('ACCEPTED_ABOVE_CLAIM');
      expect((await decideProof(reviewer, p.id, { decision: 'ACCEPT', acceptedAmount: '0' })).json().error).toBe('INVALID_AMOUNT');
      expect((await decideProof(reviewer, p.id, { decision: 'REJECT', explanation: 'x', acceptedAmount: '1.00' })).json().error).toBe('ACCEPTED_AMOUNT_NOT_ALLOWED');
      await ok(await decideProof(reviewer, p.id, { decision: 'ACCEPT', acceptedAmount: '750.50', reason: 'SECRET-PROOF-NOTE' }));
      const seen = await ownProof(r.actor, p.id);
      expect(seen).toMatchObject({ state: 'ACCEPTED', claimedAmount: '1000.00', acceptedAmount: '750.50', rejectedAmount: '249.50' });
      expect(JSON.stringify(seen)).not.toContain('SECRET-PROOF-NOTE');
      expect((await h.one<{ row_text: string }>(`select t::text as row_text from tax_proof t where id = $1`, [p.id])).row_text).not.toContain('750.50');
      await expect(h.db.query(`update tax_proof set employee_explanation = 'x' where id = $1`, [p.id])).rejects.toThrow(/final/);
    });

    it('a return decides no amount, a rejection rejects the claim, and neither gives any allowance', async () => {
      const r = await reviewed('FY-SYNTH');
      const doc = await verified(r.actor, r.id);
      const returned = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc])), 201);
      expect((await decideProof(reviewer, returned.id, { decision: 'RETURN' })).json().error).toBe('EXPLANATION_REQUIRED');
      await ok(await decideProof(reviewer, returned.id, { decision: 'RETURN', explanation: 'The receipt is unreadable (synthetic)' }));
      expect(await ownProof(r.actor, returned.id)).toMatchObject({ state: 'RETURNED', acceptedAmount: null, rejectedAmount: null, employeeExplanation: 'The receipt is unreadable (synthetic)' });
      const next = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc], { followsProofId: returned.id })), 201);
      // A proof that is still open is no predecessor.
      expect((await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc], { followsProofId: next.id }))).json().error).toBe('INVALID_PREDECESSOR');
      await ok(await decideProof(reviewer, next.id, { decision: 'REJECT', explanation: 'Not an eligible proof (synthetic)' }));
      expect(await ownProof(r.actor, next.id)).toMatchObject({ state: 'REJECTED', acceptedAmount: '0', rejectedAmount: '1000.00' });
    });

    it('checks the cutoff and the active pack when a proof is submitted', async () => {
      await activePackFor({ fiscalPeriodCode: 'FY-PROOFCUT', cutoffDate: '2099-06-30' });
      const e = await newEmployee();
      const d = await ok<Declaration>(await draft(e.actor, 'FY-PROOFCUT'), 201);
      await ok(await submit(e.actor, d));
      const doc = await ownDocument(e.actor, e.id);
      const grant = await grantOf(h, e.actor, 'own_tax', 'submit', ['tax']);
      const later: AccessGrant = { ...grant, businessDate: '2099-07-01' };
      await expect(withTransaction(h.pool, (tx) => submitOwnProof(tx, later, proofBody(d.id, [doc.id])))).rejects.toMatchObject({ code: 'TAX_CUTOFF_PASSED' });
      await activePackFor({ fiscalPeriodCode: 'FY-PROOFCUT' });
      expect((await h.call(e.actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc.id]))).json().error).toBe('TAX_RULE_PACK_CHANGED');
    });

    it('opens a released evidence file for the assigned reviewer only', async () => {
      const r = await reviewed('FY-SYNTH');
      const doc = await verified(r.actor, r.id);
      const p = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc])), 201);
      const file = await h.call(reviewer, 'GET', `/v1/tax-proofs/${p.id}/evidence/${doc}`);
      expect(file.statusCode).toBe(200);
      expect(file.body).toContain('%PDF');
      const another = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
      expect((await h.call(another, 'GET', `/v1/tax-proofs/${p.id}/evidence/${doc}`)).statusCode).toBe(404);
      expect((await h.call(plainHr, 'GET', `/v1/tax-proofs/${p.id}/evidence/${doc}`)).statusCode).toBe(403);
    });
  });

  describe('authority is re-checked inside each transaction (docs/09 §6.5)', () => {
    const withdraw = async (a: TestActor, permission: PermissionKey) => {
      const [resource, action, fieldGroup] = permission.split('.');
      await h.db.query(
        `update role_assignment_permission set active = false
          where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
        [A.id, a.assignment, resource, action, fieldGroup],
      );
    };

    it('refuses configuration and own actions under authority narrowed after the guard, recording nothing', async () => {
      await activePackFor({ fiscalPeriodCode: 'FY-RECHECK' });
      const author = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      const authorGrant = await grantOf(h, author, 'payroll_config', 'manage', ['operational']);
      await withdraw(author, 'payroll_config.manage.operational');
      await expect(withTransaction(h.pool, (tx) => createPack(tx, authorGrant, packBody({ fiscalPeriodCode: 'FY-NEVER' }) as never))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from tax_rule_pack where company_id = $1 and fiscal_period_code = 'FY-NEVER'`, [A.id])).n).toBe(0);

      const pending = await ok<{ id: string; version: number }>(await h.call(configA, 'POST', '/v1/payroll/tax-rule-packs', packBody({ fiscalPeriodCode: 'FY-NEVER2' })), 201);
      const activator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      const activatorGrant = await grantOf(h, activator, 'payroll_config', 'activate', ['operational']);
      await withdraw(activator, 'payroll_config.activate.operational');
      await expect(withTransaction(h.pool, (tx) => activatePack(tx, activatorGrant, pending.id, { expectedVersion: pending.version }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string }>(`select state from tax_rule_pack where id = $1`, [pending.id])).state).toBe('DRAFT');

      const e = await newEmployee();
      const grant = await grantOf(h, e.actor, 'own_tax', 'submit', ['tax']);
      const d = await ok<Declaration>(await draft(e.actor, 'FY-RECHECK'), 201);
      const doc = await ownDocument(e.actor, e.id);
      await withdraw(e.actor, 'own_tax.submit.tax');
      await expect(withTransaction(h.pool, (tx) => createOwnDeclaration(tx, grant, { fiscalPeriodCode: 'FY-RECHECK', regimeCode: 'SYNTH_REGIME_A', lines: [] }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(withTransaction(h.pool, (tx) => submitOwnDeclaration(tx, grant, d.id, { expectedVersion: d.version }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(withTransaction(h.pool, (tx) => submitOwnProof(tx, grant, proofBody(d.id, [doc.id])))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string }>(`select state from tax_declaration where id = $1`, [d.id])).state).toBe('DRAFT');
    });

    it('refuses a decision under a review grant withdrawn after the guard, and the task stays open', async () => {
      const second = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEWER });
      await reviewers(h, hr, 'tax_declaration', [second]);
      const r = await reviewed('FY-SYNTH', 'SUBMITTED');
      const doc = await verified(r.actor, r.id);
      const proof = await ok<Proof>(await h.call(r.actor, 'POST', '/v1/me/tax-proofs', proofBody(r.declaration.id, [doc])), 201);
      await reviewers(h, hr, 'tax_declaration', [reviewer]);
      const taskId = (await declarationTask(second, r.declaration.id))!;
      const proofTaskId = (await proofTask(second, proof.id))!;
      const grant = await grantOf(h, second, 'tax_declaration', 'review', ['tax']);
      await withdraw(second, 'tax_declaration.review.tax');
      await expect(withTransaction(h.pool, (tx) => decideDeclarationNow(tx, grant, taskId, { decision: 'ACCEPT', idempotencyKey: key() }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(withTransaction(h.pool, (tx) => decideProofNow(tx, grant, proofTaskId, { decision: 'REJECT', explanation: 'Synthetic', idempotencyKey: key() }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string }>(`select state from tax_declaration where id = $1`, [r.declaration.id])).state).toBe('SUBMITTED');
      expect((await h.one<{ state: string }>(`select state from tax_proof where id = $1`, [proof.id])).state).toBe('SUBMITTED');
    });
  });

  describe('payroll stays untouched (FR-108 "post-lock acceptance cannot rewrite processed payroll"; H3 "no automatic tax relief")', () => {
    it('leaves a processed run and the next calculation exactly as they were', async () => {
      const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
      const review = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
      const approve = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
      const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
      await reviewers(h, hr, 'payroll_run', [review]);
      await reviewers(h, hr, 'payroll_run_approval', [approve]);
      await head(h, configA, configB, { code: 'HD_TAX_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
      const periods = (await calendar(h, configA, configB, months(2030))).periods;
      const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'TAX_PAY', 'TAX_PAY', true) returning id`, [A.id])).id;
      const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
      const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e });
      await salary(h, prep, e, { effectiveFrom: '2026-01-05', monthlyGross: '60000', components: [{ code: 'HD_TAX_BASIC', amount: '60000' }] });
      const run = await createRun(h, prep, periods['2030-01']!, { departmentIds: [dept] });
      await calculate(h, prep, run.id);
      await submitAndApprove(h, { preparer: prep, reviewer: review, approver: approve }, run.id);
      await processRun(h, processor, run.id);
      const frozen = async () =>
        (
          await h.one<{ t: string }>(
            `select md5(string_agg(x, '|' order by x)) as t from (
               select r::text as x from payroll_run r where r.company_id = $1 and r.id = $2
               union all select rec::text from payroll_record rec where rec.company_id = $1 and rec.run_id = $2
               union all select l::text from payroll_line l join payroll_record rec on rec.company_id = l.company_id and rec.id = l.record_id where rec.company_id = $1 and rec.run_id = $2
               union all select i::text from payroll_input i where i.company_id = $1
             ) q`,
            [A.id, run.id],
          )
        ).t;
      const inputs = async () => (await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where company_id = $1`, [A.id])).n;
      const before = await frozen();
      const inputsBefore = await inputs();
      const netBefore = (await record(h, processor, run.id, e)).net;

      // A declaration and a proof accepted after the lock, in the fiscal period of that payroll.
      await activePackFor({ fiscalPeriodCode: 'FY-LOCKED' });
      const d = await ok<Declaration>(await draft(actor, 'FY-LOCKED'), 201);
      await ok(await submit(actor, d));
      await ok(await decideDeclaration(reviewer, d.id, { decision: 'ACCEPT' }));
      const doc = await verified(actor, e);
      const accepted = await ok<Proof>(await h.call(actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc])), 201);
      await ok(await decideProof(reviewer, accepted.id, { decision: 'ACCEPT', acceptedAmount: '1000.00' }));
      const rejected = await ok<Proof>(await h.call(actor, 'POST', '/v1/me/tax-proofs', proofBody(d.id, [doc])), 201);
      await ok(await decideProof(reviewer, rejected.id, { decision: 'REJECT', explanation: 'Synthetic rejection' }));

      expect(await frozen()).toBe(before);
      expect(await inputs()).toBe(inputsBefore);
      // The next month pays the same: nothing was deducted or relieved, and no line names a tax head.
      const next = await createRun(h, prep, periods['2030-02']!, { departmentIds: [dept] });
      await calculate(h, prep, next.id);
      const after = await record(h, prep, next.id, e);
      expect(after.net).toBe(netBefore);
      const lines = (await h.db.query<{ code: string }>(`select pc.code from payroll_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id where l.company_id = $1 and l.record_id = $2`, [A.id, after.id])).rows.map((r) => r.code);
      expect(lines).toEqual(['HD_TAX_BASIC']);
    });

    it('the calculation code reads none of these tables', async () => {
      const source = ['calculate.ts', 'runs.ts', 'inputs.ts'].map((f) => readFileSync(new URL(`../payroll/${f}`, import.meta.url), 'utf8')).join('\n');
      expect(source).not.toMatch(/tax_declaration|tax_proof|tax_rule_pack/);
    });
  });
});
