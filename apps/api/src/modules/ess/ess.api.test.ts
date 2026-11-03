// My ESS index (FR-103; H3 TN01–TN18; H1/BR-053; BR-055). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let employee: TestActor;
let limited: TestActor;
let employeeEmp: string;

type Tab = { id: string; name: string; section: string; status: string; unavailable?: { code: string }; links: { rel: string; href: string }[] };
const ess = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/ess')).json() as { context: Record<string, unknown>; tabs: Tab[] };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  employeeEmp = await person();
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  limited = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
  // A switched-off duty: this employee's assignment no longer holds the expense duties (DB109 allowlist).
  await h.db.query(
    `update role_assignment_permission rap set active = false from permission p
      where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = 'expense'`,
    [limited.assignment],
  );
});

afterAll(async () => {
  await h?.stop();
});

describe('My ESS index (FR-103)', () => {
  it('lists all 18 tabs in H3 order with the own-record context', async () => {
    const body = await ess(employee);
    expect(body.tabs.map((t) => t.id)).toEqual(Array.from({ length: 18 }, (_, i) => `TN${String(i + 1).padStart(2, '0')}`));
    expect(body.context).toMatchObject({ employeeId: employeeEmp, roleCode: 'EMPLOYEE', scopeKind: 'OWN' });
    const by = Object.fromEntries(body.tabs.map((t) => [t.id, t]));
    for (const id of ['TN01', 'TN02', 'TN03', 'TN04', 'TN10', 'TN11', 'TN12', 'TN14']) expect(by[id]!.status, id).toBe('AVAILABLE');
    // TN06 and TN15 are served by the payroll-outputs module (own issued payslips, own loans; its own tests pin the routes).
    for (const id of ['TN06', 'TN15']) expect(by[id]!.status, id).toBe('AVAILABLE');
    // Not built yet: a named unavailable state and no link anywhere.
    for (const id of ['TN07', 'TN08', 'TN09']) {
      expect(by[id]!.status, id).toBe('UNAVAILABLE');
      expect(by[id]!.unavailable?.code, id).toMatch(/_NOT_ENABLED$/);
      expect(by[id]!.links, id).toEqual([]);
    }
    // Served by business modules (their registration's essTabs); the assets module's own tests pin TN16.
    for (const id of ['TN13', 'TN16', 'TN17', 'TN18']) expect(['UNAVAILABLE', 'AVAILABLE', 'NOT_PERMITTED']).toContain(by[id]!.status);
    // Links point only at the caller's own record or own-context endpoints.
    for (const t of body.tabs) {
      for (const l of t.links) {
        expect(l.href, `${t.id} ${l.rel}`).toMatch(/^\/v1\/(me\/|employees\/[0-9a-f-]{36}(\/|$)|leave\/requests$|expense\/claims$)/);
        if (l.href.startsWith('/v1/employees/')) expect(l.href).toContain(employeeEmp);
      }
    }
  });

  it('shows a switched-off duty as not permitted, without links', async () => {
    const tab = (await ess(limited)).tabs.find((t) => t.id === 'TN14')!;
    expect(tab).toMatchObject({ status: 'NOT_PERMITTED', links: [] });
  });

  it('needs the Employee OWN context (BR-055)', async () => {
    const res = await h.call(hr, 'GET', '/v1/me/ess');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
  });

  it('lists own requests of every kind with pending reviewer and decision history, never reviewer comments (FR-109)', async () => {
    expect((await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
    const asked = await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: 'Synthetic Renamed' });
    expect(asked.statusCode).toBe(201);
    const pending = ((await h.call(employee, 'GET', '/v1/me/requests')).json().items as Record<string, unknown>[]).find((r) => r.requestId === asked.json().requestId)!;
    expect(pending).toMatchObject({ kind: 'profile_change', state: 'SUBMITTED', decisions: [] });
    expect(typeof pending.pendingWith).toBe('string');

    const task = ((await h.call(hr, 'GET', '/v1/profile-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } }[]).find((t) => t.request.id === asked.json().requestId)!;
    const decided = await h.call(hr, 'POST', `/v1/profile-changes/tasks/${task.taskId}/decision`, { decision: 'REJECT', reason: 'Synthetic private reviewer note', idempotencyKey: 'ess-test-reject-1' });
    expect(decided.statusCode).toBe(200);
    const mine = (await h.call(employee, 'GET', '/v1/me/requests?kind=profile_change')).json().items as Record<string, unknown>[];
    expect(mine.find((r) => r.requestId === asked.json().requestId)).toMatchObject({ state: 'REJECTED', pendingWith: null, decisions: [{ step: 1, decision: 'REJECT', revision: 1 }] });
    expect(JSON.stringify(mine)).not.toContain('Synthetic private reviewer note');
    // Only the caller's own requests, only in the Employee OWN context.
    expect(((await h.call(limited, 'GET', '/v1/me/requests')).json().items as unknown[]).length).toBe(0);
    expect((await h.call(hr, 'GET', '/v1/me/requests')).json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
  });

  it('pages own requests newest first with the total; without paging the capped answer also reports the total (FR-056)', async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    const own = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    // 27 closed profile changes a minute apart (fixture rows: each transaction with its root, in one commit).
    await h.db.query('begin');
    try {
      await h.db.query(
        `insert into business_transaction (company_id, kind, owner_employee_id, state, created_at)
         select $1, 'profile_change', $2, 'SUBMITTED', now() - make_interval(mins => g) from generate_series(1, 27) g`,
        [A.id, e.id],
      );
      await h.db.query(
        `insert into profile_change_request (company_id, employee_id, transaction_id, requested, current_values, state)
         select company_id, owner_employee_id, id, '{"displayName": "Synthetic Name"}', '{}', 'WITHDRAWN'
           from business_transaction where company_id = $1 and owner_employee_id = $2 and kind = 'profile_change'`,
        [A.id, e.id],
      );
      await h.db.query(`update business_transaction set state = 'WITHDRAWN' where company_id = $1 and owner_employee_id = $2 and kind = 'profile_change'`, [A.id, e.id]);
      await h.db.query('commit');
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
    type Listed = { items: { transactionId: string; requestId: string | null; createdAt: string }[]; total: number; page?: number; pageSize?: number };
    const list = async (query: string) => {
      const res = await h.call(own, 'GET', `/v1/me/requests${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Listed;
    };
    const ids = (l: Listed) => l.items.map((x) => x.transactionId);

    const unpaged = await list('');
    expect(unpaged.total).toBe(27);
    expect(unpaged.items).toHaveLength(27);
    expect(unpaged).not.toHaveProperty('page');
    expect(unpaged.items.map((x) => x.createdAt)).toEqual(unpaged.items.map((x) => x.createdAt).sort().reverse());
    const first = await list('?page=1&pageSize=25');
    expect(first).toMatchObject({ total: 27, page: 1, pageSize: 25 });
    expect(ids(first)).toEqual(ids(unpaged).slice(0, 25));
    const second = await list('?kind=profile_change&page=2&pageSize=25');
    expect(second).toMatchObject({ total: 27, page: 2, pageSize: 25 });
    expect(ids(second)).toEqual(ids(unpaged).slice(25));
    expect(second.items.every((x) => x.requestId !== null)).toBe(true);
    expect(await list('?kind=leave_request&page=1&pageSize=25')).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    expect(await list('?kind=no_such_kind')).toEqual({ items: [], total: 0 });
    expect((await h.call(own, 'GET', '/v1/me/requests?pageSize=10')).statusCode).toBe(400);
  });

  it('lists the own-ESS permissions of the Employee assignment, and no other confidential group', async () => {
    const own = (await h.call(employee, 'GET', '/v1/me/permissions')).json().permissions as string[];
    expect(own).toEqual(expect.arrayContaining(['employee.read.personal', 'employee.read.private', 'sensitive_change.submit.private', 'leave.read.reason']));
    // HR's default duties hold no confidential group, so none is listed for its assignment.
    const hrKeys = (await h.call(hr, 'GET', '/v1/me/permissions')).json().permissions as string[];
    expect(hrKeys).not.toContain('employee.read.private');
  });
});
