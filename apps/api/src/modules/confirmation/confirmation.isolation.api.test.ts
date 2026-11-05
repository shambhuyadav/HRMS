// ZT01 / ZT22 for confirmation: another company's cases, recommendations, decisions and lists, by direct identifier (the company B of
// confirmation.api.test.ts is about the attention list, and closure.api.test.ts holds the cancellation). Synthetic data only.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const hr2 = await h.actor(company, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true), ($1, 'employee_confirmation', $3, 2, true)`, [company.id, hr.user, hr2.user]);
  const bossEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json().id as string;
  await h.setStatus(company, bossEmp, 'ACTIVE_CONFIRMED');
  const manager = await h.actor(company, 'REPORTING_MANAGER', { employeeId: bossEmp });
  const probationer = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string; joiningDate: string };
    await h.setStatus(company, e.id, 'ACTIVE_PROBATION');
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: bossEmp, effectiveFrom: e.joiningDate })).statusCode).toBe(200);
    return e;
  };
  const openCase = async (id: string) => {
    const res = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: id });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().caseId as string;
  };
  const version = async (id: string) => (await h.one<{ version: number }>(`select version from employee_confirmation where id = $1`, [id])).version;
  const unopened = await probationer();
  const viewed = await probationer();
  const viewedCase = await openCase(viewed.id);
  const toRecommend = await openCase((await probationer()).id);
  const toCancel = await openCase((await probationer()).id);
  const decidedEmp = await probationer();
  const toDecide = await openCase(decidedEmp.id);
  const recommended = await h.call(manager, 'POST', `/v1/confirmations/${toDecide}/recommendation`, { expectedVersion: await version(toDecide), recommendation: 'CONFIRM', effectiveDate: '2026-06-01', reason: 'Manager review (synthetic)' });
  expect(recommended.statusCode, recommended.body).toBe(200);
  const task = ((await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === decidedEmp.id);
  return {
    company,
    actors: { hr, manager },
    ids: { unopened: unopened.id, unopenedCode: unopened.employeeCode, viewed: viewed.id, viewedCode: viewed.employeeCode, viewedCase, toRecommend, toCancel, toDecide, task: task!.taskId },
    versions: { toRecommend: await version(toRecommend), toCancel: await version(toCancel) },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign case', as: 'hr', method: 'GET', path: (w) => `/v1/confirmations/${w.ids.viewedCase}` },
  { name: 'POST a case for a foreign employee', as: 'hr', method: 'POST', path: () => '/v1/confirmations', body: (w) => ({ employeeId: w.ids.unopened }), control: 201 },
  { name: 'POST a recommendation on a foreign case', as: 'manager', method: 'POST', path: (w) => `/v1/confirmations/${w.ids.toRecommend}/recommendation`, body: (w) => ({ expectedVersion: w.versions.toRecommend, recommendation: 'CONFIRM', effectiveDate: '2026-06-01', reason: 'Isolation check (synthetic)' }) },
  { name: 'POST the cancellation of a foreign case', as: 'hr', method: 'POST', path: (w) => `/v1/confirmations/${w.ids.toCancel}/cancel`, body: (w) => ({ expectedVersion: w.versions.toCancel, reason: 'Isolation check (synthetic)' }) },
  { name: 'POST a decision on a foreign task', as: 'hr', method: 'POST', path: (w) => `/v1/confirmations/tasks/${w.ids.task}/decision`, body: () => ({ decision: 'APPROVE', reason: 'Isolation check (synthetic)', idempotencyKey: uniq('iso-conf-') }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('confirmation across companies (ZT01; ZT22)', () => {
  itListsOnlyOwnRecords(ctx, [
    {
      name: 'GET /confirmations holds only the company’s own, in its total too',
      as: 'hr',
      path: '/v1/confirmations?view=ALL',
      holds: (w) => [w.ids.viewedCode!],
      never: (w) => [w.ids.viewedCase!, w.ids.viewedCode!, w.ids.unopenedCode!],
      total: async (harness, w) => (await harness.one<{ n: number }>(`select count(*)::int as n from employee_confirmation where company_id = $1`, [w.company.id])).n,
    },
    { name: 'GET /confirmations/attention holds only the company’s own', as: 'hr', path: '/v1/confirmations/attention', holds: (w) => [w.ids.unopenedCode!], never: (w) => [w.ids.unopened!, w.ids.unopenedCode!] },
    { name: 'GET /confirmations/tasks/mine holds only the company’s own', as: 'hr', path: '/v1/confirmations/tasks/mine', holds: (w) => [w.ids.task!], never: (w) => [w.ids.task!] },
  ]);
  itRefusesForeignRecords(ctx, PROBES);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES.filter((p) => p.as === 'hr'));
});
