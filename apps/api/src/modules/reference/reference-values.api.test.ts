// Module controlled lists as form choices (DF04; GET /v1/reference-values): an active module's list is served under
// the permission of the form that offers it, with the caller's company's active values only; core lists and lists no
// module names are not served. The inactive-module case is reference-values-inactive.api.test.ts. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { MODULE_REGISTRATIONS } from '../registry.js';
import type { ModuleRegistration } from '../registry-types.js';
import { servedReferenceLists } from './routes.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

const list = (a: TestActor, category: string) => h.call(a, 'GET', `/v1/reference-values?category=${category}`);
const codes = async (a: TestActor, category: string) => {
  const res = await list(a, category);
  expect(res.statusCode).toBe(200);
  expect(res.json().category).toBe(category);
  return (res.json().items as { code: string; label: string }[]).map((x) => x.code).sort();
};

describe('module reference lists as form choices (DF04)', () => {
  it("serves an active module's lists, each under the permission of the form that takes the code", async () => {
    const co = await h.makeCompany();
    const config = await h.actor(co, 'HR_ADMINISTRATOR', { extra: ['payroll_config.manage.operational'] });
    const inputs = await h.actor(co, 'HR_ADMINISTRATOR', { extra: ['payroll_input.prepare.amount'] });
    const plain = await h.actor(co, 'HR_ADMINISTRATOR');

    const tax = await list(config, 'PAYROLL_TAX_TREATMENT');
    expect(tax.statusCode).toBe(200);
    // Three since the start, and the two house rent allowance treatments since 0238.
    expect(tax.json().items).toHaveLength(5);
    expect(tax.json().items).toEqual(
      expect.arrayContaining([
        { code: 'TAXABLE', label: 'Taxable (as declared by the company)' },
        { code: 'NON_TAXABLE', label: 'Not taxable (as declared by the company)' },
        { code: 'PER_TAX_RULE_PACK', label: 'Treatment set by the tax rule pack' },
        { code: 'HRA_RULE_2A', label: 'House rent allowance: taxable, less the exemption the income tax pack computes (s.10(13A))' },
        { code: 'SALARY_FOR_HRA', label: 'Taxable, and salary for the house rent allowance exemption (Basic and DA)' },
      ]),
    );
    expect(await codes(inputs, 'PAYROLL_INPUT_KIND')).toEqual(['OTHER_INPUT', 'VARIABLE_PAYMENT']);

    // Each list needs its own form's permission.
    expect((await list(config, 'PAYROLL_INPUT_KIND')).statusCode).toBe(403);
    expect((await list(inputs, 'PAYROLL_TAX_TREATMENT')).statusCode).toBe(403);
    expect((await list(plain, 'PAYROLL_TAX_TREATMENT')).statusCode).toBe(403);
    expect((await list(await h.actor(co, 'EMPLOYEE'), 'PAYROLL_INPUT_KIND')).statusCode).toBe(403);
  });

  it("answers with the caller's company's active values only", async () => {
    const co = await h.makeCompany();
    const other = await h.makeCompany();
    const inputs = await h.actor(co, 'HR_ADMINISTRATOR', { extra: ['payroll_input.prepare.amount'] });
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'PAYROLL_INPUT_KIND', 'OTHER_COMPANY_KIND', 'Other company (synthetic)', true)`, [
      other.id,
    ]);
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'PAYROLL_INPUT_KIND', 'OWN_KIND', 'Own kind (synthetic)', true)`, [co.id]);
    await h.db.query(`update reference_value set active = false where company_id = $1 and category = 'PAYROLL_INPUT_KIND' and code = 'OTHER_INPUT'`, [co.id]);
    expect(await codes(inputs, 'PAYROLL_INPUT_KIND')).toEqual(['OWN_KIND', 'VARIABLE_PAYMENT']);
  });

  it('serves no core list, no list a module does not name and no malformed category', async () => {
    const co = await h.makeCompany();
    const hr = await h.actor(co, 'HR_ADMINISTRATOR', { extra: ['payroll_config.manage.operational', 'payroll_input.prepare.amount'] });
    for (const category of ['EMPLOYEE_STATUS', 'EMPLOYMENT_TYPE', 'ASSET_CATEGORY', 'NO_SUCH_LIST']) expect((await list(hr, category)).statusCode).toBe(404);
    expect((await list(hr, 'payroll_input_kind')).statusCode).toBe(400);
    expect((await h.call(hr, 'GET', '/v1/reference-values')).statusCode).toBe(400);
  });

  it('serves exactly the lists the active registrations name, and refuses a reader for a list the module does not seed', () => {
    const served = servedReferenceLists(MODULE_REGISTRATIONS);
    expect(served.get('PAYROLL_TAX_TREATMENT')).toBe('payroll_config.manage.operational');
    expect(served.get('PAYROLL_INPUT_KIND')).toBe('payroll_input.prepare.amount');
    // Only registrations passed in (the active ones) serve anything.
    expect(servedReferenceLists(MODULE_REGISTRATIONS.filter((m) => m.key !== 'payroll')).has('PAYROLL_TAX_TREATMENT')).toBe(false);
    const broken: ModuleRegistration = { key: 'synthetic', active: true, referenceReaders: { SYNTHETIC_LIST: 'payroll_config.read.operational' } };
    expect(() => servedReferenceLists([broken])).toThrow(/does not seed/);
  });
});
