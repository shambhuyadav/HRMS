// P8a gap 2 (decided under owner delegation, 6 Nov 2026): processing refuses with STATUTORY_CHANGED when what the statutory evaluation
// read no longer holds: the pack revision in effect, an employee's PF option, a work location's professional tax state, or an accepted
// tax declaration. This is the same as MASTERS_CHANGED for the employee masters (docs/10 A2). Nothing is frozen, and the run is returned
// for a new revision. Values are compared, not timestamps, so a change that does not touch the calculated records refuses nothing.
// The packs are the seeded drafts, validated by one person and activated by another in this fixture only (not a legal validation).
// Synthetic employees and amounts only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { APPROVE, calculate, calendar, CONFIG, createRun, getRun, grants, head, months, ok, person, PREPARE, PROCESS, processRun, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';

interface Pack {
  id: string;
  code: string;
  revision: number;
  state: string;
  version: number;
  parameters: Record<string, unknown>;
}

describe.runIf(isModuleActive('payroll') && isModuleActive('tax-declarations'))('statutory facts changed after the calculation (P8a gap 2)', () => {
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
  let taxReviewer: TestActor;
  let periods: Record<string, string>;
  let mh: { id: string; code: string };
  const team = () => ({ preparer, reviewer, approver });

  const hex = () => Math.random().toString(16).slice(2, 10).toUpperCase();
  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, `D${hex()}`])).id;
  const location = async (stateCode: string) => {
    const code = `L${hex()}`;
    const id = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, code])).id;
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: code, effectiveFrom: '2026-01-01', stateCode }), 201);
    return { id, code };
  };
  /** Basic 20,000 a month: PF, professional tax and TDS heads all apply. */
  const paid = async (dept: string, loc: string) => {
    const e = await person(h, A, hr, { departmentId: dept, locationId: loc, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '20000', components: [{ code: 'SC_BASIC', amount: '20000' }] });
    return e;
  };
  /** A run of one department, calculated and independently approved: ready to process. */
  const approvedRun = async (month: string, dept: string) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    expect((await calculate(h, preparer, run.id)).state).toBe('CALCULATED');
    await submitAndApprove(h, team(), run.id);
    return run.id;
  };
  const process = async (runId: string) => h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: (await getRun(h, processor, runId)).version });
  const nothing = { packs: 0, pfOptions: 0, ptStates: 0, taxDeclarations: 0 };
  /** STATUTORY_CHANGED with the given counts, the run still approved and nothing frozen. */
  const refused = async (runId: string, records: Partial<typeof nothing>) => {
    const res = await process(runId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'STATUTORY_CHANGED', details: { records: { ...nothing, ...records } } });
    const after = await h.one<{ state: string; processing_started_at: string | null; frozen: number }>(
      `select r.state, r.processing_started_at, (select count(*)::int from payroll_record rec where rec.run_id = r.id and rec.frozen_at is not null) as frozen from payroll_run r where r.id = $1`,
      [runId],
    );
    expect(after).toEqual({ state: 'APPROVED', processing_started_at: null, frozen: 0 });
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
    taxReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax', 'tax_declaration.review.tax'] });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'tax_declaration', [taxReviewer]);
    await head(h, configA, configB, { code: 'SC_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'SC_PF_EE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF_EMPLOYEE', base: ['SC_BASIC'], sequence: 20 });
    await head(h, configA, configB, { code: 'SC_PT', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PROFESSIONAL_TAX', base: ['SC_BASIC'], sequence: 21 });
    await head(h, configA, configB, { code: 'SC_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['SC_BASIC'], sequence: 22 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    for (const code of ['PF', 'PT_MH', 'PT_KA', 'INCOME_TAX']) expect((await activate((await seeded(code)).id)).state).toBe('ACTIVE');
    // The FY 2026-27 declaration pack (0225), activated by someone other than its author.
    const taxPack = await h.one<{ id: string; version: number }>(`select id, version from tax_rule_pack where company_id = $1 and code = 'INCOME_TAX_2026_27'`, [A.id]);
    await ok(await h.call(configB, 'POST', `/v1/payroll/tax-rule-packs/${taxPack.id}/activate`, { expectedVersion: taxPack.version }));
    mh = await location('MH');
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('a PF option recorded after the calculation refuses processing', async () => {
    const dept = await department();
    const e = await paid(dept, mh.id);
    const runId = await approvedRun('2026-05', dept);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pf-options', { employeeId: e, effectiveFrom: '2026-01-05', contributionBasis: 'HIGHER_WAGES', reference: 'Synthetic joint option' }), 201);
    await refused(runId, { pfOptions: 1 });
  });

  it('a professional tax state recorded for the work location after the calculation refuses processing', async () => {
    const dept = await department();
    const site = await location('MH');
    await paid(dept, site.id);
    const runId = await approvedRun('2026-06', dept);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: site.code, effectiveFrom: '2026-06-01', stateCode: 'KA' }), 201);
    await refused(runId, { ptStates: 1 });
  });

  it('a tax declaration accepted after the calculation refuses processing (the regime and deductions TDS used no longer hold)', async () => {
    const dept = await department();
    const e = await paid(dept, mh.id);
    const runId = await approvedRun('2026-07', dept);
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    const d = await ok<{ id: string; version: number }>(
      await h.call(employee, 'POST', '/v1/me/tax-declarations', { fiscalPeriodCode: '2026-27', regimeCode: 'OLD', lines: [{ categoryCode: 'SEC_80C', amount: '150000.00' }] }),
      201,
    );
    await ok(await h.call(employee, 'POST', `/v1/me/tax-declarations/${d.id}/submit`, { expectedVersion: d.version }));
    const task = ((await h.call(taxReviewer, 'GET', '/v1/tax-declarations/tasks/mine')).json().items as { taskId: string; declaration: { id: string } }[]).find((t) => t.declaration.id === d.id)!;
    await ok(await h.call(taxReviewer, 'POST', `/v1/tax-declaration-tasks/${task.taskId}/decision`, { decision: 'ACCEPT', idempotencyKey: `tax-${randomUUID()}` }));
    await refused(runId, { taxDeclarations: 1 });
  });

  it('a change that does not touch the calculated records refuses nothing', async () => {
    const dept = await department();
    const e = await paid(dept, mh.id);
    const someoneElse = await paid(await department(), mh.id);
    const elsewhere = await location('MH');
    const runId = await approvedRun('2026-08', dept);
    // Another employee's option, another location's state, and this employee's option from a later month.
    await ok(await h.call(configA, 'POST', '/v1/statutory/pf-options', { employeeId: someoneElse, effectiveFrom: '2026-01-05', contributionBasis: 'HIGHER_WAGES', reference: 'Synthetic' }), 201);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pt-states', { locationCode: elsewhere.code, effectiveFrom: '2026-02-01', stateCode: 'KA' }), 201);
    await ok(await h.call(configA, 'POST', '/v1/statutory/pf-options', { employeeId: e, effectiveFrom: '2026-09-01', contributionBasis: 'HIGHER_WAGES', reference: 'Synthetic' }), 201);
    expect(await processRun(h, processor, runId)).toMatchObject({ state: 'PROCESSED_LOCKED' });
  });

  it('a PF revision activated after the calculation refuses processing; returned, the new revision is valued under it', async () => {
    const dept = await department();
    const e = await paid(dept, mh.id);
    const runId = await approvedRun('2026-09', dept);
    const created = await ok<Pack>(
      await h.call(packV, 'POST', '/v1/statutory-rule-packs', {
        code: 'PF',
        effectiveFrom: '2026-09-01',
        currencyCode: 'INR',
        parameters: { ...(await seeded('PF')).parameters, employeeRatePercent: '10' },
        statuteReference: 'Synthetic revision for the test: employee rate 10%',
      }),
      201,
    );
    await activate(created.id);
    await refused(runId, { packs: 1 });
    const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/return`, { reason: 'PF revision activated (synthetic)', expectedVersion: (await getRun(h, processor, runId)).version }), 201);
    expect((await calculate(h, preparer, next.id)).state).toBe('CALCULATED');
    await submitAndApprove(h, team(), next.id);
    expect(await processRun(h, processor, next.id)).toMatchObject({ state: 'PROCESSED_LOCKED' });
    // 10% of 15,000 (the wage ceiling): 1,500.
    const pf = await h.one<{ amount: string; revision: number }>(
      `select s.amount::text, (s.workings ->> 'packRevision')::int as revision from payroll_record_statutory s join payroll_record r on r.id = s.record_id
        where r.run_id = $1 and r.employee_id = $2 and s.rule_pack_code = 'PF_EMPLOYEE'`,
      [next.id, e],
    );
    expect(pf).toEqual({ amount: '1500.0000', revision: created.revision });
  });
});
