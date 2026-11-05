// ZT01 for report executions and downloads: another company's execution by direct identifier, a user who works in both companies,
// and filters that name another company's records. report-parity.api.test.ts holds "stays in its company" per report. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type IsolationContext, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';
import { csvTable } from './csv.fixtures.js';
import { processReportQueue } from './service.js';

let h: Harness;
let foreign: World;
let home: World;

const generate = async (a: TestActor, reportCode: string, filters: object = {}) => {
  const res = await h.call(a, 'POST', '/v1/reports', { reportCode, filters });
  expect(res.statusCode, res.body).toBe(202);
  await processReportQueue(h.pool);
  return res.json().id as string;
};

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const name = `Isolated ${uniq('person')}`;
  const created = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company, { displayName: name }));
  expect(created.statusCode, created.body).toBe(201);
  const execution = await generate(hr, 'EMPLOYEE_REGISTER');
  return { company, actors: { hr }, ids: { execution, name, employee: created.json().id, code: created.json().employeeCode, dept: company.dept }, versions: {} };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

// These routes need no permission to look (an execution belongs to its requester), so with the other company in the header a stranger's
// call reads as missing there too.
const PROBES: Probe[] = [
  { name: 'GET a foreign execution', as: 'hr', method: 'GET', path: (w) => `/v1/reports/${w.ids.execution}`, headerRefusal: [404, 'NOT_FOUND'] },
  { name: 'GET a foreign execution’s file', as: 'hr', method: 'GET', path: (w) => `/v1/reports/${w.ids.execution}/download`, headerRefusal: [404, 'NOT_FOUND'] },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('report executions across companies (ZT01; FR-065)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES);

  it('a user with an assignment in both companies cannot read an execution across them, in either direction', async () => {
    const shared = await h.actor(foreign.company, 'HR_ADMINISTRATOR');
    const inHome = await h.actor(home.company, 'HR_ADMINISTRATOR', { user: shared.user });
    const own = await generate(shared, 'EMPLOYEE_REGISTER');
    expect((await h.call(shared, 'GET', `/v1/reports/${own}/download`)).statusCode).toBe(200);
    for (const path of [`/v1/reports/${own}`, `/v1/reports/${own}/download`]) {
      const res = await h.call(inHome, 'GET', path);
      expect([res.statusCode, res.json().error], path).toEqual([404, 'NOT_FOUND']);
    }
    const list = (await h.call(inHome, 'GET', '/v1/reports')).json().items as { id: string }[];
    expect(list.map((r) => r.id)).not.toContain(own);
    // The assignment of one company with the other company's header is no access at all, even on the user's own file.
    const replayed = { ...inHome, company: foreign.company };
    expect((await h.call(replayed, 'GET', `/v1/reports/${own}/download`)).statusCode).toBe(403);
  });

  it('an execution’s status (its filters and row count) is read under the assignment that asked for it, like the list and the file (BR-046; ZT05)', async () => {
    const shared = await h.actor(foreign.company, 'HR_ADMINISTRATOR');
    const elsewhere = await h.actor(home.company, 'HR_ADMINISTRATOR', { user: shared.user });
    const sameCompany = await h.actor(foreign.company, 'HR_ADMINISTRATOR', { user: shared.user });
    const own = await generate(shared, 'EMPLOYEE_REGISTER', { search: 'filter value of the request' });
    const status = await h.call(shared, 'GET', `/v1/reports/${own}`);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ id: own, state: 'COMPLETED', filters: { search: 'filter value of the request' } });
    for (const [label, a] of [['another company’s assignment in the header', { ...elsewhere, company: foreign.company }], ['another assignment of the same company', sameCompany]] as const) {
      const res = await h.call(a, 'GET', `/v1/reports/${own}`);
      expect([res.statusCode, res.json().error], label).toEqual([404, 'NOT_FOUND']);
      expect(res.body, label).not.toContain('filter value');
    }
  });

  it('GET /reports holds only the company’s own, and a file holds nothing of another company', async () => {
    const list = await h.call(home.actors.hr!, 'GET', '/v1/reports');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(foreign.ids.execution);
    expect(list.body).toContain(home.ids.execution);
    const file = await h.call(home.actors.hr!, 'GET', `/v1/reports/${home.ids.execution}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain(home.ids.code);
    for (const value of [foreign.ids.code!, foreign.ids.name!]) expect(file.body).not.toContain(value);
  });

  it('filters naming another company’s records select nothing from either company, and queue nothing there', async () => {
    const before = await companyState(h, foreign.company.id);
    const hr = home.actors.hr!;
    const unfiltered = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: { departmentId: foreign.ids.dept } });
    expect(unfiltered.statusCode, unfiltered.body).toBe(202);
    await processReportQueue(h.pool);
    const file = await h.call(hr, 'GET', `/v1/reports/${unfiltered.json().id}/download`);
    expect(file.statusCode, file.body).toBe(200);
    expect(csvTable(file.body).trimEnd().split('\r\n')).toHaveLength(1);
    expect(file.body).not.toContain(foreign.ids.code);
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
  });

  it('the header replay queues nothing in the other company', async () => {
    const queued = async () => (await h.one<{ n: number }>(`select count(*)::int as n from report_execution where company_id = $1`, [foreign.company.id])).n;
    const before = await queued();
    const replayed = { ...home.actors.hr!, company: foreign.company };
    const res = await h.call(replayed, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER' });
    expect([res.statusCode, res.json().error]).toEqual([403, 'FORBIDDEN']);
    expect(await queued()).toBe(before);
  });
});
