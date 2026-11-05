// ZT01 for mobile-app links (FR-023): another company's links and employees, by direct identifier. Synthetic references only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const reviewer = await h.actor(company, 'HR_ADMINISTRATOR');
  const person = async () => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json().id as string;
  const pendingEmp = await person();
  const activeEmp = await person();
  const request = async (employeeId: string) => {
    const ref = uniq('app-user-');
    const res = await h.call(hr, 'POST', '/v1/mobile-links', { employeeId, appAccountRef: ref });
    expect(res.statusCode, res.body).toBe(201);
    return { id: res.json().id as string, ref };
  };
  const pending = await request(pendingEmp);
  const active = await request(activeEmp);
  const approved = await h.call(reviewer, 'POST', `/v1/mobile-links/${active.id}/decision`, { expectedVersion: 1, decision: 'APPROVE' });
  expect(approved.json(), approved.body).toMatchObject({ state: 'ACTIVE' });
  const version = async (id: string) => (await h.one<{ version: number }>(`select version from mobile_app_link where id = $1`, [id])).version;
  return {
    company,
    actors: { hr, reviewer },
    ids: { pendingEmp, activeEmp, pending: pending.id, active: active.id, pendingRef: pending.ref, activeRef: active.ref },
    versions: { pending: await version(pending.id), active: await version(active.id) },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign employee’s links', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.activeEmp}/mobile-links` },
  { name: 'POST a link request for a foreign employee', as: 'hr', method: 'POST', path: () => '/v1/mobile-links', body: (w) => ({ employeeId: w.ids.pendingEmp, appAccountRef: 'isolation-ref' }), control: 409 },
  { name: 'POST a decision on a foreign link', as: 'reviewer', method: 'POST', path: (w) => `/v1/mobile-links/${w.ids.pending}/decision`, body: (w) => ({ expectedVersion: w.versions.pending, decision: 'APPROVE' }) },
  { name: 'POST a revocation of a foreign link', as: 'reviewer', method: 'POST', path: (w) => `/v1/mobile-links/${w.ids.active}/revoke`, body: (w) => ({ expectedVersion: w.versions.active, reason: 'Isolation check (synthetic)' }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('mobile links across companies (ZT01; FR-023)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /mobile-links shows only the company’s own', as: 'reviewer', path: '/v1/mobile-links', holds: (w) => [w.ids.activeRef] },
    { name: 'GET /mobile-links?state=ACTIVE shows only the company’s own', as: 'reviewer', path: '/v1/mobile-links?state=ACTIVE' },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES);

  it('an app account linked in another company gets no answer about it, and stays linked there', async () => {
    const fresh = (await h.call(home.actors.hr!, 'POST', '/v1/employees', h.newEmployeeBody(home.company))).json().id as string;
    const before = await companyState(h, foreign.company.id);
    // A reference taken elsewhere is free here: refusing it would tell one company what another company's accounts are.
    const res = await h.call(home.actors.hr!, 'POST', '/v1/mobile-links', { employeeId: fresh, appAccountRef: foreign.ids.activeRef });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'PENDING', replacesLinkId: null });
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
  });
});
