// ZT01 / ZT39 for attendance: another company's records, amendments, day views, processing jobs and punch imports, by direct identifier.
// policies.api.test.ts holds the attendance policies across companies; corrections are in self-service.isolation. Fixed past dates.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Harness, startHarness } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const TUE = '2026-03-03';
const WED = '2026-03-04';

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR', { extra: ['attendance.read.reason'] });
  const shift = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [] })).json().id as string;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
  await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: shift, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  const self = await h.actor(company, 'EMPLOYEE', { employeeId: e.id });
  const punched = await h.call(hr, 'POST', '/v1/attendance/punches', {
    punches: [
      { employeeCode: e.employeeCode, occurredAt: `${TUE}T09:00:00+05:30`, direction: 'IN', externalEventKey: uniq('iso-evt-') },
      { employeeCode: e.employeeCode, occurredAt: `${TUE}T18:00:00+05:30`, direction: 'OUT', externalEventKey: uniq('iso-evt-') },
    ],
  });
  expect(punched.statusCode, punched.body).toBeLessThan(300);
  const job = await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: WED });
  const recordOf = async (day: string) => (await h.call(hr, 'GET', `/v1/employees/${e.id}/attendance?from=${day}&to=${day}`)).json().items[0] as { id: string; version: number };
  const amended = await recordOf(WED);
  const res = await h.call(hr, 'POST', `/v1/attendance/records/${amended.id}/amend`, { expectedVersion: amended.version, status: 'PRESENT', reason: `Amended ${uniq('zq')} (synthetic)` });
  expect(res.statusCode, res.body).toBe(200);
  const record = await recordOf(TUE);
  const importJob = await h.call(hr, 'POST', '/v1/attendance/punch-imports', {
    fileName: 'punches.csv',
    contentBase64: Buffer.from(`employeeCode,occurredAt,direction,externalEventKey,sourceIdentity\r\n${e.employeeCode},2026-03-05T09:00:00+05:30,IN,${uniq('iso-file-')},\r\n`).toString('base64'),
    idempotencyKey: uniq('iso-import-'),
  });
  expect(importJob.statusCode, importJob.body).toBeLessThan(300);
  return {
    company,
    actors: { hr, self },
    ids: { employee: e.id, code: e.employeeCode, record: record.id, amended: amended.id, job: job.id, importJob: importJob.json().id as string, shift },
    versions: { record: record.version },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const PROBES: Probe[] = [
  { name: 'GET a foreign record’s day view (raw punches)', as: 'hr', method: 'GET', path: (w) => `/v1/attendance/records/${w.ids.record}/day` },
  { name: 'GET a foreign employee’s attendance', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.employee}/attendance?from=${TUE}&to=${WED}` },
  { name: 'GET a foreign record’s amendment history', as: 'hr', method: 'GET', path: (w) => `/v1/attendance/records/${w.ids.amended}/amendments` },
  { name: 'GET a foreign processing job’s employees without a policy', as: 'hr', method: 'GET', path: (w) => `/v1/attendance/processing/${w.ids.job}/no-policy-employees` },
  { name: 'GET a foreign processing job’s unprocessed employees', as: 'hr', method: 'GET', path: (w) => `/v1/attendance/processing/${w.ids.job}/unprocessed-employees` },
  { name: 'GET a foreign punch import', as: 'hr', method: 'GET', path: (w) => `/v1/attendance/punch-imports/${w.ids.importJob}` },
  { name: 'GET a foreign employee’s raw punches', as: 'hr', method: 'GET', path: (w) => `/v1/employees/${w.ids.employee}/punches?from=${TUE}&to=${WED}` },
  { name: 'POST an amendment of a foreign record', as: 'hr', method: 'POST', path: (w) => `/v1/attendance/records/${w.ids.record}/amend`, body: (w) => ({ expectedVersion: w.versions.record, status: 'ABSENT', reason: 'Isolation check (synthetic)' }) },
  { name: 'POST the cancellation of a foreign punch import', as: 'hr', method: 'POST', path: (w) => `/v1/attendance/punch-imports/${w.ids.importJob}/cancel` },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('attendance across companies (ZT01; ZT39; FR-021)', () => {
  itRefusesForeignRecords(ctx, PROBES);
  itListsOnlyOwnRecords(ctx, [
    {
      name: 'GET /attendance/records holds only the company’s own, in its total too',
      as: 'hr',
      path: `/v1/attendance/records?from=${TUE}&to=${WED}`,
      holds: (w) => [w.ids.code],
      never: (w) => [w.ids.record, w.ids.amended, w.ids.code],
      total: async (harness, w) => (await harness.one<{ n: number }>(`select count(*)::int as n from attendance_record where company_id = $1 and work_date between $2::date and $3::date`, [w.company.id, TUE, WED])).n,
    },
    { name: 'GET /attendance/records filtered by a foreign employee holds nothing', as: 'hr', path: () => `/v1/attendance/records?from=${TUE}&to=${WED}&employeeId=${foreign.ids.employee}`, never: (w) => [w.ids.record, w.ids.code] },
    { name: 'GET /attendance/records filtered by a foreign shift holds nothing', as: 'hr', path: () => `/v1/attendance/records?from=${TUE}&to=${WED}&shiftId=${foreign.ids.shift}`, never: (w) => [w.ids.record, w.ids.code] },
  ]);
  itRefusesAnotherCompanyInTheHeader(ctx, PROBES);

  it('a punch naming a foreign employee’s code never attaches to that employee (import is matched in the importer’s company)', async () => {
    const before = await companyState(h, foreign.company.id);
    const res = await h.call(home.actors.hr!, 'POST', '/v1/attendance/punches', {
      punches: [{ employeeCode: foreign.ids.code, occurredAt: '2026-03-06T09:00:00+05:30', direction: 'IN', externalEventKey: uniq('iso-foreign-') }],
    });
    // The code means nothing here: the row is rejected like any unknown code, and neither company stores a punch for that employee.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ received: 1, accepted: 0, duplicates: 0 });
    expect(res.json().rejected).toHaveLength(1);
    expect(res.body).not.toContain(foreign.ids.employee);
    const unknown = await h.call(home.actors.hr!, 'POST', '/v1/attendance/punches', { punches: [{ employeeCode: 'NOWHERE-CODE', occurredAt: '2026-03-06T09:00:00+05:30', direction: 'IN', externalEventKey: uniq('iso-unknown-') }] });
    expect(unknown.json().rejected[0].code).toBe(res.json().rejected[0].code);
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
    const stored = await h.one<{ n: number }>(`select count(*)::int as n from attendance_punch where company_id = $1 and employee_id = $2 and occurred_at = '2026-03-06T09:00:00+05:30'::timestamptz`, [foreign.company.id, foreign.ids.employee]);
    expect(stored.n).toBe(0);
  });

  it('the export of a period holds only the company’s records, also when asked for a foreign employee', async () => {
    const { processReportQueue } = await import('../report/service.js');
    const requested = await h.call(home.actors.hr!, 'POST', '/v1/reports', { reportCode: 'ATTENDANCE_REGISTER', filters: { from: TUE, to: WED, employeeId: foreign.ids.employee } });
    expect(requested.statusCode, requested.body).toBe(202);
    await processReportQueue(h.pool);
    const file = await h.call(home.actors.hr!, 'GET', `/v1/reports/${requested.json().id}/download`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).not.toContain(foreign.ids.code);
    expect((await h.call(home.actors.hr!, 'GET', `/v1/reports/${requested.json().id}`)).json()).toMatchObject({ rowCount: 0 });
  });
});
