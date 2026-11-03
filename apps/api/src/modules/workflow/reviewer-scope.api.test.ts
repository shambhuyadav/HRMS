// Reviewer selection respects the reviewer's row scope (DF03 "select a scoped HR Administrator with the appropriate
// decision grant from an explicit fallback list"): a task never goes to someone who could not open it. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runReminders } from '../notification/reminders.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrFinanceOnly: TestActor;
let hrCompany: TestActor;

const setList = (reviewers: TestActor[]) =>
  h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });

/** A new engineering employee (outside the finance-only reviewer's scope) asks for a profile change. */
async function engineeringRequest() {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
  return h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: `Renamed ${uniq('S')} (synthetic)` });
}
const taskCount = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/profile-changes/tasks/mine')).json().items as unknown[]).length;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrFinanceOnly = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
  hrCompany = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('fallback reviewers are chosen within their row scope (DF03)', () => {
  it('the list accepts a department-filtered reviewer, who is eligible in general', async () => {
    expect((await setList([hrFinanceOnly, hrCompany])).statusCode).toBe(200);
  });

  it('skips a listed reviewer whose scope does not cover the employee and routes to the next one', async () => {
    expect((await setList([hrFinanceOnly, hrCompany])).statusCode).toBe(200);
    expect((await engineeringRequest()).statusCode).toBe(201);
    expect(await taskCount(hrFinanceOnly)).toBe(0);
    expect(await taskCount(hrCompany)).toBe(1);
  });

  it('an escalation about an employee reaches only the list members whose scope covers that employee (DF02)', async () => {
    expect((await setList([hrFinanceOnly, hrCompany])).statusCode).toBe(200);
    expect((await engineeringRequest()).statusCode).toBe(201);
    // Older than the DF03 escalation threshold, counted in business days (creation metadata is immutable, so the
    // backdating bypasses triggers in this test's own database).
    await withTransaction(h.pool, async (tx) => {
      await tx.query(`set local session_replication_role = replica`);
      await tx.query(`update approval_task set created_at = now() - interval '20 days' where company_id = $1 and assignee_user_id = $2 and state = 'PENDING'`, [A.id, hrCompany.user]);
    });
    await runReminders(h.pool, A.id);
    const recipients = (
      await h.db.query<{ u: string }>(`select recipient_user_id as u from notification where company_id = $1 and category = 'APPROVAL_ESCALATION'`, [A.id])
    ).rows.map((r) => r.u);
    expect(recipients).toContain(hrCompany.user);
    expect(recipients).not.toContain(hrFinanceOnly.user);
  });

  it('refuses to route when no listed reviewer can open the request, instead of assigning an unreachable task', async () => {
    expect((await setList([hrFinanceOnly])).statusCode).toBe(200);
    const res = await engineeringRequest();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('NO_ELIGIBLE_REVIEWER');
    expect(await taskCount(hrFinanceOnly)).toBe(0);
  });
});
