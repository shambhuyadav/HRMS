// ZT01 for shifts, holidays and plan imports: another company's records by direct identifier. weekly-off.api.test.ts and
// calendar-corrections.api.test.ts hold a company B refusal for weekly-off posting, holiday withdrawal and shift revision; this file
// holds the whole table, with the no-existence and positive-control checks. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const shiftCode = uniq('ISO').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const newShift = async (code: string) => {
    const res = await h.call(hr, 'POST', '/v1/shifts', { code, name: code, inTime: '09:00', outTime: '18:00', breaks: [] });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number };
  };
  const toPatch = await newShift(shiftCode);
  const toRevise = await newShift(`${shiftCode}R`);
  const holiday = async (holidayDate: string) => {
    const res = await h.call(hr, 'POST', '/v1/holidays', { locationId: company.loc, holidayDate, name: `Synthetic ${uniq('holiday')}` });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const toCorrect = await holiday('2026-08-14');
  const toWithdraw = await holiday('2026-08-17');
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
  await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
  const plan = async () => {
    const file = `employeeCode,shiftCode,effectiveFrom\r\n${e.employeeCode},${shiftCode},2026-09-01\r\n`;
    const res = await h.call(hr, 'POST', '/v1/shifts/plan-imports', { fileName: 'plan.csv', contentBase64: Buffer.from(file).toString('base64'), idempotencyKey: uniq('iso-plan-') });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json().id as string;
  };
  const toCommit = await plan();
  const toCancel = await plan();
  return {
    company,
    actors: { hr },
    ids: { toPatch: toPatch.id, toRevise: toRevise.id, shiftCode, toCorrect, toWithdraw, toCommit, toCancel, employee: e.id, code: e.employeeCode, loc: company.loc },
    versions: { toPatch: toPatch.version, toRevise: toRevise.version },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'PATCH a foreign shift', as: 'hr', method: 'PATCH', path: (w) => `/v1/shifts/${w.ids.toPatch}`, body: (w) => ({ expectedVersion: w.versions.toPatch, name: 'Renamed by another company' }) },
  { name: 'POST a revision of a foreign shift', as: 'hr', method: 'POST', path: (w) => `/v1/shifts/${w.ids.toRevise}/revisions`, body: (w) => ({ expectedVersion: w.versions.toRevise, effectiveFrom: '2026-10-01', inTime: '10:00', outTime: '19:00', breaks: [], reason: 'Isolation check (synthetic)' }), control: 201 },
  { name: 'POST the correction of a foreign holiday', as: 'hr', method: 'POST', path: (w) => `/v1/holidays/${w.ids.toCorrect}/correct`, body: () => ({ expectedVersion: 1, name: 'Corrected by another company', reason: 'Isolation check (synthetic)' }), control: 201 },
  { name: 'POST the withdrawal of a foreign holiday', as: 'hr', method: 'POST', path: (w) => `/v1/holidays/${w.ids.toWithdraw}/withdraw`, body: () => ({ expectedVersion: 1, reason: 'Isolation check (synthetic)' }) },
  { name: 'GET a foreign plan import', as: 'hr', method: 'GET', path: (w) => `/v1/shifts/plan-imports/${w.ids.toCommit}` },
  { name: 'POST the commit of a foreign plan import', as: 'hr', method: 'POST', path: (w) => `/v1/shifts/plan-imports/${w.ids.toCommit}/commit` },
  { name: 'POST the cancellation of a foreign plan import', as: 'hr', method: 'POST', path: (w) => `/v1/shifts/plan-imports/${w.ids.toCancel}/cancel` },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('shifts, holidays and plan imports across companies (ZT01)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /shifts holds only the company’s own', as: 'hr', path: '/v1/shifts', holds: (w) => [w.ids.toPatch!], never: (w) => [w.ids.toPatch!, w.ids.toRevise!, w.ids.shiftCode!] },
    { name: 'GET /holidays/options holds only the company’s own', as: 'hr', path: '/v1/holidays/options', holds: (w) => [w.ids.loc!], never: (w) => [w.ids.loc!] },
    { name: 'GET /holidays for a foreign location holds nothing', as: 'hr', path: () => `/v1/holidays?locationId=${foreign.ids.loc}&year=2026`, never: (w) => [w.ids.toCorrect!, w.ids.toWithdraw!] },
    { name: 'GET /weekly-off-patterns holds only the company’s own', as: 'hr', path: '/v1/weekly-off-patterns', never: (w) => [w.ids.loc!] },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES);

  it('a plan naming a foreign employee or shift rejects the row, not the company’s data, and says nothing of them', async () => {
    const before = await companyState(h, foreign.company.id);
    const file = `employeeCode,shiftCode,effectiveFrom\r\n${foreign.ids.code},${home.ids.shiftCode},2026-09-01\r\n${home.ids.code},${foreign.ids.shiftCode},2026-09-01\r\n`;
    const res = await h.call(home.actors.hr!, 'POST', '/v1/shifts/plan-imports', { fileName: 'plan.csv', contentBase64: Buffer.from(file).toString('base64'), idempotencyKey: uniq('iso-plan-') });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const job = (await h.call(home.actors.hr!, 'GET', `/v1/shifts/plan-imports/${res.json().id}`)).json() as { acceptedCount: number; rejectedCount: number };
    expect(job).toMatchObject({ acceptedCount: 0, rejectedCount: 2 });
    expect(res.body).not.toContain(foreign.ids.employee);
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
  });

  it('a foreign shift cannot be assigned to one’s own employee', async () => {
    const res = await h.call(home.actors.hr!, 'POST', `/v1/employees/${home.ids.employee}/shift`, { shiftId: foreign.ids.toPatch, effectiveFrom: '2026-09-01' });
    expect([res.statusCode, res.json().error]).toEqual([422, 'INVALID_REFERENCE']);
    expect(res.body).not.toContain(foreign.ids.shiftCode);
    const assigned = await h.db.query(`select 1 from shift_assignment where employee_id = $1 and shift_id = $2`, [home.ids.employee, foreign.ids.toPatch]);
    expect(assigned.rows).toEqual([]);
  });
});
