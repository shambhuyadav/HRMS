// Account administration (0311; FR-001; owner request of 13 Nov 2026): the System Administrator creates an account with its
// sign-in and a one-time temporary password, changes its name and email, resets its password and deletes one never used; the
// provider is the in-memory one (auth/identity-admin.ts). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityUnavailable, memoryIdentityAdmin } from '../../auth/identity-admin.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;
const idp = memoryIdentityAdmin();

let n = 0;
const email = () => `syn.account${++n}.${Date.now()}@example.invalid`;
const create = (by: TestActor, body: object) => h.call(by, 'POST', '/v1/access/accounts', body);
const detail = (by: TestActor, id: string) => h.call(by, 'GET', `/v1/access/accounts/${id}`);
const listed = async (by: TestActor, search: string) => ((await h.call(by, 'GET', `/v1/access/users?search=${encodeURIComponent(search)}`)).json().items as { userId: string; accountKey: string }[]).map((u) => u.accountKey);
const audit = (id: string) => h.db.query<{ action: string; after_values: unknown; reason: string | null }>(`select action, after_values, reason from audit_event where resource_code = 'user_account' and record_key = $1 order by created_at`, [id]);

beforeAll(async () => {
  h = await startHarness({ identity: idp });
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('account administration (0311)', () => {
  it('creates an account with its sign-in and a one-time temporary password, listed in this company only', async () => {
    const key = email();
    const res = await create(admin, { email: `  ${key.toUpperCase()} `, firstName: 'Asha', lastName: 'Synthetic' });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json() as { userId: string; accountKey: string; version: number; temporaryPassword: string };
    expect(made.accountKey).toBe(key);
    expect(made.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    // The provider holds the sign-in, with the password as temporary (chosen again at the first sign-in).
    const person = [...idp.people.values()].find((p) => p.email === key)!;
    expect(person).toMatchObject({ firstName: 'Asha', lastName: 'Synthetic', enabled: true, password: made.temporaryPassword, temporary: true });
    // Listed for this company, not for another; the password is never audited.
    expect(await listed(admin, key)).toEqual([key]);
    const other = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
    expect(await listed(other, key)).toEqual([]);
    expect((await detail(other, made.userId)).statusCode).toBe(404);
    const rows = (await audit(made.userId)).rows;
    expect(rows.map((r) => r.action)).toEqual(['CREATE']);
    expect(JSON.stringify(rows)).not.toContain(made.temporaryPassword);
    // The detail reads the name from the provider; never used, so it may be deleted.
    expect((await detail(admin, made.userId)).json()).toMatchObject({ accountKey: key, firstName: 'Asha', lastName: 'Synthetic', signInAccount: true, signedIn: false, deletable: true, active: true });
  });

  it('refuses a taken email, a malformed one, and a role without the duty', async () => {
    const key = email();
    expect((await create(admin, { email: key, firstName: 'A', lastName: 'B' })).statusCode).toBe(201);
    const again = await create(admin, { email: key, firstName: 'A', lastName: 'B' });
    expect([again.statusCode, again.json().error]).toEqual([409, 'ACCOUNT_EXISTS']);
    const bad = await create(admin, { email: 'not-an-email', firstName: 'A', lastName: 'B' });
    expect([bad.statusCode, bad.json().error]).toEqual([422, 'INVALID_EMAIL']);
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await create(hr, { email: email(), firstName: 'A', lastName: 'B' })).statusCode).toBe(403);
    // A filtered administrator acts company-wide on nothing.
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await create(filtered, { email: email(), firstName: 'A', lastName: 'B' })).statusCode).toBe(403);
  });

  it('changes the name and the sign-in email against the version, at the provider as well', async () => {
    const key = email();
    const made = (await create(admin, { email: key, firstName: 'Ravi', lastName: 'Synthetic' })).json() as { userId: string; version: number };
    const stale = await h.call(admin, 'PATCH', `/v1/access/accounts/${made.userId}`, { expectedVersion: made.version + 5, firstName: 'X' });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    const next = email();
    const changed = await h.call(admin, 'PATCH', `/v1/access/accounts/${made.userId}`, { expectedVersion: made.version, email: next, firstName: 'Ravindra', lastName: 'Synthetic' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ accountKey: next, version: made.version + 1 });
    expect([...idp.people.values()].find((p) => p.email === next)).toMatchObject({ firstName: 'Ravindra' });
    expect(await listed(admin, next)).toEqual([next]);
    // Another account's email is refused.
    const taken = (await create(admin, { email: email(), firstName: 'A', lastName: 'B' })).json() as { accountKey: string };
    const clash = await h.call(admin, 'PATCH', `/v1/access/accounts/${made.userId}`, { expectedVersion: made.version + 1, email: taken.accountKey });
    expect([clash.statusCode, clash.json().error]).toEqual([409, 'ACCOUNT_EXISTS']);
  });

  it('resets the password: a new temporary one, every session ended, the reason audited, never one’s own account', async () => {
    const made = (await create(admin, { email: email(), firstName: 'Meera', lastName: 'Synthetic' })).json() as { userId: string; temporaryPassword: string };
    await h.db.query(`insert into user_session (user_id, expires_at) values ($1, now() + interval '1 hour')`, [made.userId]);
    const reset = await h.call(admin, 'POST', `/v1/access/accounts/${made.userId}/reset-password`, { reason: 'Synthetic: forgot the password' });
    expect(reset.statusCode, reset.body).toBe(200);
    const body = reset.json() as { temporaryPassword: string; sessionsRevoked: number };
    expect(body.temporaryPassword).not.toBe(made.temporaryPassword);
    expect(body.sessionsRevoked).toBe(1);
    const person = [...idp.people.values()].find((p) => p.password === body.temporaryPassword)!;
    expect(person.temporary).toBe(true);
    expect(person.signedOut).toBe(1);
    const rows = (await audit(made.userId)).rows;
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'RESET_PASSWORD']);
    expect(rows[1]!.reason).toBe('Synthetic: forgot the password');
    expect(JSON.stringify(rows)).not.toContain(body.temporaryPassword);
    const own = await h.call(admin, 'POST', `/v1/access/accounts/${admin.user}/reset-password`, { reason: 'x' });
    expect([own.statusCode, own.json().error]).toEqual([403, 'SELF_ACTION_NOT_ALLOWED']);
  });

  it('deletes an account never used, with its sign-in; a used one is kept and only deactivated', async () => {
    const fresh = (await create(admin, { email: email(), firstName: 'Kiran', lastName: 'Synthetic' })).json() as { userId: string; accountKey: string; version: number };
    const gone = await h.call(admin, 'POST', `/v1/access/accounts/${fresh.userId}/delete`, { expectedVersion: fresh.version, reason: 'Synthetic: created by mistake' });
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json()).toEqual({ userId: fresh.userId, deleted: true });
    expect((await h.db.query(`select 1 from user_account where id = $1`, [fresh.userId])).rowCount).toBe(0);
    expect([...idp.people.values()].some((p) => p.email === fresh.accountKey)).toBe(false);
    expect((await audit(fresh.userId)).rows.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);

    // Granted a role: used, so kept.
    const used = (await create(admin, { email: email(), firstName: 'Dev', lastName: 'Synthetic' })).json() as { userId: string; version: number };
    await h.actor(A, 'EMPLOYEE', { user: used.userId });
    expect((await detail(admin, used.userId)).json()).toMatchObject({ deletable: false });
    const refused = await h.call(admin, 'POST', `/v1/access/accounts/${used.userId}/delete`, { expectedVersion: used.version, reason: 'x' });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'ACCOUNT_IN_USE']);
  });

  it('deactivating turns the sign-in off and signs the person out; reactivating turns it on', async () => {
    const made = (await create(admin, { email: email(), firstName: 'Noor', lastName: 'Synthetic' })).json() as { userId: string; accountKey: string; version: number };
    const off = await h.call(admin, 'POST', `/v1/access/users/${made.userId}/deactivate`, { expectedVersion: made.version, reason: 'Synthetic leaver' });
    expect(off.statusCode, off.body).toBe(200);
    const person = () => [...idp.people.values()].find((p) => p.email === made.accountKey)!;
    expect(person()).toMatchObject({ enabled: false, signedOut: 1 });
    // An inactive account gets no new password.
    const reset = await h.call(admin, 'POST', `/v1/access/accounts/${made.userId}/reset-password`, { reason: 'x' });
    expect([reset.statusCode, reset.json().error]).toEqual([409, 'INVALID_STATE']);
    const on = await h.call(admin, 'POST', `/v1/access/users/${made.userId}/reactivate`, { expectedVersion: (off.json() as { version: number }).version, reason: 'Synthetic return' });
    expect(on.statusCode, on.body).toBe(200);
    expect(person().enabled).toBe(true);
  });

  it('writes nothing when the provider fails: the HRMS change is rolled back', async () => {
    const key = email();
    const create0 = idp.create;
    idp.create = async () => {
      throw new IdentityUnavailable('down');
    };
    try {
      const res = await create(admin, { email: key, firstName: 'Zoya', lastName: 'Synthetic' });
      expect([res.statusCode, res.json().error]).toEqual([503, 'SIGN_IN_PROVIDER_UNAVAILABLE']);
    } finally {
      idp.create = create0;
    }
    expect((await h.db.query(`select 1 from user_account where account_key = $1`, [key])).rowCount).toBe(0);
  });

  it('does not touch an account that also serves another company', async () => {
    const made = (await create(admin, { email: email(), firstName: 'Shared', lastName: 'Synthetic' })).json() as { userId: string; version: number };
    await h.actor(B, 'EMPLOYEE', { user: made.userId });
    const reset = await h.call(admin, 'POST', `/v1/access/accounts/${made.userId}/reset-password`, { reason: 'x' });
    expect([reset.statusCode, reset.json().error]).toEqual([409, 'ACCOUNT_SPANS_COMPANIES']);
    const edit = await h.call(admin, 'PATCH', `/v1/access/accounts/${made.userId}`, { expectedVersion: made.version, firstName: 'X' });
    expect([edit.statusCode, edit.json().error]).toEqual([409, 'ACCOUNT_SPANS_COMPANIES']);
  });
});
