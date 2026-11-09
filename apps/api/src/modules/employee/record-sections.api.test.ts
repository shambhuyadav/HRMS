// FR-008 "Target sections include ... family/dependants, qualifications, prior employment, bank/payment data, applicable payroll
// identifiers ... Use field-level permissions and masked display for sensitive identifiers. Acceptance: Only authorised users can
// reveal protected identity or bank fields; invalid dates and unknown master references fail validation before save", and
// FR-007 "authorised exports for employee, family, qualification, past employer ... details", as decided under owner delegation,
// 6 Nov 2026 (docs/03 I-82 item 2; migration 0191): every section is confidential, an eligible Admin maintains it, Employee OWN
// reads its own with identifiers masked (H1/BR-053). Synthetic data only: made-up names and identifiers in their public format.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let B: Company;
let hrPlain: TestActor;
let hrPrivate: TestActor;
let hrIds: TestActor;
let hrIdsManageOnly: TestActor;
let hrFinance: TestActor;
let bHr: TestActor;
let manager: TestActor;
let payroll: TestActor;
let own: TestActor;
let ownEmp: string;
let subject: string;
let financeEmp: string;
let hrPrivateEmp: string;

const PRIVATE: PermissionKey[] = ['employee.read.private', 'employee.manage.private', 'employee.export.private'];
const IDS: PermissionKey[] = ['employee.read.private', 'employee.read.payroll_id', 'employee.manage.payroll_id'];
// Synthetic PANs, assembled at run time so no shared file holds a PAN-shaped string (ZT21; db/registers/privacy.ts).
const PAN_A = ['ABCDE', '1234', 'F'].join('');
const PAN_B = ['PQRSX', '9876', 'Z'].join('');
// Every synthetic identifier below, as it would appear if it leaked unmasked.
const FULL_IDS = new RegExp(`${PAN_A}|100200300400|1234567890|${PAN_B}`);

const sections = (a: TestActor, id: string, query = '') => h.call(a, 'GET', `/v1/employees/${id}/record-sections${query}`);
const add = (a: TestActor, id: string, section: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/employees/${id}/record-sections/${section}`, body);
const setIds = (a: TestActor, id: string, body: Record<string, unknown>) => h.call(a, 'PUT', `/v1/employees/${id}/payroll-identifiers`, body);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: '2026-01-05', ...overrides }));
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(A, res.json().id, 'ACTIVE_CONFIRMED');
    return res.json().id as string;
  };
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  subject = await create({ displayName: 'SECTIONS Subject' });
  financeEmp = await create({ departmentId: A.financeDept, displayName: 'SECTIONS Finance' });
  ownEmp = await create({ displayName: 'SECTIONS Own' });
  hrPrivateEmp = await create({ displayName: 'SECTIONS Admin Person' });
  hrPrivate = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PRIVATE, employeeId: hrPrivateEmp });
  hrIds = await h.actor(A, 'HR_ADMINISTRATOR', { extra: IDS });
  hrIdsManageOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.read.private', 'employee.manage.payroll_id'] });
  hrFinance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PRIVATE, departmentFilter: A.financeDept });
  bHr = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...new Set([...PRIVATE, ...IDS])] });
  manager = await h.actor(A, 'REPORTING_MANAGER', { extra: ['employee.read.personal'] });
  payroll = await h.actor(A, 'PAYROLL_OPERATOR');
  own = await h.actor(A, 'EMPLOYEE', { employeeId: ownEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('FR-008 employee record sections (I-82 item 2)', () => {
  it('FR-008: the field dictionary names every section, its fields, requiredness, classification and masking', async () => {
    const dictionary = (await h.call(payroll, 'GET', '/v1/employee-record-dictionary')).json();
    type Section = { key: string; classification: string; masked: boolean; fields: { name: string; required: boolean }[] };
    const byKey: Record<string, Section> = Object.fromEntries((dictionary.sections as Section[]).map((s) => [s.key, s]));
    expect(Object.keys(byKey).sort()).toEqual(['family-members', 'payroll-identifiers', 'prior-employments', 'qualifications']);
    for (const s of Object.values(byKey)) expect(s.classification).toBe('CONFIDENTIAL');
    expect(byKey['payroll-identifiers']!.masked).toBe(true);
    const required = (key: string) => byKey[key]!.fields.filter((f) => f.required).map((f) => f.name).sort();
    expect(required('family-members')).toEqual(['dependant', 'fullName', 'relationship']);
    expect(required('qualifications')).toEqual(['level', 'qualification']);
    expect(required('prior-employments')).toEqual(['employerName', 'fromDate', 'toDate']);
    // DF04: identifiers are conditionally required only for enabled payroll processing, so none is required here.
    expect(required('payroll-identifiers')).toEqual([]);
    expect(byKey['payroll-identifiers']!.fields.map((f) => f.name).sort()).toEqual(['esicIpNumber', 'pan', 'uan']);
  });

  it('FR-008 acceptance: invalid dates and unknown master references fail validation before save', async () => {
    const before = (await sections(hrPrivate, subject)).json();
    expect((await add(hrPrivate, subject, 'family-members', { relationship: 'COUSIN_TWICE_REMOVED', fullName: 'Synthetic Kin', dependant: false })).json()).toMatchObject({ error: 'INVALID_REFERENCE', details: { field: 'relationship' } });
    expect((await add(hrPrivate, subject, 'family-members', { relationship: 'SPOUSE', fullName: 'Synthetic Kin', dateOfBirth: '2026-02-30', dependant: true })).json()).toMatchObject({ error: 'INVALID_DATE', details: { field: 'dateOfBirth' } });
    expect((await add(hrPrivate, subject, 'family-members', { relationship: 'CHILD', fullName: 'Synthetic Kin', dateOfBirth: '2099-01-01', dependant: true })).json()).toMatchObject({ error: 'INVALID_DATE', details: { field: 'dateOfBirth' } });
    expect((await add(hrPrivate, subject, 'qualifications', { level: 'BOGUS', qualification: 'B.Sc.' })).json()).toMatchObject({ error: 'INVALID_REFERENCE', details: { field: 'level' } });
    expect((await add(hrPrivate, subject, 'qualifications', { level: 'GRADUATE', qualification: 'B.Sc.', completionYear: 2999 })).json()).toMatchObject({ error: 'INVALID_FIELD', details: { field: 'completionYear' } });
    expect((await add(hrPrivate, subject, 'prior-employments', { employerName: 'Synthetic Works', fromDate: '2024-05-01', toDate: '2024-04-30' })).json()).toMatchObject({ error: 'INVALID_PERIOD' });
    // Prior means before this employment (joined 2026-01-05).
    expect((await add(hrPrivate, subject, 'prior-employments', { employerName: 'Synthetic Works', fromDate: '2024-05-01', toDate: '2026-01-05' })).json()).toMatchObject({ error: 'CHRONOLOGY_CONFLICT', details: { field: 'toDate', joiningDate: '2026-01-05' } });
    expect((await add(hrPrivate, subject, 'qualifications', { level: 'GRADUATE' })).json()).toMatchObject({ error: 'FIELD_REQUIRED', details: { field: 'qualification' } });
    expect((await add(hrPrivate, subject, 'qualifications', { level: 'GRADUATE', qualification: 'B.Sc.', grade: 'A' })).json()).toMatchObject({ error: 'UNKNOWN_FIELD', details: { field: 'grade' } });
    expect((await sections(hrPrivate, subject)).json()).toEqual(before);
  });

  it('FR-008: an eligible Admin with the private grant records, changes and removes entries; a removed entry is kept with its reason', async () => {
    const kin = await add(hrPrivate, subject, 'family-members', { relationship: 'spouse', fullName: ' Synthetic Spouse ', dateOfBirth: '1990-03-04', dependant: true });
    expect(kin.statusCode, kin.body).toBe(201);
    expect((await add(hrPrivate, subject, 'qualifications', { level: 'POSTGRADUATE', qualification: 'M.Tech.', specialisation: 'Synthetic systems', institution: 'Synthetic Institute', completionYear: 2015 })).statusCode).toBe(201);
    expect((await add(hrPrivate, subject, 'prior-employments', { employerName: 'Synthetic Works Pvt Ltd', designation: 'Engineer', fromDate: '2016-07-01', toDate: '2025-12-31' })).statusCode).toBe(201);
    const read = (await sections(hrPrivate, subject)).json();
    expect(read['family-members']).toEqual([expect.objectContaining({ relationship: 'SPOUSE', relationshipLabel: 'Spouse', fullName: 'Synthetic Spouse', dateOfBirth: '1990-03-04', dependant: true, removedAt: null })]);
    expect(read.qualifications).toEqual([expect.objectContaining({ level: 'POSTGRADUATE', qualification: 'M.Tech.', completionYear: 2015 })]);
    expect(read['prior-employments']).toEqual([expect.objectContaining({ employerName: 'Synthetic Works Pvt Ltd', fromDate: '2016-07-01', toDate: '2025-12-31' })]);
    const entry = read['family-members'][0];
    const stale = await h.call(hrPrivate, 'PUT', `/v1/employees/${subject}/record-sections/family-members/${entry.id}`, { relationship: 'SPOUSE', fullName: 'Synthetic Spouse', dependant: false, expectedVersion: entry.version + 1 });
    expect(stale.json().error).toBe('STALE_VERSION');
    const changed = await h.call(hrPrivate, 'PUT', `/v1/employees/${subject}/record-sections/family-members/${entry.id}`, { relationship: 'SPOUSE', fullName: 'Synthetic Spouse', dependant: false, expectedVersion: entry.version });
    expect(changed.statusCode, changed.body).toBe(200);
    const removed = await h.call(hrPrivate, 'POST', `/v1/employees/${subject}/record-sections/family-members/${entry.id}/remove`, { reason: 'Synthetic: entered on the wrong record', expectedVersion: changed.json().version });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await sections(hrPrivate, subject)).json()['family-members']).toEqual([]);
    expect((await sections(hrPrivate, subject, '?includeRemoved=true')).json()['family-members']).toEqual([expect.objectContaining({ id: entry.id, dependant: false, removalReason: 'Synthetic: entered on the wrong record' })]);
    // Kept as removed: never changed again, never deleted.
    expect((await h.call(hrPrivate, 'PUT', `/v1/employees/${subject}/record-sections/family-members/${entry.id}`, { relationship: 'SPOUSE', fullName: 'X', dependant: false, expectedVersion: changed.json().version + 1 })).json().error).toBe('ENTRY_REMOVED');
    const del = await h.db.query(`delete from employee_family_member where id = $1`, [entry.id]).then(() => null, (e: { message: string }) => e.message);
    expect(del).not.toBeNull();
  });

  it('BR-054 / I-52: nobody changes their own record sections, not even an eligible Admin', async () => {
    expect((await add(hrPrivate, hrPrivateEmp, 'qualifications', { level: 'GRADUATE', qualification: 'B.Com.' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await add(own, ownEmp, 'qualifications', { level: 'GRADUATE', qualification: 'B.Com.' })).statusCode).toBe(403);
    expect((await setIds(own, ownEmp, { pan: PAN_A })).statusCode).toBe(403);
  });

  it('FR-008 / DF02: the sections are confidential: operational roles, a plain HR assignment and managers are refused; another company sees nothing', async () => {
    for (const a of [hrPlain, payroll, manager]) {
      expect((await sections(a, subject)).statusCode).toBe(403);
      expect((await add(a, subject, 'qualifications', { level: 'GRADUATE', qualification: 'B.A.' })).statusCode).toBe(403);
      expect((await setIds(a, subject, { uan: '100200300400' })).statusCode).toBe(403);
    }
    expect((await sections(bHr, subject)).statusCode).toBe(404);
    // Row scope: a finance-only assignment reaches finance people only.
    expect((await sections(hrFinance, subject)).statusCode).toBe(404);
    expect((await sections(hrFinance, financeEmp)).statusCode).toBe(200);
  });

  it('FR-008 acceptance: only an authorised user reveals payroll identifiers; every other reader sees them masked; formats are the public ones only', async () => {
    expect((await setIds(hrIds, subject, { pan: 'ABCDE12345' })).json()).toMatchObject({ error: 'INVALID_IDENTIFIER', details: { field: 'pan' } });
    expect((await setIds(hrIds, subject, { uan: '1002003004' })).json()).toMatchObject({ error: 'INVALID_IDENTIFIER', details: { field: 'uan' } });
    expect((await setIds(hrIds, subject, { esicIpNumber: '12345' })).json()).toMatchObject({ error: 'INVALID_IDENTIFIER', details: { field: 'esicIpNumber' } });
    const saved = await setIds(hrIds, subject, { pan: 'abcde 1234 f', uan: '1002 0030 0400', esicIpNumber: '1234567890' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ recorded: ['PAN', 'UAN', 'ESIC_IP'], version: 1 });
    expect(saved.body).not.toMatch(FULL_IDS);
    // The full values for the payroll_id grant only.
    expect((await sections(hrIds, subject)).json()['payroll-identifiers']).toEqual({ values: { pan: PAN_A, uan: '100200300400', esicIpNumber: '1234567890' }, masked: false, version: 1 });
    const masked = (await sections(hrPrivate, subject)).json()['payroll-identifiers'];
    expect(masked).toEqual({ values: { pan: '••••234F', uan: '••••0400', esicIpNumber: '••••7890' }, masked: true, version: 1 });
    // Maintaining is not revealing: the manage-only assignment reads them masked too.
    expect(JSON.stringify((await sections(hrIdsManageOnly, subject)).json())).not.toMatch(FULL_IDS);
    // Stored sealed and audited by name only.
    expect((await h.one<{ payload: string }>(`select payload from employee_payroll_identifier where employee_id = $1`, [subject])).payload).not.toMatch(FULL_IDS);
    const audits = await h.db.query<{ v: string }>(`select coalesce(after_values::text, '') || coalesce(before_values::text, '') as v from audit_event where company_id = $1 and resource_code = 'employee_payroll_identifier'`, [A.id]);
    expect(audits.rows.length).toBeGreaterThan(0);
    for (const a of audits.rows) expect(a.v).not.toMatch(FULL_IDS);
    // Version check, clearing one identifier, and a change that changes nothing.
    expect((await setIds(hrIdsManageOnly, subject, { uan: null })).json().error).toBe('STALE_VERSION');
    expect((await setIds(hrIdsManageOnly, subject, { uan: null, expectedVersion: 1 })).json()).toMatchObject({ recorded: ['PAN', 'ESIC_IP'], changed: ['UAN'], version: 2 });
    expect((await setIds(hrIdsManageOnly, subject, { pan: PAN_A, expectedVersion: 2 })).json().error).toBe('NO_CHANGE');
  });

  it('H1 / BR-053: the employee reads their own sections, with their own identifiers masked, and nobody else’s', async () => {
    expect((await add(hrPrivate, ownEmp, 'family-members', { relationship: 'MOTHER', fullName: 'Synthetic Mother', dependant: true })).statusCode).toBe(201);
    expect((await setIds(hrIds, ownEmp, { pan: PAN_B })).statusCode).toBe(200);
    const mine = await sections(own, ownEmp);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()['family-members']).toEqual([expect.objectContaining({ fullName: 'Synthetic Mother', relationship: 'MOTHER' })]);
    expect(mine.json()['payroll-identifiers']).toMatchObject({ masked: true, values: { pan: '••••876Z' } });
    expect(mine.body).not.toMatch(FULL_IDS);
    expect((await sections(own, subject)).statusCode).toBe(404);
  });

  it('FR-007: family, qualification and prior-employment exports need their own confidential grant and use the list’s filters and scope', async () => {
    const requestReport = (a: TestActor, reportCode: string, filters: object) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });
    for (const code of ['EMPLOYEE_FAMILY', 'EMPLOYEE_QUALIFICATIONS', 'EMPLOYEE_PRIOR_EMPLOYMENT']) {
      expect((await requestReport(hrPlain, code, {})).statusCode).toBe(403);
      expect((await requestReport(own, code, {})).statusCode).toBe(403);
    }
    expect((await add(hrFinance, financeEmp, 'qualifications', { level: 'DIPLOMA', qualification: 'Synthetic Diploma' })).statusCode).toBe(201);
    const generated = async (a: TestActor, reportCode: string, filters: object) => {
      const requested = await requestReport(a, reportCode, filters);
      expect(requested.statusCode, requested.body).toBe(202);
      await processReportQueue(h.pool);
      const file = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
      expect(file.statusCode, file.body).toBe(200);
      return csvTable(file.body).trimEnd().split('\r\n');
    };
    const all = await generated(hrPrivate, 'EMPLOYEE_QUALIFICATIONS', { search: 'SECTIONS' });
    expect(all[0]).toBe('"Employee code","Name","Status","Level","Qualification","Specialisation","Institution or board","Year of completion"');
    expect(all.slice(1).join('\n')).toMatch(/M\.Tech\./);
    expect(all.slice(1).join('\n')).toMatch(/Synthetic Diploma/);
    // The list's own filter (department) and the requester's row scope narrow the export exactly as they narrow the list.
    const financeOnly = await generated(hrPrivate, 'EMPLOYEE_QUALIFICATIONS', { search: 'SECTIONS', departmentId: A.financeDept });
    expect(financeOnly.slice(1)).toHaveLength(1);
    const scoped = await generated(hrFinance, 'EMPLOYEE_QUALIFICATIONS', { search: 'SECTIONS' });
    expect(scoped.slice(1)).toHaveLength(1);
    expect(scoped.slice(1)[0]).toMatch(/Synthetic Diploma/);
    // Removed entries and payroll identifiers are never exported.
    const family = await generated(hrPrivate, 'EMPLOYEE_FAMILY', { search: 'SECTIONS' });
    expect(family.slice(1).join('\n')).not.toMatch(/Synthetic Spouse/);
    expect(family.join('\n')).not.toMatch(FULL_IDS);
  });
});
