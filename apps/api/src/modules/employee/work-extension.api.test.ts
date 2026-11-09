// DF16 "Search includes permitted work email/extension" (I-62 item 7, I-83 item 5; decided under owner delegation, 6 Nov 2026,
// docs/03 I-89 item 5; 0240): an optional work phone extension on the employee record, operational like the work email, digits
// only and at most 8. HR enters and changes it with the work email's right; the employee and My Team lists show it and their
// searches match it; the field dictionary names it. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

describe('work phone extension (DF16; I-89 item 5)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let managerEmp: string;
  let manager: TestActor;

  const create = (overrides: Record<string, unknown>) => h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  const read = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/employees/${id}`)).json() as { version: number; workPhoneExtension: string | null };
  const reporting = async (id: string) => {
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    const m = await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const boss = await create({ displayName: 'Synthetic Extension Lead' });
    managerEmp = boss.json().id;
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('is entered with the record, read with it, changed and cleared by HR, and audited as an operational field', async () => {
    const created = await create({ displayName: 'Synthetic Extension Holder', workPhoneExtension: ' 40217 ' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    expect(created.json().workPhoneExtension).toBe('40217');
    expect((await create({ displayName: 'Synthetic No Extension' })).json().workPhoneExtension).toBeNull();

    const changed = await h.call(hr, 'PATCH', `/v1/employees/${id}`, { expectedVersion: (await read(hr, id)).version, workPhoneExtension: '7' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().workPhoneExtension).toBe('7');
    const audit = await h.one<{ before_values: Record<string, Record<string, unknown>>; after_values: Record<string, Record<string, unknown>> }>(
      `select before_values, after_values from audit_event where company_id = $1 and resource_code = 'employee' and record_key = $2 and action = 'UPDATE' order by occurred_at desc limit 1`,
      [A.id, id],
    );
    expect(audit).toEqual({ before_values: { operational: { workPhoneExtension: '40217' } }, after_values: { operational: { workPhoneExtension: '7' } } });

    const cleared = await h.call(hr, 'PATCH', `/v1/employees/${id}`, { expectedVersion: (await read(hr, id)).version, workPhoneExtension: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().workPhoneExtension).toBeNull();

    // The employee reads their own extension; a manager without the update right cannot change it.
    await reporting(id);
    const own = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    expect((await read(own, id)).workPhoneExtension).toBeNull();
    expect((await h.call(manager, 'PATCH', `/v1/employees/${id}`, { expectedVersion: (await read(hr, id)).version, workPhoneExtension: '12' })).statusCode).toBe(403);
  });

  it('is digits only, at most 8, at the route and in the database', async () => {
    for (const bad of ['12a4', '123456789', '+91', '12-34', '']) {
      const res = await create({ workPhoneExtension: bad });
      expect(res.statusCode, `${JSON.stringify(bad)}: ${res.body}`).toBe(400);
    }
    const ok = (await create({ workPhoneExtension: '12345678' })).json();
    expect(ok.workPhoneExtension).toBe('12345678');
    expect((await h.call(hr, 'PATCH', `/v1/employees/${ok.id}`, { expectedVersion: ok.version, workPhoneExtension: '9x' })).statusCode).toBe(400);
    // Every writer: the database refuses a value outside the rule.
    await expect(h.db.query(`update employee set work_phone_extension = '123456789' where id = $1`, [ok.id])).rejects.toMatchObject({ code: '23514', constraint: 'employee_work_phone_extension_digits' });
    await expect(h.db.query(`update employee set work_phone_extension = '' where id = $1`, [ok.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('the employee list and My Team show it and their searches match it, as they match the work email', async () => {
    const member = (await create({ displayName: 'Synthetic Searchable Member', workPhoneExtension: '86420' })).json().id as string;
    const other = (await create({ displayName: 'Synthetic Other Member', workPhoneExtension: '13579' })).json().id as string;
    await reporting(member);
    await reporting(other);

    const employees = (await h.call(hr, 'GET', '/v1/employees?search=8642')).json() as { items: { id: string; workPhoneExtension: string | null }[]; total: number };
    expect(employees.items.map((e) => e.id)).toEqual([member]);
    expect(employees).toMatchObject({ total: 1, items: [{ workPhoneExtension: '86420' }] });

    const team = (await h.call(manager, 'GET', '/v1/my-team?search=8642')).json() as { items: { id: string; workPhoneExtension: string | null }[]; total: number };
    expect(team).toMatchObject({ total: 1, items: [{ id: member, workPhoneExtension: '86420' }] });
    // The team member's work profile carries it too; the search's wildcards are literal characters.
    expect((await h.call(manager, 'GET', `/v1/my-team/${member}`)).json().tabs.workProfile.data.workPhoneExtension).toBe('86420');
    expect((await h.call(manager, 'GET', '/v1/my-team?search=86_20')).json().total).toBe(0);
    expect((await h.call(hr, 'GET', '/v1/employees?search=%25')).json().items.some((e: { id: string }) => e.id === member)).toBe(false);
  });

  it('the field dictionary names it as an operational record field', async () => {
    const dictionary = (await h.call(hr, 'GET', '/v1/employee-record-dictionary')).json();
    expect(dictionary.recordFields).toEqual([
      expect.objectContaining({ name: 'workPhoneExtension', kind: 'digits', required: false, maxLength: 8, classification: 'OPERATIONAL', read: 'employee.read.operational', change: 'employee.update.operational', searchable: true }),
    ]);
    // The confidential sections are unchanged.
    expect((dictionary.sections as { key: string }[]).map((s) => s.key).sort()).toEqual(['family-members', 'payroll-identifiers', 'prior-employments', 'qualifications']);
  });
});
