// ZT01 for workflow administration: fallback-reviewer lists, reviewer candidates and stranded tasks across companies; a user of another
// company can neither be named as a reviewer nor be listed. routing-scope.api.test.ts and manager-change.api.test.ts hold routing per
// company. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { leaveQueue, leaveTasks } from './leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let B: Company;
let hrA: TestActor;
let reviewerA: TestActor;
let hrB: TestActor;
let reviewerB: TestActor;

const reviewersOf = async (company: Company, kind: string) =>
  (await h.db.query<{ user_id: string }>(`select user_id from workflow_fallback_reviewer where company_id = $1 and kind = $2 and active order by priority`, [company.id, kind])).rows.map((r) => r.user_id);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hrA = await h.actor(A, 'HR_ADMINISTRATOR');
  reviewerA = await h.actor(A, 'HR_ADMINISTRATOR');
  hrB = await h.actor(B, 'HR_ADMINISTRATOR');
  reviewerB = await h.actor(B, 'HR_ADMINISTRATOR');
  expect((await h.call(hrA, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: reviewerA.user, priority: 1 }] })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('workflow administration across companies (ZT01; DF03)', () => {
  it('GET /workflows and its candidates list only the company’s own reviewers', async () => {
    const workflows = await h.call(hrB, 'GET', '/v1/workflows');
    expect(workflows.statusCode).toBe(200);
    expect(workflows.body).not.toContain(reviewerA.user);
    const candidates = await h.call(hrB, 'GET', '/v1/workflows/profile_change/candidates');
    expect(candidates.statusCode).toBe(200);
    const users = (candidates.json().items as { userId: string }[]).map((c) => c.userId);
    expect(users).toContain(reviewerB.user);
    expect(users).not.toContain(reviewerA.user);
    expect(users).not.toContain(hrA.user);
  });

  it('a user of another company cannot be named a fallback reviewer: same refusal as a user who does not exist, nothing stored', async () => {
    const before = await companyState(h, A.id);
    const url = '/v1/workflows/profile_change/fallback-reviewers';
    const foreign = await h.call(hrB, 'PUT', url, { reviewers: [{ userId: reviewerA.user, priority: 1 }] });
    const absent = await h.call(hrB, 'PUT', url, { reviewers: [{ userId: '00000000-0000-4000-8000-000000000009', priority: 1 }] });
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect([absent.statusCode, absent.json().error]).toEqual([foreign.statusCode, foreign.json().error]);
    expect(await reviewersOf(B, 'profile_change')).toEqual([]);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    // Positive control: the company's own user is accepted by the same call.
    const own = await h.call(hrB, 'PUT', url, { reviewers: [{ userId: reviewerB.user, priority: 1 }] });
    expect(own.statusCode, own.body).toBe(200);
    expect(await reviewersOf(B, 'profile_change')).toEqual([reviewerB.user]);
    // Company A's list is what it was.
    expect(await reviewersOf(A, 'profile_change')).toEqual([reviewerA.user]);
  });

  it('the company header cannot move a company B assignment into company A’s workflow administration', async () => {
    const before = await companyState(h, A.id);
    const replayed = { ...hrB, company: A };
    for (const [method, url, body] of [
      ['GET', '/v1/workflows', undefined],
      ['GET', '/v1/workflows/profile_change/candidates', undefined],
      ['GET', '/v1/workflows/stranded-tasks', undefined],
      ['PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: reviewerB.user, priority: 1 }] }],
    ] as const) {
      const res = await h.call(replayed, method, url, body);
      expect([res.statusCode, res.json().error], url).toEqual([403, 'FORBIDDEN']);
    }
    expect(changedTables(before, await companyState(h, A.id)).filter((t) => t !== 'audit_event')).toEqual([]);
    expect(await reviewersOf(A, 'profile_change')).toEqual([reviewerA.user]);
  });

  it('GET /workflows/stranded-tasks holds no task of another company', async () => {
    // A real stranded task in company A: its owner's manager changes while the task waits, so A's own list shows it.
    const world = leaveTasks(h, A, hrA);
    await world.activatePolicies();
    const firstBoss = await world.employee();
    const secondBoss = await world.employee();
    const firstManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: firstBoss });
    const owner = await world.employee(firstBoss);
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: owner }));
    const task = (await leaveQueue(h, firstManager)).find((t) => t.ownerEmployeeId === owner)!;
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    await world.setManager(owner, secondBoss, today);
    const inA = await h.call(hrA, 'GET', '/v1/workflows/stranded-tasks');
    expect(inA.statusCode, inA.body).toBe(200);
    expect(inA.body).toContain(task.taskId);

    const inB = await h.call(hrB, 'GET', '/v1/workflows/stranded-tasks');
    expect(inB.statusCode, inB.body).toBe(200);
    for (const value of [task.taskId, owner, firstManager.user]) expect(inB.body).not.toContain(value);
  });
});
