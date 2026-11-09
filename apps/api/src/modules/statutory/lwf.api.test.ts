// FR-039 labour welfare fund (decided under owner delegation, 6 Nov 2026; migration 0237): LWF_EMPLOYEE and LWF_EMPLOYER heads are valued
// from the LWF_<state> pack of the work location's state, two people having validated and activated it, in its contribution months only.
// The Maharashtra draft (to be validated, not legal advice): June and December, 6 / 18 up to 3,000 of monthly wages, 12 / 36 above.
// Worked synthetic examples:
//   June, 20,000 of basic: employee 12, employer 36 (a cost, never in the net); 2,500: 6 and 18.
//   July: not a contribution month, so no line.
//   A Karnataka employee while LWF_KA is a draft, and one at a location with no state: blocked, as every statutory head is.
//   A settlement with last day 15 December: 20,000 x 15 / 31 = 9,677.42 of wages, so 12 deducted and 36 of employer cost.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { HR_SETTLEMENT } from '../lifecycle/lifecycle.fixtures.js';
import { APPROVE, approvedExit, calculate, calendar, CONFIG, createRun, getRun, grants, head, months, ok, person, PREPARE, PROCESS, record, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

interface Pack {
  id: string;
  code: string;
  revision: number;
  version: number;
}

describe.runIf(isModuleActive('payroll') && isModuleActive('lifecycle'))('labour welfare fund (FR-039)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let packV: TestActor;
  let packA: TestActor;
  let periods: Record<string, string>;
  let mh: { id: string; code: string };
  let ka: { id: string; code: string };
  let bare: string;
  let june: { runId: string; dept: string; high: string; low: string };

  const hex = () => Math.random().toString(16).slice(2, 10).toUpperCase();
  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, `D${hex()}`])).id;
  const location = async (stateCode: string | null) => {
    const code = `L${hex()}`;
    const id = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, code])).id;
    if (stateCode) await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: code, effectiveFrom: '2026-01-01', stateCode }), 201);
    return { id, code };
  };
  const staff = async (dept: string, loc: string, basic: string) => {
    const id = await person(h, A, hr, { departmentId: dept, locationId: loc, joiningDate: '2026-01-05' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: basic, components: [{ code: 'LW_BASIC', amount: basic }] });
    return id;
  };
  const calculated = async (month: string, dept: string) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    return run.id;
  };
  const lwf = async (runId: string, employeeId: string) => {
    const r = await record(h, preparer, runId, employeeId);
    return Object.fromEntries(r.lines.filter((l) => l.componentCode.startsWith('LW_LWF')).map((l) => [l.componentCode, l.amount]));
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
    packV = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.validate.operational'] });
    packA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['statutory_pack.activate.operational'] });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'LW_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'LW_LWF_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'LWF_EMPLOYEE', base: ['LW_BASIC'], sequence: 20 });
    await head(h, configA, configB, { code: 'LW_LWF_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'RULE_PACK', rulePackCode: 'LWF_EMPLOYER', base: ['LW_BASIC'], sequence: 30 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    mh = await location('MH');
    ka = await location('KA');
    bare = (await location(null)).id;
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('while the LWF_MH pack is a draft, the heads block the employee with RULE_PACK_NOT_CONFIGURED, naming the pack', async () => {
    const dept = await department();
    const id = await staff(dept, mh.id, '20000');
    const r = await record(h, preparer, await calculated('2026-05', dept), id);
    expect(r.calculationStatus).toBe('FAILED');
    const blocking = r.exceptions.filter((x) => x.severity === 'BLOCKING').sort((a, b) => String(a.detail.componentCode).localeCompare(String(b.detail.componentCode)));
    expect(blocking.map((x) => [x.code, x.detail])).toEqual([
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'LW_LWF_EE', rulePackCode: 'LWF_EMPLOYEE', packCode: 'LWF_MH' }],
      ['RULE_PACK_NOT_CONFIGURED', { componentCode: 'LW_LWF_ER', rulePackCode: 'LWF_EMPLOYER', packCode: 'LWF_MH' }],
    ]);
  });

  it('once two people activate LWF_MH: June 12 and 36 above 3,000 of wages, 6 and 18 below; Karnataka (draft) and no state still block', async () => {
    const pack = ((await ok<{ items: Pack[] }>(await h.call(hr, 'GET', '/v1/statutory-rule-packs'))).items).find((p) => p.code === 'LWF_MH' && p.revision === 1)!;
    const v = await ok<Pack>(await h.call(packV, 'POST', `/v1/statutory-rule-packs/${pack.id}/validate`, { sourceReference: 'Synthetic source', validationReference: 'Synthetic check', expectedVersion: pack.version }));
    await ok(await h.call(packA, 'POST', `/v1/statutory-rule-packs/${pack.id}/activate`, { expectedVersion: v.version }));
    const dept = await department();
    const high = await staff(dept, mh.id, '20000');
    const low = await staff(dept, mh.id, '2500');
    const runId = await calculated('2026-06', dept);
    expect(await lwf(runId, high)).toEqual({ LW_LWF_EE: '12.0000', LW_LWF_ER: '36.0000' });
    expect(await lwf(runId, low)).toEqual({ LW_LWF_EE: '6.0000', LW_LWF_ER: '18.0000' });
    const r = await record(h, preparer, runId, high);
    expect({ deductions: r.deductions, net: r.net, employerContributions: r.employerContributions }).toEqual({ deductions: '12.0000', net: '19988.0000', employerContributions: '36.0000' });
    june = { runId, dept, high, low };

    const other = await department();
    const inKa = await staff(other, ka.id, '20000');
    const noState = await staff(other, bare, '20000');
    const blocked = await calculated('2026-06', other);
    expect((await record(h, preparer, blocked, inKa)).exceptions.map((x) => x.detail).filter((d) => d.componentCode === 'LW_LWF_EE')).toEqual([
      { componentCode: 'LW_LWF_EE', rulePackCode: 'LWF_EMPLOYEE', packCode: 'LWF_KA' },
    ]);
    expect((await record(h, preparer, blocked, noState)).exceptions.map((x) => x.detail).filter((d) => d.componentCode === 'LW_LWF_EE')).toEqual([
      { componentCode: 'LW_LWF_EE', rulePackCode: 'LWF_EMPLOYEE', reason: 'LWF_STATE_NOT_RECORDED' },
    ]);
  });

  it('July is not a contribution month: no line, the reason recorded with the workings', async () => {
    const runId = await calculated('2026-07', june.dept);
    expect(await lwf(runId, june.high)).toEqual({});
    expect((await record(h, preparer, runId, june.high)).net).toBe('20000.0000');
    expect((await record(h, preparer, runId, june.high)).statutory.map((s) => [s.componentCode, s.status, s.workings.reason])).toEqual([
      ['LW_LWF_EE', 'NOT_APPLICABLE', 'NOT_A_CONTRIBUTION_MONTH'],
      ['LW_LWF_ER', 'NOT_APPLICABLE', 'NOT_A_CONTRIBUTION_MONTH'],
    ]);
  });

  it('the LWF working register of June: 18 by employees and 54 by the employer, per employee with the slab', async () => {
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_report.read.amount'] });
    const reg = await ok<{ totals: unknown; packs: unknown; items: { recordId: string; facts: Record<string, unknown>; amounts: Record<string, string | null> }[] }>(
      await h.call(reader, 'GET', `/v1/payroll-outputs/runs/${june.runId}/statutory-registers/LWF_REGISTER`),
    );
    expect(reg.totals).toEqual({ records: 2, amounts: { employee: '18.0000', employer: '54.0000' } });
    expect(reg.packs).toEqual([{ packCode: 'LWF_MH', packRevision: 1 }]);
    const low = (await record(h, preparer, june.runId, june.low)).id;
    expect(reg.items.find((i) => i.recordId === low)).toMatchObject({ facts: { wages: '2500.0000', stateCode: 'MH', slab: 1, month: 6 }, amounts: { employee: '6.0000', employer: '18.0000' } });
    const operator = await h.actor(A, 'PAYROLL_OPERATOR');
    const list = await ok<{ items: { code: string; status: string }[] }>(await h.call(operator, 'GET', '/v1/payroll-outputs/statutory-outputs'));
    expect(list.items.find((i) => i.code === 'LWF_REGISTER')!.status).toBe('AVAILABLE');
  });

  it('a settlement with its last day in December values the fund on what it pays: 12 deducted, 36 of employer cost', async () => {
    const dept = await department();
    const id = await staff(dept, mh.id, '20000');
    await approvedExit(h, A, id, '2026-11-20', '2026-12-15');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const d = await ok<{ calculation: { items: { kind: string; status: string; componentCode: string | null; amount: string | null; basis: Record<string, unknown> }[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(d.calculation.items.filter((i) => i.componentCode?.startsWith('LW_')).map((i) => [i.kind, i.status, i.componentCode, i.amount, i.basis.employerCost ?? null])).toEqual([
      ['EARNINGS_DUE', 'CALCULATED', 'LW_BASIC', '9677.4200', null],
      ['STATUTORY_DEDUCTION', 'CALCULATED', 'LW_LWF_EE', '-12.0000', null],
      ['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', 'LW_LWF_ER', null, '36.0000'],
    ]);
  });

  it('0237: the database checks an LWF revision’s values as the build reads them', async () => {
    const draft = (code: string, parameters: unknown) =>
      h.db.query(
        `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by)
         select $1, $2, coalesce(max(revision), 0) + 1, '2030-01-01', 'INR', $3::jsonb, 'Synthetic revision written directly by the test', 'DRAFT', $4
           from statutory_rule_pack where company_id = $1 and code = $2`,
        [A.id, code, JSON.stringify(parameters), configA.user],
      );
    const refused = (code: string, parameters: unknown) => expect(draft(code, parameters)).rejects.toMatchObject({ code: '23514', constraint: 'statutory_rule_pack_lwf_parameters_check' });
    const good = { stateCode: 'MH', contributionMonths: [6, 12], slabs: [{ upTo: '3000.00', employee: '6.00', employer: '18.00' }, { upTo: null, employee: '12.00', employer: '36.00' }] };
    await refused('LWF_MH', { ...good, stateCode: 'KA' });
    await refused('LWF_MH', { ...good, contributionMonths: [12, 6] });
    await refused('LWF_MH', { ...good, contributionMonths: [6.5] });
    await refused('LWF_MH', { ...good, contributionMonths: [] });
    await refused('LWF_MH', { ...good, slabs: [{ upTo: '3000.00', employee: '6.00', employer: '18.00' }] });
    await refused('LWF_MH', { ...good, slabs: [{ upTo: null, employee: '6.00' }] });
    await refused('LWF_TN', { ...good, stateCode: 'TN', bonus: 1 });
    expect((await h.one<{ v: boolean }>(`select convalidated as v from pg_constraint where conname = 'statutory_rule_pack_lwf_parameters_check'`)).v).toBe(true);
    await h.db.query('begin');
    try {
      await draft('LWF_TN', { ...good, stateCode: 'TN' });
    } finally {
      await h.db.query('rollback');
    }
  });

  it('a work location state recorded after the calculation refuses processing (STATUTORY_CHANGED, lwfStates)', async () => {
    await submitAndApprove(h, { preparer, reviewer, approver }, june.runId);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: mh.code, effectiveFrom: '2026-06-01', stateCode: 'KA' }), 201);
    const res = await h.call(processor, 'POST', `/v1/payroll/runs/${june.runId}/process`, { expectedVersion: (await getRun(h, processor, june.runId)).version });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'STATUTORY_CHANGED', details: { records: { packs: 0, pfOptions: 0, ptStates: 0, lwfStates: 2, taxDeclarations: 0 } } });
  });
});
