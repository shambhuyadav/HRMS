// FR-054 settlement outputs and bulk upload over HTTP (CL-244 Bulk Upload, CL-245 PDF, CL-246 Excel, CL-247 ZIP;
// DF09; FR-064; FR-106). Outputs: one approved revision as CSV, Excel (XLSX) or PDF with the same rows, and a ZIP of the
// settlements selected from the list; every output re-checks scope and the amount group, is audited and sends nothing.
// Bulk upload: SETTLEMENT_LINES_V1 rows for many drafts through the shared import lifecycle, each row checked as the
// one-settlement upload checks it, all or nothing. Synthetic employees, pay components and amounts only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { parseCsv } from '../employee/csv.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { isModuleActive } from '../registry.js';
import { pdfLines, readPdf } from '../report/pdf.fixtures.js';
import { readZip, sheetCells, sheetRows } from '../report/xlsx.fixtures.js';
import type { AccessGrant } from '../access/authorize.js';
import { resolveAccess } from '../access/authorize.js';
import { withTransaction } from '../../db/transaction.js';
import { exportSettlement, exportSettlementArchive } from './settlement.js';
import { HR_SETTLEMENT, HR_SETTLEMENT_EXPORT, key, person, today as businessDate, trailText } from './lifecycle.fixtures.js';

const HEADER = 'employee_code,last_working_date,component_code,amount,line_kind';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Leaver {
  employeeId: string;
  exitId: string;
  code: string;
  lastWorkingDate: string;
}

describe.runIf(isModuleActive('lifecycle'))('settlement outputs and bulk upload (FR-054)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let prep: TestActor;
  let prep2: TestActor;
  let rev: TestActor;
  let appr: TestActor;
  let hrPlain: TestActor;
  let hrFinance: TestActor;
  let hrB: TestActor;
  let payroll: TestActor;
  let today: string;
  // Approved revisions (S1, S2) and a draft (S3), for the outputs.
  let s1: { id: string; code: string };
  let s2: { id: string; code: string };
  let s3: { id: string; code: string };
  // Empty drafts for the bulk upload: D1 and D2 prepared by prep, D3 by prep2.
  let d1: Leaver & { id: string };
  let d2: Leaver & { id: string };
  let d3: Leaver & { id: string };

  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const get = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/settlements/${id}`)).json();
  const exportOf = (a: TestActor, id: string, format?: string) => h.call(a, 'GET', `/v1/settlements/${id}/export${format ? `?format=${format}` : ''}`);
  const archive = (a: TestActor, ids: string[], format?: string) => h.call(a, 'GET', `/v1/settlements/export-archive?ids=${ids.join(',')}${format ? `&format=${format}` : ''}`);
  const exportAudits = async (id: string) =>
    (
      await h.db.query<{ after: { operational: Record<string, unknown> } }>(
        `select after_values as after from audit_event where company_id = $1 and resource_code = 'settlement' and record_key = $2 and action = 'EXPORT' order by created_at, id`,
        [A.id, id],
      )
    ).rows.map((r) => r.after.operational);
  const outbox = async () => (await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1`, [A.id])).n;

  /** An approved exit of a new synthetic employee, written directly (the exit journey itself is tested in exit.api.test.ts). */
  async function leaver(name: string, lastWorkingDate = today): Promise<Leaver> {
    const employeeId = await person(h, A, hr, { name });
    await h.db.query('begin');
    let exitId: string;
    try {
      const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
      exitId = (
        await h.one<{ id: string }>(
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, 'RESIGNATION', $4, $4, $4, 'SUBMITTED') returning id`,
          [A.id, employeeId, bt.id, lastWorkingDate],
        )
      ).id;
      await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [exitId, lastWorkingDate]);
      await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [exitId, lastWorkingDate]);
      await h.db.query('commit');
    } catch (e) {
      await h.db.query('rollback');
      throw e;
    }
    const code = (await h.one<{ code: string }>(`select employee_code as code from employee where id = $1`, [employeeId])).code;
    return { employeeId, exitId, code, lastWorkingDate };
  }

  async function draft(a: TestActor, x: Leaver): Promise<Leaver & { id: string }> {
    const res = await h.call(a, 'POST', `/v1/exit-cases/${x.exitId}/settlements`, { currencyCode: 'INR' });
    expect(res.statusCode, res.body).toBe(201);
    return { ...x, id: res.json().id as string };
  }

  async function approved(name: string, lines: { componentCode: string; amount: string; lineKind?: string }[]) {
    const s = await draft(prep, await leaver(name));
    const saved = await h.call(prep, 'PUT', `/v1/settlements/${s.id}/lines`, { lines, expectedVersion: (await get(prep, s.id)).version });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await h.call(prep, 'POST', `/v1/settlements/${s.id}/submit`, { expectedVersion: saved.json().version })).statusCode).toBe(200);
    for (const [a, step] of [
      [rev, 'review'],
      [appr, 'approve'],
    ] as const) {
      const task = ((await h.call(a, 'GET', '/v1/settlements/tasks/mine')).json().items as { taskId: string; settlement: { id: string } | null }[]).find((t) => t.settlement?.id === s.id)!;
      const decided = await h.call(a, 'POST', `/v1/settlements/tasks/${task.taskId}/${step}`, { decision: 'APPROVE', idempotencyKey: key() });
      expect(decided.statusCode, decided.body).toBe(200);
    }
    expect((await get(prep, s.id)).state).toBe('APPROVED');
    return { id: s.id, code: s.code };
  }

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT });
    prep2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    rev = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    appr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
    hrFinance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT, departmentFilter: A.financeDept });
    hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT });
    payroll = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['settlement.read.operational'] });
    today = await businessDate(h, A);
    for (const [code, name, kind, active] of [
      ['BASIC', 'Basic pay (synthetic)', 'EARNING', true],
      ['LEAVE_ENC', '=HYPERLINK("synthetic")', 'EARNING', true],
      ['LOAN', 'Loan recovery (synthetic)', 'DEDUCTION', true],
      ['NOTICE_REC', 'Notice recovery (synthetic)', 'DEDUCTION', true],
      ['OLD', 'Retired component (synthetic)', 'EARNING', false],
    ] as const) {
      await h.db.query(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, $2, $3, $4, $5)`, [A.id, code, name, kind, active]);
    }
    const routed = await h.call(hr, 'PUT', '/v1/workflows/settlement/fallback-reviewers', {
      reviewers: [
        { userId: rev.user, priority: 1 },
        { userId: appr.user, priority: 2 },
      ],
    });
    expect(routed.statusCode, routed.body).toBe(200);
    s1 = await approved('Ada Approved (synthetic)', [
      { componentCode: 'BASIC', amount: '40000.25' },
      { componentCode: 'LEAVE_ENC', amount: '0' },
      { componentCode: 'LOAN', amount: '-250.25' },
    ]);
    // An amount with more significant digits than a spreadsheet number keeps (19): text in the workbook.
    s2 = await approved('Ben Approved (synthetic)', [
      { componentCode: 'BASIC', amount: '123456789012345.1234' },
      { componentCode: 'LOAN', amount: '-1' },
    ]);
    const third = await draft(prep, await leaver('Cy Draft (synthetic)'));
    s3 = { id: third.id, code: third.code };
    d1 = await draft(prep, await leaver('Dee Draft (synthetic)'));
    d2 = await draft(prep, await leaver('Eve Draft (synthetic)'));
    d3 = await draft(prep2, await leaver('Fay Other (synthetic)'));
  });

  afterAll(async () => {
    await h?.stop();
  });

  // -------------------------------------------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------------------------------------------

  it('exports the same rows as Excel (XLSX) as the CSV: amounts as exact numbers, formula-like text guarded', async () => {
    expect((await exportOf(payroll, s1.id, 'XLSX')).statusCode).toBe(403);
    expect((await exportOf(hrPlain, s1.id, 'XLSX')).statusCode).toBe(403);
    expect((await exportOf(hrB, s1.id, 'XLSX')).statusCode).toBe(404);
    expect((await exportOf(hrFinance, s1.id, 'XLSX')).statusCode).toBe(404);
    expect((await exportOf(prep, s1.id, 'DOCX')).statusCode).toBe(400);
    expect((await exportOf(prep, s3.id, 'XLSX')).json()).toMatchObject({ error: 'NOT_APPROVED', details: { settlementId: s3.id } });
    // CSV stays the default format, byte for byte as before (only the generated time differs between two exports).
    const csv = await exportOf(prep, s1.id);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toContain(`filename="settlement-${s1.code}-r1.csv"`);
    const explicit = await exportOf(prep, s1.id, 'CSV');
    const timeless = (text: string) => text.replace(/"(generated_at|Generated at)","[^"]+"/g, '"$1","T"');
    expect(timeless(explicit.body)).toBe(timeless(csv.body));
    // DF09, FR-065: the file says what it holds, as every report file does: a leading block ended by a blank line.
    const block = parseCsv(csv.body.split('\r\n\r\n')[0]!);
    expect(block.map(([label]) => label)).toEqual(['Report', 'Report code', 'Company', 'Acting role', 'Row scope', 'Period', 'Filters', 'Record revision', 'Generated at', 'Rows']);
    expect(Object.fromEntries(block)).toMatchObject({ Report: 'Settlement export', 'Report code': 'SETTLEMENT_EXPORT', 'Acting role': 'HR_ADMINISTRATOR', 'Row scope': 'COMPANY', Period: 'None', Filters: `settlement: ${s1.id}`, 'Record revision': '1', Rows: '3' });
    expect(Object.fromEntries(block).Company).toMatch(/\(.+\)$/);
    expect(Object.fromEntries(block)['Generated at']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);

    const res = await exportOf(prep, s1.id, 'XLSX');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe(XLSX);
    expect(res.headers['content-disposition']).toContain(`filename="settlement-${s1.code}-r1.xlsx"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const entries = readZip(res.rawPayload);
    expect(entries.get('xl/workbook.xml')!.toString('utf8')).toContain(`<sheet name="Settlement ${s1.code} r1"`);
    const xml = entries.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    // Cell for cell what the CSV holds (its blank line apart), generated time aside.
    const rows = sheetRows(xml, 5).filter((r) => r.some((c) => c !== ''));
    const fromCsv = parseCsv(csv.body).map((r) => [...r, '', '', '', ''].slice(0, 5));
    const generated = (r: string[][]) => r.map((row) => (row[0] === 'generated_at' || row[0] === 'Generated at' ? [row[0], 'T', '', '', ''] : row));
    expect(generated(rows)).toEqual(generated(fromCsv.filter((r) => r.some((c) => c !== ''))));
    expect(rows.find((r) => r[0] === 'LEAVE_ENC')).toEqual(['LEAVE_ENC', `'=HYPERLINK("synthetic")`, 'EARNING', 'STANDARD', '0.0000']);
    expect(rows.at(-1)).toEqual(['NET', '', '', '', '39750.0000']);
    // The revision and the amounts are number cells; everything else is text.
    const cells = sheetCells(xml).flat();
    expect(cells.filter((c) => c.kind === 'number').map((c) => [c.ref, c.value])).toEqual([
      ['B14', '1'],
      ['E21', '40000.2500'],
      ['E22', '0.0000'],
      ['E23', '-250.2500'],
      ['E24', '39750.0000'],
    ]);
    // The workbook's total equals the approved net amount and the sum of its lines.
    expect((await get(prep, s1.id)).netAmount).toBe('39750.0000');
    expect(await exportAudits(s1.id)).toEqual([
      { revision: 1, lineCount: 3, format: 'CSV' },
      { revision: 1, lineCount: 3, format: 'CSV' },
      { revision: 1, lineCount: 3, format: 'XLSX' },
    ]);
  });

  it('keeps an amount a spreadsheet number cannot hold exactly as text in the workbook', async () => {
    const res = await exportOf(prep, s2.id, 'XLSX');
    expect(res.statusCode, res.body).toBe(200);
    const cells = sheetCells(readZip(res.rawPayload).get('xl/worksheets/sheet1.xml')!.toString('utf8')).flat();
    expect(cells.filter((c) => c.ref.startsWith('E') && c.ref !== 'E20').map((c) => [c.ref, c.kind, c.value])).toEqual([
      ['E21', 'text', '123456789012345.1234'],
      ['E22', 'number', '-1.0000'],
      ['E23', 'text', '123456789012344.1234'],
    ]);
  });

  it('exports the same rows as a PDF in the standard Helvetica font, the total equal to the approved net amount', async () => {
    expect((await exportOf(payroll, s1.id, 'PDF')).statusCode).toBe(403);
    const res = await exportOf(prep, s1.id, 'PDF');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`filename="settlement-${s1.code}-r1.pdf"`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const read = readPdf(res.rawPayload);
    expect(read.font).toContain('/BaseFont /Helvetica');
    expect(read.pages).toHaveLength(1);
    const lines = pdfLines(res.rawPayload);
    const generatedAt = lines.find((l) => l[0] === 'generated_at')![1]!;
    expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
    // The same context as the other formats, first.
    expect(lines.slice(0, 2)).toEqual([
      ['Report', 'Settlement export'],
      ['Report code', 'SETTLEMENT_EXPORT'],
    ]);
    expect(lines.find((l) => l[0] === 'Rows')).toEqual(['Rows', '3']);
    // A PDF is no spreadsheet: the component name is printed as recorded.
    expect(lines.slice(lines.findIndex((l) => l[0] === 'settlement_id'))).toEqual([
      ['settlement_id', s1.id],
      ['employee_code', s1.code],
      ['revision', '1'],
      ['state', 'APPROVED'],
      ['currency_code', 'INR'],
      ['calculation_status', 'NOT_CONFIGURED'],
      ['generated_at', generatedAt],
      ['component_code', 'component_name', 'component_kind', 'line_kind', 'amount'],
      ['BASIC', 'Basic pay (synthetic)', 'EARNING', 'STANDARD', '40000.2500'],
      ['LEAVE_ENC', '=HYPERLINK("synthetic")', 'EARNING', 'STANDARD', '0.0000'],
      ['LOAN', 'Loan recovery (synthetic)', 'DEDUCTION', 'STANDARD', '-250.2500'],
      ['NET', '39750.0000'],
    ]);
    expect((await exportAudits(s1.id)).at(-1)).toEqual({ revision: 1, lineCount: 3, format: 'PDF' });
  });

  it('downloads the selected settlements as one ZIP of their files in the chosen format, in the order selected', async () => {
    const before = await outbox();
    const res = await archive(prep, [s2.id, s1.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/filename="settlements-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(res.headers['cache-control']).toBe('no-store');
    const entries = readZip(res.rawPayload);
    expect([...entries.keys()]).toEqual([`settlement-${s2.code}-r1.csv`, `settlement-${s1.code}-r1.csv`]);
    // Each file is the settlement's own CSV export.
    const timeless = (text: string) => text.replace(/"(generated_at|Generated at)","[^"]+"/g, '"$1","T"');
    expect(timeless(entries.get(`settlement-${s1.code}-r1.csv`)!.toString('utf8'))).toBe(timeless((await exportOf(prep, s1.id)).body));
    expect(timeless(entries.get(`settlement-${s2.code}-r1.csv`)!.toString('utf8'))).toBe(timeless((await exportOf(prep, s2.id)).body));
    expect(entries.get(`settlement-${s1.code}-r1.csv`)!.toString('utf8').trim().split('\r\n').at(-1)).toBe('"NET","","","",39750.0000');

    const xlsx = readZip((await archive(prep, [s1.id, s2.id], 'XLSX')).rawPayload);
    expect([...xlsx.keys()]).toEqual([`settlement-${s1.code}-r1.xlsx`, `settlement-${s2.code}-r1.xlsx`]);
    const sheet = readZip(xlsx.get(`settlement-${s1.code}-r1.xlsx`)!).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(sheetRows(sheet, 5).at(-1)).toEqual(['NET', '', '', '', '39750.0000']);
    const pdfs = readZip((await archive(prep, [s1.id], 'PDF')).rawPayload);
    expect([...pdfs.keys()]).toEqual([`settlement-${s1.code}-r1.pdf`]);
    expect(pdfLines(pdfs.get(`settlement-${s1.code}-r1.pdf`)!).at(-1)).toEqual(['NET', '39750.0000']);
    // An id given twice is one file.
    expect([...readZip((await archive(prep, [s1.id, s1.id.toUpperCase()])).rawPayload).keys()]).toEqual([`settlement-${s1.code}-r1.csv`]);

    // Each settlement in an archive is audited as its export, with the archive named; nothing is sent.
    expect((await exportAudits(s2.id)).slice(1)).toEqual([
      { revision: 1, lineCount: 2, format: 'CSV', archive: 'ZIP', archiveSize: 2 },
      { revision: 1, lineCount: 2, format: 'CSV' },
      { revision: 1, lineCount: 2, format: 'XLSX', archive: 'ZIP', archiveSize: 2 },
    ]);
    expect((await exportAudits(s1.id)).at(-1)).toEqual({ revision: 1, lineCount: 3, format: 'CSV', archive: 'ZIP', archiveSize: 1 });
    expect(await outbox()).toBe(before);
    const trail = await trailText(h, A.id, [s1.id, s2.id]);
    expect(trail).toContain('ZIP');
    expect(trail).not.toMatch(/39750|40000|250\.25|123456789/);
  });

  it('refuses the whole archive when one selected settlement is not available, recording no export', async () => {
    const audits = async () => (await exportAudits(s1.id)).length;
    const before = await audits();
    expect((await archive(prep, [s1.id, s3.id])).json()).toMatchObject({ error: 'NOT_APPROVED', details: { settlementId: s3.id } });
    expect((await archive(prep, [s1.id, randomUUID()])).statusCode).toBe(404);
    // Row scope, company and the amount group are checked for every settlement.
    expect((await archive(hrFinance, [s1.id])).statusCode).toBe(404);
    expect((await archive(hrB, [s1.id])).statusCode).toBe(404);
    expect((await archive(payroll, [s1.id])).statusCode).toBe(403);
    expect((await archive(hrPlain, [s1.id])).statusCode).toBe(403);
    // Never one's own settlement, even among others.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT_EXPORT, employeeId: (await get(prep, s1.id)).employeeId });
    expect((await archive(self, [s2.id, s1.id])).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await archive(self, [s2.id])).statusCode).toBe(200);
    expect(await audits()).toBe(before);
    // The selection: at least one id, at most 100 (a technical bound: one full page of the list), ids only.
    const many = Array.from({ length: 101 }, () => randomUUID());
    expect((await archive(prep, many)).json()).toMatchObject({ error: 'TOO_MANY_SETTLEMENTS', details: { max: 100 } });
    expect((await archive(prep, many.slice(0, 100))).statusCode).toBe(404);
    expect((await h.call(prep, 'GET', '/v1/settlements/export-archive')).statusCode).toBe(400);
    expect((await h.call(prep, 'GET', `/v1/settlements/export-archive?ids=${s1.id},`)).statusCode).toBe(400);
    expect((await h.call(prep, 'GET', `/v1/settlements/export-archive?ids=${s1.id};drop`)).statusCode).toBe(400);
    expect((await archive(prep, [s1.id], 'DOCX')).statusCode).toBe(400);
  });

  it('exporting is its own right: reading, reviewing, approving or releasing a settlement does not allow it (FR-002)', async () => {
    // HR_SETTLEMENT holds every other settlement amount duty, the read grant among them.
    const audits = async () => (await exportAudits(s1.id)).length;
    const before = await audits();
    expect((await h.call(rev, 'GET', `/v1/settlements/${s1.id}`)).json().netAmount).toBe('39750.0000');
    for (const format of ['CSV', 'XLSX', 'PDF']) {
      const one = await exportOf(rev, s1.id, format);
      expect([one.statusCode, one.json().error]).toEqual([403, 'FORBIDDEN']);
      const many = await archive(rev, [s1.id, s2.id], format);
      expect([many.statusCode, many.json().error]).toEqual([403, 'FORBIDDEN']);
    }
    // The export grant is ceiling-only: no HR Administrator holds it by default.
    expect((await exportOf(hrPlain, s1.id)).statusCode).toBe(403);
    expect(await audits()).toBe(before);
    // The export grant alone is enough.
    const exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['settlement.export.amount'] });
    expect((await exportOf(exporter, s1.id)).statusCode).toBe(200);
    expect((await archive(exporter, [s1.id])).statusCode).toBe(200);
    expect(await audits()).toBe(before + 2);
    // Refusals are recorded against the export action, with no amount.
    const denied = await h.db.query<{ after: { action: string } }>(
      `select after_values as after from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'settlement' and actor_user_id = $2 and record_key = $3`,
      [A.id, rev.user, s1.id],
    );
    expect(denied.rows.map((r) => r.after.action)).toEqual(['export', 'export', 'export']);
  });

  it('re-checks the export grant inside the build: one revoked after the route guard refuses and records nothing', async () => {
    const exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['settlement.export.amount'] });
    const stale = (await resolveAccess(h.pool, { userId: exporter.user, companyId: A.id, assignmentId: exporter.assignment, resource: 'settlement', action: 'export', fieldGroups: ['amount'] })) as AccessGrant;
    expect(stale.allowed).toBe(true);
    const audits = async () => (await exportAudits(s1.id)).length;
    const before = await audits();
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'settlement' and action = 'export' and field_group = 'amount')`,
      [exporter.assignment],
    );
    await expect(withTransaction(h.pool, (tx) => exportSettlementArchive(tx, stale, [s1.id]))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => exportSettlement(tx, stale, s1.id))).rejects.toMatchObject({ statusCode: 403 });
    expect(await audits()).toBe(before);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Bulk upload
  // -------------------------------------------------------------------------------------------------------------

  const IMPORTS = '/v1/settlements/line-imports';
  const upload = (a: TestActor, text: string, fileName = 'settlements.csv') => h.call(a, 'POST', IMPORTS, { fileName, contentBase64: b64(text), idempotencyKey: key('sl-key-') });
  const file = (rows: string[][]) => `${HEADER}\r\n${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;
  type JobRow = { rowNumber: number; businessKey: string; state: string; errorCode: string | null };

  it('previews and commits the lines of several drafts in one file, replacing each draft’s lines as its own upload does', async () => {
    // D1 already has an entered line, which the upload replaces.
    const entered = await h.call(prep, 'PUT', `/v1/settlements/${d1.id}/lines`, { lines: [{ componentCode: 'NOTICE_REC', amount: '-1' }], expectedVersion: (await get(prep, d1.id)).version });
    expect(entered.statusCode, entered.body).toBe(200);
    const versions = { d1: entered.json().version as number, d2: (await get(prep, d2.id)).version as number };
    const text = file([
      [d1.code, d1.lastWorkingDate, 'BASIC', '50000.00', ''],
      [d2.code.toLowerCase(), d2.lastWorkingDate, 'BASIC', '1200.5', 'STANDARD'],
      [d1.code, d1.lastWorkingDate, 'loan', '-100.25', 'standard'],
      [d2.code, d2.lastWorkingDate, 'LEAVE_ENC', '0', ''],
    ]);
    expect((await upload(hrPlain, text)).statusCode).toBe(403);
    expect((await upload(payroll, text)).statusCode).toBe(403);
    const res = await upload(prep, text);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'PREVIEWED', template: 'SETTLEMENT_LINES_V1', rowCount: 4, acceptedCount: 0, rejectedCount: 0 });
    expect((res.json().rows as JobRow[]).map((r) => [r.rowNumber, r.businessKey, r.state, r.errorCode])).toEqual([
      [1, `${d1.code}/BASIC`, 'VALID', null],
      [2, `${d2.code}/BASIC`, 'VALID', null],
      [3, `${d1.code}/LOAN`, 'VALID', null],
      [4, `${d2.code}/LEAVE_ENC`, 'VALID', null],
    ]);
    // A preview changes nothing.
    expect(await get(prep, d1.id)).toMatchObject({ version: versions.d1, netAmount: '-1.0000' });
    expect(await get(prep, d2.id)).toMatchObject({ version: versions.d2, netAmount: '0.0000' });
    // Only its submitter commits it.
    expect((await h.call(prep2, 'POST', `${IMPORTS}/${res.json().id}/commit`)).statusCode).toBe(404);
    const committed = await h.call(prep, 'POST', `${IMPORTS}/${res.json().id}/commit`);
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 4, rejectedCount: 0 });
    const one = await get(prep, d1.id);
    expect(one).toMatchObject({ state: 'DRAFT', netAmount: '49899.7500', version: versions.d1 + 1 });
    expect(one.lines.map((l: { componentCode: string; amount: string; source: string }) => [l.componentCode, l.amount, l.source])).toEqual([
      ['BASIC', '50000.0000', 'UPLOADED'],
      ['LOAN', '-100.2500', 'UPLOADED'],
    ]);
    const two = await get(prep, d2.id);
    expect(two).toMatchObject({ netAmount: '1200.5000', version: versions.d2 + 1 });
    expect(two.lines.map((l: { componentCode: string; source: string }) => [l.componentCode, l.source])).toEqual([
      ['BASIC', 'UPLOADED'],
      ['LEAVE_ENC', 'UPLOADED'],
    ]);
    // Committing again changes nothing; nothing is submitted for review.
    expect((await h.call(prep, 'POST', `${IMPORTS}/${res.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED' });
    expect((await get(prep, d1.id)).version).toBe(versions.d1 + 1);
    // Each settlement's upload is audited with counts only; the import rows hold codes, never an amount.
    const uploads = await h.db.query<{ after: { operational: Record<string, unknown> } }>(
      `select after_values as after from audit_event where company_id = $1 and resource_code = 'settlement' and record_key = any($2::uuid[]) and action = 'UPLOAD' order by created_at`,
      [A.id, [d1.id, d2.id]],
    );
    expect(uploads.rows.map((r) => r.after.operational)).toEqual([
      { template: 'SETTLEMENT_LINES_V1', revision: 1, rows: 2, accepted: 2, rejected: 0, applied: true, bulk: true },
      { template: 'SETTLEMENT_LINES_V1', revision: 1, rows: 2, accepted: 2, rejected: 0, applied: true, bulk: true },
    ]);
    const stored = await h.one<{ t: string }>(`select string_agg(business_key || coalesce(proposed_changes::text, ''), ' ') as t from import_row where job_id = $1`, [res.json().id]);
    expect(stored.t).not.toMatch(/50000|1200|100\.25/);
    expect(await trailText(h, A.id, [d1.id, d2.id, res.json().id])).not.toMatch(/50000|1200\.5|100\.25/);
  });

  it('checks every row as the one-settlement upload does and rejects the whole file on any row error', async () => {
    const before = { d1: await get(prep, d1.id), d2: await get(prep, d2.id) };
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT, employeeId: d1.employeeId });
    const rows: [string[], string | null][] = [
      [[d2.code, d2.lastWorkingDate, 'BASIC', '10', ''], null],
      [['NO-SUCH-CODE', today, 'BASIC', '1', ''], 'UNKNOWN_EMPLOYEE'],
      [[s1.code, today, 'BASIC', '1', ''], 'NO_DRAFT_SETTLEMENT'],
      [[d1.code, '2001-01-01', 'BASIC', '1', ''], 'DATE_MISMATCH'],
      [[d3.code, d3.lastWorkingDate, 'BASIC', '1', ''], 'NOT_PREPARER'],
      [[d1.code, d1.lastWorkingDate, 'NOPE', '1', ''], 'UNKNOWN_COMPONENT'],
      [[d1.code, d1.lastWorkingDate, 'OLD', '1', ''], 'UNKNOWN_COMPONENT'],
      [[d1.code, d1.lastWorkingDate, 'BASIC', '1e3', ''], 'INVALID_AMOUNT'],
      [[d1.code, d1.lastWorkingDate, 'BASIC', '-5', ''], 'SIGN_MISMATCH'],
      [[d1.code, d1.lastWorkingDate, 'LOAN', '5', ''], 'SIGN_MISMATCH'],
      [[d1.code, d1.lastWorkingDate, 'BASIC', '5', 'BONUS'], 'INVALID_LINE_KIND'],
      [[d1.code, d1.lastWorkingDate, 'NOTICE_REC', '-5', 'NOTICE_ADJUSTMENT'], 'NOTICE_PERIOD_NOT_RECORDED'],
      [[d2.code, d2.lastWorkingDate, 'basic', '20', ''], 'DUPLICATE_COMPONENT'],
      [[d1.code, d1.lastWorkingDate, 'BASIC', '5'], 'COLUMN_COUNT'],
      [[d1.code, d1.lastWorkingDate, 'BASIC', '7', ''], null],
    ];
    const res = await upload(prep, file(rows.map(([r]) => r)));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ state: 'REJECTED', rowCount: rows.length, acceptedCount: 0, rejectedCount: rows.length });
    expect((res.json().rows as JobRow[]).map((r) => r.errorCode)).toEqual(rows.map(([, code]) => code ?? 'BATCH_REJECTED'));
    expect((res.json().rows as JobRow[]).every((r) => r.state === 'REJECTED')).toBe(true);
    // Nothing changed in either draft, and a rejected batch is never committed.
    for (const s of [d1, d2]) expect(await get(prep, s.id)).toMatchObject({ version: before[s === d1 ? 'd1' : 'd2'].version, netAmount: before[s === d1 ? 'd1' : 'd2'].netAmount });
    expect((await h.call(prep, 'POST', `${IMPORTS}/${res.json().id}/commit`)).json().error).toBe('INVALID_STATE');
    // Row scope and one's own record.
    const scoped = await upload(hrFinance, file([[d1.code, d1.lastWorkingDate, 'BASIC', '1', '']]));
    expect((scoped.json().rows as JobRow[]).map((r) => r.errorCode)).toEqual(['OUT_OF_SCOPE']);
    const own = await upload(self, file([[d1.code, d1.lastWorkingDate, 'BASIC', '1', '']]));
    expect((own.json().rows as JobRow[]).map((r) => r.errorCode)).toEqual(['SELF_ACTION_NOT_ALLOWED']);
    // File-level checks of the shared framework: the exact header, at least one row, and the malware scan first.
    expect((await upload(prep, 'employee,amount\r\nx,1\r\n')).json().error).toBe('INVALID_HEADER');
    expect((await upload(prep, `${HEADER}\r\n`)).json().error).toBe('EMPTY_FILE');
    const flagged = await upload(prep, `${HEADER}\r\n${EICAR_TEST_STRING}\r\n`);
    expect(flagged.statusCode).toBe(422);
    expect(flagged.json().error).toBe('FILE_QUARANTINED');
  });

  it('reports a draft’s rows with the same codes as the one-settlement upload', async () => {
    const rows = [
      [d2.code, d2.lastWorkingDate, 'BASIC', '10', ''],
      [d2.code, '2001-01-01', 'LOAN', '-1', ''],
      [d2.code, d2.lastWorkingDate, 'LOAN', '5', ''],
      [d2.code, d2.lastWorkingDate, 'NOTICE_REC', '-5', 'NOTICE_ADJUSTMENT'],
      [d2.code, d2.lastWorkingDate, 'NOPE', '1', ''],
      [d2.code, d2.lastWorkingDate, 'BASIC', '1', ''],
      [d2.code, d2.lastWorkingDate, 'LOAN', '-1', 'X'],
    ];
    const single = await h.call(prep, 'POST', `/v1/settlements/${d2.id}/upload`, { contentBase64: b64(file(rows)), dryRun: true, expectedVersion: (await get(prep, d2.id)).version });
    expect(single.statusCode, single.body).toBe(200);
    const bulk = await upload(prep, file(rows));
    expect(bulk.json().state).toBe('REJECTED');
    // The one-settlement upload numbers rows from the header (row 1); the import framework from the first data row.
    expect((bulk.json().rows as JobRow[]).map((r) => ({ row: r.rowNumber + 1, code: r.errorCode }))).toEqual(single.json().errors);
  });

  it('applies nothing when a draft changed after the preview: the commit is refused and the batch rejected', async () => {
    const res = await upload(prep, file([
      [d1.code, d1.lastWorkingDate, 'BASIC', '1', ''],
      [d2.code, d2.lastWorkingDate, 'BASIC', '2', ''],
    ]));
    expect(res.json().state).toBe('PREVIEWED');
    const before = await get(prep, d1.id);
    // D2 is submitted meanwhile: its lines are frozen.
    expect((await h.call(prep, 'POST', `/v1/settlements/${d2.id}/submit`, { expectedVersion: (await get(prep, d2.id)).version })).statusCode).toBe(200);
    const committed = await h.call(prep, 'POST', `${IMPORTS}/${res.json().id}/commit`);
    expect(committed.json()).toMatchObject({ state: 'REJECTED', acceptedCount: 0, rejectedCount: 2 });
    expect((committed.json().rows as JobRow[]).map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'NO_DRAFT_SETTLEMENT']);
    expect(await get(prep, d1.id)).toMatchObject({ version: before.version, netAmount: before.netAmount });
  });

  // The caller's own batches, the published template and a batch held for the malware scan (imports/routes.ts).
  let owned: Leaver | null = null;
  followUpSuite({
    path: IMPORTS,
    template: 'SETTLEMENT_LINES_V1',
    harness: () => h,
    company: () => A,
    submitter: async () => {
      const a = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
      // The first submitter prepares a draft of its own, which the valid file fills.
      if (!owned) owned = await draft(a, await leaver('Gus Follow-up (synthetic)'));
      return a;
    },
    denied: async () => [hrPlain, payroll],
    validFile: async () => ({
      text: `${HEADER}\r\n${owned!.code},${owned!.lastWorkingDate},BASIC,100.00,\r\n${owned!.code},${owned!.lastWorkingDate},LOAN,-10,STANDARD`,
      rows: 2,
    }),
  });
});
