// I-85 PF, ESIC and professional tax packs, worked examples for the owner's (or an authorised person's) review (decided under owner
// delegation, 6 Nov 2026; migration 0220). The packs are the seeded DRAFT values, validated by one person and activated by another in
// this fixture only: that is not a legal validation. Synthetic people and wages only; every figure is worked by hand in the comments.
//
// Heads: SP_BASIC, SP_DA, SP_HRA (FIXED earnings); PF heads on Basic + DA; ESIC and professional tax heads on Basic + DA + HRA.
// October 2026 has 31 days; every example is paid the full month unless stated.
//  P1 PF below the ceiling     Basic 8,000 + DA 2,000 + HRA 4,000: PF 1,200 / EPS 833 / EPF 367 / EDLI 50 / admin 50; ESIC 105 / 455;
//                              PT 200; net 14,000 - 1,505 = 12,495.00; employer cost 1,755.00.
//  P2 PF above the ceiling     Basic 20,000 + DA 5,000 + HRA 10,000: PF on 15,000: 1,800 / 1,250 / 550 / 75 / 75; no ESIC (35,000);
//                              PT 200; net 33,000.00; employer cost 1,950.00.
//  P3 higher-wage option       as P2, contributing on 25,000: 3,000 / 1,250 / 1,750 / 75 / 125; PT 200; net 31,800.00; cost 3,200.00.
//  E1 ESIC just under          12,000 + 3,000 + 5,999 = 20,999: ESIC 157.4925 -> 158 and 682.4675 -> 683; PF on 15,000; PT 200;
//                              net 20,999 - 2,158 = 18,841.00.
//  E2 ESIC just over           12,000 + 3,000 + 6,001 = 21,001: no ESIC; net 21,001 - 2,000 = 19,001.00.
//  E3 stays covered            20,000 from January, 22,000 from 1 December: December (period from 1 October, covered then) ESIC on
//                              22,000 = 165 / 715; April 2027 (a new period, 22,000 at its start) no ESIC.
//  T1 Maharashtra, October     P1's 14,000: 200.        T2 Maharashtra, February 2027: P1's 14,000: 300.
//  T3 Karnataka, no active pack: RULE_PACK_NOT_CONFIGURED for the PT head only (packCode PT_KA); the record is not paid.
//  T4 a location with no professional tax state: RULE_PACK_NOT_CONFIGURED (reason PT_STATE_NOT_RECORDED).
//  S1 settlement, last day 15 October: earnings 3,870.97 + 967.74 + 1,935.48; PF 12% of 4,838.71 = 580.6452 -> 581 (EPS 403, EPF 178,
//                              EDLI 24, admin 24 as employer cost); ESIC 0.75% of 6,774.19 = 50.81 -> 51 (employer 221); PT nil.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { approvalBlockers } from '../lifecycle/settlement-gates.js';
import { HR_SETTLEMENT } from '../lifecycle/lifecycle.fixtures.js';
import { approvedExit, calculate, calendar, CONFIG, createRun, grants, head, laterArrangement, months, ok, person, PREPARE, record, type RecordView, SALARY, salary } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

interface Pack {
  id: string;
  code: string;
  revision: number;
  state: string;
  version: number;
  effectiveFrom: string;
  parameters: Record<string, unknown>;
  statuteReference: string;
  createdBy: string;
}
interface Item {
  kind: string;
  status: string;
  componentCode: string | null;
  amount: string | null;
  basis: Record<string, unknown>;
}

const STATUTORY = ['SP_ESI_EE', 'SP_ESI_ER', 'SP_PF_ADMIN', 'SP_PF_EDLI', 'SP_PF_EE', 'SP_PF_EPF', 'SP_PF_EPS', 'SP_PT'];
/** The statutory lines of a record, by component code. */
const statutory = (r: RecordView) => Object.fromEntries(r.lines.filter((l) => STATUTORY.includes(l.componentCode)).map((l) => [l.componentCode, l.amount]));
const totals = (r: RecordView) => ({ status: r.calculationStatus, earnings: r.earnings, deductions: r.deductions, net: r.net, employerContributions: r.employerContributions });

describe.runIf(isModuleActive('lifecycle') && isModuleActive('payroll'))('I-85 statutory packs: PF, ESIC and professional tax worked examples', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let packV: TestActor;
  let packA: TestActor;
  let prep: TestActor;
  let hrPlain: TestActor;
  let periods: Record<string, string>;
  let mh: string;
  let ka: string;
  let bare: string;

  const hex = () => Math.random().toString(16).slice(2, 10).toUpperCase();
  const department = async () =>
    (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, `D${hex()}`])).id;
  const location = async () => {
    const code = `L${hex()}`;
    return { code, id: (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, code])).id };
  };
  const packs = async () => (await ok<{ items: Pack[] }>(await h.call(hr, 'GET', '/v1/statutory-rule-packs'))).items;
  /** Validated by one authorised person and activated by another (the fixture's stand-in for the authorised check). */
  const activate = async (id: string) => {
    const p = (await packs()).find((x) => x.id === id)!;
    const v = await ok<Pack>(
      await h.call(packV, 'POST', `/v1/statutory-rule-packs/${id}/validate`, {
        sourceReference: 'Synthetic: the seeded draft read back by the test fixture',
        validationReference: 'Synthetic: test fixture only, not a validation against the law in force',
        expectedVersion: p.version,
      }),
    );
    return ok<Pack>(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${id}/activate`, { expectedVersion: v.version }));
  };
  const seeded = async (code: string) => (await packs()).find((p) => p.code === code && p.revision === 1)!;
  const employee = async (dept: string, loc: string, pay: [string, string, string], joiningDate = '2026-01-05') => {
    const id = await person(h, A, hr, { joiningDate, departmentId: dept, locationId: loc });
    const [basic, da, hra] = pay;
    await salary(h, preparer, id, {
      effectiveFrom: joiningDate,
      monthlyGross: String(Number(basic) + Number(da) + Number(hra)),
      components: [
        { code: 'SP_BASIC', amount: basic },
        { code: 'SP_DA', amount: da },
        { code: 'SP_HRA', amount: hra },
      ],
    });
    return id;
  };
  const run = async (month: string, dept: string) => {
    const created = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    expect((await calculate(h, preparer, created.id)).state).toBe('CALCULATED');
    return created.id;
  };
  const verified = async (runId: string) => (await ok<{ identical: boolean }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${runId}/verify`))).identical;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.validate.operational'] });
    packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });

    const PF_BASE = ['SP_BASIC', 'SP_DA'];
    const GROSS = ['SP_BASIC', 'SP_DA', 'SP_HRA'];
    await head(h, configA, configB, { code: 'SP_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'SP_DA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'SP_HRA', headType: 'EARNING', basis: 'FIXED', sequence: 3 });
    await head(h, configA, configB, { code: 'SP_PF_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYEE', base: PF_BASE, sequence: 20 });
    await head(h, configA, configB, { code: 'SP_ESI_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'ESIC_EMPLOYEE', base: GROSS, sequence: 21 });
    await head(h, configA, configB, { code: 'SP_PT', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PROFESSIONAL_TAX', base: GROSS, sequence: 22 });
    await head(h, configA, configB, { code: 'SP_PF_EPS', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYER_EPS', base: PF_BASE, sequence: 30 });
    await head(h, configA, configB, { code: 'SP_PF_EPF', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYER_EPF', base: PF_BASE, sequence: 31 });
    await head(h, configA, configB, { code: 'SP_PF_EDLI', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EDLI', base: PF_BASE, sequence: 32 });
    await head(h, configA, configB, { code: 'SP_PF_ADMIN', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_ADMIN', base: PF_BASE, sequence: 33 });
    await head(h, configA, configB, { code: 'SP_ESI_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'ESIC_EMPLOYER', base: GROSS, sequence: 34 });
    periods = (await calendar(h, configA, configB, [...months(2026), ...months(2027)])).periods;

    // Work locations: one in Maharashtra, one in Karnataka (dated from 1 January 2026), one with no professional tax state recorded.
    const m = await location();
    const k = await location();
    [mh, ka, bare] = [m.id, k.id, (await location()).id];
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: m.code, effectiveFrom: '2026-01-01', stateCode: 'MH' }), 201);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: k.code, effectiveFrom: '2026-01-01', stateCode: 'ka' }), 201);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('every company starts with PF, ESIC and the Maharashtra and Karnataka professional tax packs as inactive drafts by the system actor', async () => {
    const all = await packs();
    expect(all.map((p) => [p.code, p.revision, p.state, p.effectiveFrom]).sort()).toEqual([
      ['ESIC', 1, 'DRAFT', '2019-07-01'],
      ['GRATUITY', 1, 'DRAFT', '2018-03-29'],
      // I-90: income tax for FY 2026-27 (statutory/income-tax.ts), to be validated against the Income-tax Act, 2025.
      ['INCOME_TAX', 1, 'DRAFT', '2026-04-01'],
      // FR-039: the state labour welfare funds of Karnataka and Maharashtra (lwf.api.test.ts).
      ['LWF_KA', 1, 'DRAFT', '2024-01-01'],
      ['LWF_MH', 1, 'DRAFT', '2023-04-01'],
      ['PF', 1, 'DRAFT', '2018-06-01'],
      ['PT_KA', 1, 'DRAFT', '2023-04-01'],
      ['PT_MH', 1, 'DRAFT', '2023-04-01'],
    ]);
    for (const p of all.filter((x) => x.code !== 'INCOME_TAX' && !x.code.startsWith('LWF_'))) expect(p.statuteReference).toContain('including the Code on Social Security, 2020');
    for (const p of all.filter((x) => x.code.startsWith('LWF_'))) expect(p.statuteReference).toContain('Validate against the law in force for the period before activation');
    expect(all.find((x) => x.code === 'INCOME_TAX')!.statuteReference).toContain('To be validated against the law in force');
    expect(new Set(all.map((p) => p.createdBy)).size).toBe(1);
    expect((await seeded('PF')).parameters).toMatchObject({ wageCeiling: '15000.00', employeeRatePercent: '12', pensionRatePercent: '8.33' });
    // A professional tax pack of another state is written as a revision; its slabs are checked.
    const bad = await h.call(packV, 'POST', '/v1/statutory-rule-packs', { code: 'PT_TN', effectiveFrom: '2026-04-01', currencyCode: 'INR', parameters: { stateCode: 'TN', slabs: [{ upTo: '1.00', amount: '0.00' }] }, statuteReference: 'Synthetic' });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'INVALID_PARAMETERS']);
  });

  it('the settings are payroll configuration: a PF option and a PT state need the configuration right, and a state is two letters', async () => {
    const dept = await department();
    const id = await employee(dept, mh, ['8000', '2000', '4000']);
    expect((await h.call(hrPlain, 'POST', '/v1/statutory/pf-options', { employeeId: id, effectiveFrom: '2026-01-01', contributionBasis: 'HIGHER_WAGES', reference: 'Synthetic form 1' })).statusCode).toBe(403);
    expect((await h.call(hrPlain, 'GET', `/v1/statutory/pf-options?employeeId=${id}`)).statusCode).toBe(403);
    expect((await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: 'NO_SUCH_SITE', effectiveFrom: '2026-01-01', stateCode: 'MH' })).json().error).toBe('UNKNOWN_LOCATION');
    expect((await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: 'NO_SUCH_SITE', effectiveFrom: '2026-01-01', stateCode: 'MAH' })).statusCode).toBe(400);
    expect((await ok<{ items: { stateCode: string }[] }>(await h.call(configA, 'GET', '/v1/statutory/pt-states'))).items.map((s) => s.stateCode).sort()).toEqual(['KA', 'MH']);
  });

  it('while the packs are inactive, every statutory head blocks the employee with RULE_PACK_NOT_CONFIGURED, as before', async () => {
    const dept = await department();
    const id = await employee(dept, mh, ['8000', '2000', '4000']);
    const runId = await run('2026-10', dept);
    const r = await record(h, preparer, runId, id);
    expect(r.calculationStatus).toBe('FAILED');
    expect(r.lines).toEqual([]);
    const details = r.exceptions.map((x) => [x.code, x.detail]).sort((a, b) => String((a[1] as { componentCode: string }).componentCode).localeCompare(String((b[1] as { componentCode: string }).componentCode)));
    expect(details).toEqual([
      ...['SP_ESI_EE:ESIC_EMPLOYEE', 'SP_ESI_ER:ESIC_EMPLOYER', 'SP_PF_ADMIN:PF_ADMIN', 'SP_PF_EDLI:PF_EDLI', 'SP_PF_EE:PF_EMPLOYEE', 'SP_PF_EPF:PF_EMPLOYER_EPF', 'SP_PF_EPS:PF_EMPLOYER_EPS'].map(
        (pair) => ['RULE_PACK_NOT_CONFIGURED', { componentCode: pair.split(':')[0], rulePackCode: pair.split(':')[1] }],
      ),
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'SP_PT', rulePackCode: 'PROFESSIONAL_TAX', packCode: 'PT_MH' }],
    ]);
    // The run fixed "none active" for each pack it needed, so a pack activated while it runs cannot split its members.
    expect((await h.db.query(`select pack_code, pack_revision from payroll_run_rule_pack where run_id = $1 order by pack_code`, [runId])).rows).toEqual([
      { pack_code: 'ESIC', pack_revision: null },
      { pack_code: 'PF', pack_revision: null },
      { pack_code: 'PT_MH', pack_revision: null },
    ]);
  });

  it('a pack is validated by one authorised person and activated by another (never its validator)', async () => {
    const pf = await seeded('PF');
    expect((await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pf.id}/validate`, { sourceReference: 'x', validationReference: 'y', expectedVersion: pf.version })).statusCode).toBe(403);
    const v = await ok<Pack>(await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pf.id}/validate`, { sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: pf.version }));
    const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'], user: packV.user });
    expect((await h.call(both, 'POST', `/v1/statutory-rule-packs/${pf.id}/activate`, { expectedVersion: v.version })).json().error).toBe('SELF_APPROVAL');
    expect((await ok<Pack>(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pf.id}/activate`, { expectedVersion: v.version }))).state).toBe('ACTIVE');
    expect((await activate((await seeded('ESIC')).id)).state).toBe('ACTIVE');
    expect((await activate((await seeded('PT_MH')).id)).state).toBe('ACTIVE');
  });

  let p1: { dept: string; id: string };

  it('P1-P3, E1-E2, T1, T3, T4: October 2026 with PF, ESIC and Maharashtra professional tax active', async () => {
    const dept = await department();
    const P1 = await employee(dept, mh, ['8000', '2000', '4000']);
    const P2 = await employee(dept, mh, ['20000', '5000', '10000']);
    const P3 = await employee(dept, mh, ['20000', '5000', '10000']);
    const E1 = await employee(dept, mh, ['12000', '3000', '5999']);
    const E2 = await employee(dept, mh, ['12000', '3000', '6001']);
    const T3 = await employee(dept, ka, ['20000', '5000', '10000']);
    const T4 = await employee(dept, bare, ['20000', '5000', '10000']);
    p1 = { dept, id: P1 };
    // P3 opted to contribute on wages above the ceiling (joint option), dated.
    const option = await ok<{ contributionBasis: string; sequence: number }>(
      await h.call(configA, 'POST', '/v1/statutory/pf-options', { employeeId: P3, effectiveFrom: '2026-01-05', contributionBasis: 'HIGHER_WAGES', reference: 'Synthetic joint option form 26(6)-001' }),
      201,
    );
    expect(option).toMatchObject({ contributionBasis: 'HIGHER_WAGES', sequence: 1 });
    const runId = await run('2026-10', dept);

    const p1r = await record(h, preparer, runId, P1);
    expect(statutory(p1r)).toEqual({
      SP_PF_EE: '1200.0000',
      SP_PF_EPS: '833.0000',
      SP_PF_EPF: '367.0000',
      SP_PF_EDLI: '50.0000',
      SP_PF_ADMIN: '50.0000',
      SP_ESI_EE: '105.0000',
      SP_ESI_ER: '455.0000',
      SP_PT: '200.0000',
    });
    expect(totals(p1r)).toEqual({ status: 'CALCULATED', earnings: '14000.0000', deductions: '1505.0000', net: '12495.0000', employerContributions: '1755.0000' });
    expect(p1r.lines.filter((l) => l.headType === 'EMPLOYER_CONTRIBUTION').map((l) => l.componentCode).sort()).toEqual(['SP_ESI_ER', 'SP_PF_ADMIN', 'SP_PF_EDLI', 'SP_PF_EPF', 'SP_PF_EPS']);

    const p2r = await record(h, preparer, runId, P2);
    expect(statutory(p2r)).toEqual({ SP_PF_EE: '1800.0000', SP_PF_EPS: '1250.0000', SP_PF_EPF: '550.0000', SP_PF_EDLI: '75.0000', SP_PF_ADMIN: '75.0000', SP_PT: '200.0000' });
    expect(totals(p2r)).toEqual({ status: 'CALCULATED', earnings: '35000.0000', deductions: '2000.0000', net: '33000.0000', employerContributions: '1950.0000' });

    const p3r = await record(h, preparer, runId, P3);
    expect(statutory(p3r)).toEqual({ SP_PF_EE: '3000.0000', SP_PF_EPS: '1250.0000', SP_PF_EPF: '1750.0000', SP_PF_EDLI: '75.0000', SP_PF_ADMIN: '125.0000', SP_PT: '200.0000' });
    expect(totals(p3r)).toEqual({ status: 'CALCULATED', earnings: '35000.0000', deductions: '3200.0000', net: '31800.0000', employerContributions: '3200.0000' });

    const e1r = await record(h, preparer, runId, E1);
    expect(statutory(e1r)).toMatchObject({ SP_ESI_EE: '158.0000', SP_ESI_ER: '683.0000', SP_PF_EE: '1800.0000', SP_PT: '200.0000' });
    expect(totals(e1r)).toEqual({ status: 'CALCULATED', earnings: '20999.0000', deductions: '2158.0000', net: '18841.0000', employerContributions: '2633.0000' });

    const e2r = await record(h, preparer, runId, E2);
    expect(Object.keys(statutory(e2r))).not.toContain('SP_ESI_EE');
    expect(totals(e2r)).toEqual({ status: 'CALCULATED', earnings: '21001.0000', deductions: '2000.0000', net: '19001.0000', employerContributions: '1950.0000' });
    // Not covered is recorded with its workings, and is no line.
    expect(
      (
        await h.one<{ status: string; workings: Record<string, unknown> }>(
          `select s.status, s.workings from payroll_record_statutory s join pay_component pc on pc.id = s.component_id where s.record_id = $1 and pc.code = 'SP_ESI_EE'`,
          [e2r.id],
        )
      ),
    ).toMatchObject({ status: 'NOT_APPLICABLE', workings: { reason: 'NOT_COVERED', rateNow: '21001.0000', wageCeiling: '21000.00', packCode: 'ESIC', packRevision: 1 } });

    // T3: Karnataka has no active pack; only the professional tax head is refused, and the record is not paid.
    const t3r = await record(h, preparer, runId, T3);
    expect(t3r.calculationStatus).toBe('FAILED');
    expect(t3r.exceptions.filter((x) => x.severity === 'BLOCKING').map((x) => [x.code, x.detail])).toEqual([
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'SP_PT', rulePackCode: 'PROFESSIONAL_TAX', packCode: 'PT_KA' }],
    ]);
    // T4: no professional tax state at the work location.
    const t4r = await record(h, preparer, runId, T4);
    expect(t4r.exceptions.filter((x) => x.severity === 'BLOCKING').map((x) => [x.code, x.detail])).toEqual([
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'SP_PT', rulePackCode: 'PROFESSIONAL_TAX', reason: 'PT_STATE_NOT_RECORDED' }],
    ]);
    // A rerun on the same snapshot gives the same lines and totals.
    expect(await verified(runId)).toBe(true);
    october = { runId, recordId: p1r.id, employeeId: P3 };
  });

  let october: { runId: string; recordId: string; employeeId: string };

  it('FR-039: the PF, ESIC and professional tax working registers of the October run read the recorded valuations, with totals', async () => {
    const operator = await h.actor(A, 'PAYROLL_OPERATOR');
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_report.read.amount'] });
    // The registers are AVAILABLE while their packs are active; the filing formats and the other outputs are not configured.
    const list = await ok<{ items: { code: string; status: string; reason: string }[] }>(await h.call(operator, 'GET', '/v1/payroll-outputs/statutory-outputs'));
    expect(Object.fromEntries(list.items.map((i) => [i.code, i.status]))).toEqual({
      PF_REGISTER: 'AVAILABLE',
      ESIC_REGISTER: 'AVAILABLE',
      PT_REGISTER: 'AVAILABLE',
      LWF_REGISTER: 'NOT_CONFIGURED',
      FORM_16: 'NOT_CONFIGURED',
      FORM_24Q: 'NOT_CONFIGURED',
      NPS_EXPORT: 'NOT_CONFIGURED',
      EDOC_EXPORT: 'NOT_CONFIGURED',
    });
    expect(await ok(await h.call(operator, 'GET', '/v1/payroll-outputs/statutory-outputs/PF_REGISTER'))).toMatchObject({ status: 'AVAILABLE', format: 'WORKING_REGISTER' });
    const path = (code: string) => `/v1/payroll-outputs/runs/${october.runId}/statutory-registers/${code}`;
    expect((await h.call(hrPlain, 'GET', path('PF_REGISTER'))).statusCode).toBe(403);
    // Form 16 is an output, not a register of a run.
    expect((await h.call(reader, 'GET', path('FORM_16'))).statusCode).toBe(404);
    type Register = { packs: unknown[]; totals: { records: number; amounts: Record<string, string> }; items: { recordId: string; facts: Record<string, unknown>; amounts: Record<string, string | null>; notApplicable: Record<string, string> }[]; next: string | null; format: string };

    // PF: P1 on 10,000; P2, E1 and E2 on the 15,000 ceiling; P3 on 25,000 by option (the October example's figures).
    const pf = await ok<Register>(await h.call(reader, 'GET', path('PF_REGISTER')));
    expect(pf).toMatchObject({ format: 'WORKING_REGISTER', packs: [{ packCode: 'PF', packRevision: 1 }], next: null });
    // T3 and T4 failed and are not in it.
    expect(pf.totals).toEqual({ records: 5, amounts: { employee: '9600.0000', pension: '5833.0000', employerEpf: '3767.0000', edli: '350.0000', adminCharges: '400.0000' } });
    const byRecord = (r: Register) => new Map(r.items.map((i) => [i.recordId, i]));
    const p3 = (await record(h, preparer, october.runId, october.employeeId)).id;
    expect(byRecord(pf).get(p3)).toMatchObject({ facts: { pfWages: '25000.0000', contributionWages: '25000.0000', option: 'HIGHER_WAGES' }, amounts: { employee: '3000.0000', pension: '1250.0000', employerEpf: '1750.0000', edli: '75.0000', adminCharges: '125.0000' } });
    expect(byRecord(pf).get(october.recordId)).toMatchObject({ facts: { pfWages: '10000.0000', option: 'STATUTORY_CEILING' }, amounts: { employee: '1200.0000', pension: '833.0000' } });

    // ESIC: P1 and E1 covered (105 + 158, 455 + 683); P2, P3 and E2 not covered, with the reason and no amount.
    const esic = await ok<Register>(await h.call(reader, 'GET', path('ESIC_REGISTER')));
    expect(esic.totals).toEqual({ records: 5, amounts: { employee: '263.0000', employer: '1138.0000' } });
    expect(esic.items.filter((i) => i.amounts.employee === null).map((i) => i.notApplicable)).toEqual([
      { employee: 'NOT_COVERED', employer: 'NOT_COVERED' },
      { employee: 'NOT_COVERED', employer: 'NOT_COVERED' },
      { employee: 'NOT_COVERED', employer: 'NOT_COVERED' },
    ]);

    // Professional tax: Maharashtra's 200 for each of the five, from the third slab in October; Karnataka was pinned as none active.
    const pt = await ok<Register>(await h.call(reader, 'GET', path('PT_REGISTER')));
    expect(pt.totals).toEqual({ records: 5, amounts: { tax: '1000.0000' } });
    expect(pt.packs).toEqual([
      { packCode: 'PT_KA', packRevision: null },
      { packCode: 'PT_MH', packRevision: 1 },
    ]);
    expect(byRecord(pt).get(october.recordId)).toMatchObject({ packCode: 'PT_MH', facts: { stateCode: 'MH', slab: 3, month: 10 }, amounts: { tax: '200.0000' } });
  });

  it('0220 guards: dated settings are consecutive and append-only; pins and statutory rows are written only by a running calculation', async () => {
    const refused = (sql: string, params: unknown[]) => expect(h.db.query(sql, params)).rejects.toMatchObject({ code: '23514' });
    // P3's option is sequence 1: a gap, a rewrite and a deletion are refused.
    await refused(`insert into employee_pf_option (company_id, employee_id, sequence, effective_from, contribution_basis, reference, created_by) values ($1, $2, 3, '2026-02-01', 'STATUTORY_CEILING', 'Synthetic', $3)`, [
      A.id,
      october.employeeId,
      configA.user,
    ]);
    await expect(h.db.query(`update employee_pf_option set contribution_basis = 'STATUTORY_CEILING' where company_id = $1 and employee_id = $2`, [A.id, october.employeeId])).rejects.toThrow();
    await expect(h.db.query(`delete from location_pt_state where company_id = $1`, [A.id])).rejects.toThrow();
    // The October run is CALCULATED: no pin or statutory row can be added to it any more.
    await refused(`insert into payroll_run_rule_pack (company_id, run_id, pack_code, created_by) values ($1, $2, 'PT_TN', $3)`, [A.id, october.runId, configA.user]);
    const pin = (await h.one<{ id: string }>(`select id from payroll_run_rule_pack where run_id = $1 and pack_code = 'PF'`, [october.runId])).id;
    const head = await h.one<{ id: string; component_id: string }>(
      `select h.id, h.component_id from payroll_head_revision h join pay_component pc on pc.id = h.component_id where h.company_id = $1 and pc.code = 'SP_PF_EE'`,
      [A.id],
    );
    const employee = (await h.one<{ employee_id: string }>(`select employee_id from payroll_record where id = $1`, [october.recordId])).employee_id;
    await refused(
      `insert into payroll_record_statutory (company_id, run_id, record_id, employee_id, component_id, head_revision_id, head_type, rule_pack_code, pin_id, status, amount, workings)
       values ($1, $2, $3, $4, $5, $6, 'DEDUCTION', 'PF_EMPLOYEE', $7, 'VALUED', 1, '{}')`,
      [A.id, october.runId, october.recordId, employee, head.component_id, head.id, pin],
    );
  });

  it("T2: Maharashtra's February amount, 300 on P1's 14,000", async () => {
    const runId = await run('2027-02', p1.dept);
    const r = await record(h, preparer, runId, p1.id);
    expect(statutory(r)).toMatchObject({ SP_PT: '300.0000', SP_PF_EE: '1200.0000', SP_ESI_EE: '105.0000' });
    expect(r.net).toBe('12395.0000');
  });

  it('E3: covered at the start of the October period stays covered after a raise to 22,000; April starts a period uncovered', async () => {
    const dept = await department();
    const id = await employee(dept, mh, ['12000', '3000', '5000']);
    await laterArrangement(h, A, id, '2026-12-01', '22000', [
      { code: 'SP_BASIC', amount: '13000' },
      { code: 'SP_DA', amount: '3000' },
      { code: 'SP_HRA', amount: '6000' },
    ]);
    const december = await record(h, preparer, await run('2026-12', dept), id);
    expect(statutory(december)).toEqual({ SP_ESI_EE: '165.0000', SP_ESI_ER: '715.0000', SP_PF_EE: '1800.0000', SP_PF_EPS: '1250.0000', SP_PF_EPF: '550.0000', SP_PF_EDLI: '75.0000', SP_PF_ADMIN: '75.0000', SP_PT: '200.0000' });
    expect(totals(december)).toEqual({ status: 'CALCULATED', earnings: '22000.0000', deductions: '2165.0000', net: '19835.0000', employerContributions: '2665.0000' });
    const april = await record(h, preparer, await run('2027-04', dept), id);
    expect(Object.keys(statutory(april)).sort()).toEqual(['SP_PF_ADMIN', 'SP_PF_EDLI', 'SP_PF_EE', 'SP_PF_EPF', 'SP_PF_EPS', 'SP_PT']);
    expect(april.net).toBe('20000.0000');
  });

  let settlement: { id: string; employeeId: string; exitCaseId: string };

  it('S1: a settlement values its statutory heads through the same evaluator; employer contributions are cost, never lines', async () => {
    const dept = await department();
    const id = await employee(dept, mh, ['8000', '2000', '4000']);
    await approvedExit(h, A, id, '2026-09-21', '2026-10-15');
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const s = await ok<{ lines: { componentCode: string; amount: string }[]; calculation: { items: Item[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    const items = s.calculation.items.filter((i) => i.kind === 'STATUTORY_DEDUCTION');
    expect(items.map((i) => [i.componentCode, i.status, i.amount, i.basis.employerCost ?? i.basis.reason ?? null])).toEqual([
      ['SP_ESI_EE', 'CALCULATED', '-51.0000', null],
      ['SP_ESI_ER', 'NOT_APPLICABLE', null, '221.0000'],
      ['SP_PF_ADMIN', 'NOT_APPLICABLE', null, '24.0000'],
      ['SP_PF_EDLI', 'NOT_APPLICABLE', null, '24.0000'],
      ['SP_PF_EE', 'CALCULATED', '-581.0000', null],
      ['SP_PF_EPF', 'NOT_APPLICABLE', null, '178.0000'],
      ['SP_PF_EPS', 'NOT_APPLICABLE', null, '403.0000'],
      ['SP_PT', 'NOT_APPLICABLE', null, 'NIL_AMOUNT'],
    ]);
    expect(Object.fromEntries(s.lines.map((l) => [l.componentCode, l.amount]))).toEqual({
      SP_BASIC: '3870.9700',
      SP_DA: '967.7400',
      SP_HRA: '1935.4800',
      SP_ESI_EE: '-51.0000',
      SP_PF_EE: '-581.0000',
    });
    settlement = { id: draft.id, employeeId: id, exitCaseId: exitId };
    // The approval gate evaluates the frozen lines again: nothing statutory blocks while they agree.
    const blockers = await approvalBlockers(h.pool, A.id, { id: settlement.id, employee_id: id, exit_case_id: exitId });
    expect(blockers.filter((b) => b.source === 'STATUTORY')).toEqual([]);
  });

  it('P8a gap 3: a rule-pack head the salary arrangement lists is valued by its active pack in a settlement, never an earnings item', async () => {
    // Basic 8,000 + DA 2,000, and the arrangement also lists the PF employee head (its 999 is not a value, as in payroll). Last day 15
    // October: 3,870.97 + 967.74; PF 12% of 4,838.71 = 580.6452 -> 581. It also lists SP_PF_LISTED, a PF head on a base nobody is paid:
    // it applies only because the arrangement lists it, and is valued on nil wages (NOT_APPLICABLE, NIL_AMOUNT), never skipped.
    await head(h, configA, configB, { code: 'SP_UNPAID_BASE', headType: 'EARNING', basis: 'FIXED', sequence: 50 });
    await head(h, configA, configB, { code: 'SP_PF_LISTED', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYEE', base: ['SP_UNPAID_BASE'], sequence: 51 });
    const dept = await department();
    const id = await person(h, A, hr, { joiningDate: '2026-01-05', departmentId: dept, locationId: mh });
    await salary(h, preparer, id, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '10000',
      components: [
        { code: 'SP_BASIC', amount: '8000' },
        { code: 'SP_DA', amount: '2000' },
        { code: 'SP_PF_EE', amount: '999' },
        { code: 'SP_PF_LISTED', amount: '999' },
      ],
    });
    await approvedExit(h, A, id, '2026-09-21', '2026-10-15');
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const s = await ok<{ lines: { componentCode: string; amount: string }[]; calculation: { items: Item[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(s.calculation.items.filter((i) => i.kind === 'EARNINGS_DUE').map((i) => [i.componentCode, i.status, i.amount])).toEqual([
      ['SP_BASIC', 'CALCULATED', '3870.9700'],
      ['SP_DA', 'CALCULATED', '967.7400'],
    ]);
    expect(s.calculation.items.filter((i) => i.componentCode === 'SP_PF_EE').map((i) => [i.kind, i.status, i.amount])).toEqual([['STATUTORY_DEDUCTION', 'CALCULATED', '-581.0000']]);
    expect(s.calculation.items.filter((i) => i.componentCode === 'SP_PF_LISTED').map((i) => [i.kind, i.status, i.amount, i.basis.reason])).toEqual([
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, 'NIL_AMOUNT'],
    ]);
    expect(s.lines.find((l) => l.componentCode === 'SP_PF_EE')!.amount).toBe('-581.0000');
    expect(s.lines.find((l) => l.componentCode === 'SP_PF_LISTED')).toBeUndefined();
    const blockers = await approvalBlockers(h.pool, A.id, { id: draft.id, employee_id: id, exit_case_id: exitId });
    expect(blockers.filter((b) => (b as { componentCode?: string | null }).componentCode === 'SP_PF_EE')).toEqual([]);
  });

  it('a later PF revision (two people again) changes what the gate expects: STATUTORY_DEDUCTION_MISMATCH until a recalculation', async () => {
    const created = await ok<Pack>(
      await h.call(packV, 'POST', '/v1/statutory-rule-packs', {
        code: 'PF',
        effectiveFrom: '2026-10-01',
        currencyCode: 'INR',
        parameters: { ...(await seeded('PF')).parameters, employeeRatePercent: '10' },
        statuteReference: 'Synthetic revision for the test: employee rate 10%',
      }),
      201,
    );
    // Written by the validator: the activator still differs from both.
    await activate(created.id);
    const blockers = await approvalBlockers(h.pool, A.id, { id: settlement.id, employee_id: settlement.employeeId, exit_case_id: settlement.exitCaseId });
    expect(blockers.filter((b) => b.source === 'STATUTORY')).toEqual([{ source: 'STATUTORY', kind: 'STATUTORY_DEDUCTION', code: 'STATUTORY_DEDUCTION_MISMATCH', componentCode: 'SP_PF_EE', rulePackCode: 'PF_EMPLOYEE' }]);
    const version = (await ok<{ version: number }>(await h.call(prep, 'GET', `/v1/settlements/${settlement.id}`))).version;
    const again = await ok<{ lines: { componentCode: string; amount: string }[] }>(await h.call(prep, 'POST', `/v1/settlements/${settlement.id}/calculate`, { expectedVersion: version }));
    // 10% of 4,838.71 = 483.871 -> 484.
    expect(again.lines.find((l) => l.componentCode === 'SP_PF_EE')!.amount).toBe('-484.0000');
    expect((await approvalBlockers(h.pool, A.id, { id: settlement.id, employee_id: settlement.employeeId, exit_case_id: settlement.exitCaseId })).filter((b) => b.source === 'STATUTORY')).toEqual([]);
  });

  it('an active revision is retired by an activator with a reason; the employees it applied to are blocked again, and a calculated run keeps its values', async () => {
    const pt = (await packs()).find((p) => p.code === 'PT_MH' && p.state === 'ACTIVE')!;
    expect((await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pt.id}/retire`, { expectedVersion: pt.version, reason: 'Synthetic' })).statusCode).toBe(403);
    const retired = await ok<Pack>(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pt.id}/retire`, { expectedVersion: pt.version, reason: 'Synthetic: superseded slabs' }));
    expect(retired.state).toBe('RETIRED');
    expect((await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pt.id}/retire`, { expectedVersion: retired.version, reason: 'Again' })).json().error).toBe('INVALID_STATE');
    const r = await record(h, preparer, await run('2026-11', p1.dept), p1.id);
    expect(r.exceptions.filter((x) => x.severity === 'BLOCKING').map((x) => [x.code, x.detail])).toEqual([
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'SP_PT', rulePackCode: 'PROFESSIONAL_TAX', packCode: 'PT_MH' }],
    ]);
  });

  it('0236: the database checks each pack family’s values as the build reads them, and a pin is a copy of an activated revision in effect', async () => {
    const draft = async (code: string, parameters: unknown) => {
      const revision = (await h.one<{ n: number }>(`select coalesce(max(revision), 0) + 1 as n from statutory_rule_pack where company_id = $1 and code = $2`, [A.id, code])).n;
      return h.db.query(
        `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by)
         values ($1, $2, $3, '2030-01-01', 'INR', $4::jsonb, 'Synthetic revision written directly by the test', 'DRAFT', $5)`,
        [A.id, code, revision, JSON.stringify(parameters), configA.user],
      );
    };
    const refused = (code: string, parameters: unknown, constraint: string) => expect(draft(code, parameters)).rejects.toMatchObject({ code: '23514', constraint });
    const params = async (code: string) => (await seeded(code)).parameters as Record<string, any>;
    const pf = await params('PF');
    const esic = await params('ESIC');
    const mhPt = await params('PT_MH');
    const incomeTax = await params('INCOME_TAX');
    const PF_CHECK = 'statutory_rule_pack_pf_parameters_check';
    await refused('PF', { ...pf, pensionRatePercent: '12.5' }, PF_CHECK); // the pension share is part of the employer's 12
    await refused('PF', { ...pf, edliRatePercent: '100.01' }, PF_CHECK);
    await refused('PF', { ...pf, wageCeiling: 15000 }, PF_CHECK);
    await refused('PF', { ...pf, rounding: 'DOWN' }, PF_CHECK);
    await refused('PF', { ...pf, bonus: '1' }, PF_CHECK);
    const ESIC_CHECK = 'statutory_rule_pack_esic_parameters_check';
    await refused('ESIC', { ...esic, contributionPeriodStartMonths: [10, 4] }, ESIC_CHECK);
    await refused('ESIC', { ...esic, contributionPeriodStartMonths: [4.5] }, ESIC_CHECK);
    await refused('ESIC', { ...esic, contributionPeriodStartMonths: [] }, ESIC_CHECK);
    const PT_CHECK = 'statutory_rule_pack_pt_parameters_check';
    await refused('PT_MH', { ...mhPt, stateCode: 'KA' }, PT_CHECK);
    await refused('PT_MH', { stateCode: 'MH', slabs: [{ upTo: '100.00', amount: '0.00' }] }, PT_CHECK); // the last slab has no upper limit
    await refused('PT_MH', { stateCode: 'MH', slabs: [{ upTo: '9000.00', amount: '0.00' }, { upTo: '8000.00', amount: '1.00' }, { upTo: null, amount: '2.00' }] }, PT_CHECK);
    await refused('PT_MH', { stateCode: 'MH', slabs: [{ upTo: null, amount: '200.00', monthAmounts: { '13': '300.00' } }] }, PT_CHECK);
    await refused('PT_TN', { stateCode: 'TN', slabs: [{ upTo: null, amount: 'two hundred' }] }, PT_CHECK);
    const TAX_CHECK = 'statutory_rule_pack_income_tax_parameters_check';
    await refused('INCOME_TAX', { ...incomeTax, fiscalYear: '2026-28' }, TAX_CHECK);
    await refused('INCOME_TAX', { ...incomeTax, regimes: { NEW: incomeTax.regimes.NEW } }, TAX_CHECK);
    await refused('INCOME_TAX', { ...incomeTax, regimes: { ...incomeTax.regimes, OLD: { ...incomeTax.regimes.OLD, cessPercent: '104' } } }, TAX_CHECK);
    await refused('INCOME_TAX', { ...incomeTax, regimes: { ...incomeTax.regimes, NEW: { ...incomeTax.regimes.NEW, standardDeduction: '75000.005' } } }, TAX_CHECK);
    // On this database every stored row satisfies them, so 0236 validated them all.
    const names = ['payroll_run_rule_pack_pack_fk', ESIC_CHECK, TAX_CHECK, PF_CHECK, PT_CHECK];
    expect((await h.db.query(`select conname::text, convalidated from pg_constraint where conname::text = any ($1::text[]) order by conname`, [names])).rows).toEqual([
      { conname: 'payroll_run_rule_pack_pack_fk', convalidated: true },
      { conname: 'statutory_rule_pack_esic_parameters_check', convalidated: true },
      { conname: 'statutory_rule_pack_income_tax_parameters_check', convalidated: true },
      { conname: 'statutory_rule_pack_pf_parameters_check', convalidated: true },
      { conname: 'statutory_rule_pack_pt_parameters_check', convalidated: true },
    ]);

    // The values the build seeds pass, and pins: a run is put mid-calculation inside a transaction that is rolled back.
    const dept = await department();
    await employee(dept, mh, ['8000', '2000', '4000']);
    const created = await createRun(h, preparer, periods['2026-08']!, { departmentIds: [dept] });
    const pf1 = (await seeded('PF')).revision;
    const pin = (code: string, revision: number, currency: string, parameters: unknown) =>
      h.db.query(`insert into payroll_run_rule_pack (company_id, run_id, pack_code, pack_revision, currency_code, parameters, created_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [
        A.id,
        created.id,
        code,
        revision,
        currency,
        JSON.stringify(parameters),
        preparer.user,
      ]);
    await h.db.query('begin');
    try {
      for (const [code, parameters] of [['PF', pf], ['ESIC', esic], ['PT_MH', mhPt], ['INCOME_TAX', incomeTax]] as const) await draft(code, parameters);
      await h.db.query(
        `update payroll_run r set calculation_started_at = now(), calculated_by = s.calculated_by, attendance_basis = s.attendance_basis, head_count = s.head_count,
                paid_day_policy_id = s.paid_day_policy_id, absent_unpaid_units = s.absent_unpaid_units, half_day_unpaid_units = s.half_day_unpaid_units
           from payroll_run s where r.id = $1 and s.id = $2`,
        [created.id, october.runId],
      );
      const refusedPin = async (code: string, revision: number, currency: string, parameters: unknown) => {
        await h.db.query('savepoint pin');
        await expect(pin(code, revision, currency, parameters)).rejects.toMatchObject({ code: '23514' });
        await h.db.query('rollback to savepoint pin');
      };
      await refusedPin('PF', pf1, 'INR', { ...pf, employeeRatePercent: '11' }); // not the revision's values
      await refusedPin('PF', pf1, 'USD', pf); // not its currency
      await refusedPin('INCOME_TAX', 1, 'INR', incomeTax); // a draft, never activated
      await pin('PF', pf1, 'INR', pf); // an exact copy of the active revision
    } finally {
      await h.db.query('rollback');
    }
  });

  it('a head of the wrong type, a pack in another currency and a pack whose values cannot be read each block, never value', async () => {
    // An employer-contribution head that names the employee's PF output.
    await head(h, configA, configB, { code: 'SP_BAD', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYEE', base: ['SP_BASIC'], sequence: 40 });
    // Revisions written straight to the table (the API refuses both): PF with unreadable values, ESIC in USD, each from 1 September 2026,
    // validated and activated by different people.
    const direct = async (code: string, revision: number, currency: string, parameters: object) => {
      const id = (
        await h.one<{ id: string }>(
          `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by, updated_by)
           values ($1, $2, $3, '2026-09-01', $4, $5::jsonb, 'Synthetic revision written directly by the test', 'DRAFT', $6, $6) returning id`,
          [A.id, code, revision, currency, JSON.stringify(parameters), configA.user],
        )
      ).id;
      await h.db.query(`update statutory_rule_pack set state = 'VALIDATED', validated_by = $2, validated_at = now(), source_reference = 'Synthetic', validation_reference = 'Synthetic' where id = $1`, [id, packV.user]);
      await h.db.query(`update statutory_rule_pack set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [id, packA.user]);
    };
    // 0236: the database refuses unreadable PF values outright, so such a revision can only be one stored before 0236, which the migration
    // leaves NOT VALID. That is simulated: the check is lifted for the write and restored NOT VALID, as 0236 leaves it on such a database.
    await expect(direct('PF', 3, 'INR', { wageCeiling: 'not an amount' })).rejects.toMatchObject({ code: '23514', constraint: 'statutory_rule_pack_pf_parameters_check' });
    await h.db.query(`alter table statutory_rule_pack drop constraint statutory_rule_pack_pf_parameters_check`);
    await direct('PF', 3, 'INR', { wageCeiling: 'not an amount' });
    await h.db.query(`alter table statutory_rule_pack add constraint statutory_rule_pack_pf_parameters_check check (code <> 'PF' or hrms_pf_pack_parameters_ok(parameters)) not valid`);
    await direct('ESIC', 2, 'USD', (await seeded('ESIC')).parameters);
    const r = await record(h, preparer, await run('2026-09', p1.dept), p1.id);
    expect(r.calculationStatus).toBe('FAILED');
    const by = (code: string) =>
      r.exceptions
        .filter((x) => x.code === code)
        .map((x) => x.detail)
        .sort((a, b) => String(a.componentCode).localeCompare(String(b.componentCode)));
    expect(by('RULE_PACK_HEAD_MISMATCH')).toEqual([{ componentCode: 'SP_BAD', rulePackCode: 'PF_EMPLOYEE', expectedHeadType: 'DEDUCTION' }]);
    expect(by('RULE_PACK_CURRENCY_MISMATCH')).toEqual([
      { componentCode: 'SP_ESI_EE', rulePackCode: 'ESIC_EMPLOYEE', packCode: 'ESIC', packCurrency: 'USD' },
      { componentCode: 'SP_ESI_ER', rulePackCode: 'ESIC_EMPLOYER', packCode: 'ESIC', packCurrency: 'USD' },
    ]);
    expect(by('RULE_PACK_INVALID').map((d) => [d.componentCode, d.packCode, d.packRevision])).toEqual([
      ['SP_PF_ADMIN', 'PF', 3],
      ['SP_PF_EDLI', 'PF', 3],
      ['SP_PF_EE', 'PF', 3],
      ['SP_PF_EPF', 'PF', 3],
      ['SP_PF_EPS', 'PF', 3],
    ]);
    expect(r.lines).toEqual([]);
  });
});
