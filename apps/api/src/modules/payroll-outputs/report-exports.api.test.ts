// Payroll report exports through the report catalogue (FR-038 payroll register, salary disbursement and comparison;
// H7 "Payroll freeze register ... confidential export eligible Admin only" and the held salary report totals; FR-002
// separate export right; FR-065; DB081; DB114; DB118; I-32): each export holds exactly the rows of its JSON report,
// under the requester's row scope and the payroll_report.export.amount grant, generated in the background as CSV or
// XLSX; the hold list totals the reserved and confirmed payments of the matching holds' release allocations over every
// matching hold. Synthetic employees, banks and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import {
  APPROVE,
  bankRevision,
  calculate,
  calendar,
  CONFIG,
  createRun,
  grantOf,
  grants,
  head,
  HOLD_RELEASE,
  key,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  verifiedBank,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { REPORTS, toCsv } from '../report/catalogue.js';
import { processReportQueue } from '../report/service.js';
import { XLSX_MEDIA_TYPE } from '../report/xlsx.js';
import { readZip, sheetCells, sheetRows } from '../report/xlsx.fixtures.js';

const BANK_REVIEW = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank', 'document.read.document', 'document.verify.document'] as const;
const READ: PermissionKey[] = ['payroll_report.read.amount'];
const EXPORT: PermissionKey[] = ['payroll_report.read.amount', 'payroll_report.export.amount'];
const T_AUTHOR: PermissionKey[] = ['payroll_bank_template.manage.operational'];
const T_APPROVER: PermissionKey[] = ['payroll_bank_template.read.operational', 'payroll_bank_template.validate.operational', 'payroll_bank_template.activate.operational'];
const B_PREPARE: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.prepare.amount'];
const B_AUTHORIZE: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.authorize.amount', 'payroll_bank.download.bank'];
const B_OUTCOME: PermissionKey[] = ['payroll_bank.read.amount', 'payroll_bank.record_outcome.amount'];
const CODES = ['PAYROLL_REGISTER', 'PAYROLL_DISBURSEMENT', 'PAYROLL_COMPARISON'] as const;
type Code = (typeof CODES)[number];

/** A synthetic delimited layout (a test transcription, not any bank's specification). */
const DEF = {
  layout: 'DELIMITED',
  delimiter: 'COMMA',
  lineEnding: 'LF',
  amountDecimals: 2,
  decimalSeparator: '.',
  dateFormat: 'YYYYMMDD',
  fileExtension: 'csv',
  header: [{ source: 'LITERAL', value: 'H' }, { source: 'BATCH_REFERENCE' }, { source: 'PAYMENT_DATE' }],
  detail: [{ source: 'LITERAL', value: 'D' }, { source: 'ALLOCATION_KEY' }, { source: 'HOLDER_NAME', maxLength: 40 }, { source: 'ACCOUNT_IDENTIFIER' }, { source: 'ROUTING_REFERENCE' }, { source: 'AMOUNT' }, { source: 'CURRENCY_CODE' }],
  trailer: [{ source: 'LITERAL', value: 'T' }, { source: 'RECORD_COUNT' }, { source: 'TOTAL_AMOUNT' }],
};

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const table = (csv: string) => csv.trimEnd().split('\r\n').map(cells);
const column = (i: number) => String.fromCharCode(65 + i);

interface Line {
  id: string;
  employeeId: string;
  holdId: string | null;
  amount: string;
  paymentState: string;
}
interface HoldList {
  items: { id: string; employeeId: string; state: string }[];
  total: number;
  page?: number;
  pageSize?: number;
  totals?: { currencyCode: string; reserved: string; confirmed: string }[];
}

describe.runIf(isModuleActive('payroll-outputs'))('payroll report exports and held salary totals (FR-038, H7)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let bankReviewer: TestActor;
  let exporter: TestActor;
  let reader: TestActor;
  let narrow: TestActor;
  let d1: string;
  let d2: string;
  let a1: string;
  let a2: string;
  let b1: string;
  let feb: string;
  const people: Record<string, TestActor> = {};

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string, amount: string, bank: 'VERIFIED' | 'UNVERIFIED' = 'VERIFIED') => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2025-12-01' });
    await salary(h, preparer, e, { effectiveFrom: '2025-12-01', monthlyGross: amount, components: [{ code: 'PX_BASIC', amount }] });
    people[e] = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    if (bank === 'VERIFIED') await verifiedBank(h, A, bankReviewer, e, people[e]);
    else await bankRevision(h, A, e);
    return e;
  };
  const processed = async (month: string, periods: Record<string, string>) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [d1, d2] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    return run.id;
  };

  const request = (a: TestActor, reportCode: string, filters: object, format?: string) => h.call(a, 'POST', '/v1/reports', { reportCode, filters, ...(format ? { format } : {}) });
  const status = async (a: TestActor, id: string) => ok<{ state: string; failureCode: string | null; rowCount: number | null; format: string }>(await h.call(a, 'GET', `/v1/reports/${id}`));
  /** Requests, generates and downloads a report. */
  async function generated(a: TestActor, reportCode: string, filters: object, format?: string) {
    const res = await request(a, reportCode, filters, format);
    expect(res.statusCode, res.body).toBe(202);
    await processReportQueue(h.pool);
    const s = await status(a, res.json().id);
    expect(s).toMatchObject({ state: 'COMPLETED', format: format ?? 'CSV' });
    const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
    expect(file.statusCode).toBe(200);
    return { id: res.json().id as string, file, rowCount: s.rowCount };
  }
  const json = async (a: TestActor, path: string) => ok<Record<string, unknown> & { items?: Record<string, unknown>[] }>(await h.call(a, 'GET', path));
  /** The JSON rows each export holds: the register's records, the reconciliation's totals, the comparison's components. */
  async function jsonRows(a: TestActor, code: Code, runId: string): Promise<Record<string, unknown>[]> {
    const base = `/v1/payroll-outputs/runs/${runId}`;
    if (code === 'PAYROLL_REGISTER') {
      const reg = await json(a, `${base}/register`);
      // One page holds the whole register here, so its items are every record.
      expect(reg.next).toBeNull();
      return reg.items!;
    }
    if (code === 'PAYROLL_DISBURSEMENT') return [(await json(a, `${base}/disbursement`)).totals as Record<string, unknown>];
    return (await json(a, `${base}/comparison`)).items!;
  }

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    bankReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...BANK_REVIEW] });
    exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
    reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: READ });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'sensitive_change', [bankReviewer]);
    await head(h, configA, configB, { code: 'PX_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    const periods = (await calendar(h, configA, configB, months(2026))).periods;
    d1 = await department('PX_ONE');
    d2 = await department('PX_TWO');
    narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, departmentFilter: d1 });
    a1 = await paid(d1, '40000');
    a2 = await paid(d1, '15000.25');
    // An unverified bank instruction: processing places an automatic payment safety block on the whole net.
    b1 = await paid(d2, '20000', 'UNVERIFIED');
    // January is the prior period of February's comparison (same calendar and scope).
    await processed('2026-01', periods);
    feb = await processed('2026-02', periods);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('lists the three run reports with CSV and XLSX and needs the separate payroll report export grant (FR-002, H7)', async () => {
    const items = (await json(hr, '/v1/reports/catalogue')).items as { code: string; title: string; requiresPeriod: boolean; columns: string[]; formats?: string[] }[];
    for (const code of CODES) {
      expect(items.find((r) => r.code === code), code).toEqual({ code, title: REPORTS[code]!.title, requiresPeriod: false, columns: REPORTS[code]!.columns.map((c) => c.header), formats: ['CSV', 'XLSX'] });
    }
    // The JSON columns exactly, nothing added (owner-approved samples pending, I-40 item 12).
    expect(items.find((r) => r.code === 'PAYROLL_DISBURSEMENT')!.columns).toEqual(['Approved payable', 'Held', 'Reserved', 'Paid', 'Ready', 'Reconciles']);
    // No grant, the read grant alone (viewing is not exporting) and the Employee context are refused at request.
    for (const code of CODES) {
      for (const a of [hr, reader, people[a1]!]) expect((await request(a, code, { runId: feb })).statusCode, code).toBe(403);
    }
    const ids: string[] = [];
    for (const code of CODES) {
      const res = await request(exporter, code, { runId: feb });
      expect(res.statusCode, res.body).toBe(202);
      ids.push(res.json().id);
    }
    await processReportQueue(h.pool);
    for (const id of ids) expect(await status(exporter, id)).toMatchObject({ state: 'COMPLETED' });
    // Each request is audited with its run; each output is confidential.
    const audit = await h.db.query<{ after: { operational: { reportCode: string; filters: { runId: string }; format: string } } }>(
      `select after_values as after from audit_event where company_id = $1 and resource_code = 'report_execution' and action = 'REQUEST' and actor_user_id = $2`,
      [A.id, exporter.user],
    );
    expect(audit.rows.map((r) => r.after.operational).sort((x, y) => x.reportCode.localeCompare(y.reportCode))).toEqual(
      [...CODES].sort().map((reportCode) => ({ reportCode, filters: { runId: feb }, format: 'CSV' })),
    );
    const outputs = await h.db.query<{ classification: string }>(
      `select a.classification from report_execution x join attachment a on a.company_id = x.company_id and a.id = x.output_attachment_id where x.id = any($1::uuid[])`,
      [ids],
    );
    expect(outputs.rows.map((r) => r.classification)).toEqual(['CONFIDENTIAL', 'CONFIDENTIAL', 'CONFIDENTIAL']);
  });

  it('holds exactly the rows of the JSON register, reconciliation and comparison, as CSV and as XLSX', async () => {
    const g = await grantOf(h, exporter, 'payroll_report', 'export', ['amount']);
    const disbursement = await jsonRows(exporter, 'PAYROLL_DISBURSEMENT', feb);
    expect(disbursement).toEqual([{ payable: '75000.2500', held: '20000.0000', reserved: '0.0000', paid: '0.0000', ready: '55000.2500', reconciles: true }]);
    const comparison = await json(exporter, `/v1/payroll-outputs/runs/${feb}/comparison`);
    expect(comparison).toMatchObject({ basis: 'RUN', priorPeriodCode: '2026-01' });
    expect(comparison.items).toEqual([expect.objectContaining({ componentCode: 'PX_BASIC', headType: 'EARNING' })]);
    for (const code of CODES) {
      const def = REPORTS[code]!;
      const rows = await jsonRows(exporter, code, feb);
      expect(rows.length, code).toBeGreaterThan(0);
      // The catalogue's rows are the JSON report's, value for value and in the same order.
      expect(await def.rows(h.db, g, { runId: feb }), code).toEqual(rows);
      const csv = await generated(exporter, code, { runId: feb });
      expect(csv.rowCount).toBe(rows.length);
      expect(csv.file.body, code).toBe(toCsv(def, rows));
      const x = await generated(exporter, code, { runId: feb }, 'XLSX');
      expect(x.file.headers['content-type']).toBe(XLSX_MEDIA_TYPE);
      expect(x.file.headers['content-disposition']).toMatch(new RegExp(`filename="${code.toLowerCase()}-[0-9a-f]{8}\\.xlsx"$`));
      const xml = readZip(x.file.rawPayload).get('xl/worksheets/sheet1.xml')!.toString('utf8');
      expect(sheetRows(xml, def.columns.length), code).toEqual(table(csv.file.body));
      // Amounts and units are number cells; identifiers, codes, states and flags stay text.
      const first = sheetCells(xml)[1]!;
      def.columns.forEach((c, i) => {
        if (rows[0]![c.key] === null) return;
        expect(first.find((cell) => cell.ref === `${column(i)}2`)?.kind, `${code} ${c.key}`).toBe(c.numeric ? 'number' : 'text');
      });
    }
    // The register lists every record of the run, the blocked net as held.
    const register = await jsonRows(exporter, 'PAYROLL_REGISTER', feb);
    expect(register.map((r) => r.employeeId).sort()).toEqual([a1, a2, b1].sort());
    expect(register.find((r) => r.employeeId === b1)).toMatchObject({ net: '20000.0000', held: '20000.0000', reserved: '0.0000', paid: '0.0000' });
  });

  it("applies the requester's row scope; the reconciliation needs the whole run, also when access changes before generation", async () => {
    // A department-filtered exporter: the register and the comparison over its own records, as the JSON lists them.
    const own = await jsonRows(narrow, 'PAYROLL_REGISTER', feb);
    expect(own.map((r) => r.employeeId).sort()).toEqual([a1, a2].sort());
    expect((await generated(narrow, 'PAYROLL_REGISTER', { runId: feb })).file.body).toBe(toCsv(REPORTS.PAYROLL_REGISTER!, own));
    expect((await json(narrow, `/v1/payroll-outputs/runs/${feb}/comparison`)).basis).toBe('SCOPE');
    const ownComparison = await jsonRows(narrow, 'PAYROLL_COMPARISON', feb);
    expect((await generated(narrow, 'PAYROLL_COMPARISON', { runId: feb })).file.body).toBe(toCsv(REPORTS.PAYROLL_COMPARISON!, ownComparison));
    // Company figures: refused at request exactly as the JSON route refuses them.
    const route = await h.call(narrow, 'GET', `/v1/payroll-outputs/runs/${feb}/disbursement`);
    expect([route.statusCode, route.json().error]).toEqual([403, 'SCOPE_INCOMPLETE']);
    const refused = await request(narrow, 'PAYROLL_DISBURSEMENT', { runId: feb });
    expect([refused.statusCode, refused.json().error]).toEqual([403, 'SCOPE_INCOMPLETE']);
    // Another company's run reads as missing.
    const B = await h.makeCompany();
    const foreign = await h.actor(B, 'HR_ADMINISTRATOR', { extra: EXPORT });
    for (const code of CODES) expect((await request(foreign, code, { runId: feb })).statusCode, code).toBe(404);

    // Access narrowed or revoked after the request: nothing is generated, the reason is kept and the queue goes on.
    const narrowed = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
    const revoked = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
    const first = (await request(narrowed, 'PAYROLL_DISBURSEMENT', { runId: feb })).json().id as string;
    const second = (await request(revoked, 'PAYROLL_REGISTER', { runId: feb })).json().id as string;
    const third = (await request(exporter, 'PAYROLL_DISBURSEMENT', { runId: feb })).json().id as string;
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, narrowed.assignment, d1]);
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'payroll_report' and action = 'export' and field_group = 'amount')`,
      [revoked.assignment],
    );
    await processReportQueue(h.pool);
    expect(await status(narrowed, first)).toMatchObject({ state: 'FAILED', failureCode: 'SCOPE_INCOMPLETE', rowCount: null });
    expect(await status(revoked, second)).toMatchObject({ state: 'FAILED', failureCode: 'ACCESS_REVOKED' });
    expect(await status(exporter, third)).toMatchObject({ state: 'COMPLETED', rowCount: 1 });
    expect((await h.call(narrowed, 'GET', `/v1/reports/${first}/download`)).statusCode).toBe(409);
  });

  it("leaves the caller's own record out of the register, as JSON and as an export, and out of its totals (H1, FR-107)", async () => {
    const reg = (a: TestActor) => json(a, `/v1/payroll-outputs/runs/${feb}/register`);
    const all = await reg(exporter);
    expect(all).toMatchObject({ scope: 'COMPANY', ownRecordExcluded: false, totals: { records: 3 } });
    expect(all.items!.map((r) => r.employeeId)).toContain(a1);
    // The same person as employee a1, in an unrestricted Admin assignment holding the report grants.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, user: people[a1]!.user });
    const mine = await reg(self);
    expect(mine).toMatchObject({ scope: 'COMPANY', ownRecordExcluded: true, totals: { records: 2, net: '35000.2500' } });
    expect(mine.items!.map((r) => r.employeeId).sort()).toEqual([a2, b1].sort());
    const file = await generated(self, 'PAYROLL_REGISTER', { runId: feb });
    expect(file.rowCount).toBe(2);
    expect(file.file.body).toBe(toCsv(REPORTS.PAYROLL_REGISTER!, mine.items!));
    expect(file.file.body).not.toContain(a1);
    // Row scope the same way: a department reader linked to one of its employees.
    const selfNarrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, departmentFilter: d1, user: people[a2]!.user });
    expect((await reg(selfNarrow)).items!.map((r) => r.employeeId)).toEqual([a1]);
  });

  it('covers exactly one payroll run and refuses every other filter, format or run', async () => {
    const queued = async () => (await h.one<{ n: number }>(`select count(*)::int as n from report_execution where company_id = $1`, [A.id])).n;
    const before = await queued();
    const cases: [string, object, number, string][] = [
      ['PAYROLL_REGISTER', {}, 422, 'RUN_REQUIRED'],
      ['PAYROLL_DISBURSEMENT', { runId: feb, from: '2026-02-01', to: '2026-02-28' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['PAYROLL_COMPARISON', { runId: feb, status: 'CALCULATED' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['PAYROLL_REGISTER', { runId: feb, employeeId: a1 }, 422, 'FILTER_NOT_SUPPORTED'],
      ['PAYROLL_REGISTER', { runId: feb, search: 'x' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['PAYROLL_COMPARISON', { runId: feb, basis: 'MONTHLY_GROSS' }, 422, 'FILTER_NOT_SUPPORTED'],
      ['PAYROLL_COMPARISON', { runId: '00000000-0000-4000-8000-000000000009' }, 404, 'NOT_FOUND'],
      ['PAYROLL_REGISTER', { runId: 'not-a-uuid' }, 400, 'INVALID_REQUEST'],
      // Only the run reports take a run.
      ['LEAVE_REGISTER', { from: '2026-02-01', to: '2026-02-28', runId: feb }, 422, 'FILTER_NOT_SUPPORTED'],
    ];
    for (const [code, filters, statusCode, error] of cases) {
      const res = await request(exporter, code, filters);
      expect(res.statusCode, `${code} ${JSON.stringify(filters)}`).toBe(statusCode);
      expect(res.json().error, `${code} ${JSON.stringify(filters)}`).toBe(error);
    }
    expect((await request(exporter, 'PAYROLL_REGISTER', { runId: feb }, 'PDF')).statusCode).toBe(400);
    expect(await queued()).toBe(before);
  });

  it('totals the reserved and confirmed payments of released holds over every matching hold; the exports follow the ledger (H7, DB118)', async () => {
    const releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HOLD_RELEASE });
    const holdReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_hold.read.hold'] });
    const author = await h.actor(A, 'TREASURY_OPERATOR', { extra: T_AUTHOR });
    // Template configuration is company-wide and C2 keeps Treasury Approver in ASSIGNED scope, so an HR Administrator
    // assignment (whose ceiling holds these duties) validates and activates.
    const tApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: T_APPROVER });
    const bankPrep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_PREPARE });
    const bankAuth = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_AUTHORIZE });
    const outcomes = await h.actor(A, 'HR_ADMINISTRATOR', { extra: B_OUTCOME });
    const holds = async (a: TestActor, query: string) => ok<HoldList>(await h.call(a, 'GET', `/v1/payroll/holds?${query}`));
    const totals = async (query: string) => (await holds(holdReader, query)).totals;
    const inr = (reserved: string, confirmed: string) => [{ currencyCode: 'INR', reserved, confirmed }];
    const outcome = (batchId: string, lineId: string, kind: string) =>
      h.call(outcomes, 'POST', `/v1/payroll-outputs/bank-manifests/${batchId}/outcomes`, { outcomes: [{ lineId, outcome: kind, eventKey: key('ev-'), evidenceReference: 'SYNTH-BANK-STATEMENT-PX' }] });

    // February's only hold is the safety block on the unverified instruction: nothing reserved or confirmed yet.
    const febHolds = await holds(holdReader, `runId=${feb}`);
    expect(febHolds.items.map((x) => [x.employeeId, x.state])).toEqual([[b1, 'APPROVED_ACTIVE']]);
    expect(febHolds.totals).toEqual(inr('0.0000', '0.0000'));
    const block = febHolds.items[0]!;
    const version = (await ok<{ version: number }>(await h.call(releaser, 'GET', `/v1/payroll/holds/${block.id}`))).version;
    await ok(await h.call(releaser, 'POST', `/v1/payroll/holds/${block.id}/release`, { reason: 'Synthetic instruction verified', evidenceReference: 'SYNTH-CALLBACK-PX', expectedVersion: version }));

    // A manifest: the released amount is the hold's own allocation (REL), the other records ordinary pay (PAY).
    const t = await ok<{ id: string; version: number }>(
      await h.call(author, 'POST', '/v1/payroll-outputs/bank-templates', {
        templateCode: 'PX_CSV',
        name: 'Synthetic test layout',
        currencyCode: 'INR',
        bankSpecificationReference: 'SYNTH-SPEC-REF-PX',
        testOnly: true,
        formatDefinition: DEF,
      }),
      201,
    );
    const sample = await ok<{ sampleHash: string }>(await h.call(tApprover, 'GET', `/v1/payroll-outputs/bank-templates/${t.id}/sample`));
    const validated = await ok<{ version: number }>(
      await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/sample-validation`, { sampleHash: sample.sampleHash, validationReference: 'SYNTH-BANK-ACCEPTANCE', expectedVersion: t.version }),
    );
    await ok(await h.call(tApprover, 'POST', `/v1/payroll-outputs/bank-templates/${t.id}/activate`, { expectedVersion: validated.version }));
    const batch = await ok<{ id: string }>(await h.call(bankPrep, 'POST', `/v1/payroll-outputs/runs/${feb}/bank-manifests`, { templateId: t.id }), 201);
    const lines = (await ok<{ items: Line[] }>(await h.call(bankPrep, 'GET', `/v1/payroll-outputs/bank-manifests/${batch.id}/lines`))).items;
    expect(lines.map((l) => [l.employeeId, l.holdId, l.amount]).sort()).toEqual(
      [
        [a1, null, '40000.0000'],
        [a2, null, '15000.2500'],
        [b1, block.id, '20000.0000'],
      ].sort(),
    );
    const rel = lines.find((l) => l.holdId === block.id)!;
    // A prepared line reserves nothing.
    expect(await totals(`runId=${feb}`)).toEqual(inr('0.0000', '0.0000'));
    // Authorised: every line is reserved, and the hold totals count only the hold's own allocation, not the PAY lines.
    const current = await ok<{ version: number }>(await h.call(bankAuth, 'GET', `/v1/payroll-outputs/bank-manifests/${batch.id}`));
    await ok(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${batch.id}/authorize`, { expectedVersion: current.version }));
    expect(await totals(`runId=${feb}`)).toEqual(inr('20000.0000', '0.0000'));
    await ok(await h.call(bankAuth, 'POST', `/v1/payroll-outputs/bank-manifests/${batch.id}/issue`));
    // UNKNOWN keeps the reservation; CONFIRMED is paid; an authorised reversal reduces the confirmed net (DB118).
    await ok(await outcome(batch.id, rel.id, 'UNKNOWN'));
    expect(await totals(`runId=${feb}`)).toEqual(inr('20000.0000', '0.0000'));
    await ok(await outcome(batch.id, rel.id, 'CONFIRMED'));
    expect(await totals(`runId=${feb}`)).toEqual(inr('0.0000', '20000.0000'));
    await ok(
      await h.call(outcomes, 'POST', `/v1/payroll-outputs/bank-lines/${rel.id}/reversal`, { amount: '100.00', eventKey: key('rv-'), evidenceReference: 'SYNTH-RETURN-PX', reason: 'Synthetic return by the bank' }),
    );
    const settled = inr('0.0000', '19900.0000');
    expect(await totals(`runId=${feb}`)).toEqual(settled);

    // Every matching hold, not the page: past the last page the totals are the same.
    expect(await holds(holdReader, `runId=${feb}&page=2&pageSize=25`)).toEqual({ items: [], total: 1, page: 2, pageSize: 25, totals: settled });
    // The filters apply: January's block (still active) has nothing reserved or paid; the released one has.
    expect(await totals('state=APPROVED_ACTIVE')).toEqual(inr('0.0000', '0.0000'));
    expect(await totals('state=RELEASED')).toEqual(settled);
    expect(await totals(`state=RELEASED&employeeId=${a1}`)).toEqual([]);
    // And the row scope: a reader of the other department totals nothing.
    const otherDepartment = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_hold.read.hold'], departmentFilter: d1 });
    expect(await holds(otherDepartment, `runId=${feb}`)).toEqual({ items: [], total: 0, totals: [] });

    // The exports hold exactly the JSON rows with these ledger positions.
    for (const code of ['PAYROLL_REGISTER', 'PAYROLL_DISBURSEMENT'] as const) {
      const rows = await jsonRows(exporter, code, feb);
      expect((await generated(exporter, code, { runId: feb })).file.body, code).toBe(toCsv(REPORTS[code]!, rows));
    }
    expect((await jsonRows(exporter, 'PAYROLL_REGISTER', feb)).find((r) => r.employeeId === b1)).toMatchObject({ held: '0.0000', reserved: '0.0000', paid: '19900.0000' });
    expect(await jsonRows(exporter, 'PAYROLL_DISBURSEMENT', feb)).toEqual([
      { payable: '75000.2500', held: '0.0000', reserved: '55000.2500', paid: '19900.0000', ready: '100.0000', reconciles: true },
    ]);
  });
});
