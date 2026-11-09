// FR-052 "no component already paid in monthly payroll is paid again in settlement", the payroll side (decided under owner delegation,
// 6 Nov 2026, docs/03 I-80 / I-81): an employee whose final settlement is release-eligible or paid is held out of every monthly run whose
// period covers or follows their last working date, with a named notice (SETTLED_IN_FINAL_SETTLEMENT); a settlement that becomes
// payable after a calculation refuses processing (SETTLEMENT_CHANGED). Synthetic salaries of 31,000 in 31-day May.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
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
  releaseEligibleSettlement,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('lifecycle'))('final settlement and monthly payroll (FR-052, I-80)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let periods: Record<string, string>;
  const team = () => ({ preparer, reviewer, approver });

  /** An employee of their own department on 31,000 from 5 January, leaving on 15 May 2026. */
  const leaver = async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'FS_BASIC', amount: '31000' }] });
    await approvedExit(h, A, id, '2026-04-20', '2026-05-15');
    return { id, dept };
  };
  const calculated = async (month: string, s: { dept: string }) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    return run.id;
  };
  const codes = async (runId: string, e: string) => (await record(h, preparer, runId, e)).exceptions.map((x) => x.code);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'FS_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('a release-eligible final settlement holds the employee out of the period of the last working date and later, with its notice; earlier months pay', async () => {
    const s = await leaver();
    await releaseEligibleSettlement(h, A, s.id, hr);
    const may = await record(h, preparer, await calculated('2026-05', s), s.id);
    expect(may).toMatchObject({ calculationStatus: 'NOT_ELIGIBLE', net: null });
    expect(may.lines).toEqual([]);
    expect(may.exceptions.map((x) => x.code)).toEqual(['SETTLED_IN_FINAL_SETTLEMENT']);
    // A later month never takes the leaver at all: a run's scope leaves out whoever left before its period.
    expect((await ok<{ memberCount: number }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: periods['2026-06'], departmentIds: [s.dept] }))).memberCount).toBe(0);
    // April ends before the last working date: the settlement does not cover it, and payroll pays it in full.
    expect(await record(h, preparer, await calculated('2026-04', s), s.id)).toMatchObject({ calculationStatus: 'CALCULATED', net: '31000.0000' });
  });

  it('without a payable settlement the leaver is paid to the last working date: 31,000 x 15 / 31 = 15,000.00', async () => {
    const s = await leaver();
    const may = await record(h, preparer, await calculated('2026-05', s), s.id);
    expect(may).toMatchObject({ calculationStatus: 'CALCULATED', net: '15000.0000' });
    expect(may.exceptions.map((x) => x.code)).not.toContain('SETTLED_IN_FINAL_SETTLEMENT');
  });

  it('a settlement that becomes payable after the calculation refuses processing; the new revision holds the employee out', async () => {
    const s = await leaver();
    const runId = await calculated('2026-05', s);
    expect((await record(h, preparer, runId, s.id)).net).toBe('15000.0000');
    await submitAndApprove(h, team(), runId);
    await releaseEligibleSettlement(h, A, s.id, hr);
    const refused = await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: (await getRun(h, processor, runId)).version });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'SETTLEMENT_CHANGED', details: { records: 1 } });
    const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/return`, { reason: 'Final settlement became payable (synthetic)', expectedVersion: (await getRun(h, processor, runId)).version }), 201);
    await calculate(h, preparer, next.id);
    expect(await record(h, preparer, next.id, s.id)).toMatchObject({ calculationStatus: 'NOT_ELIGIBLE', net: null });
    await submitAndApprove(h, team(), next.id);
    await processRun(h, processor, next.id);
  });
});
