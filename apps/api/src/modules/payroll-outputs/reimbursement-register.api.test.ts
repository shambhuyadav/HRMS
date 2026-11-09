// FR-038 "reimbursement" / BRD line 345 "Reimbursement Register" (I-40 item 11; decided under owner delegation, 6 Nov 2026,
// docs/03 I-89 item 1): one payroll run's REIMBURSEMENT-head lines of its calculated records, as a report of the catalogue under
// the separate confidential export grant (payroll_report.export.amount), the payroll register's record scope (row scope, never
// the caller's own record), CSV or XLSX. A record's rows add up to its reimbursements in the payroll register. Its columns still
// await the owner's samples (section 11; docs/10 A29). Synthetic employees and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { APPROVE, calculate, calendar, CONFIG, createRun, grantOf, grants, head, months, ok, person, PREPARE, PROCESS, processRun, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { REPORTS, toCsv } from '../report/catalogue.js';
import { csvContext, csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { XLSX_MEDIA_TYPE } from '../report/xlsx.js';
import { readZip, sheetRows } from '../report/xlsx.fixtures.js';

const READ: PermissionKey[] = ['payroll_report.read.amount'];
const EXPORT: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount'];
const CODE = 'REIMBURSEMENT_REGISTER';

describe.runIf(isModuleActive('payroll-outputs'))('reimbursement register (FR-038; I-89 item 1)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let exporter: TestActor;
  let narrow: TestActor;
  let d1: string;
  let d2: string;
  let withTwo: string;
  let withOne: string;
  let without: string;
  let other: string;
  let feb: string;
  const people: Record<string, TestActor> = {};

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, list: { code: string; amount: string }[]) => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    const gross = list.reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: gross, components: list });
    people[e] = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    return e;
  };
  const request = (a: TestActor, filters: object, format?: string) => h.call(a, 'POST', '/v1/reports', { reportCode: CODE, filters, ...(format ? { format } : {}) });
  async function generated(a: TestActor, filters: object, format?: string) {
    const res = await request(a, filters, format);
    expect(res.statusCode, res.body).toBe(202);
    await processReportQueue(h.pool);
    const s = await ok<{ state: string; rowCount: number | null; format: string }>(await h.call(a, 'GET', `/v1/reports/${res.json().id}`));
    expect(s).toMatchObject({ state: 'COMPLETED', format: format ?? 'CSV' });
    const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
    expect(file.statusCode).toBe(200);
    return { file, rowCount: s.rowCount };
  }
  const register = async (a: TestActor, runId: string) => (await ok<{ items: { employeeId: string; recordId: string; reimbursements: string }[] }>(await h.call(a, 'GET', `/v1/payroll-outputs/runs/${runId}/register`))).items;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    const approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'RR_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    // Two reimbursement heads (component kind EARNING, head type REIMBURSEMENT) paid from the salary arrangement.
    await head(h, configA, configB, { code: 'RR_FUEL', headType: 'REIMBURSEMENT', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'RR_PHONE', headType: 'REIMBURSEMENT', basis: 'FIXED', sequence: 3 });
    const periods = (await calendar(h, configA, configB, months(2026))).periods;
    d1 = await department('RR_ONE');
    d2 = await department('RR_TWO');
    narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, departmentFilter: d1 });
    withTwo = await paid(d1, [
      { code: 'RR_BASIC', amount: '30000' },
      { code: 'RR_FUEL', amount: '2500.50' },
      { code: 'RR_PHONE', amount: '999.25' },
    ]);
    withOne = await paid(d1, [
      { code: 'RR_BASIC', amount: '20000' },
      { code: 'RR_PHONE', amount: '750' },
    ]);
    without = await paid(d1, [{ code: 'RR_BASIC', amount: '18000' }]);
    other = await paid(d2, [
      { code: 'RR_BASIC', amount: '25000' },
      { code: 'RR_FUEL', amount: '1200' },
    ]);
    const run = await createRun(h, preparer, periods['2026-02']!, { departmentIds: [d1, d2] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    feb = run.id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('is a catalogue report for the separate payroll report export grant only, as CSV or XLSX', async () => {
    const listed = (a: TestActor) => h.call(a, 'GET', '/v1/reports/catalogue').then((r) => (r.json().items as { code: string; formats?: string[]; columns: string[] }[]).find((i) => i.code === CODE));
    expect(await listed(exporter)).toMatchObject({ formats: ['CSV', 'XLSX'], columns: ['Record id', 'Employee code', 'Employee name', 'Component code', 'Component name', 'Basis', 'Amount', 'Currency'] });
    // No export grant, the read grant alone (viewing is not exporting) and the Employee context: not listed and refused.
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: READ });
    for (const a of [hr, reader, people[withTwo]!]) {
      expect(await listed(a)).toBeUndefined();
      expect((await request(a, { runId: feb })).statusCode).toBe(403);
    }
    // An ordinary payroll role holds no confidential export grant by default.
    const operator = await h.actor(A, 'PAYROLL_OPERATOR');
    expect((await request(operator, { runId: feb })).statusCode).toBe(403);
  });

  it('holds each reimbursement line of the run, and a record’s rows add up to its reimbursements in the payroll register', async () => {
    const g = await grantOf(h, exporter, 'payroll_report', 'export', ['amount']);
    const rows = (await REPORTS[CODE]!.rows(h.db, g, { runId: feb })) as Record<string, string>[];
    const code = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;
    const expected = [
      [await code(withTwo), 'RR_FUEL', 'FIXED', '2500.5000', 'INR'],
      [await code(withTwo), 'RR_PHONE', 'FIXED', '999.2500', 'INR'],
      [await code(withOne), 'RR_PHONE', 'FIXED', '750.0000', 'INR'],
      [await code(other), 'RR_FUEL', 'FIXED', '1200.0000', 'INR'],
    ].sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`));
    expect(rows.map((r) => [r.employeeCode, r.componentCode, r.calculationBasis, r.amount, r.currencyCode])).toEqual(expected);
    // Earnings are not reimbursements; an employee with none has no row.
    expect(rows.some((r) => r.componentCode === 'RR_BASIC')).toBe(false);
    expect(rows.some((r) => r.employeeCode === undefined)).toBe(false);
    expect(rows.map((r) => r.employeeCode)).not.toContain(await code(without));
    // Reconciliation with the payroll register: per record, the lines sum to its reimbursements (also zero for `without`).
    for (const rec of await register(exporter, feb)) {
      const sum = rows.filter((r) => r.recordId === rec.recordId).reduce((s, r) => s + Number(r.amount), 0);
      expect(sum.toFixed(4), rec.employeeId).toBe(Number(rec.reimbursements).toFixed(4));
    }

    // The file holds exactly these rows, says which run revision it comes from, and is confidential.
    const csv = await generated(exporter, { runId: feb });
    expect(csv.rowCount).toBe(4);
    expect(csvTable(csv.file.body)).toBe(toCsv(REPORTS[CODE]!, rows));
    expect(csvContext(csv.file.body)['Record revision']).toMatch(/^Payroll period 2026-02, run revision 1, state PROCESSED_LOCKED$/);
    const classification = await h.one<{ classification: string }>(
      `select a.classification from report_execution x join attachment a on a.company_id = x.company_id and a.id = x.output_attachment_id
        where x.company_id = $1 and x.report_code = $2 order by x.created_at desc limit 1`,
      [A.id, CODE],
    );
    expect(classification.classification).toBe('CONFIDENTIAL');
    const x = await generated(exporter, { runId: feb }, 'XLSX');
    expect(x.file.headers['content-type']).toBe(XLSX_MEDIA_TYPE);
    const xml = readZip(x.file.rawPayload).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    expect(sheetRows(xml, REPORTS[CODE]!.columns.length)).toHaveLength(5);
  });

  it("applies the requester's row scope and never lists the requester's own record", async () => {
    const g = await grantOf(h, narrow, 'payroll_report', 'export', ['amount']);
    const scoped = (await REPORTS[CODE]!.rows(h.db, g, { runId: feb })) as Record<string, string>[];
    expect(new Set(scoped.map((r) => r.recordId)).size).toBe(2);
    expect(scoped).toHaveLength(3);
    const file = await generated(narrow, { runId: feb });
    expect(csvTable(file.file.body)).toBe(toCsv(REPORTS[CODE]!, scoped));
    const otherCode = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [other])).c;
    expect(csvTable(file.file.body)).not.toContain(otherCode);

    // The same person as `withTwo`, in an unrestricted Admin assignment holding the export grant: their own lines are left out.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, user: people[withTwo]!.user });
    const mine = await generated(self, { runId: feb });
    expect(mine.rowCount).toBe(2);
    const selfCode = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [withTwo])).c;
    expect(csvTable(mine.file.body)).not.toContain(selfCode);
  });

  it('covers exactly one payroll run and refuses a period, other filters, a missing run or another company’s run', async () => {
    const cases: [object, number, string][] = [
      [{}, 422, 'RUN_REQUIRED'],
      [{ runId: feb, from: '2026-02-01', to: '2026-02-28' }, 422, 'FILTER_NOT_SUPPORTED'],
      [{ runId: feb, status: 'PROCESSED_LOCKED' }, 422, 'FILTER_NOT_SUPPORTED'],
      [{ runId: feb, employeeId: withTwo }, 422, 'FILTER_NOT_SUPPORTED'],
      [{ runId: '00000000-0000-4000-8000-000000000009' }, 404, 'NOT_FOUND'],
    ];
    for (const [filters, status, error] of cases) {
      const res = await request(exporter, filters);
      expect([res.statusCode, res.json().error], JSON.stringify(filters)).toEqual([status, error]);
    }
    const foreign = await h.actor(await h.makeCompany(), 'HR_ADMINISTRATOR', { extra: EXPORT });
    expect((await request(foreign, { runId: feb })).statusCode).toBe(404);
  });
});
