// User administration over HTTP (FR-001; §5 System Administrator; §5.1 User to employee; DB007; DB009; BR-044; C4). A link
// ties an existing account to an employee of the company and grants nothing by itself; deactivating revokes the account's
// sessions and is refused when the account also serves another company. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from './authorize.js';
import { linkUser, setAccountActive } from './user-admin.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;
let admin2: TestActor;
let hr: TestActor;
let adminB: TestActor;
let hrB: TestActor;

const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const account = async () => {
  const key = uniq('acct.');
  const id = (await h.one<{ id: string }>(`insert into user_account (account_key, active) values ($1, true) returning id`, [key])).id;
  return { id, key };
};
const employee = async (actor = hr, company = A, overrides: Record<string, unknown> = {}) => (await h.call(actor, 'POST', '/v1/employees', h.newEmployeeBody(company, overrides))).json().id as string;
const link = (by: TestActor, body: object) => h.call(by, 'POST', '/v1/access/user-links', body);
const end = (by: TestActor, id: string, body: object) => h.call(by, 'POST', `/v1/access/user-links/${id}/end`, { reason: 'Synthetic end', ...body });
const version = async (user: string) => (await h.one<{ version: number }>(`select version from user_account where id = $1`, [user])).version;
const deactivate = async (by: TestActor, user: string) => h.call(by, 'POST', `/v1/access/users/${user}/deactivate`, { expectedVersion: await version(user), reason: 'Synthetic leaver' });
const reactivate = async (by: TestActor, user: string) => h.call(by, 'POST', `/v1/access/users/${user}/reactivate`, { expectedVersion: await version(user), reason: 'Synthetic return' });
const auditRows = (recordKey: string) => h.db.query<{ action: string; actor_user_id: string; reason: string | null; after_values: { operational: Record<string, unknown> } }>(
  `select action, actor_user_id, reason, after_values from audit_event where record_key = $1 and action <> 'ACCESS_DENIED' order by occurred_at`,
  [recordKey],
);
const grantOf = async (a: TestActor, action: string) => (await resolveAccess(h.pool, { userId: a.user, companyId: a.company.id, assignmentId: a.assignment, resource: 'access', action, fieldGroups: ['operational'] })) as AccessGrant;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  admin2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  adminB = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  hrB = await h.actor(B, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('linking an account to an employee (§5.1, DB009)', () => {
  it('links by exact account key, audited, with no permission from the link itself', async () => {
    const a = await account();
    const emp = await employee();
    const res = await link(admin, { accountKey: `  ${a.key.toUpperCase()} `, employeeId: emp, effectiveFrom: '2026-01-05', reason: 'Joined (synthetic)' });
    expect(res.statusCode, res.body).toBe(201);
    const { id, version: v } = res.json();
    expect(v).toBe(1);

    const [audit] = (await auditRows(id)).rows;
    expect(audit).toMatchObject({ action: 'CREATE', actor_user_id: admin.user, reason: 'Joined (synthetic)' });
    expect(audit!.after_values.operational).toMatchObject({ userId: a.id, employeeId: emp, effectiveFrom: '2026-01-05', effectiveTo: null });

    // DB009: no assignment, no allowlist entry, nothing to act with.
    expect(await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where user_id = $1`, [a.id])).toEqual({ n: 0 });
    const token = await h.tokenFor(a.id);
    const as: TestActor = { user: a.id, assignment: '00000000-0000-4000-8000-000000000000', token, company: A };
    expect((await h.call(as, 'GET', '/v1/me/assignments')).json().items).toEqual([]);
    expect((await h.call(as, 'GET', `/v1/employees/${emp}`)).statusCode).toBe(403);
    expect((await h.call(as, 'GET', '/v1/me/permissions')).json().permissions).toEqual([]);

    // It is now a user of the company, with its employee.
    const listed = (await h.call(admin, 'GET', `/v1/access/users?search=${encodeURIComponent(a.key)}`)).json().items;
    expect(listed).toMatchObject([{ userId: a.id, active: true, employee: { id: emp } }]);
    const links = (await h.call(admin, 'GET', `/v1/access/user-links?userId=${a.id}`)).json();
    expect(links).toMatchObject({ total: 1, items: [{ id, employeeId: emp, accountKey: a.key, inForce: true, effectiveTo: null }] });
  });

  it('an unknown and an inactive account read the same, and accounts are not listed across companies', async () => {
    const emp = await employee();
    const unknown = await link(admin, { accountKey: `nobody.${uniq('x')}`, employeeId: emp, effectiveFrom: '2026-01-05' });
    const inactive = await account();
    await h.db.query(`update user_account set active = false where id = $1`, [inactive.id]);
    const off = await link(admin, { accountKey: inactive.key, employeeId: emp, effectiveFrom: '2026-01-05' });
    expect([unknown.statusCode, unknown.json().error]).toEqual([422, 'INVALID_REFERENCE']);
    expect(off.json()).toEqual(unknown.json());

    // An account of another company is reachable only by its exact key, and its link in B stays out of A's lists.
    const other = await account();
    expect((await link(adminB, { accountKey: other.key, employeeId: await employee(hrB, B), effectiveFrom: '2026-01-05' })).statusCode).toBe(201);
    expect((await h.call(admin, 'GET', `/v1/access/users?search=${encodeURIComponent(other.key)}`)).json().items).toEqual([]);
    expect((await h.call(admin, 'GET', `/v1/access/user-links?userId=${other.id}`)).json().items).toEqual([]);

    // One person, one employee per company (§5.1): the same account links in A too, and A sees only A's link.
    const inA = await link(admin, { accountKey: other.key, employeeId: emp, effectiveFrom: '2026-01-05' });
    expect(inA.statusCode).toBe(201);
    expect((await h.call(admin, 'GET', `/v1/access/user-links?userId=${other.id}`)).json().items).toMatchObject([{ employeeId: emp }]);
  });

  it('refuses an overlap per user and per employee, and allows consecutive periods', async () => {
    const a = await account();
    const b = await account();
    const e1 = await employee();
    const e2 = await employee();
    expect((await link(admin, { accountKey: a.key, employeeId: e1, effectiveFrom: '2026-01-05', effectiveTo: '2026-03-01' })).statusCode).toBe(201);

    const sameUser = await link(admin, { accountKey: a.key, employeeId: e2, effectiveFrom: '2026-02-01' });
    expect([sameUser.statusCode, sameUser.json().error]).toEqual([409, 'OVERLAPPING_PERIOD']);
    const sameEmployee = await link(admin, { accountKey: b.key, employeeId: e1, effectiveFrom: '2026-02-28' });
    expect([sameEmployee.statusCode, sameEmployee.json().error]).toEqual([409, 'OVERLAPPING_PERIOD']);

    // The end is exclusive, so the next link may start on it.
    expect((await link(admin, { accountKey: a.key, employeeId: e2, effectiveFrom: '2026-03-01' })).statusCode).toBe(201);
    expect((await link(admin, { accountKey: b.key, employeeId: e1, effectiveFrom: '2026-03-01' })).statusCode).toBe(201);

    const reversed = await link(admin, { accountKey: (await account()).key, employeeId: await employee(), effectiveFrom: '2026-03-01', effectiveTo: '2026-03-01' });
    expect([reversed.statusCode, reversed.json().error]).toEqual([422, 'INVALID_PERIOD']);
  });

  it('two simultaneous links for one account: exactly one wins', async () => {
    const a = await account();
    const [e1, e2] = [await employee(), await employee()];
    const results = await Promise.all([e1, e2].map((employeeId) => link(admin, { accountKey: a.key, employeeId, effectiveFrom: '2026-01-05' })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from user_employee_link where user_id = $1`, [a.id])).toEqual({ n: 1 });
  });

  it('stays inside the company and the administrator row scope, and needs its own permission', async () => {
    const a = await account();
    const empB = await employee(hrB, B);
    const across = await link(admin, { accountKey: a.key, employeeId: empB, effectiveFrom: '2026-01-05' });
    expect(across.statusCode).toBe(404);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and record_key = $2`, [A.id, empB])).toEqual({ n: 1 });

    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const eng = await employee();
    const fin = await employee(hr, A, { departmentId: A.financeDept });
    expect((await link(filtered, { accountKey: a.key, employeeId: eng, effectiveFrom: '2026-01-05' })).statusCode).toBe(404);
    const inScope = await link(filtered, { accountKey: a.key, employeeId: fin, effectiveFrom: '2026-01-05' });
    expect(inScope.statusCode).toBe(201);
    // Its list holds only the filter's links, and it cannot end one outside it.
    const other = await link(admin, { accountKey: (await account()).key, employeeId: eng, effectiveFrom: '2026-01-05' });
    expect((await h.call(filtered, 'GET', '/v1/access/user-links?pageSize=100')).json().items.map((l: { employeeId: string }) => l.employeeId)).not.toContain(eng);
    expect((await end(filtered, other.json().id, { expectedVersion: 1 })).statusCode).toBe(404);

    const denied = await link(hr, { accountKey: a.key, employeeId: eng, effectiveFrom: '2026-01-05' });
    expect(denied.statusCode).toBe(403);
    expect((await h.call(hr, 'GET', '/v1/access/user-links')).statusCode).toBe(403);
  });

  it('never on the administrator own account or own employee (C4, I-52)', async () => {
    const self = await link(admin, { accountKey: (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [admin.user])).account_key, employeeId: await employee(), effectiveFrom: '2026-01-05' });
    expect([self.statusCode, self.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);

    const ownEmp = await employee();
    const linked = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { employeeId: ownEmp });
    const toOwn = await link(linked, { accountKey: (await account()).key, employeeId: ownEmp, effectiveFrom: '2030-01-05' });
    expect([toOwn.statusCode, toOwn.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);

    const ownLink = await h.one<{ id: string; version: number }>(`select id, version from user_employee_link where user_id = $1`, [linked.user]);
    const endOwn = await end(linked, ownLink.id, { expectedVersion: ownLink.version });
    expect([endOwn.statusCode, endOwn.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);
  });

  it('refuses a closed draft employee', async () => {
    const emp = await employee();
    const { version: v } = (await h.call(hr, 'GET', `/v1/employees/${emp}`)).json();
    expect((await h.call(hr, 'POST', `/v1/employees/${emp}/close-draft`, { expectedVersion: v, reason: 'Never joined (synthetic)' })).statusCode).toBe(200);
    const res = await link(admin, { accountKey: (await account()).key, employeeId: emp, effectiveFrom: '2026-01-05' });
    expect([res.statusCode, res.json().error]).toEqual([422, 'EMPLOYMENT_ENDED']);
  });

  it('re-checks authority inside the transaction: a grant revoked after the route guard changes nothing', async () => {
    const temp = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const grant = await grantOf(temp, 'link_user');
    expect(grant.allowed).toBe(true);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    const a = await account();
    const emp = await employee();
    await expect(withTransaction(h.pool, (tx) => linkUser(tx, grant, { accountKey: a.key, employeeId: emp, effectiveFrom: '2026-01-05' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await h.one<{ n: number }>(`select count(*)::int as n from user_employee_link where user_id = $1`, [a.id])).toEqual({ n: 0 });
  });
});

describe('ending a link (§5.1, DB009)', () => {
  const linked = async (effectiveFrom = '2026-01-05', effectiveTo?: string) => {
    const a = await account();
    const emp = await employee();
    const res = await link(admin, { accountKey: a.key, employeeId: emp, effectiveFrom, ...(effectiveTo ? { effectiveTo } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return { a, emp, id: res.json().id as string };
  };

  it('ends today by default, audited with the reason, and keeps the record', async () => {
    const { id, a, emp } = await linked();
    const stale = await end(admin, id, { expectedVersion: 9 });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    const res = await end(admin, id, { expectedVersion: 1, reason: 'Left (synthetic)' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id, version: 2 });
    const effectiveTo = res.json().effectiveTo;

    const rows = (await auditRows(id)).rows;
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'END']);
    expect(rows[1]).toMatchObject({ reason: 'Left (synthetic)', actor_user_id: admin.user });
    expect(rows[1]!.after_values.operational).toMatchObject({ userId: a.id, employeeId: emp, effectiveTo });

    // Kept, and no longer in force; a new link may follow.
    expect((await h.call(admin, 'GET', `/v1/access/user-links?userId=${a.id}`)).json().items).toMatchObject([{ id, inForce: false, effectiveTo }]);
    const again = await end(admin, id, { expectedVersion: 2 });
    expect([again.statusCode, again.json().error]).toEqual([409, 'INVALID_STATE']);
    expect((await link(admin, { accountKey: a.key, employeeId: emp, effectiveFrom: effectiveTo })).statusCode).toBe(201);
  });

  it('a link made today stops working today: own-record scope is gone at once', async () => {
    const emp = await employee();
    const a = await account();
    // The account already holds an Employee OWN assignment; only the link points it at a record.
    const own = await h.actor(A, 'EMPLOYEE', { user: a.id });
    expect((await h.call(own, 'GET', `/v1/employees/${emp}`)).statusCode).toBe(404);
    const day = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    const res = await link(admin, { accountKey: a.key, employeeId: emp, effectiveFrom: day });
    expect((await h.call(own, 'GET', `/v1/employees/${emp}`)).statusCode).toBe(200);
    const ended = await end(admin, res.json().id, { expectedVersion: 1, effectiveTo: day });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await h.call(own, 'GET', `/v1/employees/${emp}`)).statusCode).toBe(404);
  });

  it('cannot be back-dated or extended, and a future link can be cancelled on its start', async () => {
    const { id } = await linked('2026-01-05', addDays(TODAY, 60));
    const backdated = await end(admin, id, { expectedVersion: 1, effectiveTo: '2026-02-01' });
    expect([backdated.statusCode, backdated.json().error]).toEqual([422, 'INVALID_PERIOD']);
    const later = await end(admin, id, { expectedVersion: 1, effectiveTo: addDays(TODAY, 90) });
    expect([later.statusCode, later.json().error]).toEqual([422, 'INVALID_PERIOD']);
    expect((await end(admin, id, { expectedVersion: 1, effectiveTo: addDays(TODAY, 30) })).json().effectiveTo).toBe(addDays(TODAY, 30));

    const future = await linked(addDays(TODAY, 10));
    expect((await end(admin, future.id, { expectedVersion: 1 })).json().effectiveTo).toBe(addDays(TODAY, 10));
    const before = await linked(addDays(TODAY, 10));
    expect((await end(admin, before.id, { expectedVersion: 1, effectiveTo: addDays(TODAY, 5) })).json().error).toBe('INVALID_PERIOD');
  });

  it('the database keeps a link: no delete, user and start fixed, the end only earlier (0100)', async () => {
    const { id, emp } = await linked('2026-01-05', addDays(TODAY, 60));
    await expect(h.db.query(`delete from user_employee_link where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update user_employee_link set effective_from = '2026-01-06' where id = $1`, [id])).rejects.toThrow(/keeps its user, employee and start/);
    await expect(h.db.query(`update user_employee_link set employee_id = $2 where id = $1`, [id, await employee()])).rejects.toThrow(/keeps its user, employee and start/);
    await expect(h.db.query(`update user_employee_link set effective_to = null where id = $1`, [id])).rejects.toThrow(/may only come earlier/);
    await expect(h.db.query(`truncate user_employee_link`)).rejects.toMatchObject({ code: '23514' });
    expect(emp).toBeTruthy();
  });
});

describe('deactivating an account (DB007, FR-001)', () => {
  const member = async () => {
    const a = await account();
    expect((await link(admin, { accountKey: a.key, employeeId: await employee(), effectiveFrom: '2026-01-05' })).statusCode).toBe(201);
    return a;
  };

  it('revokes every session on the next request, is audited, and reactivating does not restore a session', async () => {
    const a = await member();
    const actor = await h.actor(A, 'EMPLOYEE', { user: a.id });
    const second = await h.tokenFor(a.id);
    expect((await h.call(actor, 'GET', '/v1/me/context')).statusCode).toBe(200);

    const res = await deactivate(admin, a.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ userId: a.id, active: false });
    expect(res.json().sessionsRevoked).toBeGreaterThanOrEqual(2);

    for (const token of [actor.token, second]) {
      const after = await h.call({ ...actor, token }, 'GET', '/v1/me/context');
      expect([after.statusCode, after.json().error]).toEqual([401, 'SESSION_REVOKED']);
    }
    expect(await h.one<{ n: number }>(`select count(*)::int as n from user_session where user_id = $1 and revoked_at is null`, [a.id])).toEqual({ n: 0 });
    const rows = (await auditRows(a.id)).rows;
    expect(rows.at(-1)).toMatchObject({ action: 'DEACTIVATE', reason: 'Synthetic leaver', actor_user_id: admin.user });
    expect((await deactivate(admin, a.id)).json().error).toBe('INVALID_STATE');

    // The list still shows it, inactive.
    expect((await h.call(admin, 'GET', `/v1/access/users?search=${encodeURIComponent(a.key)}`)).json().items[0]).toMatchObject({ userId: a.id, active: false });

    const back = await reactivate(admin, a.id);
    expect(back.json()).toMatchObject({ userId: a.id, active: true, sessionsRevoked: 0 });
    expect((await h.call(actor, 'GET', '/v1/me/context')).statusCode).toBe(401);
    const fresh = { ...actor, token: await h.tokenFor(a.id) };
    expect((await h.call(fresh, 'GET', '/v1/me/context')).statusCode).toBe(200);
    expect((await auditRows(a.id)).rows.at(-1)).toMatchObject({ action: 'REACTIVATE', reason: 'Synthetic return' });
  });

  it('refuses the actor own account, a stale version, a stranger and a narrowed administrator', async () => {
    const self = await deactivate(admin, admin.user);
    expect([self.statusCode, self.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);

    const a = await member();
    const stale = await h.call(admin, 'POST', `/v1/access/users/${a.id}/deactivate`, { expectedVersion: 99, reason: 'x' });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);

    // An account with no tie to this company is not found, whichever company it serves.
    const stranger = await account();
    expect((await deactivate(admin, stranger.id)).statusCode).toBe(404);
    expect(await h.one<{ active: boolean }>(`select active from user_account where id = $1`, [stranger.id])).toEqual({ active: true });

    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await deactivate(filtered, a.id)).statusCode).toBe(403);
    expect((await deactivate(hr, a.id)).statusCode).toBe(403);
  });

  it('refuses an account that also serves another company, without naming it; an ended tie does not count', async () => {
    const a = await member();
    const inB = await link(adminB, { accountKey: a.key, employeeId: await employee(hrB, B), effectiveFrom: '2026-01-05' });
    expect(inB.statusCode).toBe(201);
    const refused = await deactivate(admin, a.id);
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'ACCOUNT_SPANS_COMPANIES']);
    expect(refused.body).not.toContain(B.id);
    const fromB = await deactivate(adminB, a.id);
    expect([fromB.statusCode, fromB.json().error]).toEqual([409, 'ACCOUNT_SPANS_COMPANIES']);
    expect(await h.one<{ active: boolean }>(`select active from user_account where id = $1`, [a.id])).toEqual({ active: true });

    // A role assignment there counts as well, a pending proposal included.
    const c = await member();
    expect((await h.call(adminB, 'POST', '/v1/access/assignments', { userId: c.id, roleCode: 'AUDITOR', effectiveFrom: '2026-01-01T00:00:00Z' })).statusCode).toBe(201);
    expect((await deactivate(admin, c.id)).json().error).toBe('ACCOUNT_SPANS_COMPANIES');

    // Once B's link has ended, A may act.
    const ended = await end(adminB, inB.json().id, { expectedVersion: 1, effectiveTo: (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [B.id])).d });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await deactivate(admin, a.id)).statusCode).toBe(200);
    // An inactive account takes no new link in either company.
    expect((await link(adminB, { accountKey: a.key, employeeId: await employee(hrB, B), effectiveFrom: '2030-01-05' })).statusCode).toBe(422);
    // Reactivation applies the same rule: a live tie elsewhere blocks it as well.
    const d = await member();
    expect((await deactivate(admin, d.id)).statusCode).toBe(200);
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-05')`, [B.id, d.id, await employee(hrB, B)]);
    expect((await reactivate(admin, d.id)).json().error).toBe('ACCOUNT_SPANS_COMPANIES');
  });

  it('two administrators deactivating each other: exactly one wins', async () => {
    const one = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const two = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const [v1, v2] = [await version(one.user), await version(two.user)];
    const results = await Promise.all([
      h.call(one, 'POST', `/v1/access/users/${two.user}/deactivate`, { expectedVersion: v2, reason: 'Race' }),
      h.call(two, 'POST', `/v1/access/users/${one.user}/deactivate`, { expectedVersion: v1, reason: 'Race' }),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const rows = await h.db.query<{ active: boolean }>(`select active from user_account where id = any($1::uuid[])`, [[one.user, two.user]]);
    expect(rows.rows.filter((r) => r.active)).toHaveLength(1);
  });

  it('racing a link in another company never leaves an inactive account with a live link', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await member();
      const empB = await employee(hrB, B);
      const [off, linked] = await Promise.all([deactivate(admin, a.id), link(adminB, { accountKey: a.key, employeeId: empB, effectiveFrom: '2026-01-05' })]);
      const inactive = !(await h.one<{ active: boolean }>(`select active from user_account where id = $1`, [a.id])).active;
      const live = (await h.one<{ n: number }>(`select count(*)::int as n from user_employee_link where user_id = $1 and company_id = $2`, [a.id, B.id])).n > 0;
      expect(inactive && live, `deactivate ${off.statusCode}, link ${linked.statusCode}`).toBe(false);
      expect(inactive || live).toBe(true);
    }
  });

  it('re-checks authority inside the transaction', async () => {
    const temp = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const grant = await grantOf(temp, 'deactivate_user');
    expect(grant.allowed).toBe(true);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    const a = await member();
    await expect(withTransaction(h.pool, (tx) => setAccountActive(tx, grant, a.id, false, { expectedVersion: 1, reason: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await h.one<{ active: boolean }>(`select active from user_account where id = $1`, [a.id])).toEqual({ active: true });
  });
});

describe('an inactive user or company has no context (FR-001, C1)', () => {
  it('refuses /me/context and /me/permissions and lists no assignment, for a user set inactive with a live session', async () => {
    const a = await account();
    const actor = await h.actor(A, 'HR_ADMINISTRATOR', { user: a.id });
    expect((await h.call(actor, 'GET', '/v1/me/permissions')).json().permissions.length).toBeGreaterThan(0);
    await h.db.query(`update user_account set active = false where id = $1`, [a.id]);
    for (const url of ['/v1/me/context', '/v1/me/permissions', '/v1/employees']) {
      expect((await h.call(actor, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await h.call(actor, 'GET', '/v1/me/assignments')).json().items).toEqual([]);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from audit_event where actor_user_id = $1 and action = 'ACCESS_DENIED' and after_values->>'reason' = 'USER_INACTIVE'`, [a.id])).toEqual({ n: 3 });
  });

  it('refuses them for an inactive company', async () => {
    const C = await h.makeCompany();
    const actor = await h.actor(C, 'HR_ADMINISTRATOR');
    expect((await h.call(actor, 'GET', '/v1/me/context')).statusCode).toBe(200);
    await h.db.query(`update company set active = false where id = $1`, [C.id]);
    for (const url of ['/v1/me/context', '/v1/me/permissions', '/v1/employees']) {
      expect((await h.call(actor, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await h.call(actor, 'GET', '/v1/me/assignments')).json().items).toEqual([]);
  });
});

describe('the second administrator can act for the first', () => {
  it('an independent administrator may deactivate and end the link of a linked administrator', async () => {
    const emp = await employee();
    const linkedAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { employeeId: emp });
    const row = await h.one<{ id: string; version: number }>(`select id, version from user_employee_link where user_id = $1`, [linkedAdmin.user]);
    expect((await end(admin2, row.id, { expectedVersion: row.version })).statusCode).toBe(200);
    expect((await deactivate(admin2, linkedAdmin.user)).statusCode).toBe(200);
  });
});
