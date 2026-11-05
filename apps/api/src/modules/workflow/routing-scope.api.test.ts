// Row scope on reviewer routing (C1 "Permissions and row scope also apply to search suggestions, counts"; C4 "existing company
// scope cannot authorize an expansion beyond approved administrative scope"; DF03; ZT05). A reviewer list routes tasks across
// the whole company, so only an unrestricted assignment changes one; the people shown follow the reader's scope. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { grantOf } from '../payroll/payroll.fixtures.js';
import { setFallbackReviewers } from './admin.js';

const KIND = 'profile_change';

describe('reviewer routing and row scope', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let filtered: TestActor;
  let inFinance: TestActor;
  let elsewhere: TestActor;
  let unlinked: TestActor;
  let elsewhereCode: string;

  const staff = async (departmentId: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };
  const setList = (a: TestActor, reviewers: TestActor[]) => h.call(a, 'PUT', `/v1/workflows/${KIND}/fallback-reviewers`, { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });
  const candidates = async (a: TestActor) => (await h.call(a, 'GET', `/v1/workflows/${KIND}/candidates`)).json().items as { userId: string; employeeCode: string | null; displayName: string | null }[];
  const listed = async (a: TestActor) =>
    (((await h.call(a, 'GET', '/v1/workflows')).json().items as { kind: string; fallbackReviewers: { userId: string }[] }[]).find((k) => k.kind === KIND)?.fallbackReviewers ?? []).map((r) => r.userId).sort();

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    filtered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    inFinance = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: (await staff(A.financeDept)).id });
    const other = await staff(A.dept);
    elsewhereCode = other.code;
    elsewhere = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: other.id });
    unlinked = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await setList(hr, [inFinance, elsewhere, unlinked])).statusCode).toBe(200);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('an unrestricted assignment sees every candidate and listed reviewer, including accounts linked to no employee', async () => {
    const ids = (await candidates(hr)).map((c) => c.userId);
    expect(ids).toEqual(expect.arrayContaining([inFinance.user, elsewhere.user, unlinked.user, filtered.user, hr.user]));
    expect(await listed(hr)).toEqual([inFinance.user, elsewhere.user, unlinked.user].sort());
  });

  it('a filtered assignment sees only the people its scope covers, in the picker and the lists (C1)', async () => {
    const seen = await candidates(filtered);
    expect(seen.map((c) => c.userId)).toEqual([inFinance.user]);
    expect(JSON.stringify(seen)).not.toContain(elsewhereCode);
    expect(await listed(filtered)).toEqual([inFinance.user]);
  });

  it('a location filter narrows them the same way', async () => {
    const north = await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'RS_NORTH', 'North', true) returning id`, [A.id]);
    const byLocation = await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north.id });
    expect(await candidates(byLocation)).toEqual([]);
    expect(await listed(byLocation)).toEqual([]);
  });

  it('another company sees none of them, and the kind’s list is its own', async () => {
    const other = await h.actor(B, 'HR_ADMINISTRATOR');
    const ids = (await candidates(other)).map((c) => c.userId);
    for (const a of [hr, inFinance, elsewhere, unlinked]) expect(ids).not.toContain(a.user);
    expect(await listed(other)).toEqual([]);
  });

  it('only an unrestricted assignment changes a list; a filtered one changes nothing and leaves no audit', async () => {
    const before = await listed(hr);
    const audits = async () => (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'SET_FALLBACK'`, [A.id])).n;
    const auditsBefore = await audits();
    const refused = await setList(filtered, [inFinance]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain('unrestricted company-wide');
    expect(await listed(hr)).toEqual(before);
    expect(await audits()).toBe(auditsBefore);
    const north = await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'RS_LOC', 'Loc', true) returning id`, [A.id]);
    expect((await setList(await h.actor(A, 'HR_ADMINISTRATOR', { locationFilter: north.id }), [inFinance])).statusCode).toBe(403);
    expect((await setList(hr, [inFinance, elsewhere, unlinked])).statusCode).toBe(200);
    expect(await audits()).toBe(auditsBefore + 1);
  });

  it('a grant revoked after the route guard passed changes nothing (ZT05)', async () => {
    const temp = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = await grantOf(h, temp, 'workflow', 'manage', ['operational']);
    const before = await listed(hr);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
    await expect(withTransaction(h.pool, (tx) => setFallbackReviewers(tx, grant, KIND, [{ userId: inFinance.user, priority: 1 }]))).rejects.toMatchObject({ statusCode: 403 });
    expect(await listed(hr)).toEqual(before);
  });

  it('an unrestricted assignment can still list a filtered reviewer: the rule is on who changes a list, not who is on it', async () => {
    const candidateList = await candidates(hr);
    expect(candidateList.some((c) => c.userId === filtered.user)).toBe(true);
    expect((await setList(hr, [filtered, inFinance])).statusCode).toBe(200);
    expect(await listed(hr)).toEqual([filtered.user, inFinance.user].sort());
  });
});
