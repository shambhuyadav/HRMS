// Perquisites and past salary uploads over HTTP (BRD coverage CL-085 upload perquisites, CL-084 / CL-119 upload past salary; FR-039;
// I-90; DF09 imports; BR-026 row scope; C4 never one's own record): preview, commit, superseding revisions that never overwrite, the
// row rules, the year view, and the plain statement that the TDS projection does not read them yet. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';

const TAX: ('payroll_tax_input.read.amount' | 'payroll_tax_input.import.amount')[] = ['payroll_tax_input.read.amount', 'payroll_tax_input.import.amount'];
const PERQ = '/v1/payroll-extras/perquisite-imports';
const PAST = '/v1/payroll-extras/past-salary-imports';
const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const file = (header: string, ...rows: string[]) => `${header}\r\n${rows.join('\r\n')}\r\n`;
const PERQ_HEADER = 'employeeCode,month,perquisiteType,value';
const PAST_HEADER = 'employeeCode,financialYear,source,fromMonth,toMonth,taxableSalary,tdsDeducted';

type Job = { id: string; state: string; template: string; rows: { businessKey: string; state: string; errorCode: string | null; proposedChanges: Record<string, { from: string | null; to: string }> | null }[] };

describe.runIf(isModuleActive('payroll-extras'))('perquisites and past salary (CL-085, CL-084, CL-119; FR-039)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let admin: TestActor;
  let early: { id: string; code: string };
  let late: { id: string; code: string };
  let finance: { id: string; code: string };

  const upload = async (a: TestActor, path: string, text: string) =>
    h.call(a, 'POST', path, { fileName: 'inputs.csv', contentBase64: toBase64(text), idempotencyKey: uniq('tax-input-') });
  const previewed = async (a: TestActor, path: string, text: string) => {
    const res = await upload(a, path, text);
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json() as Job;
  };
  const errors = (job: Job) => job.rows.map((r) => r.errorCode);
  const person = async (over: Record<string, unknown>) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    admin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: TAX });
    early = await person({ joiningDate: '2026-01-05' });
    late = await person({ joiningDate: '2026-06-15' });
    finance = await person({ joiningDate: '2026-01-05', departmentId: A.financeDept });
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('CL-085: the perquisite upload previews, commits, and a later upload supersedes without overwriting', async () => {
    expect((await h.call(admin, 'GET', `${PERQ}/template`)).body).toBe(`${PERQ_HEADER}\r\n`);
    const job = await previewed(admin, PERQ, file(PERQ_HEADER, `${early.code},2026-05,rent_free_accommodation,1000`, `${late.code},2026-07,MOTOR_CAR,2400.50`));
    expect(job).toMatchObject({ state: 'PREVIEWED', template: 'PERQUISITES_V1' });
    expect(job.rows.map((r) => [r.businessKey, r.proposedChanges])).toEqual([
      [`${early.code}@2026-05@RENT_FREE_ACCOMMODATION`, { value: { from: null, to: '1000.00' } }],
      [`${late.code}@2026-07@MOTOR_CAR`, { value: { from: null, to: '2400.50' } }],
    ]);
    expect((await h.db.query(`select 1 from payroll_perquisite where company_id = $1`, [A.id])).rowCount).toBe(0);
    expect((await h.call(admin, 'POST', `${PERQ}/${job.id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });

    const again = await previewed(admin, PERQ, file(PERQ_HEADER, `${early.code},2026-05,RENT_FREE_ACCOMMODATION,1200`));
    expect(again.rows[0]!.proposedChanges).toEqual({ value: { from: '1000.00', to: '1200.00' } });
    await h.call(admin, 'POST', `${PERQ}/${again.id}/commit`);
    const stored = await h.db.query(`select revision, value::text, import_job_id from payroll_perquisite where company_id = $1 and employee_id = $2 order by revision`, [A.id, early.id]);
    expect(stored.rows).toEqual([
      { revision: 1, value: '1000.00', import_job_id: job.id },
      { revision: 2, value: '1200.00', import_job_id: again.id },
    ]);
    await expect(h.db.query(`update payroll_perquisite set value = 1 where company_id = $1`, [A.id])).rejects.toThrow();

    const view = (await h.call(admin, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2026-27')).json();
    // I-90: the projection does not read them, and says so.
    expect(view.tdsProjection.status).toBe('NOT_FED');
    const mine = view.items.find((i: { employeeId: string }) => i.employeeId === early.id);
    expect(mine.perquisites).toEqual([expect.objectContaining({ month: '2026-05', perquisiteType: 'RENT_FREE_ACCOMMODATION', value: '1200.00', revision: 2 })]);
    // The import framework's audit: each commit is recorded on the batch.
    const commits = await h.db.query(`select 1 from audit_event where company_id = $1 and resource_code = 'import_job' and action = 'COMMIT' and record_key = any($2::uuid[])`, [A.id, [job.id, again.id]]);
    expect(commits.rowCount).toBe(2);
  });

  it('CL-085 DF09: the row rules, each rejecting the whole file', async () => {
    const job = await previewed(
      admin,
      PERQ,
      file(
        PERQ_HEADER,
        `NOBODY-${uniq('x')},2026-05,MOTOR_CAR,10`,
        `${early.code},2026-13,MOTOR_CAR,10`,
        `${early.code},2099-01,MOTOR_CAR,10`,
        `${early.code},2026-05,MOTOR CAR,10`,
        `${early.code},2026-06,MOTOR_CAR,-5`,
        `${late.code},2026-05,MOTOR_CAR,10`,
        `${early.code},2026-08,ESOP,10`,
        `${early.code},2026-08,esop,20`,
      ),
    );
    expect(job.state).toBe('REJECTED');
    expect(errors(job)).toEqual(['UNKNOWN_EMPLOYEE', 'INVALID_MONTH', 'FUTURE_MONTH', 'INVALID_PERQUISITE_TYPE', 'INVALID_VALUE', 'NOT_EMPLOYED_IN_MONTH', 'BATCH_REJECTED', 'DUPLICATE_IN_BATCH']);
  });

  it('CL-084 CL-119: past salary before go-live and from an earlier employer, with the year, joining and source rules', async () => {
    expect((await h.call(admin, 'GET', `${PAST}/template`)).body).toBe(`${PAST_HEADER}\r\n`);
    const job = await previewed(admin, PAST, file(PAST_HEADER, `${early.code},2026-27,before_go_live,2026-04,2026-06,90000,4500`, `${late.code},2026-27,PREVIOUS_EMPLOYER,2026-04,2026-05,60000.5,3000`));
    expect(job.state).toBe('PREVIEWED');
    expect(job.rows[1]!.proposedChanges).toEqual({ taxableSalary: { from: null, to: '60000.50' }, tdsDeducted: { from: null, to: '3000.00' } });
    expect((await h.call(admin, 'POST', `${PAST}/${job.id}/commit`)).json().state).toBe('COMMITTED');

    const bad = await previewed(
      admin,
      PAST,
      file(
        PAST_HEADER,
        `${early.code},2026-28,BEFORE_GO_LIVE,2026-04,2026-05,1,1`,
        `${early.code},2026-27,OTHER,2026-04,2026-05,1,1`,
        `${early.code},2026-27,PREVIOUS_EMPLOYER,2026-06,2026-04,1,1`,
        `${finance.code},2026-27,PREVIOUS_EMPLOYER,2026-02,2026-05,1,1`,
        `${late.code},2026-27,PREVIOUS_EMPLOYER,2026-04,2026-08,1,1`,
        `${late.code},2026-27,BEFORE_GO_LIVE,2026-04,2026-08,1,1`,
        `${finance.code},2026-27,BEFORE_GO_LIVE,2026-04,2026-05,1.234,1`,
      ),
    );
    expect(errors(bad)).toEqual(['INVALID_FISCAL_YEAR', 'INVALID_SOURCE', 'INVALID_MONTHS', 'MONTHS_OUTSIDE_YEAR', 'AFTER_JOINING', 'NOT_EMPLOYED_IN_MONTH', 'INVALID_AMOUNT']);

    // A correction is a new revision; the view shows the current one per source, never both.
    const fix = await previewed(admin, PAST, file(PAST_HEADER, `${early.code},2026-27,BEFORE_GO_LIVE,2026-04,2026-06,91000,4600`));
    expect(fix.rows[0]!.proposedChanges).toEqual({ taxableSalary: { from: '90000.00', to: '91000.00' }, tdsDeducted: { from: '4500.00', to: '4600.00' } });
    await h.call(admin, 'POST', `${PAST}/${fix.id}/commit`);
    const view = (await h.call(admin, 'GET', `/v1/payroll-extras/tax-inputs?fiscalYear=2026-27&search=${early.code}`)).json();
    expect(view.items).toHaveLength(1);
    expect(view.items[0].pastSalary).toEqual([expect.objectContaining({ source: 'BEFORE_GO_LIVE', fromMonth: '2026-04', toMonth: '2026-06', taxableSalary: '91000.00', tdsDeducted: '4600.00', revision: 2 })]);
    expect((await h.call(admin, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2025-26')).json().items).toEqual([]);
  });

  it('FR-002 BR-026 C4: the grant, the row scope, and never one’s own record', async () => {
    const text = file(PERQ_HEADER, `${finance.code},2026-05,MOTOR_CAR,10`);
    // No grant (a plain HR Administrator: the group is confidential and ceiling-only), and the Employee context.
    expect((await upload(hr, PERQ, text)).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2026-27')).statusCode).toBe(403);
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: early.id });
    expect((await h.call(employee, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2026-27')).statusCode).toBe(403);
    // A department-filtered assignment: the other department's employee is out of scope, and absent from its view.
    const eng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: TAX, departmentFilter: A.dept });
    expect(errors(await previewed(eng, PERQ, text))).toEqual(['OUT_OF_SCOPE']);
    const seen = (await h.call(eng, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2026-27')).json().items.map((i: { employeeId: string }) => i.employeeId);
    expect(seen).toContain(early.id);
    expect(seen).not.toContain(finance.id);
    // An administrator linked to the employee never records, nor lists, their own tax inputs.
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: TAX, employeeId: late.id });
    expect(errors(await previewed(self, PERQ, file(PERQ_HEADER, `${late.code},2026-09,MOTOR_CAR,10`)))).toEqual(['OWN_RECORD']);
    const listed = (await h.call(self, 'GET', '/v1/payroll-extras/tax-inputs?fiscalYear=2026-27')).json().items.map((i: { employeeId: string }) => i.employeeId);
    expect(listed).toContain(early.id);
    expect(listed).not.toContain(late.id);
    // Another user's batch reads as missing.
    const job = await previewed(admin, PERQ, file(PERQ_HEADER, `${finance.code},2026-05,MOTOR_CAR,10`));
    expect((await h.call(eng, 'GET', `${PERQ}/${job.id}`)).statusCode).toBe(404);
  });
});
