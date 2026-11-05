// FR-029 employee salary master (E08; CL-075, CL-204-CL-210; DF02; DF09; FR-056; FR-064; FR-065; I-13; I-21): the
// salary master upload (SALARY_MASTER_V1, the rules of POST /employees/:id/salary, all-or-nothing, the shared import
// follow-up routes), the salary master list with E08's filters, and the salary and annual salary exports generated in
// the background under the confidential salary export grant and the requester's row scope. Synthetic INR amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor; // employee records only
let hr1: TestActor; // salary, increment and export grants
let hr2: TestActor; // the independent increment approver
let reader: TestActor; // salary read only
let financeHr: TestActor; // salary grants limited to the finance department
let auditor: TestActor;
const emp: Record<string, { id: string; code: string }> = {};

const SALARY: PermissionKey[] = ['salary.read.salary', 'salary.history_read.salary', 'salary.manage.salary', 'salary.export.salary'];
const INCREMENTS: PermissionKey[] = ['increment.read.salary', 'increment.propose.salary', 'increment.approve.salary'];
const HEADER = 'employeeCode,effectiveFrom,annualCtc,monthlyGross,currency';
const IMPORTS = '/v1/salary-master/imports';

type Job = { id: string; state: string; template: string; acceptedCount: number; rejectedCount: number; rows: { rowNumber: number; businessKey: string; state: string; errorCode: string | null; proposedChanges: unknown }[] };
type Listed = { employeeId: string; employeeCode: string; displayName: string; status: string; grade: string | null; effectiveFrom: string; effectiveTo: string | null; currency: string; annualCtc: string; monthlyGross: string };
type Page = { period: Record<string, string>; items: Listed[]; total: number; page: number; pageSize: number };

const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n');
const upload = (a: TestActor, text: string, key = uniq('salary-master-')) =>
  h.call(a, 'POST', IMPORTS, { fileName: 'salary.csv', contentBase64: Buffer.from(text).toString('base64'), idempotencyKey: key });
const salaryOf = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/salary`)).json().items as { effectiveFrom: string; annualCtc: string; monthlyGross: string; currency: string }[];
const arrangements = async (employeeId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from salary_arrangement where employee_id = $1`, [employeeId])).n;
const list = (a: TestActor, query = '') => h.call(a, 'GET', `/v1/salary-master${query}`);

async function employee(opts: { company?: Company; by?: TestActor; departmentId?: string; gradeId?: string; displayName?: string } = {}) {
  const company = opts.company ?? A;
  const body = h.newEmployeeBody(company, { ...(opts.departmentId ? { departmentId: opts.departmentId } : {}), ...(opts.gradeId ? { gradeId: opts.gradeId } : {}), ...(opts.displayName ? { displayName: opts.displayName } : {}) });
  const res = await h.call(opts.by ?? hr, 'POST', '/v1/employees', body);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id as string, code: res.json().employeeCode as string };
}

async function recordSalary(a: TestActor, employeeId: string, monthlyGross: string, annualCtc: string, effectiveFrom = '2026-01-05') {
  const res = await h.call(a, 'POST', `/v1/employees/${employeeId}/salary`, { effectiveFrom, monthlyGross, annualCtc, currency: 'INR' });
  expect(res.statusCode, res.body).toBe(201);
}

/** An off-cycle revision proposed by hr1 and approved by hr2 (DF15 independence): a new arrangement from that date. */
async function revise(employeeId: string, effectiveDate: string, monthlyGross: string, annualCtc: string) {
  const res = await h.call(hr1, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: monthlyGross, proposedCounterpart: annualCtc, reason: 'Synthetic revision' });
  expect(res.statusCode, res.body).toBe(201);
  const task = ((await h.call(hr2, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)!;
  const decided = await h.call(hr2, 'POST', `/v1/increment-cases/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic approval', idempotencyKey: uniq('salary-rev-') });
  expect(decided.statusCode, decided.body).toBe(200);
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...SALARY, ...INCREMENTS] });
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...SALARY, ...INCREMENTS] });
  reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary'] });
  financeHr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY, departmentFilter: A.financeDept });
  auditor = await h.actor(A, 'AUDITOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, hr1.user, hr2.user]);
});

afterAll(async () => {
  await h?.stop();
});

describe('salary master upload (FR-029, DF09, I-13)', () => {
  it('previews without recording anything, then commits every row through the initial salary route', async () => {
    const one = await employee();
    const two = await employee();
    const res = await upload(hr1, csv(`${one.code.toLowerCase()},2026-02-01,1200000,100000,INR`, `${two.code},2026-03-01,600000.50,50000.0425,INR`));
    expect(res.statusCode, res.body).toBe(201);
    const job = res.json() as Job;
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'SALARY_MASTER_V1' });
    expect(job.rows.map((r) => [r.businessKey, r.state])).toEqual([
      [one.code, 'VALID'],
      [two.code, 'VALID'],
    ]);
    // The rows keep the employee code only, never an amount.
    expect(job.rows.every((r) => r.proposedChanges === null)).toBe(true);
    expect(JSON.stringify(job)).not.toContain('1200000');
    expect(await arrangements(one.id)).toBe(0);

    const done = (await h.call(hr1, 'POST', `${IMPORTS}/${job.id}/commit`)).json() as Job;
    expect(done).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    expect(await salaryOf(hr1, one.id)).toEqual([expect.objectContaining({ effectiveFrom: '2026-02-01', annualCtc: '1200000.0000', monthlyGross: '100000.0000', currency: 'INR' })]);
    expect(await salaryOf(hr1, two.id)).toEqual([expect.objectContaining({ annualCtc: '600000.5000', monthlyGross: '50000.0425' })]);
    // Each row is audited as the single-employee route audits it.
    const audits = await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'salary_arrangement' and action = 'CREATE' and actor_user_id = $2 and record_key::text in (select id::text from salary_arrangement where employee_id = any($3))`, [
      A.id,
      hr1.user,
      [one.id, two.id],
    ]);
    expect(audits.rowCount).toBe(2);
    // Committing again changes nothing.
    expect((await h.call(hr1, 'POST', `${IMPORTS}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    expect(await arrangements(one.id)).toBe(1);
  });

  it('applies exactly the rules of POST /employees/:id/salary: one row with a problem rejects the whole batch', async () => {
    const fresh = await employee();
    const salaried = await employee();
    await recordSalary(hr1, salaried.id, '40000', '480000');
    const fourCells = await employee();
    const valid = await employee();
    const job = (
      await upload(
        hr1,
        csv(
          `${fresh.code},2026-02-30,1200000,100000,INR`,
          `NOBODY,2026-02-01,1200000,100000,INR`,
          `${salaried.code},2026-02-01,1200000,100000,INR`,
          `${fourCells.code},2026-02-01,1200000,100000`,
          // The same employee again (one initial arrangement per employee).
          `${fresh.code},2026-02-01,1200000,100000,INR`,
          `${valid.code},2026-02-01,1200000,100000,INR`,
        ),
      )
    ).json() as Job;
    expect(job.state).toBe('REJECTED');
    expect(job.rows.map((r) => r.errorCode)).toEqual(['INVALID_DATE', 'UNKNOWN_EMPLOYEE', 'SALARY_EXISTS', 'COLUMN_COUNT', 'DUPLICATE_IN_BATCH', 'BATCH_REJECTED']);
    expect(job.rows.every((r) => r.state === 'REJECTED')).toBe(true);
    expect(job.rejectedCount).toBe(6);
    expect((await h.call(hr1, 'POST', `${IMPORTS}/${job.id}/commit`)).statusCode).toBe(409);
    expect(await arrangements(valid.id)).toBe(0);
    // The single-employee route refuses a second arrangement in the same words.
    const again = await h.call(hr1, 'POST', `/v1/employees/${salaried.id}/salary`, { effectiveFrom: '2026-02-01', annualCtc: '1200000', monthlyGross: '100000', currency: 'INR' });
    expect([again.statusCode, again.json().error]).toEqual([409, 'SALARY_EXISTS']);

    // Each cell rule, one employee per row, against the single-employee route answering the same values.
    const cases: [string, Record<string, string>, string][] = [
      ['2026-02-30,1200000,100000,INR', { effectiveFrom: '2026-02-30' }, 'INVALID_DATE'],
      ['2026-02-01,"12,00,000",100000,INR', { annualCtc: '12,00,000' }, 'INVALID_ANNUAL_CTC'],
      ['2026-02-01,1200000,-5,INR', { monthlyGross: '-5' }, 'INVALID_MONTHLY_GROSS'],
      ['2026-02-01,1200000,100000.12345,INR', { monthlyGross: '100000.12345' }, 'INVALID_MONTHLY_GROSS'],
      ['2026-02-01,1200000,100000,inr', { currency: 'inr' }, 'INVALID_CURRENCY'],
    ];
    const people = await Promise.all(cases.map(() => employee()));
    const checked = (await upload(hr1, csv(...cases.map(([cells], i) => `${people[i]!.code},${cells}`), `${valid.code},2026-02-01,1200000.1234,100000,INR`))).json() as Job;
    expect(checked.rows.map((r) => r.errorCode)).toEqual([...cases.map(([, , code]) => code), 'BATCH_REJECTED']);
    for (const [i, [, change]] of cases.entries()) {
      const single = await h.call(hr1, 'POST', `/v1/employees/${people[i]!.id}/salary`, { effectiveFrom: '2026-02-01', annualCtc: '1200000', monthlyGross: '100000', currency: 'INR', ...change });
      expect(single.statusCode, JSON.stringify(change)).toBe(400);
      expect(await arrangements(people[i]!.id)).toBe(0);
    }
  });

  it('a row that becomes invalid before the commit rejects the batch and records nothing', async () => {
    const one = await employee();
    const two = await employee();
    const job = (await upload(hr1, csv(`${one.code},2026-02-01,1200000,100000,INR`, `${two.code},2026-02-01,600000,50000,INR`))).json() as Job;
    expect(job.state).toBe('PREVIEWED');
    // Someone records the second employee's salary meanwhile.
    await recordSalary(hr2, two.id, '45000', '540000');
    const done = (await h.call(hr1, 'POST', `${IMPORTS}/${job.id}/commit`)).json() as Job;
    expect(done.state).toBe('REJECTED');
    expect(done.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'SALARY_EXISTS']);
    expect(await arrangements(one.id)).toBe(0);
    expect(await salaryOf(hr1, two.id)).toEqual([expect.objectContaining({ monthlyGross: '45000.0000' })]);
  });

  it('needs salary.manage with the salary group; the row scope applies per row; a batch belongs to its submitter', async () => {
    const eng = await employee();
    const fin = await employee({ departmentId: A.financeDept });
    const file = csv(`${fin.code},2026-02-01,1080000,90000,INR`, `${eng.code},2026-02-01,1200000,100000,INR`);
    for (const a of [hr, reader, auditor]) {
      expect((await upload(a, file)).statusCode).toBe(403);
      expect((await h.call(a, 'GET', `${IMPORTS}/template`)).statusCode).toBe(403);
    }
    const scoped = (await upload(financeHr, file)).json() as Job;
    expect(scoped.rows.map((r) => r.errorCode)).toEqual(['BATCH_REJECTED', 'OUT_OF_SCOPE']);

    const key = uniq('salary-master-');
    const job = (await upload(hr1, csv(`${fin.code},2026-02-01,1080000,90000,INR`), key)).json() as Job;
    expect(job.state).toBe('PREVIEWED');
    for (const path of ['', '/commit', '/cancel']) {
      const res = await h.call(hr2, path ? 'POST' : 'GET', `${IMPORTS}/${job.id}${path}`);
      expect(res.statusCode, path).toBe(404);
    }
    expect((await upload(hr2, csv(`${fin.code},2026-02-01,1080000,90000,INR`), key)).json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect((await upload(hr1, csv(`${fin.code},2026-02-01,1080000,90000,INR`), key)).json().id).toBe(job.id);
    expect((await h.call(hr1, 'POST', `${IMPORTS}/${job.id}/cancel`)).json().state).toBe('CANCELLED');
    expect(await arrangements(fin.id)).toBe(0);
    expect((await upload(hr1, 'employeeCode,effectiveFrom,annualCtc,monthlyGross\r\nX,2026-02-01,1,1')).json().error).toBe('INVALID_HEADER');
  });
});

followUpSuite({
  path: IMPORTS,
  template: 'SALARY_MASTER_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR', { extra: SALARY }),
  denied: async () => [await h.actor(A, 'HR_ADMINISTRATOR'), await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary'] }), await h.actor(A, 'AUDITOR')],
  // A new employee without a salary each time (nothing is committed).
  validFile: async () => {
    const e = await employee();
    return { text: csv(`${e.code},2026-02-01,1200000,100000,INR`), rows: 1 };
  },
});

describe('salary master list and exports (FR-029, E08, FR-056, FR-065)', () => {
  const people: Record<string, { id: string; code: string }> = {};
  const day = (d: string) => `?date=${d}`;
  const codes = (page: Page) => page.items.map((r) => r.employeeCode);

  beforeAll(async () => {
    const grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, 'G1', 'Grade One', true) returning id`, [A.id])).id;
    people.revised = await employee();
    people.graded = await employee({ gradeId: grade, displayName: 'Synthetic Salaried Two' });
    people.finance = await employee({ departmentId: A.financeDept });
    people.none = await employee();
    people.left = await employee();
    await recordSalary(hr1, people.revised.id, '100000', '1200000');
    await recordSalary(hr1, people.graded.id, '50000', '600000');
    await recordSalary(hr1, people.finance.id, '90000', '1080000');
    await recordSalary(hr1, people.left.id, '30000', '360000');
    await h.setStatus(A, people.left.id, 'INACTIVE_SEPARATED');
    // A revision in force from 15 July 2026.
    await revise(people.revised.id, '2026-07-15', '110000', '1320000');
    // Another company's salary never appears.
    const otherHr = await h.actor(B, 'HR_ADMINISTRATOR', { extra: SALARY });
    const other = await employee({ company: B, by: otherHr });
    await recordSalary(otherHr, other.id, '70000', '840000');
    emp.other = other;
    Object.assign(emp, people);
  });

  /** Only this block's employees (the upload tests above recorded salaries too). */
  const ours = (page: Page) => ({ ...page, items: page.items.filter((r) => Object.values(people).some((p) => p.id === r.employeeId)) });

  it('lists the arrangements in force on a day with E08 grid values; the business date by default; paged with the total', async () => {
    const res = await list(hr1, day('2026-07-01'));
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as Page;
    expect(page).toMatchObject({ period: { date: '2026-07-01', from: '2026-07-01', to: '2026-07-01' }, page: 1, pageSize: 25 });
    expect(page.total).toBe(page.items.length);
    const mine = ours(page);
    expect(codes(mine).sort()).toEqual([people.revised!.code, people.graded!.code, people.finance!.code, people.left!.code].sort());
    expect(mine.items.find((r) => r.employeeId === people.revised!.id)).toEqual({
      employeeId: people.revised!.id,
      employeeCode: people.revised!.code,
      displayName: 'Synthetic Person',
      status: 'DRAFT',
      grade: null,
      effectiveFrom: '2026-01-05',
      effectiveTo: '2026-07-15',
      currency: 'INR',
      annualCtc: '1200000.0000',
      monthlyGross: '100000.0000',
    });
    expect(mine.items.find((r) => r.employeeId === people.graded!.id)).toMatchObject({ grade: 'Grade One', displayName: 'Synthetic Salaried Two' });
    // No estimated in-hand figure is computed (BR-011).
    expect(Object.keys(page.items[0]!).sort()).toEqual(['annualCtc', 'currency', 'displayName', 'effectiveFrom', 'effectiveTo', 'employeeCode', 'employeeId', 'grade', 'monthlyGross', 'status']);
    // The revision is the arrangement in force from its effective date.
    expect(ours((await list(hr1, day('2026-07-15'))).json()).items.find((r) => r.employeeId === people.revised!.id)).toMatchObject({ effectiveFrom: '2026-07-15', effectiveTo: null, monthlyGross: '110000.0000' });
    // Before any salary starts there is no row; an employee without a salary is never listed; nor another company's.
    expect(ours((await list(hr1, day('2026-01-04'))).json()).items).toEqual([]);
    const all = (await list(hr1, '?month=2026-07&pageSize=100')).json() as Page;
    expect(codes(all)).not.toContain(people.none!.code);
    expect(codes(all)).not.toContain(emp.other!.code);

    const today = (await list(hr1)).json() as Page;
    expect(today.period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today.items).toEqual(((await list(hr1, day(today.period.from!))).json() as Page).items);

    const second = (await list(hr1, `${day('2026-07-01')}&page=2`)).json() as Page;
    expect(second).toMatchObject({ items: [], total: page.total, page: 2 });
    expect((await list(hr1, '?pageSize=10')).statusCode).toBe(400);
  });

  it('a month lists every arrangement in force in it; search and status narrow it; filters are validated', async () => {
    const july = ours((await list(hr1, '?month=2026-07')).json());
    expect(july.items.filter((r) => r.employeeId === people.revised!.id).map((r) => [r.effectiveFrom, r.effectiveTo, r.monthlyGross])).toEqual([
      ['2026-01-05', '2026-07-15', '100000.0000'],
      ['2026-07-15', null, '110000.0000'],
    ]);
    expect(ours((await list(hr1, '?month=2026-06')).json()).items.filter((r) => r.employeeId === people.revised!.id)).toHaveLength(1);

    const byCode = (await list(hr1, `?month=2026-07&search=${people.graded!.code}`)).json() as Page;
    expect(byCode).toMatchObject({ total: 1, items: [{ employeeCode: people.graded!.code }] });
    expect(codes((await list(hr1, '?month=2026-07&search=salaried%20two')).json())).toEqual([people.graded!.code]);
    const left = (await list(hr1, '?month=2026-07&status=INACTIVE_SEPARATED')).json() as Page;
    expect(codes(left)).toEqual([people.left!.code]);

    const refused = await list(hr1, '?month=2026-07&date=2026-07-01');
    expect([refused.statusCode, refused.json().error]).toEqual([422, 'FILTER_CONFLICT']);
    for (const q of ['?month=2026-13', '?month=2026-7', '?date=2026-02-30', '?status=separated', '?search=' + 'x'.repeat(101)]) expect((await list(hr1, q)).statusCode, q).toBe(400);
  });

  it('needs the salary read grant (amounts are confidential); the row scope applies', async () => {
    for (const a of [hr, auditor]) expect((await list(a, day('2026-07-01'))).statusCode).toBe(403);
    // C4: the read grant answers for today and later; a past day needs the history grant (history-grants.api.test.ts).
    expect((await list(reader, '')).statusCode).toBe(200);
    expect((await list(reader, day('2026-07-01'))).json().error).toBe('HISTORY_GRANT_REQUIRED');
    const scoped = (await list(financeHr, '?month=2026-07')).json() as Page;
    expect(scoped.items.every((r) => r.employeeId !== people.revised!.id && r.employeeId !== people.graded!.id)).toBe(true);
    expect(ours(scoped).items.map((r) => r.employeeCode)).toEqual([people.finance!.code]);
  });

  describe('salary and annual salary exports', () => {
    const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
    const request = (a: TestActor, reportCode: string, filters: object = {}) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });
    const refused = async (code: string, filters: object) => {
      const res = await request(hr1, code, filters);
      return [res.statusCode, res.json().error];
    };
    async function exported(a: TestActor, reportCode: string, filters: object): Promise<Record<string, string>[]> {
      const res = await request(a, reportCode, filters);
      expect(res.statusCode, res.body).toBe(202);
      await processReportQueue(h.pool);
      expect((await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json()).toMatchObject({ state: 'COMPLETED' });
      const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
      expect(file.statusCode).toBe(200);
      const [header, ...lines] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
      return lines.map((l) => Object.fromEntries(header!.map((k, i) => [k, l[i]!])));
    }
    const money = (v: string) => Number(v).toFixed(2);
    const JULY = { from: '2026-07-01', to: '2026-07-31' };
    const FY2026 = { from: '2026-04-01', to: '2027-03-31' };

    it('are catalogued and need salary.export.salary; the output is confidential and the request audited', async () => {
      // Listed to the role holding the export grant only (reportCatalogue).
      const items = (await h.call(hr1, 'GET', '/v1/reports/catalogue')).json().items as { code: string; requiresPeriod: boolean; columns: string[] }[];
      const withoutGrant = ((await h.call(hr, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).map((r) => r.code);
      expect(withoutGrant).not.toContain('SALARY_MASTER');
      expect(withoutGrant).not.toContain('ANNUAL_SALARY');
      const columns = ['Employee code', 'Name', 'Status', 'Grade', 'Effective from', 'Effective to (exclusive)', 'Currency', 'Annual CTC', 'Monthly gross'];
      expect(items.find((r) => r.code === 'SALARY_MASTER')).toEqual({ code: 'SALARY_MASTER', title: 'Employee salary master', requiresPeriod: true, columns });
      expect(items.find((r) => r.code === 'ANNUAL_SALARY')).toEqual({ code: 'ANNUAL_SALARY', title: 'Employee annual salary', requiresPeriod: true, columns: ['Period start', 'Period end', ...columns] });
      // The salary read and manage grants, the increment export grant and operational roles are not enough.
      const incrementExporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary', 'salary.manage.salary', 'increment.export.salary'] });
      for (const [code, filters] of [['SALARY_MASTER', JULY], ['ANNUAL_SALARY', FY2026]] as const) {
        for (const a of [hr, reader, incrementExporter, auditor]) expect((await request(a, code, filters)).statusCode).toBe(403);
      }
      const ids = [(await request(hr1, 'SALARY_MASTER', JULY)).json().id, (await request(hr1, 'ANNUAL_SALARY', FY2026)).json().id];
      await processReportQueue(h.pool);
      const outputs = await h.db.query<{ classification: string; state: string }>(
        `select a.classification, x.state from report_execution x join attachment a on a.company_id = x.company_id and a.id = x.output_attachment_id where x.id = any($1)`,
        [ids],
      );
      expect(outputs.rows).toEqual([
        { classification: 'CONFIDENTIAL', state: 'COMPLETED' },
        { classification: 'CONFIDENTIAL', state: 'COMPLETED' },
      ]);
      const audit = await h.db.query<{ after: { operational: { reportCode: string } } }>(
        `select after_values as after from audit_event where company_id = $1 and resource_code = 'report_execution' and action = 'REQUEST' and record_key = any($2)`,
        [A.id, ids],
      );
      expect(audit.rows.map((r) => r.after.operational.reportCode).sort()).toEqual(['ANNUAL_SALARY', 'SALARY_MASTER']);
      // The download is the requester's only.
      expect((await h.call(hr2, 'GET', `/v1/reports/${ids[0]}/download`)).statusCode).toBe(404);
    });

    it('the salary export holds exactly the rows its list shows for the selected month or day (FR-029 acceptance)', async () => {
      const rows = await exported(hr1, 'SALARY_MASTER', JULY);
      const listed = (await list(hr1, '?month=2026-07&pageSize=100')).json() as Page;
      expect(rows).toHaveLength(listed.total);
      expect(rows.map((r) => [r['Employee code'], r['Effective from']])).toEqual(listed.items.map((r) => [r.employeeCode, r.effectiveFrom]));
      for (const [i, r] of listed.items.entries()) {
        expect(rows[i]).toEqual({
          'Employee code': r.employeeCode,
          Name: r.displayName,
          Status: r.status,
          Grade: r.grade ?? '',
          'Effective from': r.effectiveFrom,
          'Effective to (exclusive)': r.effectiveTo ?? '',
          Currency: r.currency,
          'Annual CTC': money(r.annualCtc),
          'Monthly gross': money(r.monthlyGross),
        });
      }
      expect(rows.filter((r) => r['Employee code'] === people.revised!.code).map((r) => r['Monthly gross'])).toEqual(['100000.00', '110000.00']);

      const oneDay = await exported(hr1, 'SALARY_MASTER', { from: '2026-07-20', to: '2026-07-20' });
      expect(oneDay.map((r) => r['Employee code'])).toEqual(((await list(hr1, '?date=2026-07-20&pageSize=100')).json() as Page).items.map((r) => r.employeeCode));
      expect(oneDay.find((r) => r['Employee code'] === people.revised!.code)).toMatchObject({ 'Monthly gross': '110000.00', 'Annual CTC': '1320000.00' });

      // The list's search and status filters apply alike; a department-limited exporter exports its department only.
      const searched = await exported(hr1, 'SALARY_MASTER', { ...JULY, search: people.graded!.code });
      expect(searched.map((r) => [r['Employee code'], r.Grade])).toEqual([[people.graded!.code, 'Grade One']]);
      expect((await exported(hr1, 'SALARY_MASTER', { ...JULY, status: 'INACTIVE_SEPARATED' })).map((r) => r['Employee code'])).toEqual([people.left!.code]);
      const finance = await exported(financeHr, 'SALARY_MASTER', JULY);
      expect(finance.map((r) => r['Employee code'])).toEqual(((await list(financeHr, '?month=2026-07&pageSize=100')).json() as Page).items.map((r) => r.employeeCode));
      expect(finance.map((r) => r['Employee code'])).toContain(people.finance!.code);
      expect(finance.map((r) => r['Employee code'])).not.toContain(people.revised!.code);
    });

    it('the annual salary export lists every arrangement in force in one financial or calendar year', async () => {
      const rows = (await exported(hr1, 'ANNUAL_SALARY', FY2026)).filter((r) => Object.values(people).some((p) => p.code === r['Employee code']));
      expect(rows.every((r) => r['Period start'] === '2026-04-01' && r['Period end'] === '2027-03-31')).toBe(true);
      expect(rows.map((r) => r['Employee code']).sort()).toEqual([people.revised!.code, people.revised!.code, people.graded!.code, people.finance!.code, people.left!.code].sort());
      expect(rows.filter((r) => r['Employee code'] === people.revised!.code).map((r) => [r['Effective from'], r['Effective to (exclusive)'], r['Annual CTC']])).toEqual([
        ['2026-01-05', '2026-07-15', '1200000.00'],
        ['2026-07-15', '', '1320000.00'],
      ]);
      const calendar = await exported(hr1, 'ANNUAL_SALARY', { from: '2026-01-01', to: '2026-12-31', search: people.revised!.code });
      expect(calendar.map((r) => [r['Period start'], r['Effective from']])).toEqual([
        ['2026-01-01', '2026-01-05'],
        ['2026-01-01', '2026-07-15'],
      ]);
      // Nothing was in force in the financial year before the first salary started.
      expect(await exported(hr1, 'ANNUAL_SALARY', { from: '2024-04-01', to: '2025-03-31' })).toEqual([]);
    });

    it('cover one day or month (salary) or one year (annual) exactly, and take only their own filters', async () => {
      expect(await refused('SALARY_MASTER', {})).toEqual([422, 'PERIOD_REQUIRED']);
      for (const period of [
        { from: '2026-07-01', to: '2026-07-30' },
        { from: '2026-07-02', to: '2026-07-31' },
        { from: '2026-07-01', to: '2026-08-31' },
      ]) {
        expect(await refused('SALARY_MASTER', period), JSON.stringify(period)).toEqual([422, 'DAY_OR_MONTH_REQUIRED']);
      }
      // A month ends on its own last day (28 February 2026; 29 February 2028).
      expect((await request(hr1, 'SALARY_MASTER', { from: '2026-02-01', to: '2026-02-28' })).statusCode).toBe(202);
      expect((await request(hr1, 'SALARY_MASTER', { from: '2028-02-01', to: '2028-02-29' })).statusCode).toBe(202);
      expect(await refused('SALARY_MASTER', { from: '2028-02-01', to: '2028-02-28' })).toEqual([422, 'DAY_OR_MONTH_REQUIRED']);
      for (const period of [JULY, { from: '2026-04-01', to: '2026-12-31' }, { from: '2026-04-02', to: '2027-03-31' }]) {
        expect(await refused('ANNUAL_SALARY', period)).toEqual([422, 'ANNUAL_PERIOD_REQUIRED']);
      }
      for (const code of ['SALARY_MASTER', 'ANNUAL_SALARY']) {
        const period = code === 'SALARY_MASTER' ? JULY : FY2026;
        expect(await refused(code, { ...period, departmentId: A.dept })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
        expect(await refused(code, { ...period, joinedFrom: '2026-01-01' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
        expect(await refused(code, { ...period, basis: 'MONTHLY_GROSS' })).toEqual([422, 'FILTER_NOT_SUPPORTED']);
      }
    });

    it('access revoked after the request means nothing is generated (ZT05)', async () => {
      const temp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.export.salary', 'salary.history_read.salary'] });
      const { id } = (await request(temp, 'SALARY_MASTER', JULY)).json();
      await h.db.query(
        `update role_assignment_permission set active = false
          where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'salary' and action = 'export' and field_group = 'salary')`,
        [temp.assignment],
      );
      await processReportQueue(h.pool);
      expect((await h.call(temp, 'GET', `/v1/reports/${id}`)).statusCode).toBe(403);
      expect(await h.one(`select state, failure_code from report_execution where id = $1`, [id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });
    });
  });
});
