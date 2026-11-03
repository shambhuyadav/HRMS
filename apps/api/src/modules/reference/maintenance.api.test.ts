// Company maintenance of reference values (FR-004 "configurable entities"; DF04; DB006; BR-004; 0105): create, relabel,
// deactivate or end-date, audited, never delete; lists the code depends on stay protected; forms offer only what is in force.
// Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { isModuleActive } from '../registry.js';
import { createReferenceValue, updateReferenceValue } from './maintenance.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;
let hr: TestActor;
let adminB: TestActor;
let today: string;
let seq = 0;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const create = (by: TestActor, body: Record<string, unknown>) => h.call(by, 'POST', '/v1/reference-admin/values', body);
const docType = async (body: Record<string, unknown> = {}) => {
  const res = await create(admin, { category: 'DOCUMENT_TYPE', code: `TYPE_${++seq}`, label: 'Synthetic type', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; category: string; code: string; label: string; active: boolean; validFrom: string | null; validTo: string | null; version: number };
};
const patch = (by: TestActor, id: string, body: object) => h.call(by, 'PATCH', `/v1/reference-admin/values/${id}`, body);
const valueId = async (company: Company, category: string, code: string) =>
  (await h.one<{ id: string; version: number }>(`select id, version from reference_value where company_id = $1 and category = $2 and code = $3`, [company.id, category, code]));

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  adminB = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('creating and changing a value', () => {
  it('creates a value in the company only, normalising the code, audited', async () => {
    const res = await create(admin, { category: 'DOCUMENT_TYPE', code: ' passport ', label: ' Passport (synthetic) ' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ category: 'DOCUMENT_TYPE', code: 'PASSPORT', label: 'Passport (synthetic)', active: true, version: 1 });
    const audit = await h.one<{ action: string; actor_user_id: string; after_values: { operational: Record<string, unknown> } }>(`select action, actor_user_id, after_values from audit_event where record_key = $1`, [res.json().id]);
    expect(audit).toMatchObject({ action: 'CREATE', actor_user_id: admin.user });
    expect(audit.after_values.operational).toMatchObject({ category: 'DOCUMENT_TYPE', code: 'PASSPORT' });

    const codesIn = async (by: TestActor) => (await h.call(by, 'GET', '/v1/reference-admin/values?category=DOCUMENT_TYPE')).json().items.map((i: { code: string }) => i.code) as string[];
    expect(await codesIn(hr)).toContain('PASSPORT');
    expect(await codesIn(adminB)).not.toContain('PASSPORT');

    const again = await create(admin, { category: 'DOCUMENT_TYPE', code: 'PASSPORT', label: 'Again' });
    expect([again.statusCode, again.json().error]).toEqual([409, 'DUPLICATE']);
    // The other company has its own list.
    expect((await create(adminB, { category: 'DOCUMENT_TYPE', code: 'PASSPORT', label: 'B passport' })).statusCode).toBe(201);
  });

  it('two simultaneous creations of one code: exactly one wins', async () => {
    const results = await Promise.all([1, 2].map((n) => create(admin, { category: 'DOCUMENT_TYPE', code: 'RACED', label: `Raced ${n}` })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('relabels and deactivates with version checks and audit, and a no-op writes nothing', async () => {
    const v = await docType();
    expect((await patch(admin, v.id, { expectedVersion: 9, label: 'x' })).json().error).toBe('STALE_VERSION');
    const relabelled = await patch(admin, v.id, { expectedVersion: 1, label: 'Renamed (synthetic)' });
    expect(relabelled.json()).toMatchObject({ code: v.code, label: 'Renamed (synthetic)', version: 2 });

    const noOp = await patch(admin, v.id, { expectedVersion: 2, label: 'Renamed (synthetic)' });
    expect(noOp.json().version).toBe(2);

    const off = await patch(admin, v.id, { expectedVersion: 2, active: false });
    expect(off.json()).toMatchObject({ active: false, version: 3 });
    const on = await patch(admin, v.id, { expectedVersion: 3, active: true });
    expect(on.json()).toMatchObject({ active: true, version: 4 });

    const actions = (await h.db.query<{ action: string }>(`select action from audit_event where record_key = $1 order by occurred_at`, [v.id])).rows.map((r) => r.action);
    expect(actions).toEqual(['CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE']);
  });

  it('never deletes, and a value keeps its category and code, in the database too (0105)', async () => {
    const v = await docType();
    await expect(h.db.query(`delete from reference_value where id = $1`, [v.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update reference_value set code = 'OTHER_CODE' where id = $1`, [v.id])).rejects.toThrow(/keeps its category and code/);
    await expect(h.db.query(`truncate reference_value cascade`)).rejects.toMatchObject({ code: '23514' });
    // No route deletes one.
    const del = await h.app.inject({ method: 'DELETE', url: `/v1/reference-admin/values/${v.id}`, headers: { authorization: `Bearer ${admin.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: admin.assignment } });
    expect(del.statusCode).toBe(404);
    expect((await h.call(admin, 'GET', '/v1/reference-admin/values?category=DOCUMENT_TYPE')).json().items.map((i: { id: string }) => i.id)).toContain(v.id);
  });

  it('refuses a reversed period', async () => {
    const reversed = await create(admin, { category: 'DOCUMENT_TYPE', code: 'REVERSED', label: 'x', validFrom: '2026-06-01', validTo: '2026-06-01' });
    expect([reversed.statusCode, reversed.json().error]).toEqual([422, 'INVALID_PERIOD']);
    const v = await docType({ validFrom: '2026-06-01' });
    expect((await patch(admin, v.id, { expectedVersion: 1, validTo: '2026-05-01' })).json().error).toBe('INVALID_PERIOD');
  });
});

describe('protected lists', () => {
  it.each(['EMPLOYEE_STATUS', 'EMPLOYMENT_TYPE', 'ATTENDANCE_STATUS', 'PAYROLL_TAX_TREATMENT', 'PAYROLL_INPUT_KIND'])('%s cannot be added to or changed, and is shown read-only', async (category) => {
    const add = await create(admin, { category, code: 'NEW_VALUE', label: 'New' });
    expect([add.statusCode, add.json().error]).toEqual([422, 'REFERENCE_CATEGORY_PROTECTED']);
    const row = await h.db.query<{ id: string; version: number }>(`select id, version from reference_value where company_id = $1 and category = $2 limit 1`, [A.id, category]);
    if (row.rows[0]) {
      const { id, version } = row.rows[0];
      for (const change of [{ label: 'Renamed' }, { active: false }, { validTo: '2030-01-01' }]) {
        const res = await patch(admin, id, { expectedVersion: version, ...change });
        expect([res.statusCode, res.json().error]).toEqual([422, 'REFERENCE_CATEGORY_PROTECTED']);
      }
      expect((await h.one<{ version: number }>(`select version from reference_value where id = $1`, [id])).version).toBe(version);
    }
    const listed = (await h.call(admin, 'GET', '/v1/reference-admin/categories')).json().items as { category: string; maintainable: boolean }[];
    if (row.rows[0]) expect(listed.find((c) => c.category === category)).toMatchObject({ maintainable: false });
  });

  it('a list the code does not name cannot be started: no free text creates a master (DF04)', async () => {
    const res = await create(admin, { category: 'MADE_UP_LIST', code: 'X', label: 'x' });
    expect([res.statusCode, res.json().error]).toEqual([422, 'REFERENCE_CATEGORY_PROTECTED']);
  });

  it('a code the application uses by name can be relabelled but stays in force', async () => {
    const holiday = await valueId(A, 'HOLIDAY_TYPE', 'HOLIDAY');
    for (const change of [{ active: false }, { validTo: '2030-01-01' }, { validFrom: '2020-01-01' }]) {
      const res = await patch(admin, holiday.id, { expectedVersion: holiday.version, ...change });
      expect([res.statusCode, res.json().error]).toEqual([422, 'REFERENCE_CODE_PROTECTED']);
    }
    expect((await patch(admin, holiday.id, { expectedVersion: holiday.version, label: 'Public holiday (synthetic)' })).json().label).toBe('Public holiday (synthetic)');
    // Another value of that list is the company's own.
    const own = await create(admin, { category: 'HOLIDAY_TYPE', code: 'RESTRICTED', label: 'Restricted holiday' });
    expect((await patch(admin, own.json().id, { expectedVersion: 1, active: false })).json().active).toBe(false);
    const listed = (await h.call(admin, 'GET', '/v1/reference-admin/categories')).json().items as { category: string; maintainable: boolean; protectedCodes: string[] }[];
    expect(listed.find((c) => c.category === 'HOLIDAY_TYPE')).toEqual({ category: 'HOLIDAY_TYPE', maintainable: true, protectedCodes: ['HOLIDAY'] });
  });

  it('the database keeps the three lists the code matches by name switched on, whichever path writes (0105)', async () => {
    for (const [category, code] of [['EMPLOYEE_STATUS', 'DRAFT'], ['EMPLOYMENT_TYPE', 'PERMANENT'], ['ATTENDANCE_STATUS', 'PRESENT']] as const) {
      const { id } = await valueId(A, category, code);
      await expect(h.db.query(`update reference_value set active = false where id = $1`, [id])).rejects.toThrow(/cannot be deactivated or end-dated/);
      await expect(h.db.query(`update reference_value set valid_to = '2030-01-01' where id = $1`, [id])).rejects.toThrow(/cannot be deactivated or end-dated/);
    }
  });
});

describe('authority', () => {
  it('needs the manage duty and an unrestricted company grant; reading needs the read duty', async () => {
    const v = await docType();
    // HR Administrator reads the lists but does not change them.
    expect((await h.call(hr, 'GET', '/v1/reference-admin/categories')).statusCode).toBe(200);
    expect((await create(hr, { category: 'DOCUMENT_TYPE', code: 'BY_HR', label: 'x' })).statusCode).toBe(403);
    expect((await patch(hr, v.id, { expectedVersion: 1, label: 'x' })).statusCode).toBe(403);

    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await create(filtered, { category: 'DOCUMENT_TYPE', code: 'BY_FILTERED', label: 'x' })).statusCode).toBe(403);
    expect((await patch(filtered, v.id, { expectedVersion: 1, label: 'x' })).statusCode).toBe(403);

    const employee = await h.actor(A, 'EMPLOYEE');
    expect((await h.call(employee, 'GET', '/v1/reference-admin/values?category=DOCUMENT_TYPE')).statusCode).toBe(403);
  });

  it('another company’s value reads as missing', async () => {
    const v = await docType();
    expect((await patch(adminB, v.id, { expectedVersion: 1, label: 'Taken over' })).statusCode).toBe(404);
    expect((await h.one<{ label: string }>(`select label from reference_value where id = $1`, [v.id])).label).toBe('Synthetic type');
  });

  it('re-checks authority inside the transaction: a grant revoked after the route guard changes nothing', async () => {
    const v = await docType();
    const temp = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: temp.user, companyId: A.id, assignmentId: temp.assignment, resource: 'reference_value', action: 'manage', fieldGroups: ['operational'] })) as AccessGrant;
    expect(grant.allowed).toBe(true);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [temp.assignment]);
    await expect(withTransaction(h.pool, (tx) => createReferenceValue(tx, grant, { category: 'DOCUMENT_TYPE', code: 'AFTER_REVOKE', label: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => updateReferenceValue(tx, grant, v.id, { expectedVersion: 1, label: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.db.query(`select 1 from reference_value where company_id = $1 and code = 'AFTER_REVOKE'`, [A.id])).rowCount).toBe(0);
  });
});

describe('forms use what is in force (DF04)', () => {
  it('a holiday takes a type in force on its own date, not on the day it is entered', async () => {
    const type = await create(admin, { category: 'HOLIDAY_TYPE', code: 'SEASONAL', label: 'Seasonal', validFrom: '2026-06-01', validTo: '2026-09-01' });
    expect(type.statusCode, type.body).toBe(201);
    const holiday = (holidayDate: string) => h.call(hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate, name: 'Synthetic holiday', holidayType: 'SEASONAL' });
    expect((await holiday('2026-05-31')).statusCode).toBe(422);
    expect((await holiday('2026-09-01')).statusCode).toBe(422);
    expect((await holiday('2026-06-01')).statusCode).toBe(201);
    expect((await holiday('2026-08-31')).statusCode).toBe(201);
  });

  it('a document form refuses a type not yet in force, ended or deactivated', async () => {
    const future = await docType({ validFrom: addDays(today, 5) });
    const ended = await docType({ validTo: today });
    const running = await docType({ validFrom: today, validTo: addDays(today, 5) });
    const off = await docType();
    await patch(admin, off.id, { expectedVersion: 1, active: false });
    const inForce = (await h.db.query<{ code: string }>(`select code from reference_value_in_force where company_id = $1 and category = 'DOCUMENT_TYPE'`, [A.id])).rows.map((r) => r.code);
    expect(inForce).toContain(running.code);
    for (const v of [future, ended, off]) expect(inForce).not.toContain(v.code);
    // validOn asks the same question of any date.
    const on = async (date: string) => (await h.call(admin, 'GET', `/v1/reference-admin/values?category=DOCUMENT_TYPE&validOn=${date}`)).json().items.map((i: { code: string }) => i.code) as string[];
    expect(await on(addDays(today, 5))).toContain(future.code);
    expect(await on(addDays(today, 5))).not.toContain(running.code);
  });

  it.runIf(isModuleActive('training'))('a form list drops a value when it ends, and a record already using it keeps its label', async () => {
    const trainer = await h.actor(A, 'TRAINING_COORDINATOR');
    const modes = async () => (await h.call(trainer, 'GET', '/v1/training-modes')).json().items.map((i: { code: string }) => i.code) as string[];
    const created = await create(admin, { category: 'TRAINING_MODE', code: 'BLENDED', label: 'Blended (synthetic)' });
    expect(created.statusCode, created.body).toBe(201);
    expect(await modes()).toContain('BLENDED');
    expect((await patch(admin, created.json().id, { expectedVersion: 1, validTo: today })).statusCode).toBe(200);
    expect(await modes()).not.toContain('BLENDED');
    // Still on record for what references it.
    expect((await h.call(admin, 'GET', '/v1/reference-admin/values?category=TRAINING_MODE')).json().items.map((i: { code: string }) => i.code)).toContain('BLENDED');
  });
});
