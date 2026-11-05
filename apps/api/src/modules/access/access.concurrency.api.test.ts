// ZT11, BR-007 ("Proposed sensitive grant changes require independent recorded approval"), C4: two independent approvers acting on
// one pending grant, or one pending role-permission change, leave one decision, one actor on record and one audit entry. Each path
// serialises on its row, so that is the lock this test holds. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { raceOnRow, statusesOf } from '../../test/race.fixtures.js';

let h: Harness;
let A: Company;
let proposer: TestActor;
let approver1: TestActor;
let approver2: TestActor;

const auditOf = async (id: string) => (await h.db.query<{ v: string }>(`select action || ':' || actor_user_id as v from audit_event where company_id = $1 and record_key = $2 order by occurred_at, action`, [A.id, id])).rows.map((r) => r.v);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  proposer = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  approver1 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  approver2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('one pending role grant', () => {
  const pending = async () => {
    const res = await h.call(proposer, 'POST', '/v1/access/assignments', { userId: await h.makeUser(), roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const grant = (id: string) => h.one<{ state: string; approved_by: string | null; version: number; decision_reason: string | null }>(`select state, approved_by, version, decision_reason from role_assignment where id = $1`, [id]);
  const approve = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion });
  const reject = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `/v1/access/assignments/${id}/reject`, { expectedVersion, reason: 'Synthetic rejection' });

  it('two approvers: the first queued approves, the second is refused as stale, and only the first is on record', async () => {
    const id = await pending();
    const v = (await grant(id)).version;
    const before = await auditOf(id);
    const [first, second] = await raceOnRow(h, 'role_assignment', id, [() => approve(approver1, id, v), () => approve(approver2, id, v)]);
    expect(first!.statusCode, first!.body).toBe(200);
    expect(second!.statusCode).toBe(409);
    expect(second!.json().error).toBe('STALE_VERSION');
    expect(await grant(id)).toMatchObject({ state: 'ACTIVE', approved_by: approver1.user, version: v + 1 });
    expect((await auditOf(id)).slice(before.length)).toEqual([expect.stringContaining(`:${approver1.user}`)]);
  });

  it('the other order puts the other approver on record: the queue decides, not the name', async () => {
    const id = await pending();
    const v = (await grant(id)).version;
    const [second, first] = await raceOnRow(h, 'role_assignment', id, [() => approve(approver2, id, v), () => approve(approver1, id, v)]);
    expect([second!.statusCode, first!.statusCode]).toEqual([200, 409]);
    expect((await grant(id)).approved_by).toBe(approver2.user);
  });

  it('an approval and a rejection: rejection queued first leaves no access', async () => {
    const id = await pending();
    const v = (await grant(id)).version;
    const [no, yes] = await raceOnRow(h, 'role_assignment', id, [() => reject(approver1, id, v), () => approve(approver2, id, v)]);
    expect(no!.statusCode, no!.body).toBe(200);
    expect(yes!.statusCode).toBe(409);
    // A rejected proposal ends as REVOKED: it never carried access, and no one is on record as its approver.
    expect(await grant(id)).toMatchObject({ state: 'REVOKED', approved_by: null, decision_reason: 'Synthetic rejection' });
  });

  it('an approval and a rejection: approval queued first stands', async () => {
    const id = await pending();
    const v = (await grant(id)).version;
    const [yes, no] = await raceOnRow(h, 'role_assignment', id, [() => approve(approver2, id, v), () => reject(approver1, id, v)]);
    expect(yes!.statusCode, yes!.body).toBe(200);
    expect(no!.statusCode).toBe(409);
    expect(await grant(id)).toMatchObject({ state: 'ACTIVE', approved_by: approver2.user });
  });

  it('with no lock held, however the two interleave: one approver on record', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await pending();
      const v = (await grant(id)).version;
      const before = await auditOf(id);
      const results = await Promise.all([approve(approver1, id, v), approve(approver2, id, v)]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      const g = await grant(id);
      expect(g.state).toBe('ACTIVE');
      expect(g.approved_by).toBe(results[0]!.statusCode === 200 ? approver1.user : approver2.user);
      expect((await auditOf(id)).slice(before.length)).toHaveLength(1);
    }
  });
});

describe('one pending role-permission change', () => {
  const PATH = '/v1/access/role-permission-changes';
  const pending = async (change: 'ALLOW' | 'DENY' | 'REMOVE', roleCode: string, permission: string) => {
    const res = await h.call(proposer, 'POST', PATH, { roleCode, permission, change, reason: 'Access review (synthetic)' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const approve = (a: TestActor, id: string) => h.call(a, 'POST', `${PATH}/${id}/approve`, { expectedVersion: 1 });
  const reject = (a: TestActor, id: string) => h.call(a, 'POST', `${PATH}/${id}/reject`, { expectedVersion: 1, reason: 'Not needed (synthetic)' });
  const rolePermission = async (roleCode: string, key: string) => {
    const [resource, action, group] = key.split('.');
    return (
      await h.db.query(
        `select 1 from role_permission rp join role r on r.company_id = rp.company_id and r.id = rp.role_id join permission p on p.id = rp.permission_id
          where rp.company_id = $1 and r.code = $2 and p.resource = $3 and p.action = $4 and p.field_group = $5`,
        [A.id, roleCode, resource, action, group],
      )
    ).rowCount;
  };
  const change = (id: string) => h.one<{ state: string; decided_by: string | null }>(`select state, decided_by from role_permission_change where id = $1`, [id]);

  it('two approvers: applied once, one approver on record, and the second is refused', async () => {
    const id = await pending('REMOVE', 'EMPLOYEE', 'mobile_link.read.operational');
    expect(await rolePermission('EMPLOYEE', 'mobile_link.read.operational')).toBe(1);
    const [first, second] = await raceOnRow(h, 'role_permission_change', id, [() => approve(approver1, id), () => approve(approver2, id)]);
    expect(first!.statusCode, first!.body).toBe(200);
    expect(second!.statusCode).toBe(409);
    expect(await change(id)).toMatchObject({ state: 'APPROVED', decided_by: approver1.user });
    expect(await rolePermission('EMPLOYEE', 'mobile_link.read.operational')).toBe(0);
  });

  it('an approval and a rejection: rejection queued first changes nothing', async () => {
    const id = await pending('REMOVE', 'EMPLOYEE', 'profile_change.read.operational');
    const [no, yes] = await raceOnRow(h, 'role_permission_change', id, [() => reject(approver1, id), () => approve(approver2, id)]);
    expect(no!.statusCode, no!.body).toBe(200);
    expect(yes!.statusCode).toBe(409);
    expect(await change(id)).toMatchObject({ state: 'REJECTED', decided_by: approver1.user });
    expect(await rolePermission('EMPLOYEE', 'profile_change.read.operational')).toBe(1);
  });
});
