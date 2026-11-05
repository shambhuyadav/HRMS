// ZT01 / ZT39 for leave: another company's requests, balances, ledger, tasks, cancellations, evidence, types and policies, by direct
// identifier. leave-policies.api.test.ts holds the no-policy list per company; attendance has its own file. Synthetic data only.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';
import { leaveTasks, mondayAfter } from '../workflow/leave-tasks.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const pdf = () => Buffer.from(`%PDF-1.4\n% synthetic leave evidence ${uniq('e')}\n%%EOF\n`).toString('base64');
const RESUBMITTED_DAY = mondayAfter(300);
const IN_TWO_DAYS = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.upload.document'] });
  const activator = await h.actor(company, 'HR_ADMINISTRATOR');
  const tasks = leaveTasks(h, company, hr);
  await tasks.activatePolicies();
  const bossEmp = await tasks.employee();
  const selfEmp = await tasks.employee(bossEmp);
  const manager = await h.actor(company, 'REPORTING_MANAGER', { employeeId: bossEmp });
  const self = await h.actor(company, 'EMPLOYEE', { employeeId: selfEmp });
  const code = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [selfEmp])).c;

  let weeks = 6;
  const ask = async (extra: Record<string, unknown> = {}) => {
    const day = mondayAfter(7 * ++weeks);
    const res = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day, reason: `Private ${uniq('reason')}`, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().requestId as string, day };
  };
  const taskFor = async (requestId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [requestId])).transaction_id;
    return ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = async (requestId: string, decision: string) => {
    const res = await h.call(manager, 'POST', `/v1/leave/tasks/${await taskFor(requestId)}/decision`, { decision, reason: 'Decided (synthetic)', idempotencyKey: uniq('iso-leave-') });
    expect(res.statusCode, res.body).toBe(200);
  };
  const version = async (requestId: string) => (await h.one<{ version: number }>(`select version from leave_request where id = $1`, [requestId])).version;

  const toWithdraw = await ask();
  const returned = await ask();
  await decide(returned.id, 'RETURN');
  const approved = await ask();
  await decide(approved.id, 'APPROVE');
  const toDecide = await ask();
  const document = (await h.call(self, 'POST', `/v1/employees/${selfEmp}/documents`, { documentType: 'GENERAL', fileName: 'note.pdf', contentBase64: pdf() })).json().id as string;
  const withEvidence = await ask({ evidenceDocumentIds: [document] });

  const typeCode = uniq('T').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
  const type = (await h.call(hr, 'POST', '/v1/leave/types', { code: typeCode, name: `Synthetic ${typeCode}`, paid: false })).json() as { id: string; version: number };
  const draftPolicy = async (over: Record<string, unknown> = {}) => {
    const res = await h.call(hr, 'POST', '/v1/leave/policies', { leaveType: typeCode, effectiveFrom: '2026-01-01', eligibility: 'SYNTHETIC_GROUP', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0, ...over });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number };
  };
  const policyVersion = async (id: string) => (await h.one<{ version: number }>(`select version from leave_policy where id = $1`, [id])).version;
  const permanent = (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = 'PERMANENT'`, [company.id])).id;
  const inForce = await draftPolicy({ effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });
  const inForceMapped = await h.call(hr, 'POST', `/v1/leave/policies/${inForce.id}/mappings`, { expectedVersion: inForce.version, employmentTypeId: permanent });
  expect(inForceMapped.statusCode, inForceMapped.body).toBe(201);
  expect((await h.call(activator, 'POST', `/v1/leave/policies/${inForce.id}/activate`, { expectedVersion: await policyVersion(inForce.id) })).statusCode).toBe(200);
  const draft = await draftPolicy({ effectiveFrom: '2027-01-01' });
  const mapped = await draftPolicy({ effectiveFrom: '2028-01-01' });
  const mapping = await h.call(hr, 'POST', `/v1/leave/policies/${mapped.id}/mappings`, { expectedVersion: mapped.version, employmentTypeId: permanent });
  expect(mapping.statusCode, mapping.body).toBe(201);
  const activate = await draftPolicy({ effectiveFrom: '2029-01-01' });
  expect((await h.call(hr, 'POST', `/v1/leave/policies/${activate.id}/mappings`, { expectedVersion: activate.version, employmentTypeId: permanent })).statusCode).toBe(201);

  return {
    company,
    actors: { hr, activator, manager, self },
    ids: {
      selfEmp,
      code,
      toWithdraw: toWithdraw.id,
      returned: returned.id,
      approved: approved.id,
      toDecide: toDecide.id,
      task: await taskFor(toDecide.id),
      withEvidence: withEvidence.id,
      document,
      type: type.id,
      typeCode,
      draft: draft.id,
      mapped: mapped.id,
      mapping: mapping.json().id as string,
      activate: activate.id,
      inForce: inForce.id,
      permanent,
    },
    versions: {
      returned: await version(returned.id),
      type: type.version,
      draft: await policyVersion(draft.id),
      mapped: await policyVersion(mapped.id),
      activate: await policyVersion(activate.id),
      inForce: await policyVersion(inForce.id),
    },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign employee’s leave requests', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.selfEmp}/leave-requests` },
  { name: 'GET a foreign employee’s leave balances', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.selfEmp}/leave-balances` },
  { name: 'GET a foreign employee’s leave ledger (history)', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.selfEmp}/leave-ledger?from=2026-01-01&to=2030-12-31` },
  { name: 'GET a foreign request’s evidence file', as: 'self', method: 'GET', path: (w) => `/v1/leave/requests/${w.ids.withEvidence}/evidence/${w.ids.document}/content` },
  { name: 'POST the withdrawal of a foreign request', as: 'self', method: 'POST', path: (w) => `/v1/leave/requests/${w.ids.toWithdraw}/withdraw` },
  { name: 'PUT a resubmission of a foreign request', as: 'self', method: 'PUT', path: (w) => `/v1/leave/requests/${w.ids.returned}`, body: (w) => ({ startDate: RESUBMITTED_DAY, endDate: RESUBMITTED_DAY, expectedVersion: w.versions.returned }) },
  { name: 'POST the cancellation of a foreign request', as: 'self', method: 'POST', path: (w) => `/v1/leave/requests/${w.ids.approved}/cancellation`, body: () => ({ reason: 'Isolation check (synthetic)' }), control: 201 },
  { name: 'POST a decision on a foreign task', as: 'manager', method: 'POST', path: (w) => `/v1/leave/tasks/${w.ids.task}/decision`, body: () => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-leave-') }) },
  {
    name: 'POST a balance adjustment for a foreign employee',
    as: 'hr',
    method: 'POST',
    path: () => '/v1/leave/adjustments',
    body: (w) => ({ employeeId: w.ids.selfEmp, leaveType: 'UNPAID', kind: 'ADJUSTMENT', units: '1', effectiveDate: '2026-02-02', reason: 'Isolation check (synthetic)', idempotencyKey: uniq('iso-adjust-') }),
    control: 201,
  },
  { name: 'PATCH a foreign leave type', as: 'hr', method: 'PATCH', path: (w) => `/v1/leave/types/${w.ids.type}`, body: (w) => ({ expectedVersion: w.versions.type, name: 'Renamed by another company' }) },
  { name: 'PATCH a foreign draft policy', as: 'hr', method: 'PATCH', path: (w) => `/v1/leave/policies/${w.ids.draft}`, body: (w) => ({ expectedVersion: w.versions.draft, minServiceDays: 7 }) },
  { name: 'POST a mapping onto a foreign policy', as: 'hr', method: 'POST', path: (w) => `/v1/leave/policies/${w.ids.draft}/mappings`, body: (w) => ({ expectedVersion: w.versions.draft! + (w === home ? 1 : 0), employmentTypeId: w.ids.permanent }), control: 201 },
  { name: 'POST the removal of a foreign mapping', as: 'hr', method: 'POST', path: (w) => `/v1/leave/policies/${w.ids.mapped}/mappings/${w.ids.mapping}/remove`, body: (w) => ({ expectedVersion: w.versions.mapped }) },
  { name: 'POST the activation of a foreign policy', as: 'activator', method: 'POST', path: (w) => `/v1/leave/policies/${w.ids.activate}/activate`, body: (w) => ({ expectedVersion: w.versions.activate }) },
  { name: 'POST the retirement of a foreign policy', as: 'activator', method: 'POST', path: (w) => `/v1/leave/policies/${w.ids.inForce}/retire`, body: (w) => ({ expectedVersion: w.versions.inForce, effectiveTo: IN_TWO_DAYS, reason: 'Isolation check (synthetic)' }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('leave across companies (ZT01; ZT39)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /leave/tasks holds no task of another company', as: 'manager', path: '/v1/leave/tasks', never: (w) => [w.ids.task, w.ids.selfEmp, w.ids.code] },
    { name: 'GET /leave/types holds only the company’s own', as: 'hr', path: '/v1/leave/types', holds: (w) => [w.ids.typeCode], never: (w) => [w.ids.type, w.ids.typeCode] },
    { name: 'GET /leave/policies holds only the company’s own', as: 'hr', path: '/v1/leave/policies', holds: (w) => [w.ids.typeCode], never: (w) => [w.ids.draft, w.ids.mapped, w.ids.typeCode] },
    { name: 'GET /leave/policy-options holds only the company’s own', as: 'hr', path: '/v1/leave/policy-options', holds: (w) => [w.ids.permanent], never: (w) => [w.ids.permanent, w.ids.type] },
    { name: 'GET the employees without a policy holds only the company’s own', as: 'hr', path: '/v1/leave/accruals/employees-without-policy?month=2026-03', never: (w) => [w.ids.selfEmp, w.ids.code] },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES.filter((p) => p.as !== 'self' && p.as !== 'manager'));
});
