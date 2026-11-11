// Company events and ticker messages (coverage CL-021 "Event planner", CL-022 "Ticker message", under FR-001 and FR-096; 0290):
// HR keeps them, every change audited, nothing deleted; each person's dashboard feed holds the messages running today and the
// upcoming events for everyone or for their own department or location, nothing else. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let engineer: TestActor;
let financier: TestActor;
let admin: TestActor;
let today: string;
let otherLoc: string;

const plus = async (days: number) => (await h.one<{ d: string }>(`select to_char($1::date + $2::int, 'YYYY-MM-DD') as d`, [today, days])).d;
const feed = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/announcements/feed');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { asOf: string; messages: { message: string }[]; events: { name: string; for: string | null }[] };
};
const event = async (body: Record<string, unknown>) => {
  const res = await h.call(hr, 'POST', '/v1/company-events', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number; name: string };
};
const ticker = async (body: Record<string, unknown>) => {
  const res = await h.call(hr, 'POST', '/v1/ticker-messages', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; version: number };
};
async function employeeIn(departmentId: string, locationId: string) {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId, locationId }));
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  otherLoc = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'BR', 'Branch', true) returning id`, [A.id])).id;
  engineer = await h.actor(A, 'EMPLOYEE', { employeeId: await employeeIn(A.dept, A.loc) });
  financier = await h.actor(A, 'EMPLOYEE', { employeeId: await employeeIn(A.financeDept, otherLoc) });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('company events and ticker messages (CL-021, CL-022)', () => {
  it('FR-096 each person sees the running messages and the upcoming events for everyone or for their own department or location', async () => {
    await event({ name: 'Annual day', eventDate: await plus(10), audience: 'ALL', description: 'All hands (synthetic)' });
    await event({ name: 'Engineering offsite', eventDate: await plus(5), audience: 'DEPARTMENT', departmentId: A.dept });
    await event({ name: 'Branch blood camp', eventDate: await plus(3), audience: 'LOCATION', locationId: otherLoc });
    await event({ name: 'Last week party', eventDate: await plus(-7), audience: 'ALL' });
    await event({ name: 'Far future gala', eventDate: await plus(90), audience: 'ALL' });
    const off = await event({ name: 'Cancelled quiz', eventDate: await plus(2), audience: 'ALL' });
    const res = await h.call(hr, 'PATCH', `/v1/company-events/${off.id}`, { expectedVersion: off.version, active: false });
    expect(res.statusCode, res.body).toBe(200);
    await ticker({ message: 'Office closed on Friday (synthetic)', startsOn: today, endsOn: await plus(3) });
    await ticker({ message: 'Next month notice', startsOn: await plus(20), endsOn: await plus(25) });
    await ticker({ message: 'Expired notice', startsOn: await plus(-10), endsOn: await plus(-1) });

    const eng = await feed(engineer);
    expect(eng.asOf).toBe(today);
    expect(eng.events.map((e) => e.name)).toEqual(['Engineering offsite', 'Annual day']);
    expect(eng.events.find((e) => e.name === 'Engineering offsite')!.for).toBe('ENG');
    expect(eng.messages.map((m) => m.message)).toEqual(['Office closed on Friday (synthetic)']);
    const fin = await feed(financier);
    expect(fin.events.map((e) => e.name)).toEqual(['Branch blood camp', 'Annual day']);
    // No linked employee: the company-wide events only.
    expect((await feed(admin)).events.map((e) => e.name)).toEqual(['Annual day']);
    // Another company sees none of it.
    expect((await feed(await h.actor(B, 'HR_ADMINISTRATOR'))).events).toEqual([]);
  });

  it('FR-001 HR changes and switches off with the version on screen; every change is audited and nothing is deleted', async () => {
    const e = await event({ name: 'Town hall', eventDate: await plus(4), audience: 'ALL' });
    const moved = await h.call(hr, 'PATCH', `/v1/company-events/${e.id}`, { expectedVersion: 1, audience: 'DEPARTMENT', departmentId: A.financeDept, name: 'Finance town hall' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ name: 'Finance town hall', audience: 'DEPARTMENT', departmentId: A.financeDept, version: 2 });
    expect((await h.call(hr, 'PATCH', `/v1/company-events/${e.id}`, { expectedVersion: 1, active: false })).statusCode).toBe(409);
    const t = await ticker({ message: 'Fire drill at noon', startsOn: today, endsOn: today });
    expect((await feed(engineer)).messages.map((m) => m.message)).toContain('Fire drill at noon');
    const off = await h.call(hr, 'PATCH', `/v1/ticker-messages/${t.id}`, { expectedVersion: 1, active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await feed(engineer)).messages.map((m) => m.message)).not.toContain('Fire drill at noon');
    const listed = await h.call(hr, 'GET', '/v1/ticker-messages?includeInactive=true');
    expect(listed.json().items.find((m: { id: string }) => m.id === t.id)).toMatchObject({ active: false, version: 2 });
    expect((await h.call(hr, 'GET', '/v1/ticker-messages')).json().items.some((m: { id: string }) => m.id === t.id)).toBe(false);
    const audits = await h.db.query<{ resource_code: string; action: string }>(
      `select resource_code, action from audit_event where company_id = $1 and record_key = any($2::uuid[]) order by occurred_at`,
      [A.id, [e.id, t.id]],
    );
    expect(audits.rows.map((r) => `${r.resource_code} ${r.action}`)).toEqual(['company_event CREATE', 'company_event UPDATE', 'ticker_message CREATE', 'ticker_message UPDATE']);
    await expect(h.db.query(`delete from ticker_message where company_id = $1 and id = $2`, [A.id, t.id])).rejects.toThrow(/never deleted/);
  });

  it('refuses an audience without its target, a target for everyone, another company’s department and a reversed period', async () => {
    const bad = async (url: string, body: Record<string, unknown>) => {
      const res = await h.call(hr, 'POST', url, body);
      return [res.statusCode, res.json().error];
    };
    const day = await plus(3);
    expect(await bad('/v1/company-events', { name: 'X', eventDate: day, audience: 'DEPARTMENT' })).toEqual([422, 'VALIDATION_FAILED']);
    expect(await bad('/v1/company-events', { name: 'X', eventDate: day, audience: 'ALL', locationId: A.loc })).toEqual([422, 'VALIDATION_FAILED']);
    expect(await bad('/v1/company-events', { name: 'X', eventDate: day, audience: 'DEPARTMENT', departmentId: B.dept })).toEqual([422, 'INVALID_REFERENCE']);
    expect(await bad('/v1/company-events', { name: '   ', eventDate: day, audience: 'ALL' })).toEqual([422, 'VALIDATION_FAILED']);
    expect(await bad('/v1/ticker-messages', { message: 'Y', startsOn: day, endsOn: today })).toEqual([422, 'INVALID_PERIOD']);
  });

  it('BR-026 keeping them needs company-wide scope: an HR Administrator filtered to a department reads the feed but cannot post or change', async () => {
    const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await h.call(filtered, 'GET', '/v1/announcements/feed')).statusCode).toBe(200);
    expect((await h.call(filtered, 'GET', '/v1/company-events')).statusCode).toBe(403);
    expect((await h.call(filtered, 'POST', '/v1/ticker-messages', { message: 'Verify your account at once', startsOn: today, endsOn: today })).statusCode).toBe(403);
    const e = await event({ name: 'Not theirs', eventDate: today, audience: 'ALL' });
    expect((await h.call(filtered, 'PATCH', `/v1/company-events/${e.id}`, { expectedVersion: 1, active: false })).statusCode).toBe(403);
    expect((await h.one<{ active: boolean }>(`select active from company_event where id = $1`, [e.id])).active).toBe(true);
  });

  it('BR-026 only HR keeps them: an employee reads the feed but cannot list, create or change', async () => {
    expect((await h.call(engineer, 'GET', '/v1/company-events')).statusCode).toBe(403);
    expect((await h.call(engineer, 'POST', '/v1/company-events', { name: 'Mine', eventDate: today, audience: 'ALL' })).statusCode).toBe(403);
    expect((await h.call(engineer, 'POST', '/v1/ticker-messages', { message: 'Mine', startsOn: today, endsOn: today })).statusCode).toBe(403);
    const e = await event({ name: 'Locked', eventDate: today, audience: 'ALL' });
    expect((await h.call(engineer, 'PATCH', `/v1/company-events/${e.id}`, { expectedVersion: 1, active: false })).statusCode).toBe(403);
  });
});
