// ZT01 / ZT23 for notifications: read marks and inboxes across companies, under a user who works in both; the inbox routes need no
// assignment (config.assignmentOptional), so the company in the header is all that separates them. delivery-log.api.test.ts holds the
// delivery log per company. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from './dispatcher.js';

let h: Harness;
let A: Company;
let B: Company;
let inA: TestActor; // one user, with an assignment in each company
let inB: TestActor;
let strangerInB: TestActor;
let noticeInA: string;
let noticeInB: string;

/** An inbox call without an assignment: only the bearer token and the company header. */
const inboxCall = (a: TestActor, company: Company, method: 'GET' | 'POST', url: string) =>
  h.app.inject({ method, url, headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: company.id } });

async function noticeFor(company: Company, recipient: string) {
  // A real notification by the real path: a leave request routed to this reviewer, delivered by the dispatcher.
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true) on conflict do nothing`, [company.id, recipient]);
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number; state: string }[]) {
    if (p.state === 'DRAFT') expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
  }
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string };
  await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
  const self = await h.actor(company, 'EMPLOYEE', { employeeId: e.id });
  const day = new Date(Date.now() + 50 * 86_400_000);
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  const iso = day.toISOString().slice(0, 10);
  expect((await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: iso, endDate: iso })).statusCode).toBe(201);
  await dispatchOutbox(h.pool);
  return (await h.one<{ id: string }>(`select id from notification where company_id = $1 and recipient_user_id = $2 and state = 'DELIVERED' order by occurred_at desc limit 1`, [company.id, recipient])).id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  inA = await h.actor(A, 'HR_ADMINISTRATOR');
  inB = await h.actor(B, 'HR_ADMINISTRATOR', { user: inA.user });
  strangerInB = await h.actor(B, 'HR_ADMINISTRATOR');
  noticeInA = await noticeFor(A, inA.user);
  noticeInB = await noticeFor(B, inA.user);
});

afterAll(async () => {
  await h?.stop();
});

describe('inboxes across companies (ZT01; ZT23; DF12)', () => {
  it('a user who works in both companies sees each company’s notices only under that company', async () => {
    const shown = async (company: Company) => ((await inboxCall(inA, company, 'GET', '/v1/me/notifications')).json() as { items: { id: string }[] }).items.map((n) => n.id);
    expect(await shown(A)).toEqual([noticeInA]);
    expect(await shown(B)).toEqual([noticeInB]);
    const counted = async (company: Company) => (await inboxCall(inA, company, 'GET', '/v1/me/notifications')).json().unread as number;
    expect(await counted(A)).toBe(1);
    expect(await counted(B)).toBe(1);
  });

  it('a read mark under one company’s header cannot reach the other company’s notice, and looks like a notice that does not exist', async () => {
    const before = await companyState(h, A.id);
    const refused = await inboxCall(inA, B, 'POST', `/v1/me/notifications/${noticeInA}/read`);
    expect([refused.statusCode, refused.json().error]).toEqual([404, 'NOT_FOUND']);
    const absent = await inboxCall(inA, B, 'POST', '/v1/me/notifications/00000000-0000-4000-8000-000000000009/read');
    expect([absent.statusCode, absent.json()]).toEqual([refused.statusCode, refused.json()]);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect((await h.one<{ read_at: string | null }>(`select read_at from notification where id = $1`, [noticeInA])).read_at).toBeNull();
    // Positive control: the same call under its own company marks it.
    const own = await inboxCall(inA, A, 'POST', `/v1/me/notifications/${noticeInA}/read`);
    expect(own.statusCode, own.body).toBe(200);
    expect((await h.one<{ read_at: string | null }>(`select read_at from notification where id = $1`, [noticeInA])).read_at).not.toBeNull();
  });

  it('a stranger cannot mark another company’s notice, or a colleague’s, by its identifier', async () => {
    const before = await companyState(h, A.id);
    for (const company of [A, B]) {
      for (const id of [noticeInA, noticeInB]) {
        const res = await inboxCall(strangerInB, company, 'POST', `/v1/me/notifications/${id}/read`);
        expect([res.statusCode, res.json().error], `${company.id}:${id}`).toEqual([404, 'NOT_FOUND']);
      }
    }
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect((await inboxCall(strangerInB, A, 'GET', '/v1/me/notifications')).json().items).toEqual([]);
  });

  it('preferences are the company’s: one saved under B is not read or changed under A', async () => {
    const before = await companyState(h, A.id);
    const shown = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notification-preferences')).json().items as { eventType: string; receiveOptional: boolean }[];
    const eventType = (await shown(inB))[0]!.eventType;
    const save = await h.call(inB, 'PUT', '/v1/me/notification-preferences', { eventType, receiveOptional: false });
    expect(save.statusCode, save.body).toBe(200);
    expect((await shown(inB)).find((p) => p.eventType === eventType)!.receiveOptional).toBe(false);
    expect((await shown(inA)).find((p) => p.eventType === eventType)!.receiveOptional).toBe(true);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
  });

  it('the assignment header cannot carry a company B assignment into company A’s inbox', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me/notifications', headers: { authorization: `Bearer ${strangerInB.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: strangerInB.assignment } });
    // Not an error: the inbox is the caller's own in that company, and a stranger has none there.
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.body).not.toContain(noticeInA);
  });
});
