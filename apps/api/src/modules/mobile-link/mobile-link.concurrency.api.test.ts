// ZT11, FR-023, C4: two reviewers deciding one mobile-app link end in one decision and one audit entry; a re-link revokes the old link
// once; and one app account is never active for two employees, even when two links of two different employees are approved at the
// same moment. Link work is serialised per employee, so the cross-employee race is held by the database's unique index alone: it is
// run here with no key to hold, then with each link's row held. Synthetic opaque account references.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { raceOnKey, statusesOf } from '../../test/race.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let reviewer1: TestActor;
let reviewer2: TestActor;

const person = async () => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
const request = async (employeeId: string, appAccountRef = uniq('app-user-')) => {
  const res = await h.call(hr, 'POST', '/v1/mobile-links', { employeeId, appAccountRef });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const row = (id: string) => h.one<{ state: string; decided_by: string | null; version: number }>(`select state, decided_by, version from mobile_app_link where id = $1`, [id]);
const decide = (a: TestActor, id: string, expectedVersion: number, decision: 'APPROVE' | 'REJECT') => h.call(a, 'POST', `/v1/mobile-links/${id}/decision`, { expectedVersion, decision, ...(decision === 'REJECT' ? { reason: 'Synthetic' } : {}) });
const decisionsAudited = async (id: string) => (await h.db.query<{ action: string }>(`select action from audit_event where resource_code = 'mobile_app_link' and record_key = $1 and action in ('APPROVE', 'REJECT') order by action`, [id])).rows.map((r) => r.action);
const active = async (ref: string) => (await h.one<{ n: number }>(`select count(*)::int as n from mobile_app_link where company_id = $1 and app_account_ref = $2 and state = 'ACTIVE'`, [A.id, ref])).n;
const keyOf = (employeeId: string) => `mobile_link:${employeeId}`;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  reviewer1 = await h.actor(A, 'HR_ADMINISTRATOR');
  reviewer2 = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one link', () => {
  it('two approvers: the first queued decides, the second is refused as stale, and one decision is audited', async () => {
    const emp = await person();
    const id = await request(emp);
    const { version } = await row(id);
    const [first, second] = await raceOnKey(h, keyOf(emp), [() => decide(reviewer1, id, version, 'APPROVE'), () => decide(reviewer2, id, version, 'APPROVE')]);
    expect(first!.statusCode, first!.body).toBe(200);
    expect(second!.statusCode).toBe(409);
    expect(second!.json().error).toBe('STALE_VERSION');
    expect(await row(id)).toMatchObject({ state: 'ACTIVE', decided_by: reviewer1.user, version: version + 1 });
    expect(await decisionsAudited(id)).toEqual(['APPROVE']);
  });

  it('approve and reject: rejection queued first leaves no active link', async () => {
    const emp = await person();
    const ref = uniq('app-user-');
    const id = await request(emp, ref);
    const { version } = await row(id);
    const [no, yes] = await raceOnKey(h, keyOf(emp), [() => decide(reviewer1, id, version, 'REJECT'), () => decide(reviewer2, id, version, 'APPROVE')]);
    expect(no!.statusCode, no!.body).toBe(200);
    expect(yes!.statusCode).toBe(409);
    expect((await row(id)).state).toBe('REJECTED');
    expect(await active(ref)).toBe(0);
    expect(await decisionsAudited(id)).toEqual(['REJECT']);
  });

  it('a re-link approved twice at once revokes the old link once and leaves one active link', async () => {
    const emp = await person();
    const old = await request(emp);
    expect((await decide(reviewer1, old, (await row(old)).version, 'APPROVE')).statusCode).toBe(200);
    const next = await request(emp);
    const { version } = await row(next);
    const results = await raceOnKey(h, keyOf(emp), [() => decide(reviewer1, next, version, 'APPROVE'), () => decide(reviewer2, next, version, 'APPROVE')]);
    expect(results.map((r) => r.statusCode), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
    expect((await row(old)).state).toBe('REVOKED');
    expect((await row(next)).state).toBe('ACTIVE');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from mobile_app_link where employee_id = $1 and state = 'ACTIVE'`, [emp])).n).toBe(1);
  });

  it('with no lock held, however the two interleave: one decider on record', async () => {
    for (let round = 0; round < 4; round++) {
      const id = await request(await person());
      const { version } = await row(id);
      const results = await Promise.all([decide(reviewer1, id, version, 'APPROVE'), decide(reviewer2, id, version, 'APPROVE')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      expect((await row(id)).decided_by).toBe(results[0]!.statusCode === 200 ? reviewer1.user : reviewer2.user);
      expect(await decisionsAudited(id)).toEqual(['APPROVE']);
    }
  });

  it('two requests for one employee at once leave one pending', async () => {
    for (let round = 0; round < 3; round++) {
      const emp = await person();
      const send = () => h.call(hr, 'POST', '/v1/mobile-links', { employeeId: emp, appAccountRef: uniq('app-user-') });
      const results = await raceOnKey(h, keyOf(emp), [send, send]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([201, 409]);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from mobile_app_link where employee_id = $1 and state = 'PENDING'`, [emp])).n).toBe(1);
    }
  });
});

describe('one account, two employees (C4 "an account linked to one employee cannot be linked to another")', () => {
  it('both approved at once: one link is active, the other is refused and stays pending', async () => {
    for (let round = 0; round < 5; round++) {
      const ref = uniq('app-user-');
      const [e1, e2] = [await person(), await person()];
      const [l1, l2] = [await request(e1, ref), await request(e2, ref)];
      const [v1, v2] = [(await row(l1)).version, (await row(l2)).version];
      const results = await Promise.all([decide(reviewer1, l1, v1, 'APPROVE'), decide(reviewer2, l2, v2, 'APPROVE')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      expect(await active(ref)).toBe(1);
      const refused = results[0]!.statusCode === 200 ? l2 : l1;
      expect((await row(refused)).state).toBe('PENDING');
      expect(await decisionsAudited(refused)).toEqual([]);
    }
  });
});
