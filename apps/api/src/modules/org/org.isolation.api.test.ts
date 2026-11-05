// ZT01 for org masters and the company record: another company's masters by direct identifier, and a master of another company named on
// an employee. master-periods.api.test.ts holds the composite foreign keys at the database (B1, ZT06). Synthetic data only.
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
  const admin = await h.actor(company, 'SYSTEM_ADMINISTRATOR');
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const created: Record<string, string> = {};
  const versions: Record<string, number> = {};
  for (const kind of ['departments', 'locations', 'designations', 'grades']) {
    const code = uniq('ISO').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const res = await h.call(admin, 'POST', `/v1/org/${kind}`, { code, name: `Isolated ${code}` });
    expect(res.statusCode, `${kind}: ${res.body}`).toBe(201);
    created[kind] = res.json().id;
    created[`${kind}Code`] = code;
    versions[kind] = res.json().version;
  }
  const name = (await h.one<{ name: string }>(`select name from company where id = $1`, [company.id])).name;
  return { company, actors: { admin, hr }, ids: { ...created, companyName: name, companyId: company.id }, versions };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = ['departments', 'locations', 'designations', 'grades'].map((kind) => ({
  name: `PATCH a foreign ${kind.slice(0, -1)}`,
  as: 'admin',
  method: 'PATCH',
  path: (w: World) => `/v1/org/${kind}/${w.ids[kind]}`,
  body: (w: World) => ({ expectedVersion: w.versions[kind], name: 'Renamed by another company' }),
}));

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('org masters across companies (ZT01; B1)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itListsOnlyOwnRecords(
    ctx,
    ['departments', 'locations', 'designations', 'grades'].map((kind) => ({
      name: `GET /org/${kind} holds only the company’s own`,
      as: 'hr',
      path: `/v1/org/${kind}`,
      holds: (w: World) => [w.ids[kind]!],
      never: (w: World) => [w.ids[kind]!, w.ids[`${kind}Code`]!],
    })),
  );
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES);

  it('GET /org/company answers the header’s company only under an assignment there', async () => {
    const res = await h.call(home.actors.admin!, 'GET', '/v1/org/company');
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(home.company.id);
    expect(res.body).not.toContain(foreign.company.id);
    const replayed = { ...home.actors.admin!, company: foreign.company };
    const refused = await h.call(replayed, 'GET', '/v1/org/company');
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'FORBIDDEN']);
    expect(refused.body).not.toContain(foreign.ids.companyName);
  });

  it('PATCH /org/company changes the caller’s own company, never the one in another assignment’s header', async () => {
    const before = await companyState(h, foreign.company.id);
    const replayed = { ...home.actors.admin!, company: foreign.company };
    const current = (await h.call(home.actors.admin!, 'GET', '/v1/org/company')).json() as { version: number };
    const refused = await h.call(replayed, 'PATCH', '/v1/org/company', { expectedVersion: current.version, name: 'Taken over' });
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'FORBIDDEN']);
    expect(changedTables(before, await companyState(h, foreign.company.id)).filter((t) => t !== 'audit_event')).toEqual([]);
  });

  it('a master of another company cannot be named on an employee, and the refusal is the same as for one that does not exist', async () => {
    const hr = home.actors.hr!;
    const before = await companyState(h, foreign.company.id);
    const employees = async () => (await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1`, [home.company.id])).n;
    const count = await employees();
    for (const field of ['departmentId', 'locationId', 'designationId'] as const) {
      const kind = { departmentId: 'departments', locationId: 'locations', designationId: 'designations' }[field];
      const inForeign = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(home.company, { [field]: foreign.ids[kind] }));
      const nowhere = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(home.company, { [field]: '00000000-0000-4000-8000-000000000009' }));
      expect([inForeign.statusCode, inForeign.json().error], field).toEqual([nowhere.statusCode, nowhere.json().error]);
      expect(inForeign.statusCode, `${field}: ${inForeign.body}`).toBe(422);
    }
    expect(await employees()).toBe(count);
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
  });
});
