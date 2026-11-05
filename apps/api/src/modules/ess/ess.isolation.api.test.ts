// ZT39 "unrelated-company/employee negative" over every My ESS tab (FR-103; H1/BR-053): each link the index gives an employee, asked by an
// employee of another company and by a colleague: the link that names the owner's record refuses, and an own-context link answers with
// the caller's own record and nothing of the owner's. ess.api.test.ts holds the tabs themselves; issued outputs are tested by payroll-outputs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { mondayAfter } from '../workflow/leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let B: Company;
let owner: TestActor;
let ownerEmp: string;
let ownerCode: string;
let ownerRequest: string;
let colleague: TestActor;
let stranger: TestActor;
let strangerEmp: string;

type Tab = { id: string; status: string; links: { rel: string; href: string; method?: string }[] };
const tabsOf = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/ess')).json().tabs as Tab[];
const get = (a: TestActor, href: string) => h.call(a, 'GET', href.startsWith('/v1') ? href : `/v1${href}`);

async function employeeIn(company: Company) {
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
  await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
  return { hr, id: e.id, code: e.employeeCode, actor: await h.actor(company, 'EMPLOYEE', { employeeId: e.id }) };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  const a = await employeeIn(A);
  owner = a.actor;
  ownerEmp = a.id;
  ownerCode = a.code;
  colleague = (await employeeIn(A)).actor;
  const b = await employeeIn(B);
  stranger = b.actor;
  strangerEmp = b.id;
  for (const p of (await h.call(a.hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    expect((await h.call(a.hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
  }
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, a.hr.user]);
  const day = mondayAfter(40);
  const asked = await h.call(owner, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day });
  expect(asked.statusCode, asked.body).toBe(201);
  ownerRequest = asked.json().requestId;
});

afterAll(async () => {
  await h?.stop();
});

describe('My ESS across companies and colleagues (ZT39; H1)', () => {
  it('every link of every available tab holds nothing of the owner for an employee of another company or a colleague', async () => {
    const links = [...new Set((await tabsOf(owner)).flatMap((t) => t.links.filter((l) => (l.method ?? 'GET') === 'GET').map((l) => l.href)))];
    // A link to a dated list needs its period: asked with one, so a refusal below is about the record and not the query.
    const hrefs: string[] = [];
    for (const link of links) {
      const plain = await get(owner, link);
      hrefs.push(plain.statusCode === 400 ? `${link}${link.includes('?') ? '&' : '?'}from=2026-01-01&to=2026-12-31` : link);
    }
    // The owner's own index is the positive control: its links are real and at least one of them names the owner's record.
    expect(hrefs.length).toBeGreaterThan(5);
    const naming = hrefs.filter((href) => href.includes(ownerEmp));
    expect(naming.length).toBeGreaterThan(0);
    for (const href of naming) expect((await get(owner, href)).statusCode, href).toBe(200);

    for (const a of [stranger, colleague]) {
      for (const href of hrefs) {
        const res = await get(a, href);
        if (href.includes(ownerEmp)) expect([res.statusCode, JSON.parse(res.body).error], href).toEqual([404, 'NOT_FOUND']);
        for (const value of [ownerEmp, ownerCode, ownerRequest]) expect(res.body.includes(value), `${href}: holds ${value}`).toBe(false);
      }
    }
  });

  it('the index and the own-requests list of an employee of another company are their own', async () => {
    const own = await h.call(owner, 'GET', '/v1/me/requests');
    expect(own.body).toContain(ownerRequest);
    for (const path of ['/v1/me/ess', '/v1/me/requests', '/v1/me/requests?kind=leave_request']) {
      const res = await h.call(stranger, 'GET', path);
      expect(res.statusCode, path).toBe(200);
      for (const value of [ownerEmp, ownerRequest]) expect(res.body.includes(value), path).toBe(false);
    }
    expect((await h.call(stranger, 'GET', '/v1/me/ess')).json().context).toMatchObject({ employeeId: strangerEmp });
  });

  it('the company header cannot move an Employee assignment into another company’s ESS', async () => {
    const replayed = { ...stranger, company: A };
    for (const path of ['/v1/me/ess', '/v1/me/requests', '/v1/me/private-profile', `/v1/employees/${ownerEmp}`]) {
      const res = await h.call(replayed, 'GET', path);
      expect([res.statusCode, res.json().error], path).toEqual([403, 'FORBIDDEN']);
    }
  });
});
