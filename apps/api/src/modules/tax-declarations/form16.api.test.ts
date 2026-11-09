// Form 16 Part B working data (FR-107; decided under owner delegation, 6 Nov 2026, docs/03 I-90): built from processed payroll, valued only
// under an INCOME_TAX pack two people validated and activated; Part A stays an outside input. Synthetic salaries: 10,00,000 a month of
// taxable basic and 20,000 of a non-taxable allowance, April and May 2026, so FY 2026-27 so far is 20,00,000 taxable and 40,000 exempt.
// New regime (the default, no accepted declaration): 20,00,000 - 75,000 = 19,25,000 taxable; 20,000 + 40,000 + 60,000 + 3,25,000 x 20%
// = 1,85,000; cess 4% 7,400: 1,92,400.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { APPROVE, calendar, CONFIG, createRun, calculate, grants, head, months, ok, person, PREPARE, PROCESS, processRun, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { INCOME_TAX_SEED } from '../statutory/income-tax.js';

const TAX_READ: PermissionKey[] = ['tax_declaration.read.tax'];

describe('Form 16 Part B data (FR-107, I-90)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let taxReader: TestActor;
  let employee: string;

  const partB = (a: TestActor, fiscalYear = '2026-27') => h.call(a, 'GET', `/v1/payroll/form16/part-b?employeeId=${employee}&fiscalYear=${fiscalYear}`);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    const approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    taxReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: TAX_READ });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'F16_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    // A non-taxable allowance head, as the company declares it.
    await ok(await h.call(configA, 'POST', '/v1/payroll/components', { code: 'F16_ALLOW', name: 'Allowance (synthetic)', componentKind: 'EARNING' }), 201);
    const allow = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'F16_ALLOW', effectiveFrom: '2020-01-01', inUse: true, headType: 'EARNING', calculationBasis: 'FIXED', taxTreatment: 'NON_TAXABLE', displaySequence: 2 }),
      201,
    );
    await ok(await h.call(configB, 'POST', `/v1/payroll/head-revisions/${allow.id}/activate`, { expectedVersion: allow.version }));
    const periods = (await calendar(h, configA, configB, months(2026))).periods;
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, uniq('F16')])).id;
    employee = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, employee, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '1020000',
      components: [
        { code: 'F16_BASIC', amount: '1000000' },
        { code: 'F16_ALLOW', amount: '20000' },
      ],
    });
    for (const month of ['2026-03', '2026-04', '2026-05']) {
      const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
      await processRun(h, processor, run.id);
    }
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('without an active INCOME_TAX pack for the year, shows the year’s salary and values nothing', async () => {
    expect((await partB(hr)).statusCode).toBe(403);
    expect((await partB(taxReader, '2026-28')).json().error).toBe('INVALID_FISCAL_YEAR');
    const res = await ok<Record<string, unknown>>(await partB(taxReader));
    // March 2026 belongs to FY 2025-26: only April and May count.
    expect(res).toMatchObject({
      status: 'NOT_CONFIGURED',
      code: 'INCOME_TAX_PACK_NOT_ACTIVE',
      salary: { processedMonths: 2, grossSalary: '2000000.00', exemptAllowances: '40000.00', tdsDeducted: '0.00' },
      partA: { status: 'NOT_AVAILABLE' },
    });
    expect(res).not.toHaveProperty('tax');
  });

  it('under a pack two people validated and activated: the new regime by default, 19,25,000 taxable, 1,92,400 tax, all still due', async () => {
    const [validator, activator] = [configA, configB];
    // Every company is provisioned the FY 2026-27 draft (statutory/rule-packs.ts ensureStatutoryPacks); two people make it active.
    const seeded = await h.one<{ id: string; parameters: unknown }>(`select id, parameters from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1 and state = 'DRAFT'`, [A.id]);
    expect(seeded.parameters).toEqual(INCOME_TAX_SEED.parameters);
    const pack = seeded.id;
    await h.db.query(`update statutory_rule_pack set state = 'VALIDATED', validated_by = $2, validated_at = now(), source_reference = 'Synthetic source', validation_reference = 'Synthetic check' where id = $1`, [
      pack,
      validator.user,
    ]);
    // Two people: whoever validated it never activates it.
    await expect(h.db.query(`update statutory_rule_pack set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [pack, validator.user])).rejects.toThrow(/statutory_rule_pack_check/);
    await h.db.query(`update statutory_rule_pack set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [pack, activator.user]);
    const res = await ok<{ status: string; regime: string; regimeSource: string; standardDeduction: string; taxableIncome: string; tax: Record<string, string>; balance: string; pack: { statuteReference: string } }>(
      await partB(taxReader),
    );
    expect(res).toMatchObject({ status: 'CALCULATED', regime: 'NEW', regimeSource: 'DEFAULT', standardDeduction: '75000.00', taxableIncome: '1925000.00', balance: '192400.00' });
    expect(res.tax).toMatchObject({ slabTax: '185000.00', rebate: '0.00', cess: '7400.00', total: '192400.00' });
    expect(res.pack.statuteReference).toContain('To be validated against the law in force');
  });
});
