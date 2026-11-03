// GET /v1/reference-values in a run where the payroll modules are not active (the registry is replaced by one without
// them, as registry.ts computes it for a module that is not active): provisioning seeds none of their lists, and the
// lists are not served even where a company still holds values seeded while the module was active. Synthetic data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startHarness } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';

vi.mock('../registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry.js')>();
  const registrations = actual.MODULE_REGISTRATIONS.filter((m) => m.key !== 'payroll' && m.key !== 'payroll-outputs');
  return { ...actual, MODULE_REGISTRATIONS: registrations, isModuleActive: (key: string) => registrations.some((m) => m.key === key) };
});

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('reference lists of a module that is not active (DF04)', () => {
  it('are neither seeded nor served, even where the company holds their values', async () => {
    expect(isModuleActive('payroll')).toBe(false);
    const co = await h.makeCompany();
    const seeded = await h.one<{ n: number }>(`select count(*)::int as n from reference_value where company_id = $1 and category like 'PAYROLL\\_%'`, [co.id]);
    expect(seeded.n).toBe(0);

    // Values left from a run in which the module was active.
    await h.db.query(
      `insert into reference_value (company_id, category, code, label, active)
       values ($1, 'PAYROLL_TAX_TREATMENT', 'TAXABLE', 'Taxable (synthetic)', true), ($1, 'PAYROLL_INPUT_KIND', 'OTHER_INPUT', 'Other input (synthetic)', true)`,
      [co.id],
    );
    const hr = await h.actor(co, 'HR_ADMINISTRATOR');
    for (const category of ['PAYROLL_TAX_TREATMENT', 'PAYROLL_INPUT_KIND']) {
      const res = await h.call(hr, 'GET', `/v1/reference-values?category=${category}`);
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain('TAXABLE');
    }
  });
});
