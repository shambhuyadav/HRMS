// ZT01 / ZT39 for work requests (outdoor duty and the like; FR-027): another company's requests, evidence, tasks and lists, by direct
// identifier. Synthetic data only.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';
import { mondayAfter } from '../workflow/leave-tasks.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const KIND = 'outdoor_duty';
const pdf = () => Buffer.from(`%PDF-1.4\n% synthetic travel order ${uniq('e')}\n%%EOF\n`).toString('base64');
const LIST_PERIOD = `from=${mondayAfter(0)}&to=${mondayAfter(400)}`;

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [] })).json().id as string;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
    await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: shift, effectiveFrom: '2026-01-05' });
    if (managerId) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return e;
  };
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version });
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  const boss = await person();
  const claimant = await person(boss.id);
  const manager = await h.actor(company, 'REPORTING_MANAGER', { employeeId: boss.id });
  const self = await h.actor(company, 'EMPLOYEE', { employeeId: claimant.id });

  let weeks = 6;
  const purpose = `Client visit ${uniq('zq')} (synthetic)`;
  const ask = async (extra: Record<string, unknown> = {}) => {
    const day = mondayAfter(7 * ++weeks);
    const res = await h.call(self, 'POST', `/v1/work-requests/${KIND}`, { startDate: day, endDate: day, purpose, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().requestId as string, day };
  };
  const taskOf = async (requestId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from outdoor_duty_request where id = $1`, [requestId])).transaction_id;
    return ((await h.call(manager, 'GET', '/v1/work-requests/tasks/mine')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const version = async (id: string) => (await h.one<{ version: number }>(`select version from outdoor_duty_request where id = $1`, [id])).version;

  const toWithdraw = await ask();
  const returned = await ask();
  const giveBack = await h.call(manager, 'POST', `/v1/work-requests/tasks/${await taskOf(returned.id)}/decision`, { decision: 'RETURN', reason: 'Correct it (synthetic)', idempotencyKey: uniq('iso-wr-') });
  expect(giveBack.statusCode, giveBack.body).toBe(200);
  const toDecide = await ask();
  const document = (await h.call(self, 'POST', `/v1/employees/${claimant.id}/documents`, { documentType: 'GENERAL', fileName: 'travel-order.pdf', contentBase64: pdf() })).json().id as string;
  const withEvidence = await ask({ evidenceDocumentIds: [document] });

  return {
    company,
    actors: { hr, manager, self },
    ids: { claimant: claimant.id, code: claimant.employeeCode, purpose, toWithdraw: toWithdraw.id, returned: returned.id, task: await taskOf(toDecide.id), withEvidence: withEvidence.id, document },
    versions: { returned: await version(returned.id) },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign employee’s work requests', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.claimant}/work-requests` },
  { name: 'GET a foreign request’s evidence file', as: 'self', method: 'GET', path: (w) => `/v1/work-requests/${KIND}/${w.ids.withEvidence}/evidence/${w.ids.document}/content` },
  { name: 'PUT a resubmission of a foreign request', as: 'self', method: 'PUT', path: (w) => `/v1/work-requests/${KIND}/${w.ids.returned}`, body: (w) => ({ startDate: mondayAfter(200), endDate: mondayAfter(200), purpose: 'Isolation check (synthetic)', expectedVersion: w.versions.returned }) },
  { name: 'POST the withdrawal of a foreign request', as: 'self', method: 'POST', path: (w) => `/v1/work-requests/${KIND}/${w.ids.toWithdraw}/withdraw` },
  { name: 'POST a decision on a foreign task', as: 'manager', method: 'POST', path: (w) => `/v1/work-requests/tasks/${w.ids.task}/decision`, body: () => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-wr-') }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('work requests across companies (ZT01; ZT39; FR-027)', () => {
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /work-requests/tasks/mine holds only the company’s own', as: 'manager', path: '/v1/work-requests/tasks/mine', holds: (w) => [w.ids.task!], never: (w) => [w.ids.task!, w.ids.code!, w.ids.purpose!] },
    { name: `GET /work-requests/${KIND} holds only the company’s own`, as: 'hr', path: `/v1/work-requests/${KIND}?${LIST_PERIOD}`, holds: (w) => [w.ids.toWithdraw!], never: (w) => [w.ids.toWithdraw!, w.ids.returned!, w.ids.code!, w.ids.purpose!] },
  ]);
  itRefusesForeignRecords(ctx, [
    ...PROBES,
    { name: 'POST a request citing a foreign document as evidence', as: 'self', method: 'POST', path: () => `/v1/work-requests/${KIND}`, body: (w) => ({ startDate: mondayAfter(300), endDate: mondayAfter(300), purpose: 'Isolation check (synthetic)', evidenceDocumentIds: [w.ids.document] }), refusal: [422, 'INVALID_EVIDENCE'], controlBody: () => ({ startDate: mondayAfter(300), endDate: mondayAfter(300), purpose: 'Isolation check (synthetic)' }), control: 201 },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES.filter((p) => p.as === 'hr' || p.as === 'manager'));
});
