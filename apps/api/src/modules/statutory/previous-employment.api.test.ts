// I-90 follow-up, an earlier employment in the year (Form 12B; decided under owner delegation, 6 Nov 2026; migration 0239): the salary and
// the tax an earlier employer paid and deducted this year are declared (PREV_EMPLOYER_SALARY, PREV_EMPLOYER_TDS) and taken into the year's
// TDS: the salary into the year's salary, the tax into what was already deducted; neither is a deduction. Worked synthetic examples, a
// joiner from 1 October on 2,50,000 a month (new regime) who declares 9,00,000 of salary and 50,000 of tax from an earlier employer:
//   October: the year is 15,00,000 here + 9,00,000 earlier = 24,00,000; taxable 23,25,000; tax 2,81,250 + cess 11,250 = 2,92,500; less
//            50,000 already deducted, over the 6 months left: 2,42,500 / 6 = 40,416.67 -> 40,417 (16,250 without the earlier employment).
//   A final settlement for a last day of 30 November (October processed): 2,50,000 + 2,50,000 + 9,00,000 = 14,00,000; taxable
//            13,25,000; 20,000 + 40,000 + 18,750 = 78,750 + cess 3,150 = 81,900, already covered by 40,417 + 50,000: NO_TAX_DUE.
//   Form 16 Part B (October processed, both amounts proved): 2,50,000 + 9,00,000 = 11,50,000; taxable 10,75,000 within the rebate: nil;
//            deducted 40,417 + 50,000.
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
  getRun,
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

describe.runIf(isModuleActive('payroll') && isModuleActive('tax-declarations') && isModuleActive('lifecycle'))('an earlier employment in the year (Form 12B, I-90)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let taxReviewer: TestActor;
  let verifier: TestActor;
  let periods: Record<string, string>;
  let joiner: { id: string; dept: string; actor: TestActor; declarationId: string; october: string };

  const accept = async (kind: 'declaration' | 'proof', id: string, body: Record<string, unknown> = {}) => {
    const list = kind === 'declaration' ? '/v1/tax-declarations/tasks/mine' : '/v1/tax-proofs/tasks/mine';
    const items = (await h.call(taxReviewer, 'GET', list)).json().items as { taskId: string; declaration?: { id: string }; proof?: { id: string } }[];
    const task = items.find((t) => (kind === 'declaration' ? t.declaration?.id : t.proof?.id) === id)!;
    const path = kind === 'declaration' ? `/v1/tax-declaration-tasks/${task.taskId}/decision` : `/v1/tax-proof-tasks/${task.taskId}/decision`;
    await ok(await h.call(taxReviewer, 'POST', path, { decision: 'ACCEPT', idempotencyKey: `tax-${randomUUID()}`, ...body }));
  };
  const prove = async (s: { id: string; actor: TestActor; declarationId: string }, categoryCode: string, amount: string) => {
    const doc = await ok<{ id: string }>(
      await h.call(s.actor, 'POST', `/v1/employees/${s.id}/documents`, {
        documentType: 'GENERAL',
        fileName: 'form12b.pdf',
        contentBase64: Buffer.from(`%PDF-1.4\n% synthetic Form 12B ${randomUUID()}\n%%EOF\n`, 'latin1').toString('base64'),
      }),
      201,
    );
    await ok(await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
    const proof = await ok<{ id: string }>(
      await h.call(s.actor, 'POST', '/v1/me/tax-proofs', { declarationId: s.declarationId, categoryCode, claimedAmount: amount, evidenceDocumentIds: [doc.id], idempotencyKey: `proof-${randomUUID()}` }),
      201,
    );
    await accept('proof', proof.id, { acceptedAmount: amount });
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    taxReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax', 'tax_declaration.review.tax'] });
    verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: VERIFY_DOCUMENTS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'tax_declaration', [taxReviewer]);
    await head(h, configA, configB, { code: 'PE_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'PE_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['PE_BASIC'], sequence: 20 });
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

  it('both regimes take the earlier salary and tax (0239), and October’s TDS counts them: 40,417 a month instead of 16,250', async () => {
    const categories = (await h.db.query<{ regime_code: string; code: string }>(
      `select c.regime_code, c.code from tax_rule_pack_category c join tax_rule_pack p on p.id = c.pack_id where p.company_id = $1 and c.code like 'PREV_EMPLOYER_%' order by 1, 2`,
      [A.id],
    )).rows;
    expect(categories.map((c) => `${c.regime_code}:${c.code}`)).toEqual(['NEW:PREV_EMPLOYER_SALARY', 'NEW:PREV_EMPLOYER_TDS', 'OLD:PREV_EMPLOYER_SALARY', 'OLD:PREV_EMPLOYER_TDS']);
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-10-01' });
    await salary(h, preparer, id, { effectiveFrom: '2026-10-01', monthlyGross: '250000', components: [{ code: 'PE_BASIC', amount: '250000' }] });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    const d = await ok<{ id: string; version: number }>(
      await h.call(actor, 'POST', '/v1/me/tax-declarations', {
        fiscalPeriodCode: '2026-27',
        regimeCode: 'NEW',
        lines: [
          { categoryCode: 'PREV_EMPLOYER_SALARY', amount: '900000.00' },
          { categoryCode: 'PREV_EMPLOYER_TDS', amount: '50000.00' },
        ],
      }),
      201,
    );
    await ok(await h.call(actor, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version }));
    await accept('declaration', d.id);
    const run = await createRun(h, preparer, periods['2026-10']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, id);
    expect(r.lines.find((l) => l.componentCode === 'PE_TDS')?.amount).toBe('40417.0000');
    expect(r.statutory.find((s) => s.componentCode === 'PE_TDS')?.workings).toMatchObject({
      projectedAnnualSalary: '1500000.00',
      previousEmployerSalary: '900000.00',
      previousEmployerTds: '50000.00',
      deductionsAllowed: '0.00',
      taxableIncome: '2325000.00',
      annualTax: '292500.00',
      tdsEarlier: '0.00',
      monthsLeft: 6,
    });
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    joiner = { id, dept, actor, declarationId: d.id, october: run.id };
  });

  it('Form 16 Part B counts what was proved of the earlier employment: 11,50,000 of salary, nil tax, 90,417 deducted', async () => {
    await prove(joiner, 'PREV_EMPLOYER_SALARY', '900000.00');
    await prove(joiner, 'PREV_EMPLOYER_TDS', '50000.00');
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax'] });
    expect(await ok(await h.call(reader, 'GET', `/v1/payroll/form16/part-b?employeeId=${joiner.id}&fiscalYear=2026-27`))).toMatchObject({
      status: 'CALCULATED',
      salary: { grossSalary: '250000.00', tdsDeducted: '40417.00' },
      previousEmployment: { salary: '900000.00', tds: '50000.00' },
      deductions: [],
      taxableIncome: '1075000.00',
      tax: { total: '0.00' },
      balance: '-90417.00',
    });
  });

  it('an earlier salary proved at another amount after the calculation refuses processing (STATUTORY_CHANGED, taxDeclarations)', async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-11-01' });
    await salary(h, preparer, id, { effectiveFrom: '2026-11-01', monthlyGross: '250000', components: [{ code: 'PE_BASIC', amount: '250000' }] });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    const d = await ok<{ id: string; version: number }>(
      await h.call(actor, 'POST', '/v1/me/tax-declarations', { fiscalPeriodCode: '2026-27', regimeCode: 'NEW', lines: [{ categoryCode: 'PREV_EMPLOYER_SALARY', amount: '900000.00' }] }),
      201,
    );
    await ok(await h.call(actor, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version }));
    await accept('declaration', d.id);
    const run = await createRun(h, preparer, periods['2026-11']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await prove({ id, actor, declarationId: d.id }, 'PREV_EMPLOYER_SALARY', '800000.00');
    const res = await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: (await getRun(h, processor, run.id)).version });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'STATUTORY_CHANGED', details: { records: { taxDeclarations: 1 } } });
  });

  it('a final settlement takes the earlier employment too: 14,00,000 for the year, 81,900 of tax, already covered: NO_TAX_DUE', async () => {
    await approvedExit(h, A, joiner.id, '2026-11-02', '2026-11-30');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [joiner.id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const s = await ok<{ calculation: { items: { status: string; componentCode: string | null; basis: Record<string, unknown> }[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(s.calculation.items.find((i) => i.componentCode === 'PE_TDS')).toMatchObject({
      status: 'NOT_APPLICABLE',
      basis: { reason: 'NO_TAX_DUE', annualSalary: '500000.00', previousEmployerSalary: '900000.00', previousEmployerTds: '50000.00', taxableIncome: '1325000.00', annualTax: '81900.00', tdsEarlier: '40417.00' },
    });
  });
});
