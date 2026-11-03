// Grant list for administration over HTTP (FR-066/067; C4; DF02): scope containment and what an approver sees.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let sysAdmin: TestActor;
let engUser: TestActor;
let finUser: TestActor;

type Grant = { id: string; userId: string; userAccountKey: string; requestedByAccountKey: string | null; filters: { departments: string[]; locations: string[]; employees: string[] }; state: string };
const grants = async (a: TestActor, query = '') => (await h.call(a, 'GET', `/v1/access/assignments${query}`)).json() as { items: Grant[] };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const eng = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  const fin = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept }))).json().id;
  engUser = await h.actor(A, 'EMPLOYEE', { employeeId: eng });
  finUser = await h.actor(A, 'EMPLOYEE', { employeeId: fin });
});

afterAll(async () => {
  await h?.stop();
});

describe('grant list (C4)', () => {
  it('shows each grant with its scope filters and the accounts involved', async () => {
    const proposed = await h.call(sysAdmin, 'POST', '/v1/access/assignments', {
      userId: engUser.user,
      roleCode: 'HR_ADMINISTRATOR',
      effectiveFrom: '2026-01-01T00:00:00Z',
      filters: { departments: [A.dept] },
    });
    expect(proposed.statusCode).toBe(201);
    const item = (await grants(sysAdmin, `?userId=${engUser.user}&state=PENDING`)).items[0]!;
    const sysKey = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [sysAdmin.user])).account_key;
    expect(item).toMatchObject({ id: proposed.json().id, state: 'PENDING', requestedByAccountKey: sysKey, filters: { departments: [A.dept], locations: [], employees: [] } });
    expect(item.userAccountKey).toBeTruthy();
  });

  it('a department-filtered administrator sees only grants of users inside the filter; outside company scope is refused', async () => {
    const engAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    const users = new Set((await grants(engAdmin)).items.map((g) => g.userId));
    expect(users.has(engUser.user)).toBe(true);
    expect(users.has(finUser.user)).toBe(false);
    expect(users.has(sysAdmin.user)).toBe(false); // unlinked accounts are outside a filtered scope

    // C2 fixes System Administrator at company scope, so a role C2 does not name stands in.
    const narrow = await h.customActor(A, { scope: 'TEAM', permissions: ['access.read_users.operational'] });
    expect((await h.call(narrow, 'GET', '/v1/access/assignments')).statusCode).toBe(403);
  });

  it('refuses a grant that ends before it starts, and the session context names the user', async () => {
    const res = await h.call(sysAdmin, 'POST', '/v1/access/assignments', {
      userId: finUser.user,
      roleCode: 'TRAINING_COORDINATOR',
      effectiveFrom: '2026-02-01T00:00:00Z',
      effectiveTo: '2026-01-01T00:00:00Z',
    });
    expect(res.json().error).toBe('INVALID_PERIOD');
    expect((await h.call(sysAdmin, 'GET', '/v1/me/context')).json().userId).toBe(sysAdmin.user);
  });
});
