// Absconding warnings and the absconding audit report (BRD coverage CL-052 "Absconding Audit Report", under FR-018 restricted notes and
// warnings; FR-056 to FR-058 reports; BR-026 scope; BR-045 confidential derived values; DF08 corrections and voids; DF09 bulk upload;
// migration 0283). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let auditor: TestActor;
let auditorEng: TestActor;
let notesOnly: TestActor;
let auditorB: TestActor;
let hrSelf: TestActor;
let today: string;
const emp: Record<string, { id: string; code: string }> = {};

const NOTES: PermissionKey[] = ['employee_note.read.restricted', 'employee_note.write.restricted', 'employee_note.void.restricted', 'employee_note.import.restricted'];
const EXPORT: PermissionKey = 'employee_note.export.restricted';
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`).toString('base64');
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const warn = async (a: TestActor, key: string, body: Record<string, unknown>) => {
  const res = await h.call(a, 'POST', `/v1/employees/${emp[key]!.id}/notes`, { kind: 'WARNING', body: `Synthetic warning for ${key}`, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; warningCategory: string | null };
};

async function report(a: TestActor, filters: object) {
  const requested = await h.call(a, 'POST', '/v1/reports', { reportCode: 'ABSCONDING_AUDIT', filters });
  expect(requested.statusCode, requested.body).toBe(202);
  await processReportQueue(h.pool);
  const file = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').filter(Boolean).map(cells);
  return { body: file.body, rows: rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!]))) };
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
  await person('E3', A.financeDept);
  await person('SELF', A.dept);
  auditor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT] });
  auditorEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT], departmentFilter: A.dept });
  notesOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: NOTES });
  auditorB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT] });
  hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...NOTES, EXPORT], employeeId: emp.SELF!.id });
});

afterAll(async () => {
  await h?.stop();
});

describe('CL-052 absconding warnings', () => {
  it('CL-052 FR-018: a warning may carry the absconding category, chosen when written, audited without its text; no other note type may', async () => {
    const w = await warn(hr, 'E1', { warningCategory: 'ABSCONDING', noteDate: daysAgo(20) });
    expect(w.warningCategory).toBe('ABSCONDING');
    const listed = (await h.call(hr, 'GET', `/v1/employees/${emp.E1!.id}/notes`)).json().items as { id: string; kind: string; warningCategory: string | null }[];
    expect(listed.find((n) => n.id === w.id)).toMatchObject({ kind: 'WARNING', warningCategory: 'ABSCONDING' });
    const register = (await h.call(hr, 'GET', '/v1/employee-notes?kind=WARNING')).json().items as { id: string; warningCategory: string | null }[];
    expect(register.find((n) => n.id === w.id)?.warningCategory).toBe('ABSCONDING');
    const audit = await h.one<{ after_values: { restricted: Record<string, unknown> } }>(`select after_values from audit_event where record_key = $1 and action = 'CREATE'`, [w.id]);
    expect(audit.after_values.restricted).toMatchObject({ kind: 'WARNING', warningCategory: 'ABSCONDING' });
    expect(JSON.stringify(audit.after_values)).not.toContain('Synthetic warning');

    const remark = await h.call(hr, 'POST', `/v1/employees/${emp.E1!.id}/notes`, { kind: 'REMARK', body: 'Synthetic remark', warningCategory: 'ABSCONDING' });
    expect([remark.statusCode, remark.json().error]).toEqual([422, 'INVALID_WARNING_CATEGORY']);
    expect((await h.call(hr, 'POST', `/v1/employees/${emp.E1!.id}/notes`, { kind: 'WARNING', body: 'Synthetic', warningCategory: 'LATE' })).statusCode).toBe(400);
    // The database holds the same rule, and a note is never changed afterwards.
    await expect(h.db.query(`update employee_note set warning_category = null where id = $1`, [w.id])).rejects.toThrow();
  });

  it('CL-052 DF09: the notes bulk upload takes "Absconding warning" as a type', async () => {
    const staged = await h.call(hr, 'POST', '/v1/employee-note-imports', {
      fileName: 'warnings.csv',
      contentBase64: csv(['employeeCode,noteType,noteDate,text', `${emp.E2!.code},Absconding warning,${daysAgo(12)},Synthetic absconding warning by upload`, `${emp.E2!.code},Warning,${daysAgo(12)},Synthetic plain warning`]),
      idempotencyKey: uniq('abscond-key-'),
    });
    expect(staged.json()).toMatchObject({ state: 'PREVIEWED' });
    expect((await h.call(hr, 'POST', `/v1/employee-note-imports/${staged.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    const notes = (await h.db.query<{ warning_category: string | null; source: string }>(`select warning_category, source from employee_note where employee_id = $1 order by warning_category nulls last`, [emp.E2!.id])).rows;
    expect(notes).toEqual([
      { warning_category: 'ABSCONDING', source: 'IMPORT' },
      { warning_category: null, source: 'IMPORT' },
    ]);
  });
});

describe('CL-052 absconding audit report', () => {
  it('CL-052 FR-056: lists the absconding warnings issued from a date, with type, number, status and who issued them; never the text', async () => {
    // E1: a first warning (20 days ago, above), a second one 10 days ago that is later corrected, and the correction.
    const second = await warn(hr, 'E1', { warningCategory: 'ABSCONDING', noteDate: daysAgo(10), body: 'Synthetic second warning' });
    await warn(hr, 'E1', { warningCategory: 'ABSCONDING', noteDate: daysAgo(10), body: 'Synthetic second warning, corrected', supersedesNoteId: second.id });
    // E3: one voided, one plain warning (not absconding), and one remark.
    const voided = await warn(hr, 'E3', { warningCategory: 'ABSCONDING', noteDate: daysAgo(5) });
    expect((await h.call(hr, 'POST', `/v1/employee-notes/${voided.id}/void`, { reason: 'Synthetic: recorded for the wrong person' })).statusCode).toBe(200);
    await warn(hr, 'E3', { noteDate: daysAgo(4) });
    await h.call(hr, 'POST', `/v1/employees/${emp.E3!.id}/notes`, { kind: 'REMARK', body: 'Synthetic remark', noteDate: daysAgo(3) });
    // The requester's own record is never listed.
    await warn(hr, 'SELF', { warningCategory: 'ABSCONDING', noteDate: daysAgo(2) });

    const { rows, body } = await report(hrSelf, { from: daysAgo(15) });
    expect(rows.map((r) => [r['Employee code'], r['Warning date'], r['Type'], r['Warning number'], r['Status'], r['Source']])).toEqual([
      [emp.E1!.code, daysAgo(10), 'Absconding warning', '', 'Corrected by a later note', 'Entered on screen'],
      [emp.E1!.code, daysAgo(10), 'Absconding warning', '2', 'Active', 'Entered on screen'],
      [emp.E2!.code, daysAgo(12), 'Absconding warning', '1', 'Active', 'Bulk upload'],
      [emp.E3!.code, daysAgo(5), 'Absconding warning', '', 'Voided', 'Entered on screen'],
    ].sort((a, b) => `${a[1]}${a[0]}`.localeCompare(`${b[1]}${b[0]}`)));
    expect(rows.every((r) => r['Issued by'] !== '' && r['Department'] !== '')).toBe(true);
    expect(body).not.toContain('Synthetic second warning');
    expect(body).not.toContain('Synthetic warning for');
    expect(body).not.toContain(emp.SELF!.code);

    // Everyone, from the first warning; and a range with an end.
    expect((await report(auditor, { from: daysAgo(30) })).rows.filter((r) => r['Employee code'] === emp.E1!.code).map((r) => r['Warning number'])).toEqual(['1', '', '2']);
    expect((await report(auditor, { from: daysAgo(30), to: daysAgo(11) })).rows.map((r) => r['Employee code'])).toEqual([emp.E1!.code, emp.E2!.code]);
    const missing = await h.call(auditor, 'POST', '/v1/reports', { reportCode: 'ABSCONDING_AUDIT', filters: {} });
    expect([missing.statusCode, missing.json().error]).toEqual([422, 'FROM_REQUIRED']);
  });

  it('CL-052 BR-026 BR-045: the report needs its own confidential export right and keeps to the row scope and the company', async () => {
    const refused = await h.call(notesOnly, 'POST', '/v1/reports', { reportCode: 'ABSCONDING_AUDIT', filters: { from: daysAgo(30) } });
    expect(refused.statusCode).toBe(403);
    const scoped = await report(auditorEng, { from: daysAgo(30) });
    expect(new Set(scoped.rows.map((r) => r['Employee code']))).toEqual(new Set([emp.E1!.code, emp.E2!.code, emp.SELF!.code]));
    expect((await report(auditorB, { from: daysAgo(30) })).rows).toEqual([]);
  });
});
