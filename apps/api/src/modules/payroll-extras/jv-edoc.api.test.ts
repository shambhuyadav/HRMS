// Salary JV and the EDOC export over HTTP, the report worker and the bulk worker, on real processed payroll (BRD coverage CL-097 GL
// mapping and salary JV, CL-100 export for EDOC, CL-084 past salary against processed payroll; FR-038; FR-107; DF07; NFR-S09 bulk work;
// BR-026 row scope; C4 never one's own). Synthetic employees, amounts and accounts (the owner's chart of accounts is not available).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { APPROVE, calculate, calendar, CONFIG, createRun, head, months, ok, person, PREPARE, PROCESS, processRun, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { isModuleActive } from '../registry.js';
import { MODULE_DAILY_JOBS } from '../jobs-registry.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { EDOC_MAX_ARCHIVE_BYTES, edocArchive, purgeExpiredEdocFiles } from './edoc.js';

const MAPPING: PermissionKey[] = ['payroll_gl_mapping.read.operational', 'payroll_gl_mapping.manage.operational'];
const REPORT: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount'];
const EXPORT: PermissionKey[] = ['payroll_output.export.amount'];
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

/** The entries of a stored (uncompressed) ZIP: name and bytes, read from the local headers. */
function unzip(zip: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let at = 0;
  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.push({ name, data: zip.subarray(start, start + size) });
    at = start + size;
  }
  return out;
}

describe.runIf(isModuleActive('payroll-extras') && isModuleActive('payroll-outputs'))('salary JV and EDOC export (CL-097, CL-100)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let mapper: TestActor;
  let reader: TestActor;
  let runId: string;
  const e: Record<string, string> = {};
  const code: Record<string, string> = {};

  const jv = (a: TestActor, id = runId) => h.call(a, 'GET', `/v1/payroll-extras/runs/${id}/salary-jv`);
  const mapping = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/payroll-extras/gl-mappings', { effectiveFrom: '2026-01-01', netPayAccountCode: '2000', reason: 'Synthetic chart', ...body });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    const approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    mapper = await h.actor(A, 'HR_ADMINISTRATOR', { extra: MAPPING });
    reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'JV_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'JV_DED', headType: 'DEDUCTION', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'JV_ER', headType: 'EMPLOYER_CONTRIBUTION', basis: 'FIXED', sequence: 3 });
    const periods = (await calendar(h, configA, configB, months(2026))).periods;
    const paid = async (key: string, departmentId: string, components: { code: string; amount: string }[]) => {
      e[key] = await person(h, A, hr, { departmentId, joiningDate: '2025-12-01', name: `Synthetic ${key}` });
      code[key] = (await h.one<{ employee_code: string }>(`select employee_code from employee where id = $1`, [e[key]])).employee_code;
      await salary(h, preparer, e[key]!, { effectiveFrom: '2025-12-01', monthlyGross: components[0]!.amount, components });
    };
    await paid('eng1', A.dept, [{ code: 'JV_BASIC', amount: '30000' }, { code: 'JV_DED', amount: '1000' }, { code: 'JV_ER', amount: '1500' }]);
    await paid('fin1', A.financeDept, [{ code: 'JV_BASIC', amount: '20000' }, { code: 'JV_DED', amount: '500' }, { code: 'JV_ER', amount: '1000' }]);
    await paid('eng2', A.dept, [{ code: 'JV_BASIC', amount: '10000' }]);
    const run = await createRun(h, preparer, periods['2026-01']!, { departmentIds: [A.dept, A.financeDept] });
    runId = run.id;
    await calculate(h, preparer, runId);
    // CL-097: a run that is not approved has no voucher.
    expect((await jv(reader)).json().error).toBe('RUN_NOT_APPROVED');
    await submitAndApprove(h, { preparer, reviewer, approver }, runId);
    await processRun(h, processor, runId);
    // FR-107: the payslips are issued by a publisher.
    const publisher = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_output.read.amount', 'payroll_output.publish.amount'] });
    for (let i = 0; i < 10; i++) if ((await h.call(publisher, 'POST', `/v1/payroll-outputs/runs/${runId}/payslips/publish`)).statusCode === 200) break;
  }, 600_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe('GL mapping and salary JV (CL-097; FR-038, DF07)', () => {
    it('CL-097: NOT_CONFIGURED until every head of the run is mapped, naming what is missing', async () => {
      expect((await jv(reader)).json()).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'NO_GL_MAPPING', lines: [], totals: null });
      const partial = await mapping(mapper, { lines: [{ componentCode: 'jv_basic', accountCode: '5100' }, { componentCode: 'JV_DED', accountCode: '2100' }] });
      expect(partial.statusCode, partial.body).toBe(201);
      expect((await jv(reader)).json()).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'HEADS_NOT_MAPPED', mappingRevision: 1, missing: [{ componentCode: 'JV_ER', problem: 'NO_ACCOUNT' }] });
      await mapping(mapper, { lines: [{ componentCode: 'JV_BASIC', accountCode: '5100' }, { componentCode: 'JV_DED', accountCode: '2100' }, { componentCode: 'JV_ER', accountCode: '5200' }] });
      expect((await jv(reader)).json()).toMatchObject({ status: 'NOT_CONFIGURED', mappingRevision: 2, missing: [{ componentCode: 'JV_ER', problem: 'NO_PAYABLE_ACCOUNT' }] });
      // The export is refused at request while it is not configured.
      expect((await h.call(reader, 'POST', '/v1/reports', { reportCode: 'SALARY_JV', filters: { runId } })).json().error).toBe('NOT_CONFIGURED');
    });

    it('CL-097 DF07: a balanced voucher: expenses by cost centre (department), deductions and contribution liabilities, net pay', async () => {
      const full = await mapping(mapper, {
        netPayAccountName: 'Salary payable',
        lines: [
          { componentCode: 'JV_BASIC', accountCode: '5100', accountName: 'Salaries' },
          { componentCode: 'JV_DED', accountCode: '2100', accountName: 'Staff recoveries' },
          { componentCode: 'JV_ER', accountCode: '5200', accountName: 'Employer contributions', payableAccountCode: '2200', payableAccountName: 'Contributions payable' },
        ],
      });
      expect(full.json()).toMatchObject({ revision: 3, netPayAccountCode: '2000' });
      // A later revision for later periods does not change January's voucher.
      await mapping(mapper, { effectiveFrom: '2026-02-01', netPayAccountCode: '2999', lines: [{ componentCode: 'JV_BASIC', accountCode: '9999' }] });
      const v = (await jv(reader)).json();
      expect(v).toMatchObject({ status: 'READY', mappingRevision: 3, periodCode: '2026-01', runState: 'PROCESSED_LOCKED', totals: { debit: '62500.0000', credit: '62500.0000', balanced: true } });
      expect(v.lines.map((l: { side: string; accountCode: string; costCentre: string; componentCode: string; amount: string }) => [l.side, l.accountCode, l.costCentre, l.componentCode, l.amount])).toEqual([
        ['DEBIT', '5100', 'ENG', 'JV_BASIC', '40000.0000'],
        ['DEBIT', '5100', 'FIN', 'JV_BASIC', '20000.0000'],
        ['DEBIT', '5200', 'ENG', 'JV_ER', '1500.0000'],
        ['DEBIT', '5200', 'FIN', 'JV_ER', '1000.0000'],
        ['CREDIT', '2100', '', 'JV_DED', '1500.0000'],
        ['CREDIT', '2200', '', 'JV_ER', '2500.0000'],
        ['CREDIT', '2000', '', '', '58500.0000'],
      ]);
      // FR-056: the SALARY_JV report holds the same lines.
      const requested = await h.call(reader, 'POST', '/v1/reports', { reportCode: 'SALARY_JV', filters: { runId } });
      expect(requested.statusCode, requested.body).toBe(202);
      await processReportQueue(h.pool, 10);
      const file = await h.call(reader, 'GET', `/v1/reports/${requested.json().id}/download`);
      const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
      expect(header).toEqual(['Voucher date', 'Period', 'Account code', 'Account name', 'Cost centre', 'Pay head', 'Narration', 'Debit', 'Credit', 'Currency']);
      expect(rows.map((r) => [r[2], r[4], r[7], r[8]])).toEqual([
        ['5100', 'ENG', '40000.0000', ''],
        ['5100', 'FIN', '20000.0000', ''],
        ['5200', 'ENG', '1500.0000', ''],
        ['5200', 'FIN', '1000.0000', ''],
        ['2100', '', '', '1500.0000'],
        ['2200', '', '', '2500.0000'],
        ['2000', '', '', '58500.0000'],
      ]);
    });

    it('CL-097 C4: a requester whose own pay is in the run, linked now or in an earlier period, is refused (SELF_INCLUDED), screen and export', async () => {
      const own = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT, employeeId: e.eng1! });
      const refused = await jv(own);
      expect([refused.statusCode, refused.json().error]).toEqual([403, 'SELF_INCLUDED']);
      const exported = await h.call(own, 'POST', '/v1/reports', { reportCode: 'SALARY_JV', filters: { runId } });
      expect([exported.statusCode, exported.json().error]).toEqual([403, 'SELF_INCLUDED']);
      // A link that ended before the run counts as well.
      const former = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REPORT });
      expect((await jv(former)).json().status).toBe('READY');
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2025-12-01', '2025-12-20')`, [A.id, former.user, e.eng2]);
      expect([(await jv(former)).statusCode, (await jv(former)).json().error]).toEqual([403, 'SELF_INCLUDED']);
      // Someone linked to nobody in the run still gets the voucher.
      expect((await jv(reader)).json().status).toBe('READY');
    });

    it('C1: a scoped DENY of the report grant on another assignment of the user is not company-wide: no voucher, no reconciliation', async () => {
      const user = await h.makeUser();
      const denied = await h.actor(A, 'HR_ADMINISTRATOR', { user, extra: [...REPORT, 'payroll_challan.read.operational'] });
      expect((await jv(denied)).json().status).toBe('READY');
      expect((await h.call(denied, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26')).statusCode).toBe(200);
      // Another assignment of the same user, in a company role that DENYs payroll_report.read.amount over the finance department.
      const role = (await h.one<{ id: string }>(`insert into role (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, uniq('DENY_REPORT_').toUpperCase()])).id;
      const permission = (await h.one<{ id: string }>(`select id from permission where resource = 'payroll_report' and action = 'read' and field_group = 'amount'`)).id;
      await h.db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'DENY')`, [A.id, role, permission]);
      const seat = (
        await h.one<{ id: string }>(
          `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by)
           values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now(), $5) returning id`,
          [A.id, user, role, await h.makeUser(), SYSTEM_ACTOR_ID],
        )
      ).id;
      await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, seat, A.financeDept]);
      const voucher = await jv(denied);
      expect([voucher.statusCode, voucher.json().error]).toEqual([403, 'SCOPE_INCOMPLETE']);
      const reconciliation = await h.call(denied, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26');
      expect([reconciliation.statusCode, reconciliation.json().error]).toEqual([403, 'COMPANY_SCOPE_REQUIRED']);
    });

    it('BR-026 FR-002: company figures need the whole run in scope; the grants; mapping rules and its audit', async () => {
      const engOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REPORT, ...MAPPING], departmentFilter: A.dept });
      expect((await jv(engOnly)).json().error).toBe('SCOPE_INCOMPLETE');
      expect((await mapping(engOnly, { lines: [{ componentCode: 'JV_BASIC', accountCode: '1' }] })).json().error).toBe('COMPANY_SCOPE_REQUIRED');
      expect((await jv(hr)).statusCode).toBe(403);
      expect((await mapping(hr, { lines: [{ componentCode: 'JV_BASIC', accountCode: '1' }] })).statusCode).toBe(403);
      // The Payroll Operator reads the mapping by default; maintaining it is a granted duty.
      const operator = await h.actor(A, 'PAYROLL_OPERATOR');
      // In force today: the revision effective from February.
      expect((await h.call(operator, 'GET', '/v1/payroll-extras/gl-mappings')).json().inForce).toMatchObject({ revision: 4, netPayAccountCode: '2999' });
      expect((await mapping(operator, { lines: [{ componentCode: 'JV_BASIC', accountCode: '1' }] })).statusCode).toBe(403);
      expect((await mapping(mapper, { lines: [{ componentCode: 'NOPE', accountCode: '1' }] })).json().error).toBe('UNKNOWN_COMPONENT');
      expect((await mapping(mapper, { lines: [{ componentCode: 'JV_BASIC', accountCode: 'bad account' }] })).json().error).toBe('INVALID_ACCOUNT');
      expect((await mapping(mapper, { lines: [{ componentCode: 'JV_BASIC', accountCode: '1' }, { componentCode: 'jv_basic', accountCode: '2' }] })).json().error).toBe('DUPLICATE_HEAD');
      await expect(h.db.query(`update payroll_gl_mapping set net_pay_account_code = 'X' where company_id = $1`, [A.id])).rejects.toThrow();
      const audit = await h.db.query(`select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'payroll_gl_mapping' and action = 'CREATE'`, [A.id]);
      expect(audit.rows[0]!.n).toBe(4);
    });
  });

  describe('export for EDOC (CL-100; FR-107, NFR-S09)', () => {
    let exporter: TestActor;
    let jobId: string;

    it('CL-100: a background job renders one PDF per issued payslip of the month; the requester downloads them as one ZIP', async () => {
      exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
      const job = await h.runBulkJob(exporter, '/v1/payroll-extras/edoc-exports', { month: '2026-01', idempotencyKey: uniq('edoc-export-') }, { chunkSize: 2 });
      expect(job.result).toEqual({ month: '2026-01', files: 3 });
      jobId = job.id;
      const res = await h.call(exporter, 'GET', `/v1/payroll-extras/edoc-exports/${jobId}/download`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('payslips-2026-01-edoc.zip');
      const entries = unzip(res.rawPayload);
      expect(entries.map((x) => x.name)).toEqual([code.eng1!, code.eng2!, code.fin1!].sort().map((c) => `payslip-2026-01-${c}-v1.pdf`));
      const issued = await h.db.query<{ employee_id: string; content_hash: string }>(`select employee_id, content_hash from employee_issued_output where company_id = $1 and run_id = $2`, [A.id, runId]);
      for (const x of entries) {
        const text = x.data.toString('latin1');
        expect(text.startsWith('%PDF-1.4')).toBe(true);
        const employee = Object.keys(code).find((k) => x.name.includes(code[k]!))!;
        // Each PDF names the employee and the issued document it stands for.
        expect(text).toContain(code[employee]!);
        const hash = issued.rows.find((r) => r.employee_id === e[employee])!.content_hash;
        expect(text).toContain(`(SHA-256 ${hash.slice(0, 32)}) Tj`);
        expect(text).toContain(`(${hash.slice(32)}) Tj`);
      }
      expect(entries.find((x) => x.name.includes(code.eng1!))!.data.toString('latin1')).toContain('(29000.00) Tj');
      const audit = await h.db.query(`select action from audit_event where company_id = $1 and resource_code = 'payroll_edoc_export' and record_key = $2 order by occurred_at`, [A.id, jobId]);
      expect(audit.rows.map((r) => r.action)).toEqual(['REQUEST', 'EXPORT', 'DOWNLOAD']);
    });

    it('NFR-S09: a repeat request for a month whose export is open (queued, running or still downloadable) answers that export, queueing none', async () => {
      const edocJobs = async (month: string) =>
        (await h.one<{ n: number }>(`select count(*)::int as n from bulk_job where company_id = $1 and kind = 'PAYSLIP_EDOC_EXPORT' and requested_by = $2 and parameters ->> 'month' = $3`, [A.id, exporter.user, month])).n;
      // The completed export of January is still downloadable: a new request (another key) answers it.
      const again = await h.call(exporter, 'POST', '/v1/payroll-extras/edoc-exports', { month: '2026-01', idempotencyKey: uniq('edoc-export-') });
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json()).toMatchObject({ jobId, state: 'COMPLETED', existing: true, downloadPath: `/v1/payroll-extras/edoc-exports/${jobId}/download` });
      expect(await edocJobs('2026-01')).toBe(1);
      // A queued one too, with or without a key.
      const queued = await h.call(exporter, 'POST', '/v1/payroll-extras/edoc-exports', { month: '2025-12' });
      expect(queued.json()).toMatchObject({ state: 'QUEUED', existing: false });
      for (const body of [{ month: '2025-12' }, { month: '2025-12', idempotencyKey: uniq('edoc-export-') }]) {
        const repeat = await h.call(exporter, 'POST', '/v1/payroll-extras/edoc-exports', body);
        expect(repeat.json()).toMatchObject({ jobId: queued.json().jobId, state: 'QUEUED', existing: true });
      }
      expect(await edocJobs('2025-12')).toBe(1);
      // Only one REQUEST audit for each job.
      const requests = await h.db.query(`select record_key from audit_event where company_id = $1 and resource_code = 'payroll_edoc_export' and action = 'REQUEST' and actor_user_id = $2`, [A.id, exporter.user]);
      expect(requests.rows.map((r) => r.record_key).sort()).toEqual([jobId, queued.json().jobId].sort());
      // The archive is built in memory, so a job whose PDFs exceed the cap is refused whole (cap lowered here to one byte).
      const grant = await resolveAccess(h.pool, { userId: exporter.user, companyId: A.id, assignmentId: exporter.assignment, resource: 'payroll_output', action: 'export', fieldGroups: ['amount'] });
      expect(grant.allowed).toBe(true);
      await expect(edocArchive(h.pool, grant as AccessGrant, jobId, 1)).rejects.toMatchObject({ statusCode: 422, code: 'EXPORT_TOO_LARGE' });
      expect(EDOC_MAX_ARCHIVE_BYTES).toBe(100 * 1024 * 1024);
      expect((await h.call(exporter, 'GET', `/v1/payroll-extras/edoc-exports/${jobId}/download`)).statusCode).toBe(200);
    });

    it('BR-026 C4: the row scope, never one’s own payslip, the requester only, and the grant', async () => {
      const engOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, departmentFilter: A.dept });
      const eng = await h.runBulkJob(engOnly, '/v1/payroll-extras/edoc-exports', { month: '2026-01' });
      expect(eng.result.files).toBe(2);
      const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, employeeId: e.eng2! });
      const own = await h.runBulkJob(self, '/v1/payroll-extras/edoc-exports', { month: '2026-01' });
      const names = unzip((await h.call(self, 'GET', `/v1/payroll-extras/edoc-exports/${own.id}/download`)).rawPayload).map((x) => x.name);
      expect(names).toHaveLength(2);
      expect(names.some((n) => n.includes(code.eng2!))).toBe(false);
      // Someone else's export reads as missing; no grant, no export; a month that has not started is refused.
      expect((await h.call(engOnly, 'GET', `/v1/payroll-extras/edoc-exports/${jobId}/download`)).statusCode).toBe(404);
      expect((await h.call(hr, 'POST', '/v1/payroll-extras/edoc-exports', { month: '2026-01' })).statusCode).toBe(403);
      expect((await h.call(exporter, 'POST', '/v1/payroll-extras/edoc-exports', { month: '2099-01' })).json().error).toBe('FUTURE_MONTH');
      expect((await h.call(exporter, 'POST', '/v1/payroll-extras/edoc-exports', { month: '2026-1' })).json().error).toBe('INVALID_MONTH');
      // A month with no issued payslip completes with no file.
      expect((await h.runBulkJob(exporter, '/v1/payroll-extras/edoc-exports', { month: '2026-02' })).result).toEqual({ month: '2026-02', files: 0 });
      // The requester's scope narrows after the export: the whole archive is withheld, with redacted evidence.
      const elsewhere = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'EDOC_ELSEWHERE', 'Elsewhere', true) returning id`, [A.id])).id;
      await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, location_id) values ($1, $2, 'LOCATION', $3)`, [A.id, engOnly.assignment, elsewhere]);
      expect((await h.call(engOnly, 'GET', `/v1/payroll-extras/edoc-exports/${eng.id}/download`)).json().error).toBe('SCOPE_CHANGED');
      const denied = await h.db.query(`select 1 from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and record_key = $2`, [A.id, eng.id]);
      expect(denied.rowCount).toBe(1);
      // A completed export is downloadable for 24 hours.
      // (A completed job is final in the database; its completion time is moved back with the triggers off, as a clock would.)
      await h.db.query(`set session_replication_role = replica`);
      try {
        await h.db.query(`update bulk_job set finished_at = now() - interval '25 hours' where id = $1`, [jobId]);
      } finally {
        await h.db.query(`set session_replication_role = origin`);
      }
      expect((await h.call(exporter, 'GET', `/v1/payroll-extras/edoc-exports/${jobId}/download`)).statusCode).toBe(410);
    });

    it('CL-100: the daily purge deletes the PDFs of exports whose download window closed, and nothing else', async () => {
      const filesOf = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from payroll_edoc_export_file where company_id = $1 and job_id = $2`, [A.id, id])).n;
      // The first export finished 25 hours ago (moved back above); the others are still downloadable.
      expect(await filesOf(jobId)).toBe(3);
      const others = (await h.db.query<{ id: string }>(`select distinct job_id as id from payroll_edoc_export_file where company_id = $1 and job_id <> $2`, [A.id, jobId])).rows.map((r) => r.id);
      expect(others.length).toBeGreaterThan(0);
      const before = new Map<string, number>();
      for (const id of others) before.set(id, await filesOf(id));
      expect(await purgeExpiredEdocFiles(h.pool, A.id)).toEqual({ deleted: 3 });
      expect(await filesOf(jobId)).toBe(0);
      for (const id of others) expect(await filesOf(id)).toBe(before.get(id));
      // The job, its counts and its audit stay; a second run finds nothing.
      expect((await h.db.query(`select 1 from bulk_job where company_id = $1 and id = $2`, [A.id, jobId])).rowCount).toBe(1);
      expect((await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'payroll_edoc_export' and record_key = $2`, [A.id, jobId])).rowCount).toBeGreaterThan(0);
      expect(await purgeExpiredEdocFiles(h.pool, A.id)).toEqual({ deleted: 0 });
      // It runs every night with the module's daily jobs.
      expect(MODULE_DAILY_JOBS.filter((j) => j.code === 'EDOC_PURGE').map((j) => [j.key, j.fromHour])).toEqual([['payroll-extras', 1]]);
    });
  });

  it('CL-081 C4: a reconciler paid in the year is refused (SELF_INCLUDED), never given totals that silently leave out their own TDS', async () => {
    const grants: PermissionKey[] = ['payroll_challan.read.operational', 'payroll_report.read.amount'];
    const paid = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants, employeeId: e.fin1! });
    const refused = await h.call(paid, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26');
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'SELF_INCLUDED']);
    // A year in which they were not paid, and a reconciler who is nobody's employee, are answered.
    expect((await h.call(paid, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2024-25')).statusCode).toBe(200);
    const outsider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants });
    expect((await h.call(outsider, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26')).statusCode).toBe(200);
  });

  it('CL-081 C4: a link that has ended still counts: someone once linked to an employee paid in the year is refused (SELF_INCLUDED)', async () => {
    const grants: PermissionKey[] = ['payroll_challan.read.operational', 'payroll_report.read.amount'];
    const former = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants });
    expect((await h.call(former, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26')).statusCode).toBe(200);
    // Linked to fin1 for part of December 2025 only: not linked today, and the link ended before fin1's January pay.
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2025-12-01', '2025-12-20')`, [A.id, former.user, e.fin1]);
    const refused = await h.call(former, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2025-26');
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'SELF_INCLUDED']);
    expect((await h.call(former, 'GET', '/v1/payroll-extras/tds-reconciliation?fiscalYear=2024-25')).statusCode).toBe(200);
  });

  it('CL-084: a past salary period before go-live may not overlap processed payroll, which the projection already counts', async () => {
    const tax = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_tax_input.read.amount', 'payroll_tax_input.import.amount'] });
    const text = `employeeCode,financialYear,source,fromMonth,toMonth,taxableSalary,tdsDeducted\r\n${code.eng1},2025-26,BEFORE_GO_LIVE,2025-12,2026-01,60000,3000\r\n${code.fin1},2025-26,BEFORE_GO_LIVE,2025-12,2025-12,20000,0\r\n`;
    const job = await ok<{ rows: { errorCode: string | null }[] }>(
      await h.call(tax, 'POST', '/v1/payroll-extras/past-salary-imports', { fileName: 'past.csv', contentBase64: Buffer.from(text).toString('base64'), idempotencyKey: uniq('past-salary-') }),
      201,
    );
    expect(job.rows.map((r) => r.errorCode)).toEqual(['OVERLAPS_PROCESSED_PAYROLL', 'BATCH_REJECTED']);
  });
});
