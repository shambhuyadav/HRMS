// Data migration toolkit against a company (embedded PostgreSQL harness, synthetic sample extract): validate reads the company
// without writing to it; load refuses without confirmation or with a validation failure, goes through the existing import
// pipelines as the named operator with provenance (CI16), and is idempotent; reconcile (ZT19) matches a clean load exactly
// and reports a source row the load dropped and a money difference. Synthetic data only.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../apps/api/src/test/harness.js';
import { calendar, CONFIG, months } from '../../apps/api/src/modules/payroll/payroll.fixtures.js';
import { memoryFileStore } from '../../apps/api/src/storage/files.js';
import { developmentScanner } from '../../apps/api/src/storage/scan.js';
import { analyse, type ExtractInput } from './analyse.js';
import { LoadRefused, loadExtract, type LoadResult } from './load.js';
import { reconcile } from './reconcile.js';
import { readExtract, reconcileMarkdown } from './report.js';
import { migrationRecordKey, readOnly, readTargetFacts } from './target.js';

const SAMPLE = fileURLToPath(new URL('./sample', import.meta.url));
const TABLES = ['employee', 'department', 'location', 'designation', 'grade', 'employment_assignment', 'manager_assignment', 'shift_assignment', 'salary_arrangement', 'leave_movement', 'payroll_loan', 'import_job', 'import_row', 'attachment', 'audit_event', 'role_assignment', 'role_assignment_permission'];

describe('data migration load and reconcile (ZT19, CI16, DQ-01 to DQ-15)', () => {
  let h: Harness;
  let A: Company;
  let code: string;
  let operator: TestActor;
  let operatorKey: string;
  let base: ExtractInput;
  const files = memoryFileStore();
  const scanner = developmentScanner();

  const copy = (): ExtractInput => ({ manifest: structuredClone(base.manifest), files: new Map(base.files) });
  const counts = async () => {
    const n: Record<string, number> = {};
    for (const t of TABLES) n[t] = (await h.one<{ n: number }>(`select count(*)::int as n from ${t}`)).n;
    return n;
  };
  const load = (extract: ExtractInput, extra: Partial<Parameters<typeof loadExtract>[0]> = {}) =>
    loadExtract({ db: h.pool, files, scanner, extract, companyCode: code, operator: operatorKey, commit: true, confirm: code, ...extra });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    code = (await h.one<{ code: string }>(`select code from company where id = $1`, [A.id])).code;
    base = await readExtract(SAMPLE);
    // The operator: an HR Administrator granted salary and loan entry (confidential, never default duties), who also holds the
    // System Administrator assignment that creates organisation masters.
    operator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.manage.salary', 'salary.read.salary', 'payroll_loan.request.loan', 'payroll_loan.read.loan'] });
    await h.actor(A, 'SYSTEM_ADMINISTRATOR', { user: operator.user });
    operatorKey = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [operator.user])).account_key;
    // What the company already has before the migration: the general shift and an active INR payroll calendar (loans need one).
    const setup = await h.actor(A, 'HR_ADMINISTRATOR');
    const shift = await h.call(setup, 'POST', '/v1/shifts', { code: 'GEN', name: 'General', inTime: '09:30', outTime: '18:30', bufferMinutes: 60, breaks: [] });
    expect(shift.statusCode, shift.body).toBe(201);
    await calendar(h, await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG }), await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG }), months(2026));
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('DQ-05 DQ-10: validate against the company reads it in a read-only transaction and writes nothing; shifts and leave types are checked there', async () => {
    const before = await counts();
    const a = analyse(base, await readOnly(h.pool, (tx) => readTargetFacts(tx, code, base.manifest.migrationId)));
    expect(a.failed).toBe(false);
    expect(a.target).toEqual({ companyCode: code });
    // With the company, nothing is left unverified.
    expect(a.checks.find((c) => c.id === 'DQ-05')!.status).toBe('PASS');
    expect(await counts()).toEqual(before);
    await expect(readOnly(h.pool, (tx) => tx.query(`insert into department (company_id, code, name, active) values ($1, 'NOPE', 'Nope', true)`, [A.id]))).rejects.toThrow(/read-only transaction/);

    // Another company, with no GEN shift and an employee L006 of its own: a leave type and a shift it lacks, an inactive master and
    // an employee code it already has fail against it.
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const res = await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B, { employeeCode: 'L006' }));
    expect(res.statusCode, res.body).toBe(201);
    await h.db.query(`insert into location (company_id, code, name, active) values ($1, 'PUN', 'Pune (closed)', false)`, [B.id]);
    const codeB = (await h.one<{ code: string }>(`select code from company where id = $1`, [B.id])).code;
    const x = copy();
    x.files.set('leave_balances.csv', Buffer.from(x.files.get('leave_balances.csv')!.toString('utf-8').replace('L003,PL,4', 'L003,ML,4')));
    const b = analyse(x, await readOnly(h.pool, (tx) => readTargetFacts(tx, codeB, base.manifest.migrationId)));
    const fail = (id: string) => b.checks.find((c) => c.id === id)!.findings.filter((f) => f.severity === 'FAIL').map((f) => `${f.key} ${f.reason}`);
    expect(fail('DQ-05')).toEqual(
      expect.arrayContaining([
        'L003 leaveType "ML" is not a known leaveType and has no entry in codeMaps.leaveType',
        'L001 shiftCode "General" is not a known shift (mapped to GEN)',
        'L004 location PUN exists in the target company but is inactive',
      ]),
    );
    expect(fail('DQ-10')).toEqual(['L006 employee code L006 already exists in the target company']);
  });

  it('load refuses without --commit and without the company confirmed, before reading or writing anything', async () => {
    const before = await counts();
    await expect(load(base, { commit: false })).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
    await expect(load(base, { confirm: undefined })).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
    await expect(load(base, { confirm: 'ANOTHER' })).rejects.toBeInstanceOf(LoadRefused);
    const wrongCompany = copy();
    wrongCompany.manifest.company = 'ANOTHER';
    await expect(load(wrongCompany)).rejects.toMatchObject({ code: 'COMPANY_MISMATCH' });
    expect(await counts()).toEqual(before);
  });

  it('DQ-06: load refuses an extract that fails validation (a reporting cycle) and writes nothing', async () => {
    const x = copy();
    x.files.set('employees.csv', Buffer.from(x.files.get('employees.csv')!.toString('utf-8').replace('G3,L001,General,ZZTEST0002', 'G3,L004,General,ZZTEST0002')));
    const before = await counts();
    const refused = await load(x).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(LoadRefused);
    expect(refused).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((refused as LoadRefused).analysis!.checks.find((c) => c.id === 'DQ-06')!.status).toBe('FAIL');
    expect(await counts()).toEqual(before);
  });

  it('load refuses an operator without the grants a stage needs, before writing anything', async () => {
    const plain = await h.actor(A, 'HR_ADMINISTRATOR');
    const key = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [plain.user])).account_key;
    const before = await counts();
    await expect(load(base, { operator: key })).rejects.toMatchObject({ code: 'OPERATOR', message: expect.stringContaining('org_master.create') });
    expect(await counts()).toEqual(before);
  });

  let first: LoadResult;
  it('ZT19 CI16 DQ-08 DQ-14: a clean load goes through the import pipelines in order as the operator, with provenance, and reconcile matches it exactly', async () => {
    const roles = (await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where company_id = $1`, [A.id])).n;
    first = await load(base);
    expect(first.ok, JSON.stringify(first.stages, null, 1)).toBe(true);
    expect(first.stages.map((s) => [s.stage, s.template, s.state, s.rows])).toEqual([
      // ENG and FIN were already in the company; the inactive OPS is not created.
      ['masters', 'org master create', 'COMMITTED', 21],
      ['employees', 'EMPLOYEE_ONBOARDING_V1', 'COMMITTED', 12],
      ['assignments-1', 'EMPLOYEE_UPDATE_V1', 'COMMITTED', 2],
      ['shifts', 'SHIFT_PLAN_V1', 'COMMITTED', 12],
      ['activation-0', 'employee activation', 'COMMITTED', 1],
      ['managers-1', 'EMPLOYEE_UPDATE_V1', 'COMMITTED', 4],
      ['activation-1', 'employee activation', 'COMMITTED', 4],
      ['managers-2', 'EMPLOYEE_UPDATE_V1', 'COMMITTED', 7],
      ['activation-2', 'employee activation', 'COMMITTED', 6],
      ['salary', 'SALARY_MASTER_V1', 'COMMITTED', 11],
      ['leave-opening', 'LEAVE_OPENING_V1', 'COMMITTED', 13],
      ['loans', 'LOAN_REQUESTS_V1', 'COMMITTED', 3],
    ]);
    expect(first.stages.find((s) => s.stage === 'masters')).toMatchObject({ accepted: 19 });

    // CI16: every batch is an import job of this migration, submitted by the operator, with accepted counts equal to its rows.
    const jobs = (
      await h.db.query<{ template_code: string; state: string; submitted_by: string; accepted_count: number; rejected_count: number; rows: number; key: string }>(
        `select j.template_code, j.state, j.submitted_by, j.accepted_count, j.rejected_count, j.idempotency_key as key,
                (select count(*)::int from import_row r where r.company_id = j.company_id and r.job_id = j.id and r.state = 'ACCEPTED') as rows
           from import_job j where j.company_id = $1 order by j.created_at`,
        [A.id],
      )
    ).rows;
    expect(jobs).toHaveLength(8);
    for (const j of jobs) {
      expect(j).toMatchObject({ state: 'COMMITTED', submitted_by: operator.user, rejected_count: 0 });
      expect(j.accepted_count).toBe(j.rows);
      expect(j.key.startsWith('data-migration:SAMPLE-LEGACY-2026:')).toBe(true);
    }
    // DQ-08: each stage is on the audit trail as the operator, naming the manifest, the source files and their lines.
    const stages = (await h.db.query<{ actor_user_id: string; action: string; record_key: string; after_values: { operational: { stage?: string; manifestSha256: string; sources: unknown[]; sourceLines?: string[] } } }>(
      `select actor_user_id, action, record_key, after_values from audit_event where company_id = $1 and resource_code = 'data_migration' order by occurred_at, id`,
      [A.id],
    )).rows;
    expect(new Set(stages.map((s) => s.record_key))).toEqual(new Set([migrationRecordKey(A.id, 'SAMPLE-LEGACY-2026')]));
    expect(stages.map((s) => s.after_values.operational.stage ?? s.action)).toEqual([
      'masters', 'employees', 'assignments-1', 'shifts', 'activation-0', 'managers-1', 'activation-1', 'managers-2', 'activation-2', 'salary', 'leave-opening', 'loans', 'LOAD_COMPLETED',
    ]);
    expect(stages.every((s) => s.actor_user_id === operator.user && s.after_values.operational.manifestSha256 === first.analysis.manifestSha256)).toBe(true);
    expect(stages[1]!.after_values.operational.sourceLines).toContain('employees.csv:2');
    // Business records carry the operator as their writer, through the ordinary paths.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and created_by = $2`, [A.id, operator.user])).n).toBe(12);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'employee' and action = 'ACTIVATE' and actor_user_id = $2`, [A.id, operator.user])).n).toBe(11);
    // DQ-14: the migration grants nobody anything.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where company_id = $1`, [A.id])).n).toBe(roles);
    // Statuses: the activated employees are on probation in the system, the not-yet-joined one is a draft.
    const statuses = (await h.db.query<{ code: string; status: string }>(`select e.employee_code as code, st.code as status from employee e join reference_value st on st.id = e.status_id where e.company_id = $1 and e.employee_code like 'L%' order by 1`, [A.id])).rows;
    expect(statuses.filter((s) => s.status === 'ACTIVE_PROBATION')).toHaveLength(11);
    expect(statuses.find((s) => s.code === 'L012')!.status).toBe('DRAFT');
    expect(statuses.find((s) => s.code === 'L013')).toBeUndefined();
    // Loans are requests awaiting their independent decision, carrying their legacy reference.
    expect((await h.db.query<{ state: string; purpose: string }>(`select state, purpose from payroll_loan where company_id = $1 order by purpose`, [A.id])).rows).toEqual([
      { state: 'REQUESTED', purpose: 'Home repairs [migration SAMPLE-LEGACY-2026 loan LN-2024-001]' },
      { state: 'REQUESTED', purpose: 'Medical expenses [migration SAMPLE-LEGACY-2026 loan LN-2025-007]' },
      { state: 'REQUESTED', purpose: 'Vehicle purchase [migration SAMPLE-LEGACY-2026 loan LN-2026-003]' },
    ]);

    const r = await reconcile({ db: h.pool, extract: base, companyCode: code, operator: operatorKey });
    expect(r.reasons).toEqual([]);
    expect(r).toMatchObject({ zt19: 'PASS', unexplained: 0, validation: { failed: false } });
    expect(Object.fromEntries(r.entities.map((e) => [e.entity, [e.sourceRows, e.excluded, e.expected, e.matched]]))).toEqual({
      masters: [22, 1, 21, 21],
      employee: [13, 1, 12, 12],
      salary: [13, 2, 11, 11],
      leave_opening: [15, 2, 13, 13],
      loan: [4, 1, 3, 3],
    });
    expect(r.money).toEqual([
      { entity: 'leave_opening', field: 'units', category: 'ANNUAL', source: '103.00', target: '103.00', difference: '0.00', matches: true },
      { entity: 'leave_opening', field: 'units', category: 'CASUAL', source: '7.50', target: '7.50', difference: '0.00', matches: true },
      { entity: 'leave_opening', field: 'units', category: 'SICK', source: '6.00', target: '6.00', difference: '0.00', matches: true },
      { entity: 'loan', field: 'amount (ADVANCE)', category: 'INR', source: '10000.00', target: '10000.00', difference: '0.00', matches: true },
      { entity: 'loan', field: 'amount (LOAN)', category: 'INR', source: '170000.00', target: '170000.00', difference: '0.00', matches: true },
      { entity: 'salary', field: 'annualCtc', category: 'INR', source: '23700000.00', target: '23700000.00', difference: '0.00', matches: true },
      { entity: 'salary', field: 'monthlyGross', category: 'INR', source: '1975000.00', target: '1975000.00', difference: '0.00', matches: true },
    ]);
    // Explained differences: confirmations, and loans awaiting their decision, are completed by workflows in the system.
    expect(r.entities.find((e) => e.entity === 'employee')!.followUps).toHaveLength(8);
    expect(r.entities.find((e) => e.entity === 'loan')!.followUps.map((f) => f.key)).toEqual(['LN-2024-001', 'LN-2025-007', 'LN-2026-003']);
    expect(r.exclusions.every((x) => x.approved)).toBe(true);
    // DQ-12: the salary master report (the HR screen's own query) agrees with the records.
    expect(r.dq12.status).toBe('PASS');
    const md = reconcileMarkdown(r);
    expect(md).toContain('**ZT19: PASS**');
    for (const secret of ['Asha', 'example.invalid', 'ZZTEST']) expect(md + JSON.stringify(r)).not.toContain(secret);
  }, 240_000);

  it('ZT19: load is idempotent; a second run commits nothing new and duplicates nothing', async () => {
    const before = await counts();
    const again = await load(base);
    expect(again.ok).toBe(true);
    expect(again.stages.map((s) => s.state)).toEqual(['NOTHING_TO_DO', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED', 'ALREADY_COMMITTED']);
    expect(again.stages.filter((s) => s.jobId).map((s) => s.jobId)).toEqual(first.stages.filter((s) => s.jobId).map((s) => s.jobId));
    expect(await counts()).toEqual(before);
    expect((await reconcile({ db: h.pool, extract: base, companyCode: code })).zt19).toBe('PASS');
  }, 120_000);

  it('ZT19: reconcile reports a source row the load dropped, unless an owner-approved disposition explains it, and a money difference', async () => {
    const dropped = copy();
    dropped.files.set('employees.csv', Buffer.from(`${dropped.files.get('employees.csv')!.toString('utf-8')}L014,Pooja Nair,pooja.nair@example.invalid,05-05-2025,Permanent,Active,SALES,PUN,SALES-EXEC,G1,L010,General,ZZTEST0014,\n`));
    const totals = dropped.manifest.controlTotals!.employee!;
    totals.rows = 14;
    totals.byStatus!.Active = 9;
    totals.byDepartment!.SALES = 5;
    const r = await reconcile({ db: h.pool, extract: dropped, companyCode: code });
    expect(r.zt19).toBe('FAIL');
    expect(r.entities.find((e) => e.entity === 'employee')!.missing).toEqual([{ key: 'L014', source: { file: 'employees.csv', line: 15 }, reason: 'not in the company' }]);
    expect(r.reasons).toEqual(expect.arrayContaining(['employee: 1 missing', 'DQ-12: the report totals differ from the records']));
    expect(reconcileMarkdown(r)).toContain('[L014] employees.csv line 15: not in the company');

    // The same row set aside by an approved disposition is explained: nothing is unexplained.
    dropped.manifest.dispositions = [{ file: 'employees.csv', line: 15, action: 'EXCLUDE', reason: 'Joined after the extract was frozen; entered directly in the new system', approvedBy: 'Sample Data Owner', approvedOn: '2026-11-10' }];
    const explained = await reconcile({ db: h.pool, extract: dropped, companyCode: code });
    expect(explained).toMatchObject({ zt19: 'PASS', unexplained: 0 });
    expect(explained.exclusions.find((x) => x.policy === 'DISPOSITION')).toMatchObject({ key: 'L014', approved: true });

    // A salary that differs from what was loaded is a mismatch and a money difference.
    const changed = copy();
    changed.files.set('salary.csv', Buffer.from(changed.files.get('salary.csv')!.toString('utf-8').replace('L003,02-06-2025,960000.00', 'L003,02-06-2025,960100.00')));
    changed.manifest.controlTotals!.salary!.amounts!.annualCtc!.INR = '25980100.00';
    const m = await reconcile({ db: h.pool, extract: changed, companyCode: code });
    expect(m.zt19).toBe('FAIL');
    expect(m.entities.find((e) => e.entity === 'salary')!.mismatched).toEqual([{ key: 'L003', source: { file: 'salary.csv', line: 4 }, reason: 'annual CTC differs' }]);
    expect(m.money.find((x) => x.entity === 'salary' && x.field === 'annualCtc')).toMatchObject({ source: '23700100.00', target: '23700000.00', difference: '-100.00', matches: false });
  }, 120_000);
});
