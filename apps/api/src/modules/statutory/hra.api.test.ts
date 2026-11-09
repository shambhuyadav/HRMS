// I-90 follow-up, the house rent allowance exemption (decided under owner delegation, 6 Nov 2026; migration 0238): rent is not a deduction.
// In the old regime the exemption under s.10(13A) and rule 2A (to be validated against the Income-tax Act, 2025) is the least of the
// allowance received (heads treated HRA_RULE_2A), rent less 10% of salary (Basic and DA, heads treated SALARY_FOR_HRA), and 50% of salary
// for a house in one of the four cities (HRA_METRO) or 40% elsewhere (HRA). Worked synthetic examples, Basic 1,00,000 and HRA 50,000 a
// month from April, so the projected year is 18,00,000 with 6,00,000 of allowance and 12,00,000 of salary:
//   A  metro, rent 6,00,000:  least of 6,00,000 / 4,80,000 / 6,00,000 = 4,80,000; taxable 18,00,000 - 4,80,000 - 50,000 = 12,70,000;
//      old regime 12,500 + 1,00,000 + 81,000 = 1,93,500, cess 7,740: 2,01,240; 16,770 a month.
//   B  metro, rent 9,00,000:  least of 6,00,000 / 7,80,000 / 6,00,000 = 6,00,000; taxable 11,50,000; 1,57,500 + 6,300 = 1,63,800;
//      13,650 a month.
//   C  elsewhere, rent 9,00,000: least of 6,00,000 / 7,80,000 / 4,80,000 = 4,80,000; as A, 16,770.
// Before this, the rent itself was deducted: A would have been taxed on 11,50,000 (13,650 a month).
// Form 16 Part B on April alone, rent proved 6,00,000 (metro): least of 50,000 / 5,90,000 / 50,000 = 50,000.
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

describe.runIf(isModuleActive('payroll') && isModuleActive('tax-declarations'))('house rent allowance exemption (s.10(13A), I-90)', () => {
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
  let metro6: { id: string; dept: string; actor: TestActor; declarationId: string };

  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
  /** Basic 1,00,000 and HRA 50,000 a month, with an accepted old-regime declaration of the rent given. */
  const tenant = async (category: 'HRA' | 'HRA_METRO', rent: string) => {
    const dept = await department();
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, id, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '150000',
      components: [
        { code: 'HR_BASIC', amount: '100000' },
        { code: 'HR_HRA', amount: '50000' },
      ],
    });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    const d = await ok<{ id: string; version: number }>(await h.call(actor, 'POST', '/v1/me/tax-declarations', { fiscalPeriodCode: '2026-27', regimeCode: 'OLD', lines: [{ categoryCode: category, amount: rent }] }), 201);
    await ok(await h.call(actor, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version }));
    const task = ((await h.call(taxReviewer, 'GET', '/v1/tax-declarations/tasks/mine')).json().items as { taskId: string; declaration: { id: string } }[]).find((t) => t.declaration.id === d.id)!;
    await ok(await h.call(taxReviewer, 'POST', `/v1/tax-declaration-tasks/${task.taskId}/decision`, { decision: 'ACCEPT', idempotencyKey: `tax-${randomUUID()}` }));
    return { id, dept, actor, declarationId: d.id };
  };
  /** Rent receipts uploaded by the employee and verified, proved under HRA_METRO and accepted at `amount`. */
  const proved = async (s: { id: string; actor: TestActor; declarationId: string }, amount: string) => {
    const doc = await ok<{ id: string }>(
      await h.call(s.actor, 'POST', `/v1/employees/${s.id}/documents`, {
        documentType: 'GENERAL',
        fileName: 'rent.pdf',
        contentBase64: Buffer.from(`%PDF-1.4\n% synthetic rent receipts ${randomUUID()}\n%%EOF\n`, 'latin1').toString('base64'),
      }),
      201,
    );
    await ok(await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'VERIFIED' }));
    const proof = await ok<{ id: string }>(
      await h.call(s.actor, 'POST', '/v1/me/tax-proofs', { declarationId: s.declarationId, categoryCode: 'HRA_METRO', claimedAmount: amount, evidenceDocumentIds: [doc.id], idempotencyKey: `proof-${randomUUID()}` }),
      201,
    );
    const task = ((await h.call(taxReviewer, 'GET', '/v1/tax-proofs/tasks/mine')).json().items as { taskId: string; proof: { id: string } }[]).find((t) => t.proof.id === proof.id)!;
    await ok(await h.call(taxReviewer, 'POST', `/v1/tax-proof-tasks/${task.taskId}/decision`, { decision: 'ACCEPT', acceptedAmount: amount, idempotencyKey: `tax-${randomUUID()}` }));
  };
  const april = async (s: { id: string; dept: string }) => {
    const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, s.id);
    return { runId: run.id, tds: r.lines.find((l) => l.componentCode === 'HR_TDS')?.amount, workings: r.statutory.find((x) => x.componentCode === 'HR_TDS')?.workings };
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
    await head(h, configA, configB, { code: 'HR_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1, taxTreatment: 'SALARY_FOR_HRA' });
    await head(h, configA, configB, { code: 'HR_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2, taxTreatment: 'HRA_RULE_2A' });
    await head(h, configA, configB, { code: 'HR_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['HR_BASIC', 'HR_HRA'], sequence: 20 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    // The INCOME_TAX draft validated by one person and activated by another (the fixture's stand-in only), and the declaration pack.
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

  it('A: rent 6,00,000 for a house in a metro city: 4,80,000 exempt (rent less 10% of salary), 16,770 a month, never the rent itself', async () => {
    metro6 = await tenant('HRA_METRO', '600000.00');
    const a = await april(metro6);
    expect(a.tds).toBe('16770.0000');
    expect(a.workings).toMatchObject({
      regime: 'OLD',
      projectedAnnualSalary: '1800000.00',
      hraReceivedYear: '600000.00',
      salaryForHraYear: '1200000.00',
      hraRentPaid: '600000.00',
      hraMetro: true,
      hraRentLessSalaryShare: '480000.00',
      hraSalaryShare: '600000.00',
      hraExemption: '480000.00',
      deductionsAllowed: '0.00',
      taxableIncome: '1270000.00',
      annualTax: '201240.00',
    });
  });

  it('B and C: in a metro city 50% of salary allows 6,00,000 of 9,00,000 rent (13,650); elsewhere 40% allows 4,80,000 (16,770)', async () => {
    const b = await april(await tenant('HRA_METRO', '900000.00'));
    expect([b.tds, b.workings?.hraExemption, b.workings?.taxableIncome]).toEqual(['13650.0000', '600000.00', '1150000.00']);
    const c = await april(await tenant('HRA', '900000.00'));
    expect([c.tds, c.workings?.hraExemption, c.workings?.hraMetro, c.workings?.hraSalaryShare]).toEqual(['16770.0000', '480000.00', false, '480000.00']);
  });

  it('Form 16 Part B on April alone, rent proved: the exemption from the year so far, 50,000 (the allowance received)', async () => {
    // A's April is processed, and the rent proved and accepted (6,00,000, metro).
    const run = (await h.one<{ id: string }>(`select r.run_id as id from payroll_record r join payroll_run ru on ru.id = r.run_id where r.employee_id = $1 and ru.service_start = '2026-04-01'`, [metro6.id])).id;
    await submitAndApprove(h, { preparer, reviewer, approver }, run);
    await processRun(h, processor, run);
    await proved(metro6, '600000.00');
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax'] });
    const partB = await ok<Record<string, unknown>>(await h.call(reader, 'GET', `/v1/payroll/form16/part-b?employeeId=${metro6.id}&fiscalYear=2026-27`));
    // Gross 1,50,000 less 50,000 exempt and the 50,000 standard deduction: 50,000 taxable, below the first taxed slab. Rent is no deduction.
    expect(partB).toMatchObject({
      status: 'CALCULATED',
      regime: 'OLD',
      salary: { grossSalary: '150000.00' },
      hraExemption: { exemption: '50000.00', hraReceived: '50000.00', salaryForHra: '100000.00', rentPaid: '600000.00', metro: true },
      deductions: [],
      taxableIncome: '50000.00',
    });
  });

  it('rent proved after the calculation changes the exemption the run used: processing refuses (STATUTORY_CHANGED, taxDeclarations)', async () => {
    // B declared 9,00,000 (metro: 6,00,000 exempt); its April run is approved; then 6,00,000 is proved and accepted: 4,80,000 exempt.
    const b = await tenant('HRA_METRO', '900000.00');
    const { runId } = await april(b);
    await submitAndApprove(h, { preparer, reviewer, approver }, runId);
    await proved(b, '600000.00');
    const res = await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: (await getRun(h, processor, runId)).version });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'STATUTORY_CHANGED', details: { records: { taxDeclarations: 1 } } });
  });

  it('0238: the database checks the regime’s HRA exemption as the build reads it', async () => {
    const params = (await h.one<{ parameters: Record<string, any> }>(`select parameters from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id])).parameters;
    expect(params.regimes.OLD.hraExemption).toEqual({ metroPercent: '50', otherPercent: '40', rentAboveSalaryPercent: '10' });
    const write = (hraExemption: unknown) =>
      h.db.query(
        `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by)
         select $1, 'INCOME_TAX', max(revision) + 1, '2030-04-01', 'INR', $2::jsonb, 'Synthetic revision written directly by the test', 'DRAFT', $3
           from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX'`,
        [A.id, JSON.stringify({ ...params, regimes: { ...params.regimes, OLD: { ...params.regimes.OLD, hraExemption } } }), configA.user],
      );
    for (const bad of [{ metroPercent: '50', otherPercent: '140', rentAboveSalaryPercent: '10' }, { metroPercent: '50', otherPercent: '40' }, { metroPercent: '50', otherPercent: '40', rentAboveSalaryPercent: '10', extra: '1' }]) {
      await expect(write(bad)).rejects.toMatchObject({ code: '23514', constraint: 'statutory_rule_pack_income_tax_parameters_check' });
    }
  });

  it('a final settlement values the exemption on the year as it ends: April and May give 1,00,000 of allowance, all of it exempt', async () => {
    // A leaves on Sunday 31 May; the settlement pays May (1,00,000 + 50,000). The year: allowance 1,00,000, salary 2,00,000, rent proved
    // 6,00,000 (metro): least of 1,00,000 / 5,80,000 / 1,00,000 = 1,00,000; 3,00,000 - 1,00,000 - 50,000 = 1,50,000: no tax, and April's
    // 16,770 is not refunded by the settlement (NO_TAX_DUE).
    await approvedExit(h, A, metro6.id, '2026-05-01', '2026-05-31');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [metro6.id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const d = await ok<{ calculation: { items: { status: string; componentCode: string | null; basis: Record<string, unknown> }[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(d.calculation.items.find((i) => i.componentCode === 'HR_TDS')).toMatchObject({
      status: 'NOT_APPLICABLE',
      basis: { reason: 'NO_TAX_DUE', regime: 'OLD', annualSalary: '300000.00', hraReceivedYear: '100000.00', salaryForHraYear: '200000.00', hraExemption: '100000.00', taxableIncome: '150000.00', tdsEarlier: '16770.00' },
    });
  });
});
