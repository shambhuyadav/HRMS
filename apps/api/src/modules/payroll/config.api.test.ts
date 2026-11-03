// Payroll masters over HTTP (FR-028 heads, FR-029 salary components, FR-030 calendar and periods, FR-032 paid-day
// policy; DF05; H8 "supply activated company payroll calendar, service valuation/attendance policy"). Synthetic
// components, codes and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  attendance,
  calculate,
  calendar,
  CONFIG,
  createRun,
  getRun,
  grants,
  head,
  ok,
  person,
  PREPARE,
  record,
  SALARY,
  salary,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('payroll masters (FR-028, FR-029, FR-030, FR-032)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const draftHead = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/payroll/heads', { effectiveFrom: '2020-01-01', inUse: true, taxTreatment: 'TAXABLE', displaySequence: 5, ...body });
  const component = async (code: string, componentKind: 'EARNING' | 'DEDUCTION' = 'EARNING') =>
    ok(await h.call(configA, 'POST', '/v1/payroll/components', { code, name: `${code} (synthetic)`, componentKind }), 201);
  const activate = async (a: TestActor, draft: { id: string; version: number }) => h.call(a, 'POST', `/v1/payroll/head-revisions/${draft.id}/activate`, { expectedVersion: draft.version });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('defines heads completely, matches the component kind and activates them through someone else', async () => {
    await component('CFG_BASIC');
    await component('CFG_DED', 'DEDUCTION');
    expect((await draftHead(configA, { componentCode: 'CFG_BASIC' })).json().error).toBe('DEFINITION_INCOMPLETE');
    expect((await draftHead(configA, { componentCode: 'CFG_BASIC', headType: 'DEDUCTION', calculationBasis: 'FIXED' })).json().error).toBe('KIND_MISMATCH');
    expect((await draftHead(configA, { componentCode: 'CFG_DED', headType: 'EARNING', calculationBasis: 'FIXED' })).json().error).toBe('KIND_MISMATCH');
    expect((await draftHead(configA, { componentCode: 'CFG_BASIC', headType: 'EARNING', calculationBasis: 'FIXED', taxTreatment: 'NOT_A_TREATMENT' })).json().error).toBe('UNKNOWN_TAX_TREATMENT');
    expect((await draftHead(configA, { componentCode: 'CFG_DED', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK' })).json().error).toBe('RULE_PACK_REQUIRED');
    expect((await draftHead(configA, { componentCode: 'CFG_BASIC', headType: 'EARNING', calculationBasis: 'FIXED', baseComponentCodes: ['CFG_DED'] })).json().error).toBe('BASE_NOT_ALLOWED');
    expect((await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'CFG_BASIC', effectiveFrom: '2020-01-01', inUse: false, headType: 'EARNING' })).json().error).toBe(
      'DISCONTINUATION_HAS_NO_DEFINITION',
    );
    // DF05: one rounding rule exists (currency minor unit, half-up); nothing else is accepted.
    expect((await draftHead(configA, { componentCode: 'CFG_BASIC', headType: 'EARNING', calculationBasis: 'FIXED', roundingRule: 'HALF_EVEN' })).statusCode).toBe(400);
    const draft = await ok<{ id: string; version: number; state: string; roundingRule: string; taxTreatment: string }>(
      await draftHead(configA, { componentCode: 'CFG_BASIC', headType: 'EARNING', calculationBasis: 'FIXED' }),
      201,
    );
    expect(draft).toMatchObject({ state: 'DRAFT', roundingRule: 'HALF_UP_MINOR_UNIT', taxTreatment: 'TAXABLE' });
    expect((await activate(configA, draft)).json().error).toBe('SELF_APPROVAL');
    expect(await ok(await activate(configB, draft))).toMatchObject({ state: 'ACTIVE' });
    // A created revision never changes; the database refuses an edit.
    await expect(h.db.query(`update payroll_head_revision set head_type = 'REIMBURSEMENT' where id = $1`, [draft.id])).rejects.toThrow(/fixed once created/);
    await expect(h.db.query(`delete from payroll_head_revision where id = $1`, [draft.id])).rejects.toThrow();
  });

  it('refuses to activate a rule-pack head whose base is missing or that would depend on itself', async () => {
    await component('CFG_PACK_A', 'DEDUCTION');
    await component('CFG_PACK_B', 'DEDUCTION');
    await component('CFG_UNDEFINED');
    // Base without any head: missing definition.
    const missing = await ok<{ id: string; version: number }>(
      await draftHead(configA, { componentCode: 'CFG_PACK_A', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK', rulePackCode: 'SYNTH_PACK', baseComponentCodes: ['CFG_UNDEFINED'] }),
      201,
    );
    expect((await activate(configB, missing)).json()).toMatchObject({ error: 'MISSING_DEFINITION', details: { componentCode: 'CFG_PACK_A', baseComponentCode: 'CFG_UNDEFINED' } });
    await ok(await h.call(configA, 'POST', `/v1/payroll/head-revisions/${missing.id}/cancel`, { expectedVersion: missing.version }));
    // A -> B and B -> A: a cycle, refused on the second activation.
    const b = await ok<{ id: string; version: number }>(await draftHead(configA, { componentCode: 'CFG_PACK_B', headType: 'DEDUCTION', calculationBasis: 'FIXED' }), 201);
    await ok(await activate(configB, b));
    const a = await ok<{ id: string; version: number }>(
      await draftHead(configA, { componentCode: 'CFG_PACK_A', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK', rulePackCode: 'SYNTH_PACK', baseComponentCodes: ['CFG_PACK_B'] }),
      201,
    );
    await ok(await activate(configB, a));
    const bCycle = await ok<{ id: string; version: number }>(
      await draftHead(configA, { componentCode: 'CFG_PACK_B', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK', rulePackCode: 'SYNTH_PACK', baseComponentCodes: ['CFG_PACK_A'], effectiveFrom: '2026-01-01' }),
      201,
    );
    expect((await activate(configB, bCycle)).json().error).toBe('CYCLIC_DEFINITION');
    // Discontinuing a head that a rule-pack head still uses as its base is a missing definition too.
    const stop = await ok<{ id: string; version: number }>(await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'CFG_PACK_B', effectiveFrom: '2026-02-01', inUse: false }), 201);
    expect((await activate(configB, stop)).json().error).toBe('MISSING_DEFINITION');
    // A head cannot be its own base.
    expect((await draftHead(configA, { componentCode: 'CFG_PACK_B', headType: 'DEDUCTION', calculationBasis: 'RULE_PACK', rulePackCode: 'SYNTH_PACK', baseComponentCodes: ['CFG_PACK_B'] })).json().error).toBe(
      'CYCLIC_DEFINITION',
    );
  });

  it('reproduces the structure of a past month after a new structure is introduced (effective dating)', async () => {
    await head(h, configA, configB, { code: 'CFG_ALLOW', headType: 'EARNING', basis: 'FIXED', sequence: 3 });
    const { periods } = await calendar(h, configA, configB, [
      { code: 'EFF-06', start: '2026-06-01', end: '2026-06-30' },
      { code: 'EFF-07', start: '2026-07-01', end: '2026-07-31' },
    ]);
    const dept = await department('EFFECTIVE');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '3000', components: [{ code: 'CFG_ALLOW', amount: '3000' }] });
    // From July the allowance is classified as a reimbursement (a new, independently activated revision).
    const july = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', {
        componentCode: 'CFG_ALLOW',
        effectiveFrom: '2026-07-01',
        inUse: true,
        headType: 'REIMBURSEMENT',
        calculationBasis: 'FIXED',
        taxTreatment: 'NON_TAXABLE',
        displaySequence: 3,
      }),
      201,
    );
    await ok(await activate(configB, july));
    const asOf = async (day: string) =>
      (await ok<{ items: { componentCode: string; headType: string; revision: number }[] }>(await h.call(configA, 'GET', `/v1/payroll/heads?asOf=${day}`))).items.find(
        (x) => x.componentCode === 'CFG_ALLOW',
      );
    expect(await asOf('2026-06-15')).toMatchObject({ headType: 'EARNING', revision: 1 });
    expect(await asOf('2026-07-15')).toMatchObject({ headType: 'REIMBURSEMENT', revision: 2 });
    // June, calculated after July's structure exists, still uses June's structure.
    const june = await createRun(h, preparer, periods['EFF-06']!, { departmentIds: [dept] });
    await calculate(h, preparer, june.id);
    expect(await record(h, preparer, june.id, e)).toMatchObject({
      earnings: '3000.0000',
      reimbursements: '0.0000',
      lines: [expect.objectContaining({ componentCode: 'CFG_ALLOW', headType: 'EARNING', ruleVersion: 'HEAD:CFG_ALLOW@r1' })],
    });
    const run7 = await createRun(h, preparer, periods['EFF-07']!, { departmentIds: [dept] });
    await calculate(h, preparer, run7.id);
    expect(await record(h, preparer, run7.id, e)).toMatchObject({
      earnings: '0.0000',
      reimbursements: '3000.0000',
      net: '3000.0000',
      lines: [expect.objectContaining({ headType: 'REIMBURSEMENT', ruleVersion: 'HEAD:CFG_ALLOW@r2' })],
    });
  });

  it('has no default calendar; periods are whole months with a cutoff on or before payment, fixed once used', async () => {
    // H8 / H2: a new company has no payroll calendar, no paid-day policy and no hold criterion until it supplies them.
    const B = await h.makeCompany();
    const configOfB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIG });
    expect((await ok<{ items: unknown[] }>(await h.call(configOfB, 'GET', '/v1/payroll/calendars'))).items).toEqual([]);
    expect((await ok<{ items: unknown[] }>(await h.call(configOfB, 'GET', '/v1/payroll/paid-day-policies'))).items).toEqual([]);
    expect((await ok<{ items: unknown[] }>(await h.call(configOfB, 'GET', '/v1/payroll/heads'))).items).toEqual([]);
    const k = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/calendars', { code: uniq('CFGCAL'), name: 'Synthetic calendar', currencyCode: 'INR', currencyMinorUnit: 2 }),
      201,
    );
    const period = (body: Record<string, unknown>) =>
      h.call(configA, 'POST', `/v1/payroll/calendars/${k.id}/periods`, { financialYear: 'FY-SYNTH', inputCutoff: '2026-03-25', paymentDate: '2026-03-31', ...body });
    // Activation needs periods and someone other than the author.
    const fresh = await ok<{ version: number }>(await h.call(configA, 'GET', `/v1/payroll/calendars/${k.id}`));
    expect((await h.call(configB, 'POST', `/v1/payroll/calendars/${k.id}/activate`, { expectedVersion: fresh.version })).json().error).toBe('NO_PERIODS');
    expect((await period({ periodCode: 'P1', serviceStart: '2026-03-02', serviceEnd: '2026-03-31' })).json().error).toBe('SERVICE_PERIOD_NOT_A_MONTH');
    expect((await period({ periodCode: 'P1', serviceStart: '2026-03-01', serviceEnd: '2026-04-15' })).json().error).toBe('SERVICE_PERIOD_NOT_A_MONTH');
    expect((await period({ periodCode: 'P1', serviceStart: '2026-03-01', serviceEnd: '2026-03-31', inputCutoff: '2026-04-02' })).json().error).toBe('CUTOFF_AFTER_PAYMENT');
    expect((await period({ periodCode: 'P1', serviceStart: '2026-02-30', serviceEnd: '2026-03-31' })).json().error).toBe('INVALID_DATE');
    const march = await ok<{ id: string; version: number }>(await period({ periodCode: 'P1', serviceStart: '2026-03-01', serviceEnd: '2026-03-31' }), 201);
    expect((await period({ periodCode: 'P2', serviceStart: '2026-03-01', serviceEnd: '2026-03-31' })).json().error).toBe('PERIOD_EXISTS');
    // A run needs an active calendar.
    expect((await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: march.id })).json().error).toBe('CALENDAR_NOT_ACTIVE');
    const current = await ok<{ version: number }>(await h.call(configA, 'GET', `/v1/payroll/calendars/${k.id}`));
    expect((await h.call(configA, 'POST', `/v1/payroll/calendars/${k.id}/activate`, { expectedVersion: current.version })).json().error).toBe('SELF_APPROVAL');
    await ok(await h.call(configB, 'POST', `/v1/payroll/calendars/${k.id}/activate`, { expectedVersion: current.version }));
    // The payment date and cutoff can still be corrected while nothing uses the period.
    const moved = await ok<{ paymentDate: string; inputCutoff: string }>(
      await h.call(configA, 'PUT', `/v1/payroll/periods/${march.id}`, {
        financialYear: 'FY-SYNTH',
        serviceStart: '2026-03-01',
        serviceEnd: '2026-03-31',
        inputCutoff: '2026-03-24',
        paymentDate: '2026-03-30',
        expectedVersion: march.version,
      }),
    );
    expect(moved).toMatchObject({ inputCutoff: '2026-03-24', paymentDate: '2026-03-30' });
    // The change is audited with both sides (operational configuration values only).
    const changed = await h.one<{ before_values: { operational: Record<string, string> }; after_values: { operational: Record<string, string> } }>(
      `select before_values, after_values from audit_event where record_key = $1 and action = 'UPDATE'`,
      [march.id],
    );
    expect(changed.before_values.operational).toMatchObject({ inputCutoff: '2026-03-25', paymentDate: '2026-03-31' });
    expect(changed.after_values.operational).toMatchObject({ inputCutoff: '2026-03-24', paymentDate: '2026-03-30' });
    // Once a run uses it, it is fixed.
    const dept = await department('CALENDAR');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '100', components: [{ code: 'CFG_BASIC', amount: '100' }] });
    await createRun(h, preparer, march.id, { departmentIds: [dept] });
    const p = await h.one<{ version: number }>(`select version from payroll_period where id = $1`, [march.id]);
    expect(
      (
        await h.call(configA, 'PUT', `/v1/payroll/periods/${march.id}`, {
          financialYear: 'FY-SYNTH',
          serviceStart: '2026-03-01',
          serviceEnd: '2026-03-31',
          inputCutoff: '2026-03-20',
          paymentDate: '2026-03-30',
          expectedVersion: p.version,
        })
      ).json().error,
    ).toBe('PERIOD_IN_USE');
    await expect(h.db.query(`update payroll_period set payment_date = '2026-03-29' where id = $1`, [march.id])).rejects.toThrow(/fixed once runs/);
  });

  it('values attendance only as an activated policy says, with the units the company states', async () => {
    expect((await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-11-01', attendanceBasis: 'REVIEWED_ATTENDANCE' })).json().error).toBe('UNITS_REQUIRED');
    expect(
      (await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-11-01', attendanceBasis: 'APPROVED_LEAVE_ONLY', absentUnpaidUnits: '1', halfDayUnpaidUnits: '0.5' })).json().error,
    ).toBe('UNITS_NOT_ALLOWED');
    expect(
      (await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-11-01', attendanceBasis: 'REVIEWED_ATTENDANCE', absentUnpaidUnits: '1.5', halfDayUnpaidUnits: '0.5' })).json()
        .error,
    ).toBe('INVALID_AMOUNT');
    const draft = await ok<{ id: string; version: number }>(await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-11-01', attendanceBasis: 'APPROVED_LEAVE_ONLY' }), 201);
    expect((await h.call(configA, 'POST', `/v1/payroll/paid-day-policies/${draft.id}/activate`, { expectedVersion: draft.version })).json().error).toBe('SELF_APPROVAL');
    await ok(await h.call(configB, 'POST', `/v1/payroll/paid-day-policies/${draft.id}/activate`, { expectedVersion: draft.version }));
    // Under APPROVED_LEAVE_ONLY the company has said attendance never reduces pay: no deduction and nothing to resolve.
    const { periods } = await calendar(h, configA, configB, [{ code: 'POL-11', start: '2026-11-01', end: '2026-11-30' }]);
    const dept = await department('LEAVE_ONLY');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'CFG_BASIC', amount: '30000' }] });
    await attendance(h, A, e, '2026-11-03', 'ABSENT');
    const run = await createRun(h, preparer, periods['POL-11']!, { departmentIds: [dept] });
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated).toMatchObject({ exceptions: { blocking: 0 } });
    expect(await record(h, preparer, run.id, e)).toMatchObject({ paidUnits: '30.0000', earnings: '30000.0000', lossOfPay: [] });
    expect((await getRun(h, preparer, run.id)) as unknown).toMatchObject({ snapshot: { attendanceBasis: 'APPROVED_LEAVE_ONLY', paidDayPolicyId: draft.id } });
  });

  it('sets the salary components of an arrangement once, under the salary grant, and keeps them immutable', async () => {
    const e = await person(h, A, hr, { joiningDate: '2026-01-05' });
    const created = await h.call(preparer, 'POST', `/v1/employees/${e}/salary`, { effectiveFrom: '2026-01-05', annualCtc: '360000', monthlyGross: '30000', currency: 'INR' });
    const arrangement = (created.json() as { id: string }).id;
    const set = (a: TestActor, list: { componentCode: string; amount: string; basis: string }[]) => h.call(a, 'POST', `/v1/payroll/salary-arrangements/${arrangement}/components`, { components: list });
    // The configuration duty is not the salary duty.
    expect((await set(configA, [{ componentCode: 'CFG_BASIC', amount: '30000', basis: 'MONTHLY' }])).statusCode).toBe(403);
    expect((await set(preparer, [{ componentCode: 'NOT_A_COMPONENT', amount: '1', basis: 'MONTHLY' }])).json().error).toBe('UNKNOWN_COMPONENT');
    expect(
      (await set(preparer, [
        { componentCode: 'CFG_BASIC', amount: '1', basis: 'MONTHLY' },
        { componentCode: 'CFG_BASIC', amount: '2', basis: 'MONTHLY' },
      ])).json().error,
    ).toBe('DUPLICATE_COMPONENT');
    const view = await ok<{ components: { componentCode: string; amount: string }[]; totals: unknown[] }>(
      await set(preparer, [
        { componentCode: 'CFG_BASIC', amount: '25000', basis: 'MONTHLY' },
        { componentCode: 'CFG_DED', amount: '200', basis: 'MONTHLY' },
      ]),
      201,
    );
    expect(view.components.map((c) => [c.componentCode, c.amount])).toEqual([
      ['CFG_BASIC', '25000.0000'],
      ['CFG_DED', '200.0000'],
    ]);
    expect((await set(preparer, [{ componentCode: 'CFG_BASIC', amount: '1', basis: 'MONTHLY' }])).json().error).toBe('COMPONENTS_ALREADY_SET');
    await expect(h.db.query(`update salary_component set amount = 1 where salary_arrangement_id = $1`, [arrangement])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`delete from salary_component where salary_arrangement_id = $1`, [arrangement])).rejects.toThrow(/never deleted/);
    // An administrator never maintains their own salary components in this context.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY, employeeId: e });
    expect((await h.call(self, 'GET', `/v1/payroll/salary-arrangements/${arrangement}/components`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
  });

  it('gives the payroll, finance and treasury roles their operational context only', async () => {
    const operator = await h.actor(A, 'PAYROLL_OPERATOR');
    const payrollApprover = await h.actor(A, 'PAYROLL_APPROVER');
    const finance = await h.actor(A, 'FINANCE_REVIEWER');
    const treasury = await h.actor(A, 'TREASURY_OPERATOR');
    const treasuryApprover = await h.actor(A, 'TREASURY_APPROVER');
    expect((await h.call(operator, 'GET', '/v1/payroll/heads')).statusCode).toBe(200);
    expect((await h.call(payrollApprover, 'GET', '/v1/payroll/calendars')).statusCode).toBe(200);
    // Configuration changes need the (ceiling) manage grant of the assignment.
    expect((await h.call(operator, 'POST', '/v1/payroll/components', { code: 'CFG_OP', name: 'x', componentKind: 'EARNING' })).statusCode).toBe(403);
    const operatorWithGrant = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['payroll_config.manage.operational'] });
    await ok(await h.call(operatorWithGrant, 'POST', '/v1/payroll/components', { code: 'CFG_OP', name: 'Operator component (synthetic)', componentKind: 'EARNING' }), 201);
    for (const a of [finance, treasury, treasuryApprover]) {
      expect((await h.call(a, 'GET', '/v1/payroll/runs')).statusCode).toBe(200);
      expect((await h.call(a, 'GET', '/v1/payroll/heads')).statusCode).toBe(403);
      // Amounts need an eligible Admin assignment's confidential grant.
      expect((await h.call(a, 'GET', `/v1/payroll/runs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/records`)).statusCode).toBe(403);
    }
  });
});
