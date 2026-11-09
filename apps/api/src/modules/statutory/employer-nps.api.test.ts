// I-90 follow-up, the employer's NPS contribution (s.80CCD(2) of the 1961 Act, to be validated against the Income-tax Act, 2025; decided
// under owner delegation, 6 Nov 2026; migration 0243): the deduction is capped at a share of salary, Basic and DA (heads treated
// SALARY_FOR_HRA): the regime's `employerNpsLimitPercent`, 14 in the new regime and 10 in the old in the FY 2026-27 draft. Worked synthetic
// example, new regime, Basic 1,00,000 and HRA 50,000 a month from April, 3,00,000 declared:
//   the cap is 14% of 12,00,000 = 1,68,000; taxable 18,00,000 - 75,000 - 1,68,000 = 15,57,000; 20,000 + 40,000 + 53,550 = 1,13,550,
//   cess 4,542: 1,18,092 -> 1,18,090 (nearest ten); 9,840.83 -> 9,841 a month. Uncapped (before), 3,00,000 would have left 14,25,000:
//   5,525 a month.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { HR_SETTLEMENT } from '../lifecycle/lifecycle.fixtures.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  approvedExit,
  calculate,
  calendar,
  CONFIG,
  createRun,
  grants,
  head,
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
  VERIFY_DOCUMENTS,
} from '../payroll/payroll.fixtures.js';

describe.runIf(isModuleActive('payroll') && isModuleActive('tax-declarations'))('employer NPS contribution capped at a share of salary (s.80CCD(2), I-90)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let taxReviewer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;
  let employee: { id: string; dept: string; actor: TestActor; declarationId: string; april: string };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    taxReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax', 'tax_declaration.review.tax'] });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'tax_declaration', [taxReviewer]);
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'NP_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1, taxTreatment: 'SALARY_FOR_HRA' });
    await head(h, configA, configB, { code: 'NP_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2, taxTreatment: 'HRA_RULE_2A' });
    await head(h, configA, configB, { code: 'NP_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['NP_BASIC', 'NP_HRA'], sequence: 20 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    const packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.validate.operational'] });
    const packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    const pack = await h.one<{ id: string; version: number }>(`select id, version from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id]);
    const v = await ok<{ version: number }>(await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, { sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: pack.version }));
    await ok(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: v.version }));
    const taxPack = await h.one<{ id: string; version: number }>(`select id, version from tax_rule_pack where company_id = $1 and code = 'INCOME_TAX_2026_27'`, [A.id]);
    await ok(await h.call(configB, 'POST', `/v1/payroll/tax-rule-packs/${taxPack.id}/activate`, { expectedVersion: taxPack.version }));
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('3,00,000 declared, 1,68,000 allowed (14% of 12,00,000 of Basic): 9,841 a month', async () => {
    const params = (await h.one<{ parameters: Record<string, any> }>(`select parameters from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id])).parameters;
    expect([params.regimes.NEW.employerNpsLimitPercent, params.regimes.OLD.employerNpsLimitPercent]).toEqual(['14', '10']);
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, id, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '150000',
      components: [
        { code: 'NP_BASIC', amount: '100000' },
        { code: 'NP_HRA', amount: '50000' },
      ],
    });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    const d = await ok<{ id: string; version: number }>(
      await h.call(actor, 'POST', '/v1/me/tax-declarations', { fiscalPeriodCode: '2026-27', regimeCode: 'NEW', lines: [{ categoryCode: 'SEC_80CCD_2', amount: '300000.00' }] }),
      201,
    );
    await ok(await h.call(actor, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version }));
    const task = ((await h.call(taxReviewer, 'GET', '/v1/tax-declarations/tasks/mine')).json().items as { taskId: string; declaration: { id: string } }[]).find((t) => t.declaration.id === d.id)!;
    await ok(await h.call(taxReviewer, 'POST', `/v1/tax-declaration-tasks/${task.taskId}/decision`, { decision: 'ACCEPT', idempotencyKey: `tax-${randomUUID()}` }));
    const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, id);
    expect(r.lines.find((l) => l.componentCode === 'NP_TDS')?.amount).toBe('9841.0000');
    expect(r.statutory.find((s) => s.componentCode === 'NP_TDS')?.workings).toMatchObject({
      regime: 'NEW',
      projectedAnnualSalary: '1800000.00',
      salaryForHraYear: '1200000.00',
      employerNpsLimit: '168000.00',
      deductionsAllowed: '168000.00',
      taxableIncome: '1557000.00',
      annualTax: '118090.00',
    });
    employee = { id, dept, actor, declarationId: d.id, april: run.id };
  });

  it('Form 16 Part B on April alone, 3,00,000 proved: the cap is 14% of the year’s 1,00,000 of Basic so far, 14,000', async () => {
    await submitAndApprove(h, { preparer, reviewer, approver }, employee.april);
    await processRun(h, processor, employee.april);
    const doc = await ok<{ id: string }>(
      await h.call(employee.actor, 'POST', `/v1/employees/${employee.id}/documents`, {
        documentType: 'GENERAL',
        fileName: 'nps.pdf',
        contentBase64: Buffer.from(`%PDF-1.4\n% synthetic NPS statement ${randomUUID()}\n%%EOF\n`, 'latin1').toString('base64'),
      }),
      201,
    );
    await ok(await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
    const proof = await ok<{ id: string }>(
      await h.call(employee.actor, 'POST', '/v1/me/tax-proofs', {
        declarationId: employee.declarationId,
        categoryCode: 'SEC_80CCD_2',
        claimedAmount: '300000.00',
        evidenceDocumentIds: [doc.id],
        idempotencyKey: `proof-${randomUUID()}`,
      }),
      201,
    );
    const task = ((await h.call(taxReviewer, 'GET', '/v1/tax-proofs/tasks/mine')).json().items as { taskId: string; proof: { id: string } }[]).find((t) => t.proof.id === proof.id)!;
    await ok(await h.call(taxReviewer, 'POST', `/v1/tax-proof-tasks/${task.taskId}/decision`, { decision: 'ACCEPT', acceptedAmount: '300000.00', idempotencyKey: `tax-${randomUUID()}` }));
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax'] });
    // 1,50,000 - 75,000 - 14,000 = 61,000.
    expect(await ok(await h.call(reader, 'GET', `/v1/payroll/form16/part-b?employeeId=${employee.id}&fiscalYear=2026-27`))).toMatchObject({
      status: 'CALCULATED',
      deductions: [{ categoryCode: 'SEC_80CCD_2', amount: '300000.00', limit: '14000.00', allowed: '14000.00' }],
      deductionsAllowed: '14000.00',
      taxableIncome: '61000.00',
    });
  });

  it('a final settlement caps it on the year as it ends: April and May give 2,00,000 of Basic, so 28,000', async () => {
    // Last day 31 May: 1,50,000 in April and 1,50,000 paid by the settlement; 3,00,000 - 75,000 - 28,000 = 1,97,000: no tax.
    await approvedExit(h, A, employee.id, '2026-05-01', '2026-05-31');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [employee.id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const s = await ok<{ calculation: { items: { status: string; componentCode: string | null; basis: Record<string, unknown> }[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(s.calculation.items.find((i) => i.componentCode === 'NP_TDS')).toMatchObject({
      status: 'NOT_APPLICABLE',
      basis: { reason: 'NO_TAX_DUE', annualSalary: '300000.00', salaryForHraYear: '200000.00', employerNpsLimit: '28000.00', deductionsAllowed: '28000.00', taxableIncome: '197000.00' },
    });
  });

  it('0243: the database checks the limit as the build reads it', async () => {
    const params = (await h.one<{ parameters: Record<string, any> }>(`select parameters from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id])).parameters;
    await expect(
      h.db.query(
        `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by)
         select $1, 'INCOME_TAX', max(revision) + 1, '2030-04-01', 'INR', $2::jsonb, 'Synthetic revision written directly by the test', 'DRAFT', $3
           from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX'`,
        [A.id, JSON.stringify({ ...params, regimes: { ...params.regimes, NEW: { ...params.regimes.NEW, employerNpsLimitPercent: '114' } } }), configA.user],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'statutory_rule_pack_income_tax_parameters_check' });
  });
});
