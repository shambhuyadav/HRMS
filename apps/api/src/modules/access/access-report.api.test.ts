// The user access register (0310; BRD role matrix "System Administrator | ... access reviews"): a default duty of the System
// Administrator, one row per role assignment of the company, access metadata only. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

async function report(a: TestActor, filters: object = {}) {
  const requested = await h.call(a, 'POST', '/v1/reports', { reportCode: 'USER_ACCESS', filters });
  expect(requested.statusCode, requested.body).toBe(202);
  await processReportQueue(h.pool);
  const file = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
  return { body: file.body, header: header!, rows: rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!]))) };
}
const accountOf = async (a: TestActor) => (await h.one<{ k: string }>(`select account_key as k from user_account where id = $1`, [a.user])).k;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('user access register (0310)', () => {
  it('is offered to a System Administrator by default and not to an HR Administrator', async () => {
    const codes = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
    expect(await codes(admin)).toContain('USER_ACCESS');
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    expect(await codes(hr)).not.toContain('USER_ACCESS');
    const refused = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'USER_ACCESS', filters: {} });
    expect(refused.statusCode).toBe(403);
  });

  it('lists every assignment of the company with its employee, scope, restrictions, state and approver, and nothing of another company', async () => {
    const hrCreator = await h.actor(A, 'HR_ADMINISTRATOR');
    const created = await h.call(hrCreator, 'POST', '/v1/employees', h.newEmployeeBody(A));
    expect(created.statusCode, created.body).toBe(201);
    const employee = created.json() as { id: string; employeeCode: string; displayName: string };
    const employeeId = employee.id;
    const linked = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId });
    const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const elsewhere = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
    // A grant still waiting for its independent approver, with a purpose the register must not carry.
    await h.db.query(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by, purpose)
       select $1, $2, r.id, 'COMPANY', '2026-01-01T00:00:00Z', 'PENDING', $3, 'SECRET-PURPOSE synthetic' from role r where r.company_id = $1 and r.code = 'HR_ADMINISTRATOR'`,
      [A.id, await h.makeUser(), admin.user],
    );

    const { header, rows, body } = await report(admin);
    expect(header).toEqual([
      'Account',
      'Account status',
      'Employee code',
      'Employee',
      'Role',
      'Scope',
      'Restrictions',
      'Permissions',
      'Grant state',
      'From',
      'Until (not included)',
      'Requested by',
      'Approved by',
      'Approved at (company time)',
    ]);
    const row = async (a: TestActor) => {
      const account = await accountOf(a);
      return rows.find((r) => r.Account === account);
    };
    const own = (await row(admin))!;
    expect(own).toMatchObject({ 'Account status': 'Active', Role: 'System Administrator', Scope: 'Company-wide', Restrictions: 'None', 'Grant state': 'Approved' });
    expect(Number(own.Permissions)).toBeGreaterThan(0);
    expect(own['Approved by']).not.toBe('');
    expect(own['Approved at (company time)']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(await row(linked)).toMatchObject({ 'Employee code': employee.employeeCode, Employee: employee.displayName, Role: 'HR Administrator' });
    expect((await row(filtered))!.Restrictions).toBe('1 department');
    const pending = rows.filter((r) => r['Grant state'] === 'Waiting for approval');
    expect(pending).toHaveLength(1);
    expect(pending[0]!['Approved by']).toBe('');
    expect(pending[0]!['Requested by']).toBe(await accountOf(admin));
    expect(await row(elsewhere)).toBeUndefined();
    expect(body).not.toContain('SECRET-PURPOSE');
  });

  it('applies the grant state filter and refuses an unknown one', async () => {
    const { rows } = await report(admin, { status: 'PENDING' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r['Grant state'] === 'Waiting for approval')).toBe(true);
    const bad = await h.call(admin, 'POST', '/v1/reports', { reportCode: 'USER_ACCESS', filters: { status: 'ANYTHING' } });
    expect(bad.statusCode).toBe(422);
  });

  it('is not offered to a System Administrator restricted to part of the company', async () => {
    const restricted = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    const codes = ((await h.call(restricted, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
    expect(codes).not.toContain('USER_ACCESS');
    const refused = await h.call(restricted, 'POST', '/v1/reports', { reportCode: 'USER_ACCESS', filters: {} });
    expect(refused.statusCode).toBe(403);
  });
});
