// The employee notes register export (BRD coverage CL-040 "Exit Notes/Remarks/Warnings", follow-up; FR-018 restricted notes; FR-056
// to FR-058 reports; BR-026 row scope; BR-045 confidential derived values; DF02; DF08 corrections and voids; ZT17 the list and its export
// hold the same rows). The report EMPLOYEE_NOTES_REGISTER under employee_note.export.restricted (0283). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { csvContext, csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let exporter: TestActor;
let exporterEng: TestActor;
let exporterSelf: TestActor;
let notesOnly: TestActor;
let exporterB: TestActor;
let today: string;
const emp: Record<string, { id: string; code: string }> = {};

const NOTES: PermissionKey[] = ['employee_note.read.restricted', 'employee_note.write.restricted', 'employee_note.void.restricted', 'employee_note.import.restricted'];
const EXPORT: PermissionKey = 'employee_note.export.restricted';
const HEADERS = ['Employee code', 'Name', 'Type', 'Note date', 'Status', 'Submitted by', 'Recorded (company time)', 'Source'];
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const note = async (key: string, body: Record<string, unknown>) => {
  const res = await h.call(hr, 'POST', `/v1/employees/${emp[key]!.id}/notes`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
};

const requested = (a: TestActor, filters: object, format?: string) => h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_NOTES_REGISTER', filters, ...(format ? { format } : {}) });

async function exported(a: TestActor, filters: object) {
  const res = await requested(a, filters);
  expect(res.statusCode, res.body).toBe(202);
  await processReportQueue(h.pool);
  const status = (await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json();
  expect(status.state, JSON.stringify(status)).toBe('COMPLETED');
  const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').filter(Boolean).map(cells);
  return { body: file.body, header: header!, rows: rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!]))) };
}

async function person(key: string, departmentId: string) {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: `Synthetic ${key}`, departmentId }));
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; employeeCode: string };
  await h.setStatus(A, body.id, 'ACTIVE_CONFIRMED');
  emp[key] = { id: body.id, code: body.employeeCode };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  await person('E1', A.dept);
  await person('E2', A.dept);
  await person('F1', A.financeDept);
  await person('SELF', A.dept);
  exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT] });
  exporterEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT], departmentFilter: A.dept });
  exporterSelf = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT], employeeId: emp.SELF!.id });
  notesOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES });
  exporterB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT] });

  // E1: a remark (later corrected), its correction, and an absconding warning. E2: an appreciation that is voided. F1: a PIP. SELF: a warning.
  const remark = await note('E1', { kind: 'REMARK', body: 'SECRET-REMARK-TEXT first', noteDate: daysAgo(20) });
  await note('E1', { kind: 'REMARK', body: 'SECRET-REMARK-TEXT corrected', noteDate: daysAgo(20), supersedesNoteId: remark.id });
  await note('E1', { kind: 'WARNING', warningCategory: 'ABSCONDING', body: 'SECRET-WARNING-TEXT', noteDate: daysAgo(5) });
  const praised = await note('E2', { kind: 'APPRECIATION', body: 'SECRET-APPRECIATION-TEXT', noteDate: daysAgo(10) });
  expect((await h.call(hr, 'POST', `/v1/employee-notes/${praised.id}/void`, { reason: 'SECRET-VOID-REASON' })).statusCode).toBe(200);
  await note('F1', { kind: 'PIP', body: 'SECRET-PIP-TEXT', noteDate: daysAgo(3) });
  await note('SELF', { kind: 'WARNING', body: 'SECRET-SELF-TEXT', noteDate: daysAgo(1) });
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('employee notes register export (CL-040 follow-up; FR-056; BR-045)', () => {
  it('CL-040 FR-056 DF08: every note of the register with type, date, status, submitter, recorded time and source; never the text or a void reason', async () => {
    const { header, rows, body } = await exported(exporter, {});
    expect(header).toEqual(HEADERS);
    expect(rows.map((r) => [r['Employee code'], r.Type, r['Note date'], r.Status, r.Source])).toEqual([
      [emp.SELF!.code, 'Warning', daysAgo(1), 'Active', 'Entered on screen'],
      [emp.F1!.code, 'Performance improvement plan (PIP)', daysAgo(3), 'Active', 'Entered on screen'],
      [emp.E1!.code, 'Absconding warning', daysAgo(5), 'Active', 'Entered on screen'],
      [emp.E2!.code, 'Appreciation', daysAgo(10), 'Voided', 'Entered on screen'],
      [emp.E1!.code, 'Remark', daysAgo(20), 'Active', 'Entered on screen'],
      [emp.E1!.code, 'Remark', daysAgo(20), 'Corrected by a later note', 'Entered on screen'],
    ]);
    const hrName = (await h.one<{ k: string }>(`select account_key as k from user_account where id = $1`, [hr.user])).k;
    expect(rows.every((r) => r['Submitted by'] === hrName && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r['Recorded (company time)']!) && r.Name!.startsWith('Synthetic '))).toBe(true);
    for (const secret of ['SECRET-REMARK-TEXT', 'SECRET-WARNING-TEXT', 'SECRET-APPRECIATION-TEXT', 'SECRET-VOID-REASON', 'SECRET-PIP-TEXT', 'SECRET-SELF-TEXT']) expect(body).not.toContain(secret);
  });

  it('CL-040 ZT17: the register’s filters (period, type as category, status, search) give the same notes as the register list', async () => {
    const same = async (query: string, filters: Record<string, string>) => {
      const list = (await h.call(exporter, 'GET', `/v1/employee-notes?${query}&pageSize=100`)).json() as { items: { noteDate: string; employee: { employeeCode: string } }[]; total: number };
      const { rows, body } = await exported(exporter, filters);
      expect(rows.map((r) => [r['Employee code'], r['Note date']]), query).toEqual(list.items.map((n) => [n.employee.employeeCode, String(n.noteDate).slice(0, 10)]));
      expect(rows.length, query).toBe(list.total);
      return { rows, body };
    };
    expect((await same(`from=${daysAgo(10)}&to=${daysAgo(3)}`, { from: daysAgo(10), to: daysAgo(3) })).rows.map((r) => r.Type)).toEqual(['Performance improvement plan (PIP)', 'Absconding warning', 'Appreciation']);
    expect((await same('kind=REMARK', { category: 'REMARK' })).rows).toHaveLength(2);
    expect((await same('status=VOIDED', { status: 'VOIDED' })).rows.map((r) => r['Employee code'])).toEqual([emp.E2!.code]);
    expect((await same('status=SUPERSEDED', { status: 'SUPERSEDED' })).rows.map((r) => r.Status)).toEqual(['Corrected by a later note']);
    expect((await same(`search=${emp.F1!.code}`, { search: emp.F1!.code })).rows.map((r) => r.Type)).toEqual(['Performance improvement plan (PIP)']);
    const both = await same('kind=WARNING&status=ACTIVE', { category: 'WARNING', status: 'ACTIVE' });
    expect(both.rows.map((r) => r['Employee code'])).toEqual([emp.SELF!.code, emp.E1!.code]);
    // DF09: the file says which filters made it.
    expect(csvContext(both.body)).toMatchObject({ Report: 'Employee notes register', Filters: expect.stringContaining('category: WARNING') });
  });

  it('CL-040 BR-026: the requester’s own record is left out, the row scope holds, and another company sees nothing', async () => {
    const own = await exported(exporterSelf, {});
    expect(own.rows.map((r) => r['Employee code'])).not.toContain(emp.SELF!.code);
    expect(own.rows).toHaveLength(5);
    expect(own.body).not.toContain(emp.SELF!.code);
    const scoped = await exported(exporterEng, {});
    expect(new Set(scoped.rows.map((r) => r['Employee code']))).toEqual(new Set([emp.E1!.code, emp.E2!.code, emp.SELF!.code]));
    expect((await exported(exporterB, {})).rows).toEqual([]);
  });

  it('CL-040 BR-045: the export needs its own confidential export right; reading the register is not enough; it is listed only with that right', async () => {
    const refused = await requested(notesOnly, {});
    expect(refused.statusCode, refused.body).toBe(403);
    const listed = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
    expect(await listed(notesOnly)).not.toContain('EMPLOYEE_NOTES_REGISTER');
    expect((await h.call(exporter, 'GET', '/v1/reports/catalogue')).json().items).toContainEqual(expect.objectContaining({ code: 'EMPLOYEE_NOTES_REGISTER', columns: HEADERS, formats: ['CSV', 'XLSX'] }));
  });

  it('CL-040 FR-056: XLSX is offered; an unknown type or status and filters the register does not take are refused', async () => {
    const xlsx = await requested(exporter, { category: 'WARNING' }, 'XLSX');
    expect(xlsx.statusCode, xlsx.body).toBe(202);
    await processReportQueue(h.pool);
    const file = await h.call(exporter, 'GET', `/v1/reports/${xlsx.json().id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect((await requested(exporter, { category: 'GOSSIP' })).json()).toMatchObject({ error: 'INVALID_FILTER' });
    expect((await requested(exporter, { status: 'DELETED' })).json()).toMatchObject({ error: 'INVALID_FILTER' });
    expect((await requested(exporter, { departmentId: A.dept })).json()).toMatchObject({ error: 'FILTER_NOT_SUPPORTED' });
    expect((await requested(exporter, { employeeId: emp.E1!.id })).json()).toMatchObject({ error: 'FILTER_NOT_SUPPORTED' });
    expect((await requested(exporter, { from: daysAgo(1), to: daysAgo(5) })).json()).toMatchObject({ error: 'INVALID_PERIOD' });
  });
});
