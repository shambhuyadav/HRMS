// Data migration toolkit, validate step without a database (BRD §9.4 DQ-01 to DQ-15; CI16). Each automated check is proved by
// seeding one bad row into a copy of the synthetic sample extract (db/data-migration/sample: made-up names, example.invalid
// emails). The database-backed steps (validate against a company, load, reconcile) are in load-reconcile.test.ts.
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Analysis, analyse, type ExtractInput } from './analyse.js';
import { type DqId, ManifestError, parseManifest } from './model.js';
import { readExtract, validationJson, validationMarkdown } from './report.js';

const SAMPLE = fileURLToPath(new URL('./sample', import.meta.url));
let base: ExtractInput;

beforeAll(async () => {
  base = await readExtract(SAMPLE);
});

const copy = (): ExtractInput => ({ manifest: structuredClone(base.manifest), files: new Map(base.files) });
const text = (x: ExtractInput, file: string) => x.files.get(file)!.toString('utf-8');
const setText = (x: ExtractInput, file: string, value: string) => x.files.set(file, Buffer.from(value, 'utf-8'));
/** Replaces spreadsheet line `line` (the header is line 1) of a file. */
const setLine = (x: ExtractInput, file: string, line: number, value: string) => {
  const lines = text(x, file).split('\n');
  lines[line - 1] = value;
  setText(x, file, lines.join('\n'));
};
const appendLine = (x: ExtractInput, file: string, value: string) => setText(x, file, `${text(x, file).replace(/\n$/, '')}\n${value}\n`);
const fails = (a: Analysis, id: DqId) => a.checks.find((c) => c.id === id)!.findings.filter((f) => f.severity === 'FAIL');
const status = (a: Analysis, id: DqId) => a.checks.find((c) => c.id === id)!.status;
const reasons = (a: Analysis, id: DqId) => fails(a, id).map((f) => `${f.file ?? ''}:${f.line ?? ''}:${f.key ?? ''} ${f.reason}`);

describe('data migration validate (DQ-01 to DQ-15)', () => {
  it('DQ-01 to DQ-15: the sample extract has no failure; DQ-01, DQ-08, DQ-12, DQ-14 and DQ-15 are MANUAL sign-off items with a checklist, and a sign-off shows its reviewer', () => {
    const a = analyse(copy());
    expect(a.failed).toBe(false);
    expect(Object.fromEntries(a.checks.map((c) => [c.id, c.status]))).toEqual({
      'DQ-01': 'MANUAL',
      'DQ-02': 'PASS',
      'DQ-03': 'PASS',
      'DQ-04': 'PASS',
      // Shifts live only in the target company: without it they are unverified, never passed.
      'DQ-05': 'MANUAL',
      'DQ-06': 'PASS',
      'DQ-07': 'PASS',
      'DQ-08': 'MANUAL',
      'DQ-09': 'PASS',
      'DQ-10': 'PASS',
      'DQ-11': 'PASS',
      'DQ-12': 'MANUAL',
      'DQ-13': 'PASS',
      'DQ-14': 'MANUAL',
      'DQ-15': 'MANUAL',
    });
    expect(a.checks.find((c) => c.id === 'DQ-05')!.findings.every((f) => f.severity === 'UNVERIFIED' && f.field === 'shiftCode')).toBe(true);
    for (const id of ['DQ-01', 'DQ-08', 'DQ-12', 'DQ-14', 'DQ-15'] as const) {
      const c = a.checks.find((x) => x.id === id)!;
      expect(c.checklist.length, id).toBeGreaterThan(0);
      expect(c.automated.length, id).toBeGreaterThan(0);
      expect(c.signOff).toBeNull();
    }
    // The plan: 12 employees loaded (the resigned one is excluded), 11 activated (one has not joined yet), one salary each but the
    // draft, the arrangement in force at cut-over only, 13 non-zero leave balances, the three open loans at their outstanding amount.
    expect(a.plan.employees.map((e) => e.code)).toHaveLength(12);
    expect(a.plan.employees.filter((e) => e.activate)).toHaveLength(11);
    expect(a.plan.salaries.find((s) => s.employeeCode === 'L004')).toMatchObject({ effectiveFrom: '2025-04-01', annualCtc: '1800000.00' });
    expect(a.plan.salaries).toHaveLength(11);
    expect(a.plan.leaveOpenings).toHaveLength(13);
    expect(a.plan.loans.map((l) => [l.loanReference, l.amount])).toEqual([
      ['LN-2024-001', '90000.00'],
      ['LN-2025-007', '10000.00'],
      ['LN-2026-003', '80000.00'],
    ]);
    expect(a.exclusions.map((x) => x.policy).sort()).toEqual(['CLOSED_LOAN', 'INACTIVE_EMPLOYEE', 'INACTIVE_EMPLOYEE', 'INACTIVE_EMPLOYEE', 'INACTIVE_MASTER', 'SALARY_HISTORY', 'ZERO_LEAVE_BALANCE']);
    expect(a.exclusions.every((x) => x.approvedBy === 'Sample Data Owner')).toBe(true);

    const signed = copy();
    signed.manifest.signOffs = { 'DQ-14': { reviewer: 'Sample Reviewer', date: '2026-11-10', evidence: 'role walkthrough notes' } };
    const b = analyse(signed);
    expect(b.checks.find((c) => c.id === 'DQ-14')).toMatchObject({ status: 'MANUAL', signOff: { reviewer: 'Sample Reviewer', date: '2026-11-10' } });
    expect(validationMarkdown(b, new Date())).toContain('Reviewer: Sample Reviewer  Date: 2026-11-10');
  });

  it('DQ-01: a file that names no record owner fails; each file is listed with its business record, target screen and loading path', () => {
    const x = copy();
    delete x.manifest.files.find((f) => f.file === 'salary.csv')!.owner;
    const a = analyse(x);
    expect(reasons(a, 'DQ-01')).toEqual(['salary.csv:: salary.csv names no record owner']);
    expect(a.checks.find((c) => c.id === 'DQ-01')!.checklist).toEqual(
      expect.arrayContaining(['salary.csv -> Salary arrangement (annual CTC, monthly gross, currency, effective date); screen: Salary master (/salary-master); loaded by SALARY_MASTER_V1; owner: not named']),
    );
  });

  it('DQ-02: an unmapped legacy column, a mapped column missing from the file, an unknown field, an unmapped required field and an undeclared file are reported', () => {
    const x = copy();
    setText(x, 'grades.csv', text(x, 'grades.csv').replace('Grade,Grade Name', 'Grade,Grade Name,Band'));
    const employees = x.manifest.files.find((f) => f.file === 'employees.csv')!;
    employees.columns['Middle Name'] = 'displayName2';
    delete employees.columns.DOJ;
    employees.ignoredColumns = [...(employees.ignoredColumns ?? []), 'DOJ'];
    setText(x, 'payroll_extra.csv', 'a,b\n1,2\n');
    const r = reasons(analyse(x), 'DQ-02');
    expect(r).toEqual(
      expect.arrayContaining([
        expect.stringContaining('column "Band" is neither mapped nor listed in ignoredColumns'),
        expect.stringContaining('"displayName2", which is not a field of employee'),
        expect.stringContaining('mapped column "Middle Name" is not in the file'),
        expect.stringContaining('no column is mapped to joiningDate'),
        expect.stringContaining('payroll_extra.csv is in the extract folder but neither declared'),
      ]),
    );
    const missing = copy();
    missing.files.delete('loans.csv');
    expect(reasons(analyse(missing), 'DQ-02')).toEqual([expect.stringContaining('loans.csv is declared but not in the extract folder')]);
  });

  it('DQ-03: a blank required value fails; work email and shift are required only of employees who will be active', () => {
    const x = copy();
    // L003 (active) without a work email; L012 (yet to join, DRAFT) without email and shift is fine; a salary row without an amount.
    setLine(x, 'employees.csv', 4, 'L003,Kavya Iyer,,02-06-2025,Permanent,Probation,ENGG,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    setLine(x, 'employees.csv', 13, 'L012,Imran Sheikh,,04-01-2027,Permanent,Yet to Join,SALES,PUN,SALES-EXEC,G1,L010,,ZZTEST0012,');
    setLine(x, 'salary.csv', 4, 'L003,02-06-2025,,80000.00,INR');
    const a = analyse(x);
    expect(reasons(a, 'DQ-03')).toEqual(['employees.csv:4:L003 workEmail is required', 'salary.csv:4:L003 annualCtc is required']);
  });

  it('DQ-04: another date pattern, an impossible date, more decimals than the currency allows, a grouped number in the wrong place, a bad flag and a bad employee code are reported', () => {
    const x = copy();
    setLine(x, 'employees.csv', 4, 'L003,Kavya Iyer,kavya.iyer@example.invalid,2025-06-02,Permanent,Probation,ENGG,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    setLine(x, 'salary.csv', 4, 'L003,31-02-2025,960000.005,"8,0000.00",INR');
    setLine(x, 'locations.csv', 3, 'PUN,Pune Office,Maybe');
    appendLine(x, 'leave_balances.csv', 'L005,CL,-1,31-10-2026');
    setLine(x, 'loans.csv', 3, 'LN-2025-007,L007,Salary Advance,INR,30000.00,10000.00,Running,Medical expenses,05-06-2025,extra cell');
    const a = analyse(x);
    expect(reasons(a, 'DQ-04')).toEqual(
      expect.arrayContaining([
        'employees.csv:4:L003 joiningDate is not a date in the declared pattern DD-MM-YYYY',
        'salary.csv:4:L003 effectiveFrom is not a date in the declared pattern DD-MM-YYYY',
        'salary.csv:4:L003 annualCtc has 3 decimals; INR allows 2',
        'salary.csv:4:L003 monthlyGross is not an amount',
        'locations.csv:3:PUN active "Maybe" is not a declared true or false value',
        'leave_balances.csv:17:L005 an opening balance is never negative; record an adjustment after the migration instead',
        'loans.csv:3: the row has 10 cells where the header has 9',
      ]),
    );
    const code = copy();
    setLine(code, 'employees.csv', 4, 'L 003,Kavya Iyer,kavya.iyer@example.invalid,02-06-2025,Permanent,Probation,ENGG,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    expect(reasons(analyse(code), 'DQ-04')).toEqual(['employees.csv:4:L 003 employeeCode is not a valid employee code (letters, digits, "-" or "_", up to 40)']);
    const encoding = copy();
    encoding.files.set('grades.csv', Buffer.from([0x47, 0x72, 0x61, 0x64, 0x65, 0x0a, 0xe9, 0x0a]));
    expect(reasons(analyse(encoding), 'DQ-04')).toEqual(['grades.csv:: grades.csv is not UTF-8 text: save it from Excel as "CSV UTF-8"']);
  });

  it('DQ-05: an unknown employment type and loan kind fail; a department or leave type that only the company could hold is unverified offline, never passed', () => {
    const x = copy();
    setLine(x, 'employees.csv', 4, 'L003,Kavya Iyer,kavya.iyer@example.invalid,02-06-2025,Freelance,Probation,RND,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    setLine(x, 'leave_balances.csv', 6, 'L003,ML,4,31-10-2026');
    setLine(x, 'loans.csv', 3, 'LN-2025-007,L007,Festival Advance,INR,30000.00,10000.00,Running,Medical expenses,05-06-2025');
    const a = analyse(x);
    expect(reasons(a, 'DQ-05')).toEqual([
      'employees.csv:4:L003 employmentType "Freelance" is not a known employmentType and has no entry in codeMaps.employmentType',
      'loans.csv:3:LN-2025-007 loanKind "Festival Advance" is not a known loanKind and has no entry in codeMaps.loanKind',
    ]);
    const unverified = a.checks.find((c) => c.id === 'DQ-05')!.findings.filter((f) => f.severity === 'UNVERIFIED' && f.field !== 'shiftCode');
    expect(unverified.map((f) => [f.key, f.field])).toEqual([
      ['L003', 'departmentCode'],
      ['L003', 'leaveType'],
    ]);
    // Referencing a master the extract marks inactive is a failure.
    const inactive = copy();
    setLine(inactive, 'employees.csv', 4, 'L003,Kavya Iyer,kavya.iyer@example.invalid,02-06-2025,Permanent,Probation,OPS-OLD,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    expect(reasons(analyse(inactive), 'DQ-05')).toEqual(['employees.csv:4:L003 department OPS is inactive in the extract\'s department file, so it is not created']);
  });

  it('DQ-06: an unknown manager, a reporting cycle, a manager who will not be active and rows for an employee not in the file fail', () => {
    const x = copy();
    // L002 reports to L003, who reports to L002: a cycle. L007 reports to the draft L012. A salary and a loan for L099.
    setLine(x, 'employees.csv', 3, 'L002,Rohit Menon,rohit.menon@example.invalid,15-01-2024,Permanent,Active,ENGG,MUM,ENG-MGR,G3,L003,General,ZZTEST0002,');
    setLine(x, 'employees.csv', 8, 'L007,Sana Kapadia,sana.kapadia@example.invalid,17-03-2025,Contract,Active,HRD,MUM,HR-EXEC,G1,L012,General,ZZTEST0007,');
    setLine(x, 'employees.csv', 9, 'L008,Vivek Rao,vivek.rao@example.invalid,11-09-2023,Permanent,Active,FINC,MUM,FIN-MGR,G3,L777,General,ZZTEST0008,');
    appendLine(x, 'salary.csv', 'L099,01-01-2025,100000.00,8000.00,INR');
    const r = reasons(analyse(x), 'DQ-06');
    expect(r).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/reporting lines form a cycle: L00[23] -> L00[23] -> L00[23]/),
        'employees.csv:8:L007 manager L012 will not be active in the target (DRAFT); a manager must be active',
        'employees.csv:9:L008 manager L777 is not in the employee file',
        'salary.csv:15:L099 employee L099 is not in the employee file',
      ]),
    );
    const top = copy();
    delete top.manifest.policies!.noManagerReason;
    expect(reasons(analyse(top), 'DQ-06')).toEqual(['employees.csv:2:L001 has no manager; activation needs policies.noManagerReason for the top of the reporting chain']);
  });

  it('DQ-07: an unmapped employee or loan status label, a status mapped to no state and an active employee who joins after cut-over fail', () => {
    const x = copy();
    setLine(x, 'employees.csv', 4, 'L003,Kavya Iyer,kavya.iyer@example.invalid,02-06-2025,Permanent,On Leave,ENGG,MUM,SW-ENG,G1,L002,General,ZZTEST0003,');
    setLine(x, 'employees.csv', 6, 'L005,Meenal Joshi,meenal.joshi@example.invalid,01-12-2026,Trainee,Probation,ENGG,PUN,SW-ENG,G1,L002,General,ZZTEST0005,');
    setLine(x, 'loans.csv', 2, 'LN-2024-001,L004,Personal Loan,INR,"1,50,000.00","90,000.00",Frozen,Home repairs,10-12-2024');
    x.manifest.statusMaps!.employee!['Notice Period'] = 'SERVING_NOTICE';
    setLine(x, 'employees.csv', 7, 'L006,Tarun Bhatia,tarun.bhatia@example.invalid,01-11-2023,Permanent,Notice Period,HRD,MUM,HR-MGR,G3,L001,General,ZZTEST0006,');
    const r = reasons(analyse(x), 'DQ-07');
    expect(r).toEqual(
      expect.arrayContaining([
        'employees.csv:4:L003 status "On Leave" has no entry in statusMaps.employee',
        'employees.csv:6:L005 status "Probation" is active but the employee joins after the cut-over date 2026-10-31; map a not-yet-joined status to DRAFT',
        'employees.csv:7:L006 status "Notice Period" maps to SERVING_NOTICE, which is not an employee status (DRAFT, ACTIVE_PROBATION, ACTIVE_CONFIRMED, NOTICE, INACTIVE_SEPARATED, ARCHIVED)',
        'loans.csv:2:LN-2024-001 loan status "Frozen" has no entry in statusMaps.loan',
      ]),
    );
  });

  it('DQ-09: rows excluded without a declared, approved policy fail, and a row disposition needs its approver', () => {
    const x = copy();
    delete x.manifest.exclusionPolicies!.INACTIVE_EMPLOYEE;
    x.manifest.exclusionPolicies!.CLOSED_LOAN = { reason: 'Closed loans stay archived', approvedBy: '', approvedOn: '2026-11-09' };
    x.manifest.dispositions = [{ file: 'loans.csv', line: 3, action: 'EXCLUDE', reason: 'Disputed balance, settled outside the system', approvedBy: 'Sample Data Owner', approvedOn: 'soon' }];
    const a = analyse(x);
    expect(reasons(a, 'DQ-09')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('3 row(s) fall under INACTIVE_EMPLOYEE but exclusionPolicies.INACTIVE_EMPLOYEE is not declared'),
        'employees.csv:14:L013 not loaded (INACTIVE_EMPLOYEE) without an approved policy',
        expect.stringContaining('1 row(s) fall under CLOSED_LOAN'),
        'loans.csv:3:LN-2025-007 the disposition needs a reason, approvedBy and approvedOn (YYYY-MM-DD)',
      ]),
    );
    const unknownLine = copy();
    unknownLine.manifest.dispositions = [{ file: 'loans.csv', line: 40, action: 'EXCLUDE', reason: 'x', approvedBy: 'Sample Data Owner', approvedOn: '2026-11-09' }];
    expect(reasons(analyse(unknownLine), 'DQ-09')).toEqual(['loans.csv:: a disposition names line 40 of loans.csv, which is not a data row of the extract']);
    // An approved disposition sets the row aside with its approval, before any other check.
    const ok = copy();
    ok.manifest.dispositions = [{ file: 'loans.csv', line: 3, action: 'EXCLUDE', reason: 'Disputed balance, settled outside the system', approvedBy: 'Sample Data Owner', approvedOn: '2026-11-09' }];
    const b = analyse(ok);
    expect(b.failed).toBe(false);
    expect(b.plan.loans.map((l) => l.loanReference)).toEqual(['LN-2024-001', 'LN-2026-003']);
    expect(b.exclusions.find((e) => e.policy === 'DISPOSITION')).toMatchObject({ key: 'LN-2025-007', approvedBy: 'Sample Data Owner' });
  });

  it('DQ-10: repeated employee codes, work emails, identity numbers, loan references and leave types are reported without echoing the values', () => {
    const x = copy();
    setLine(x, 'employees.csv', 4, 'l002,Kavya Iyer,kavya.iyer@example.invalid,02-06-2025,Permanent,Probation,ENGG,MUM,SW-ENG,G1,L001,General,ZZTEST0003,');
    setLine(x, 'employees.csv', 6, 'L005,Meenal Joshi,ASHA.VARGHESE@example.invalid,01-09-2025,Trainee,Probation,ENGG,PUN,SW-ENG,G1,L002,General,zz-test 0004,');
    setLine(x, 'loans.csv', 3, 'LN-2024-001,L007,Salary Advance,INR,30000.00,10000.00,Running,Medical expenses,05-06-2025');
    appendLine(x, 'leave_balances.csv', 'L011,PL,2,31-10-2026');
    const a = analyse(x);
    const r = reasons(a, 'DQ-10');
    expect(r).toEqual(
      expect.arrayContaining([
        'employees.csv:4:L002 employee code L002 is repeated (first at line 3)',
        'employees.csv:6:L005 work email repeats the one of L001 (line 2)',
        'employees.csv:6:L005 identity number repeats the one of L004 (line 5)',
        'loans.csv:3:LN-2024-001 loan reference LN-2024-001 is repeated (line 2)',
        'leave_balances.csv:17:L011 a second opening balance for ANNUAL (line 15)',
      ]),
    );
    const report = JSON.stringify(validationJson(a)) + validationMarkdown(a, new Date());
    expect(report).not.toMatch(/asha\.varghese|ZZTEST|zz-test/i);
  });

  it('DQ-11: control totals that differ from the extract, a missing control total, an unclassified amount and no loan basis fail', () => {
    const x = copy();
    x.manifest.controlTotals!.employee!.rows = 14;
    x.manifest.controlTotals!.salary!.amounts!.annualCtc!.INR = '25980000.01';
    x.manifest.controlTotals!.leave_opening!.amounts!.units!.PL = '109.5';
    delete x.manifest.controlTotals!.grade;
    delete x.manifest.amountClassification!['loan.outstanding'];
    delete x.manifest.policies!.loanAmountBasis;
    const r = reasons(analyse(x), 'DQ-11');
    expect(r).toEqual(
      expect.arrayContaining([
        ':: employee: the extract has 13 row(s) where the old system reported 14',
        ':: salary annualCtc total for INR: the extract has 25980000.00 where the old system reported 25980000.01',
        ':: leave_opening units total for PL: the extract has 110.00 where the old system reported 109.5',
        expect.stringContaining('no control total is recorded for grade'),
        expect.stringContaining('amountClassification["loan.outstanding"]'),
        ':: policies.loanAmountBasis must say whether a loan is carried over at its PRINCIPAL or its OUTSTANDING amount',
      ]),
    );
  });

  it('DQ-13: an overlapping history, one that does not start at joining, a salary before joining and a revision after cut-over fail', () => {
    const x = copy();
    setLine(x, 'assignment_history.csv', 3, 'L004,19-08-2024,ENGG,PUN,SR-ENG,G2');
    setLine(x, 'assignment_history.csv', 4, 'L009,01-06-2024,FINC,PUN,ACCT,G2');
    setLine(x, 'salary.csv', 4, 'L003,01-01-2025,960000.00,80000.00,INR');
    appendLine(x, 'salary.csv', 'L010,01-04-2027,2900000.00,241666.67,INR');
    const r = reasons(analyse(x), 'DQ-13');
    expect(r).toEqual(
      expect.arrayContaining([
        expect.stringContaining('two placements start on 2024-08-19'),
        'assignment_history.csv:4:L009 the assignment history starts on 2024-06-01, not on the joining date 2024-05-06',
        'salary.csv:4:L003 salary effective 2025-01-01 is before joining',
        'salary.csv:15:L010 a salary revision from 2027-04-01 is after the cut-over date; it goes through an increment case, not the salary master upload',
      ]),
    );
    const noChange = copy();
    setLine(noChange, 'assignment_history.csv', 3, 'L004,01-04-2025,ENGG,PUN,SW-ENG,G1');
    expect(reasons(analyse(noChange), 'DQ-13')).toEqual(
      expect.arrayContaining([expect.stringContaining('does not change anything from line 2'), expect.stringContaining('differs from the employee file\'s placement')]),
    );
  });

  it('CI16: the validation report names rows by file, line and code and carries no name, email, identity number or personal amount', () => {
    const a = analyse(copy());
    const report = JSON.stringify(validationJson(a)) + validationMarkdown(a, new Date());
    for (const secret of ['Asha', 'Varghese', 'example.invalid', 'ZZTEST', '+00 0000', 'Home repairs', '1800000']) expect(report).not.toContain(secret);
    expect(report).toContain('employees.csv line 14');
  });

  it('refuses a manifest it cannot read, naming each problem', () => {
    expect(() => parseManifest({ manifestVersion: 2, files: [], statusMap: {} })).toThrow(ManifestError);
    const problems = (() => {
      try {
        parseManifest({ manifestVersion: 1, migrationId: 'bad id', sourceSystem: 'X', cutoverDate: '31-10-2026', formats: { date: 'DD-MM-YYYY' }, files: [{ file: 'a.csv', entity: 'payslip', columns: {} }] });
        return [];
      } catch (err) {
        return (err as ManifestError).problems;
      }
    })();
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('migrationId'), expect.stringContaining('cutoverDate'), expect.stringContaining('files[0].entity')]));
    expect(parseManifest(base.manifest)).toBe(base.manifest);
  });
});
