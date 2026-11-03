// FR-057 "Auditors can trace who changed an employee grade and which payroll run used it; audit access cannot mutate the
// underlying transaction": the assignment a run selected and calculated with (0121), the read-only trace of the audit
// duty, and the nested field names in the audit trail. Synthetic employees, grades and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { calculate, calendar, CONFIG, createRun, head, ok, person, PREPARE, salary, SALARY } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { processReportQueue } from '../report/service.js';

interface TraceRun {
  runId: string;
  revision: number;
  state: string;
  periodCode: string;
  selectedAssignmentId: string | null;
  calculatedAssignmentId: string | null;
  recordId: string | null;
  salaryArrangementIds: string[];
}
interface Trace {
  employee: { id: string; code: string; name: string };
  assignments: { id: string; gradeId: string | null; gradeCode: string | null; effectiveFrom: string; effectiveTo: string | null; recordedBy: string | null; changedFields: string[] }[];
  runs: TraceRun[];
  total: number;
  page?: number;
  pageSize?: number;
}

describe.runIf(isModuleActive('payroll'))('trace of a grade change to the payroll runs that used it (FR-057)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let changer: TestActor;
  let preparer: TestActor;
  let auditor: TestActor;
  let periods: Record<string, string>;
  let dept: string;
  let employeeId: string;
  let arrangementId: string;
  let gradeOne: string;
  let gradeTwo: string;
  let gradeThree: string;
  let septemberRun: string;
  let octoberRun: string;

  const grade = async (code: string) => (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const accountOf = async (a: TestActor) => (await h.one<{ k: string }>(`select account_key as k from user_account where id = $1`, [a.user])).k;
  const traceOf = async (a: TestActor = auditor, id = employeeId, query = '') => h.call(a, 'GET', `/v1/audit/employees/${id}/payroll-trace${query}`);
  const trace = async (a: TestActor = auditor) => ok<Trace>(await traceOf(a));
  const changeGrade = (gradeId: string, effectiveFrom: string) =>
    h.call(changer, 'POST', `/v1/employees/${employeeId}/assignment`, { departmentId: dept, locationId: A.loc, designationId: A.desig, gradeId, effectiveFrom });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    changer = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    auditor = await h.actor(A, 'AUDITOR');
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (
      await calendar(h, configA, configB, [
        { code: '2026-09', start: '2026-09-01', end: '2026-09-30' },
        { code: '2026-10', start: '2026-10-01', end: '2026-10-31' },
        { code: '2026-11', start: '2026-11-01', end: '2026-11-30' },
      ])
    ).periods;
    dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'TRACE', 'TRACE', true) returning id`, [A.id])).id;
    gradeOne = await grade('G-ONE');
    gradeTwo = await grade('G-TWO');
    gradeThree = await grade('G-THREE');
    employeeId = await person(h, A, hr, { departmentId: dept, gradeId: gradeOne, joiningDate: '2026-01-05', name: 'Tess Traced (synthetic)' });
    arrangementId = await salary(h, preparer, employeeId, { effectiveFrom: '2026-01-05', monthlyGross: '54321', components: [{ code: 'BASIC', amount: '54321' }] });

    septemberRun = (await createRun(h, preparer, periods['2026-09']!, { departmentIds: [dept] })).id;
    await calculate(h, preparer, septemberRun);
    const changed = await changeGrade(gradeTwo, '2026-10-01');
    expect(changed.statusCode, changed.body).toBeLessThan(300);
    octoberRun = (await createRun(h, preparer, periods['2026-10']!, { departmentIds: [dept] })).id;
    await calculate(h, preparer, octoberRun);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('names who changed the grade and when, and follows each assignment to the run that selected and calculated with it', async () => {
    const t = await trace();
    expect(t.employee).toMatchObject({ id: employeeId, name: 'Tess Traced (synthetic)' });
    const [current, first] = t.assignments;
    expect(current).toMatchObject({ gradeId: gradeTwo, gradeCode: 'G-TWO', effectiveFrom: '2026-10-01', effectiveTo: null, recordedBy: await accountOf(changer), changedFields: ['assignment.gradeId'] });
    // The first assignment had nothing before it to change.
    expect(first).toMatchObject({ gradeId: gradeOne, gradeCode: 'G-ONE', effectiveTo: '2026-10-01', recordedBy: await accountOf(hr), changedFields: [] });

    const of = (runId: string) => t.runs.find((r) => r.runId === runId)!;
    expect(of(septemberRun)).toMatchObject({ periodCode: '2026-09', revision: 1, state: 'CALCULATED', selectedAssignmentId: first!.id, calculatedAssignmentId: first!.id, salaryArrangementIds: [arrangementId] });
    expect(of(octoberRun)).toMatchObject({ periodCode: '2026-10', selectedAssignmentId: current!.id, calculatedAssignmentId: current!.id, salaryArrangementIds: [arrangementId] });
    expect(t.runs.map((r) => r.periodCode)).toEqual(['2026-10', '2026-09']);
    expect(t.total).toBe(2);
  });

  it('never shows an amount, and pages the runs with their total', async () => {
    const res = await traceOf();
    expect(res.body).not.toContain('54321');
    for (const field of ['net', 'gross', 'earnings', 'deductions', 'amount', 'monthlyGross', 'annualCtc']) expect(res.body).not.toContain(`"${field}"`);
    expect(await ok<Trace>(await traceOf(auditor, employeeId, '?page=2&pageSize=25'))).toMatchObject({ runs: [], total: 2, page: 2, pageSize: 25 });
    expect((await traceOf(auditor, employeeId, '?pageSize=7')).statusCode).toBe(400);
  });

  it('records what the calculation used separately from what the scope selected, and later changes rewrite neither', async () => {
    const run = (await createRun(h, preparer, periods['2026-11']!, { departmentIds: [dept] })).id;
    const selected = (await trace()).assignments[0]!.id;
    // A grade change after the scope was confirmed and before the calculation, inside the service month.
    expect((await changeGrade(gradeThree, '2026-11-15')).statusCode).toBeLessThan(300);
    await calculate(h, preparer, run);
    const after = await trace();
    expect(after.assignments[0]).toMatchObject({ gradeCode: 'G-THREE', changedFields: ['assignment.gradeId'] });
    const november = after.runs.find((r) => r.runId === run)!;
    expect(november.selectedAssignmentId).toBe(selected);
    expect(november.calculatedAssignmentId).toBe(after.assignments[0]!.id);
    // The earlier runs still say what they used.
    expect(after.runs.find((r) => r.runId === octoberRun)!.calculatedAssignmentId).toBe(selected);
  });

  it('holds what a run used in the database: the employee’s own assignment, written once', async () => {
    const other = await person(h, A, hr, { departmentId: A.financeDept });
    const foreign = (await h.one<{ id: string }>(`select id from employment_assignment where company_id = $1 and employee_id = $2`, [A.id, other])).id;
    await expect(h.db.query(`update payroll_run_member set employment_assignment_id = $3 where company_id = $1 and employee_id = $2`, [A.id, employeeId, foreign])).rejects.toThrow(/immutable|foreign key/);
    await expect(h.db.query(`update payroll_record set employment_assignment_id = null where company_id = $1 and employee_id = $2`, [A.id, employeeId])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`update payroll_run_member set employment_assignment_id = null where company_id = $1 and employee_id = $2`, [A.id, employeeId])).rejects.toThrow(/immutable/);
  });

  it('names the changed assignment field in the audit trail and its export, never its value', async () => {
    const view = await ok<{ items: { action: string; actorUserId: string; changedFields: string[] }[] }>(await h.call(auditor, 'GET', `/v1/audit/events?resource=employment_assignment&recordKey=${employeeId}`));
    expect(view.items.length).toBeGreaterThanOrEqual(2);
    for (const e of view.items) {
      expect(e).toMatchObject({ action: 'UPDATE', actorUserId: changer.user });
      expect(e.changedFields).toContain('assignment.gradeId');
      expect(e.changedFields).toContain('effectiveFrom');
      // Only the grade changed: a department or location change would name itself, and the bare object says nothing.
      expect(e.changedFields).not.toContain('assignment');
      expect(e.changedFields).not.toContain('assignment.departmentId');
      expect(e.changedFields).not.toContain('assignment.locationId');
    }
    const body = JSON.stringify(view);
    expect(body).not.toContain(gradeTwo);
    expect(body).not.toContain(gradeThree);

    // A change of department names that field instead.
    const moved = await h.call(changer, 'POST', `/v1/employees/${employeeId}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, gradeId: gradeThree, effectiveFrom: '2026-12-01' });
    expect(moved.statusCode, moved.body).toBeLessThan(300);
    const latest = await ok<{ items: { changedFields: string[] }[] }>(await h.call(auditor, 'GET', `/v1/audit/events?resource=employment_assignment&recordKey=${employeeId}&pageSize=1`));
    expect(latest.items[0]!.changedFields).toEqual(['assignment.departmentId', 'effectiveFrom']);

    const exporter = await h.actor(A, 'AUDITOR', { extra: ['audit.export.operational'] });
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    const queued = await h.call(exporter, 'POST', '/v1/reports', { reportCode: 'AUDIT_TRAIL', filters: { from: today, to: today } });
    expect(queued.statusCode, queued.body).toBe(202);
    await processReportQueue(h.pool);
    const csv = (await h.call(exporter, 'GET', `/v1/reports/${queued.json().id}/download`)).body;
    expect(csv).toContain('assignment.gradeId');
    expect(csv).not.toContain(gradeTwo);
  });

  it('is for the audit duty alone, in company scope, and that duty changes nothing', async () => {
    expect((await traceOf(hr)).statusCode).toBe(403);
    expect((await traceOf(preparer)).statusCode).toBe(403);
    expect((await traceOf(await h.actor(A, 'EMPLOYEE', { employeeId }))).statusCode).toBe(403);
    expect((await traceOf(await h.actor(A, 'REPORTING_MANAGER'))).statusCode).toBe(403);
    // Audit records are not employee-scoped: a filtered audit assignment reads none of them.
    expect((await traceOf(await h.actor(A, 'AUDITOR', { departmentFilter: dept }))).statusCode).toBe(403);
    // Another company's employee, and an unknown one, read as missing.
    expect((await traceOf(await h.actor(B, 'AUDITOR'))).statusCode).toBe(404);
    expect((await traceOf(auditor, '00000000-0000-4000-8000-00000000abcd')).statusCode).toBe(404);
    expect((await traceOf(auditor, 'not-an-id')).statusCode).toBe(400);
    // FR-057 "audit access cannot mutate the underlying transaction".
    const before = await h.one<{ n: number; runs: number }>(
      `select (select count(*)::int from employment_assignment where company_id = $1 and employee_id = $2) as n, (select count(*)::int from payroll_run where company_id = $1) as runs`,
      [A.id, employeeId],
    );
    expect((await h.call(auditor, 'POST', `/v1/employees/${employeeId}/assignment`, { departmentId: dept, locationId: A.loc, designationId: A.desig, gradeId: gradeOne, effectiveFrom: '2027-01-01' })).statusCode).toBe(403);
    expect((await h.call(auditor, 'POST', `/v1/payroll/runs/${octoberRun}/calculate`, { expectedVersion: 1 })).statusCode).toBe(403);
    expect((await h.call(auditor, 'POST', `/v1/audit/employees/${employeeId}/payroll-trace`, {})).statusCode).toBe(404);
    expect(
      await h.one<{ n: number; runs: number }>(
        `select (select count(*)::int from employment_assignment where company_id = $1 and employee_id = $2) as n, (select count(*)::int from payroll_run where company_id = $1) as runs`,
        [A.id, employeeId],
      ),
    ).toEqual(before);
  });

  it('says null for a run recorded before the assignment was kept (0121), and an employee with no run has none', async () => {
    const fresh = await person(h, A, hr, { departmentId: A.dept, name: `Nia No Run ${uniq('n')} (synthetic)` });
    expect(await ok<Trace>(await traceOf(auditor, fresh))).toMatchObject({ runs: [], total: 0 });
    const legacy = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, legacy, { effectiveFrom: '2026-01-05', monthlyGross: '1000', components: [{ code: 'BASIC', amount: '1000' }] });
    // Everyone else in the department is already in this month's run, so this run holds the legacy employee alone.
    const run = (await createRun(h, preparer, periods['2026-11']!, { departmentIds: [dept] })).id;
    // The member as a run older than 0121 left it: only the guard of this one column is set aside to write it.
    await h.db.query(`alter table payroll_run_member disable trigger payroll_run_member_used_assignment`);
    try {
      await h.db.query(`update payroll_run_member set employment_assignment_id = null where company_id = $1 and employee_id = $2`, [A.id, legacy]);
    } finally {
      await h.db.query(`alter table payroll_run_member enable trigger payroll_run_member_used_assignment`);
    }
    const t = await ok<Trace>(await traceOf(auditor, legacy));
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ runId: run, selectedAssignmentId: null, calculatedAssignmentId: null, recordId: null, salaryArrangementIds: [] });
  });
});
