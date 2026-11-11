// State, city, qualification and bank masters (BRD coverage CL-005 "State Master", CL-006 "City Master", CL-007 "Qualification Master",
// CL-010 "Bank Master", under FR-004; DF04 controlled lists; DF09 bulk upload; BR-004 never deleted; FR-057 audit; migration 0280).
// The flat lists are reference values (reference/maintenance.ts); a city has its own table and routes (org/cities.ts). Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { STATES_OF_INDIA } from './masters-registration.js';

let h: Harness;
let A: Company;
let B: Company;
let admin: TestActor;
let hr: TestActor;
let scopedAdmin: TestActor;
let adminB: TestActor;
let employee: TestActor;

const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`).toString('base64');
const HEADER = 'stateCode,cityCode,cityName';
type City = { id: string; country: string; stateCode: string; stateName: string; code: string; name: string; active: boolean; validFrom: string | null; validTo: string | null; version: number };
const addCity = (a: TestActor, body: object) => h.call(a, 'POST', '/v1/org/cities', body);
const cities = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `/v1/org/cities${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as City[];
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.manage.private'] });
  scopedAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
  adminB = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  const created = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A));
  expect(created.statusCode, created.body).toBe(201);
  const emp = created.json() as { id: string };
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp.id });
});

afterAll(async () => {
  await h?.stop();
});

describe('CL-005, CL-007, CL-010 the state, qualification and bank lists (DF04)', () => {
  it('CL-005: every company has the 36 states and union territories of India, served to the city screen under the master read permission', async () => {
    const seeded = await h.db.query<{ code: string; label: string }>(`select code, label from reference_value where company_id = $1 and category = 'STATE_IN' order by code`, [A.id]);
    expect(seeded.rows).toHaveLength(36);
    expect(Object.keys(STATES_OF_INDIA)).toHaveLength(36);
    expect(seeded.rows.find((r) => r.code === 'MH')).toEqual({ code: 'MH', label: 'Maharashtra' });
    // The professional tax packs' state codes (0220) are states of the list.
    for (const code of ['MH', 'KA']) expect(seeded.rows.map((r) => r.code)).toContain(code);

    const served = await h.call(hr, 'GET', '/v1/reference-values?category=STATE_IN');
    expect(served.statusCode, served.body).toBe(200);
    expect(served.json().items).toHaveLength(36);
    expect((await h.call(employee, 'GET', '/v1/reference-values?category=STATE_IN')).statusCode).toBe(403);
  });

  it('CL-005, CL-007, CL-010: the state, qualification and bank lists are maintained on the reference values screen, audited, never deleted', async () => {
    const listed = (await h.call(admin, 'GET', '/v1/reference-admin/categories')).json().items as { category: string; maintainable: boolean }[];
    for (const category of ['STATE_IN', 'BANK', 'QUALIFICATION']) expect(listed.find((c) => c.category === category)).toMatchObject({ maintainable: true });

    // CL-010: a bank name with an active flag; nothing is seeded, the company adds its own.
    expect((await h.call(admin, 'GET', '/v1/reference-admin/values?category=BANK')).json().items).toEqual([]);
    const bank = await h.call(admin, 'POST', '/v1/reference-admin/values', { category: 'BANK', code: 'SYNTH_BANK', label: 'Synthetic Bank Ltd' });
    expect(bank.statusCode, bank.body).toBe(201);
    const off = await h.call(admin, 'PATCH', `/v1/reference-admin/values/${bank.json().id}`, { expectedVersion: 1, active: false });
    expect(off.json()).toMatchObject({ code: 'SYNTH_BANK', active: false });
    const actions = (await h.db.query<{ action: string }>(`select action from audit_event where record_key = $1 order by occurred_at, id`, [bank.json().id])).rows.map((r) => r.action);
    expect(actions).toEqual(['CREATE', 'DEACTIVATE']);
    // Company B's list is its own.
    expect((await h.call(adminB, 'GET', '/v1/reference-admin/values?category=BANK&includeInactive=true')).json().items).toEqual([]);

    // CL-005: a state can be relabelled or deactivated like any maintained value.
    const ladakh = await h.one<{ id: string; version: number }>(`select id, version from reference_value where company_id = $1 and category = 'STATE_IN' and code = 'LA'`, [A.id]);
    const renamed = await h.call(admin, 'PATCH', `/v1/reference-admin/values/${ladakh.id}`, { expectedVersion: ladakh.version, label: 'Ladakh (UT)' });
    expect(renamed.json()).toMatchObject({ code: 'LA', label: 'Ladakh (UT)' });

    // CL-007: the qualification names are served to whoever maintains the qualification section.
    const quals = await h.call(hr, 'GET', '/v1/reference-values?category=QUALIFICATION');
    expect(quals.statusCode, quals.body).toBe(200);
    expect((quals.json().items as { code: string; label: string }[]).map((q) => q.code)).toEqual(expect.arrayContaining(['BTECH', 'MBA', 'PHD']));
    expect((await h.call(await h.actor(A, 'HR_ADMINISTRATOR'), 'GET', '/v1/reference-values?category=QUALIFICATION')).statusCode).toBe(403);
  });
});

describe('CL-006 the city master', () => {
  it('CL-006 BR-004: a city has a state, a code unique within it, a name and a period; it is renamed and deactivated, never deleted, all audited', async () => {
    const pune = await addCity(admin, { stateCode: 'mh', code: ' pune ', name: ' Pune ' });
    expect(pune.statusCode, pune.body).toBe(201);
    expect(pune.json()).toMatchObject({ country: 'IN', stateCode: 'MH', stateName: 'Maharashtra', code: 'PUNE', name: 'Pune', active: true, version: 1 });

    const again = await addCity(admin, { stateCode: 'MH', code: 'PUNE', name: 'Pune again' });
    expect([again.statusCode, again.json().error]).toEqual([409, 'DUPLICATE']);
    // The same code under another state is another city (Aurangabad is in Maharashtra and in Bihar).
    expect((await addCity(admin, { stateCode: 'MH', code: 'AURANGABAD', name: 'Aurangabad' })).statusCode).toBe(201);
    expect((await addCity(admin, { stateCode: 'BR', code: 'AURANGABAD', name: 'Aurangabad' })).statusCode).toBe(201);

    for (const [body, code] of [
      [{ stateCode: 'ZZ', code: 'NOWHERE', name: 'Nowhere' }, 'UNKNOWN_STATE'],
      [{ stateCode: 'MH', code: '-BAD', name: 'Bad code' }, 'INVALID_CITY_CODE'],
      [{ stateCode: 'MH', code: 'BLANK', name: '   ' }, 'INVALID_CITY_NAME'],
      [{ stateCode: 'MH', code: 'LATE', name: 'Late', validFrom: '2026-05-01', validTo: '2026-04-01' }, 'INVALID_PERIOD'],
    ] as const) {
      const res = await addCity(admin, body);
      expect([res.statusCode, res.json().error], JSON.stringify(body)).toEqual([422, code]);
    }

    const listed = await cities(hr, '?state=MH');
    expect(listed.map((c) => c.code)).toEqual(['AURANGABAD', 'PUNE']);
    expect((await cities(hr)).map((c) => `${c.stateCode}/${c.code}`)).toEqual(['BR/AURANGABAD', 'MH/AURANGABAD', 'MH/PUNE']);

    const id = pune.json().id as string;
    const renamed = await h.call(admin, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 1, name: 'Pune (Poona)' });
    expect(renamed.json()).toMatchObject({ name: 'Pune (Poona)', version: 2 });
    const stale = await h.call(admin, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 1, active: false });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'STALE_VERSION']);
    const off = await h.call(admin, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 2, active: false });
    expect(off.json()).toMatchObject({ active: false, version: 3 });
    expect((await cities(hr, '?state=MH')).map((c) => c.code)).toEqual(['AURANGABAD']);
    expect((await cities(hr, '?state=MH&includeInactive=true')).map((c) => c.code)).toEqual(['AURANGABAD', 'PUNE']);
    // Nothing to change writes nothing.
    expect((await h.call(admin, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 3, active: false })).json()).toMatchObject({ version: 3 });

    const trail = (await h.db.query<{ action: string; resource_code: string }>(`select action, resource_code from audit_event where record_key = $1 order by occurred_at, id`, [id])).rows;
    expect(trail).toEqual([
      { action: 'CREATE', resource_code: 'org_master' },
      { action: 'UPDATE', resource_code: 'org_master' },
      { action: 'DEACTIVATE', resource_code: 'org_master' },
    ]);
    // The database keeps a city's state and code and refuses a delete.
    await expect(h.db.query(`update city set code = 'OTHER' where id = $1`, [id])).rejects.toThrow(/keeps its state and code/);
    await expect(h.db.query(`delete from city where id = $1`, [id])).rejects.toThrow();
  });

  it('CL-006: no city is added under a state that is inactive or not yet in force; its existing cities stay', async () => {
    expect((await addCity(admin, { stateCode: 'GA', code: 'PANAJI', name: 'Panaji' })).statusCode).toBe(201);
    const goa = await h.one<{ id: string; version: number }>(`select id, version from reference_value where company_id = $1 and category = 'STATE_IN' and code = 'GA'`, [A.id]);
    expect((await h.call(admin, 'PATCH', `/v1/reference-admin/values/${goa.id}`, { expectedVersion: goa.version, active: false })).statusCode).toBe(200);
    const res = await addCity(admin, { stateCode: 'GA', code: 'MARGAO', name: 'Margao' });
    expect([res.statusCode, res.json().error]).toEqual([422, 'STATE_NOT_IN_FORCE']);
    expect((await cities(hr, '?state=GA')).map((c) => c.code)).toEqual(['PANAJI']);
  });

  it('CL-006 BR-004: only an unrestricted company-scope holder of the master duties changes cities; reading needs the read duty; companies are isolated', async () => {
    const res = await addCity(admin, { stateCode: 'KA', code: 'MYSURU', name: 'Mysuru' });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    // The HR Administrator reads masters but does not change them.
    expect((await addCity(hr, { stateCode: 'KA', code: 'HUBLI', name: 'Hubli' })).statusCode).toBe(403);
    expect((await h.call(hr, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 1, name: 'Mysore' })).statusCode).toBe(403);
    // A department-filtered master holder is refused: masters are company-wide.
    expect((await addCity(scopedAdmin, { stateCode: 'KA', code: 'HUBLI', name: 'Hubli' })).statusCode).toBe(403);
    expect((await h.call(scopedAdmin, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 1, name: 'Mysore' })).statusCode).toBe(403);
    expect((await h.call(employee, 'GET', '/v1/org/cities')).statusCode).toBe(403);
    // Another company neither sees nor changes it.
    expect((await cities(adminB)).map((c) => c.code)).not.toContain('MYSURU');
    expect((await h.call(adminB, 'PATCH', `/v1/org/cities/${id}`, { expectedVersion: 1, name: 'Mysore' })).statusCode).toBe(404);
    expect((await h.one<{ name: string }>(`select name from city where id = $1`, [id])).name).toBe('Mysuru');
  });

  it('CL-006 DF09: the bulk upload previews without writing, commits all or nothing once, and refuses repeats, unknown states and cities on record', async () => {
    const key = uniq('city-key-');
    const lines = [HEADER, 'TN,CHENNAI,Chennai', 'tn,coimbatore,Coimbatore', 'KL,KOCHI,Kochi'];
    const staged = await h.call(admin, 'POST', '/v1/org/city-imports', { fileName: 'cities.csv', contentBase64: csv(lines), idempotencyKey: key });
    expect(staged.statusCode, staged.body).toBe(201);
    expect(staged.json()).toMatchObject({ state: 'PREVIEWED', template: 'CITY_MASTER_V1', rowCount: 3 });
    expect((staged.json().rows as { businessKey: string }[]).map((r) => r.businessKey)).toEqual(['TN/CHENNAI', 'TN/COIMBATORE', 'KL/KOCHI']);
    // A preview writes nothing.
    expect(await cities(hr, '?state=TN')).toEqual([]);
    // The same key returns the same batch.
    expect((await h.call(admin, 'POST', '/v1/org/city-imports', { fileName: 'cities.csv', contentBase64: csv(lines), idempotencyKey: key })).json().id).toBe(staged.json().id);
    const committed = await h.call(admin, 'POST', `/v1/org/city-imports/${staged.json().id}/commit`);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 3 });
    expect((await cities(hr, '?state=TN')).map((c) => c.name)).toEqual(['Chennai', 'Coimbatore']);
    // A committed batch commits once.
    expect((await h.call(admin, 'POST', `/v1/org/city-imports/${staged.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED' });
    expect((await cities(hr, '?state=TN'))).toHaveLength(2);

    // The same file again under a new key adds nothing; one bad row rejects the whole batch.
    const again = await h.call(admin, 'POST', '/v1/org/city-imports', { fileName: 'cities.csv', contentBase64: csv(lines), idempotencyKey: uniq('city-key-') });
    expect(again.json().state).toBe('REJECTED');
    expect((again.json().rows as { errorCode: string }[]).map((r) => r.errorCode)).toEqual(['DUPLICATE_CITY', 'DUPLICATE_CITY', 'DUPLICATE_CITY']);
    const bad = await h.call(admin, 'POST', '/v1/org/city-imports', {
      fileName: 'bad.csv',
      contentBase64: csv([HEADER, 'WB,KOLKATA,Kolkata', 'WB,KOLKATA,Calcutta', 'XX,ATLANTIS,Atlantis', 'WB,-NO,Bad code', 'WB,HOWRAH,']),
      idempotencyKey: uniq('city-key-'),
    });
    expect(bad.json().state).toBe('REJECTED');
    expect((bad.json().rows as { errorCode: string | null }[]).map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'DUPLICATE_IN_BATCH', 'UNKNOWN_STATE', 'INVALID_CITY_CODE', 'INVALID_CITY_NAME']);
    expect(await cities(hr, '?state=WB')).toEqual([]);

    // The published template, the batch belongs to its submitter, and the upload needs the create duty.
    const template = await h.call(admin, 'GET', '/v1/org/city-imports/template');
    expect([template.statusCode, template.body]).toEqual([200, `${HEADER}\r\n`]);
    expect((await h.call(hr, 'POST', '/v1/org/city-imports', { fileName: 'c.csv', contentBase64: csv(lines), idempotencyKey: uniq('city-key-') })).statusCode).toBe(403);
    expect((await h.call(scopedAdmin, 'POST', '/v1/org/city-imports', { fileName: 'c.csv', contentBase64: csv(lines), idempotencyKey: uniq('city-key-') })).statusCode).toBe(403);
    expect((await h.call(await h.actor(A, 'SYSTEM_ADMINISTRATOR'), 'GET', `/v1/org/city-imports/${staged.json().id}`)).statusCode).toBe(404);
  });
});
