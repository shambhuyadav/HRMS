// Reconcile: the extract against what the target company holds after the load (ZT19 "Fixture migration has zero rejected
// unexplained records, zero orphans/duplicates, exact counts and reconciled monetary balances. Every rejected row has
// owner-approved disposition."; DQ-12 report-to-record comparison). Read-only: one read-only transaction, nothing written.
// Records are attributed to the migration by its own provenance (CI16): the import batches under its idempotency-key prefix and
// their accepted rows, the opening-balance reason and the loan purpose marker each migrated record carries.
import type { Database } from '../../apps/api/src/db/transaction.js';
import { SqlParams } from '../../apps/api/src/modules/access/authorize.js';
import { salaryMasterSelect } from '../../apps/api/src/modules/increment/salary-master.js';
import { type Analysis, analyse, type Exclusion, type ExtractInput, LOAN_MARKER, openingReason, type PlannedEmployee, type SourceRef } from './analyse.js';
import { type DqId, MASTER_KINDS } from './model.js';
import { grantFor, OperatorError, resolveOperator } from './operator.js';
import { jobKeyPrefix, likePrefix, readOnly, readTargetFacts } from './target.js';
import { formatScaled, scaledOf } from './values.js';

export interface Discrepancy {
  key: string;
  source?: SourceRef;
  reason: string;
}

export interface EntityReconciliation {
  entity: string;
  /** Data rows of the entity's files in the extract. */
  sourceRows: number;
  /** Rows deliberately not loaded (each with its approved reason, in `exclusions`). */
  excluded: number;
  expected: number;
  /** Expected records found in the target with every compared value equal. */
  matched: number;
  missing: Discrepancy[];
  mismatched: Discrepancy[];
  extra: Discrepancy[];
  duplicates: Discrepancy[];
  orphans: Discrepancy[];
  /** Explained differences that a workflow in the system completes (not failures). */
  followUps: Discrepancy[];
}

export interface MoneyLine {
  entity: string;
  field: string;
  category: string;
  source: string;
  target: string;
  difference: string;
  matches: boolean;
}

export interface ReconcileReport {
  migrationId: string;
  sourceSystem: string;
  companyCode: string;
  cutoverDate: string;
  generatedAt: string;
  validation: { failed: boolean; failedChecks: DqId[] };
  jobs: { id: string; kind: string; template: string; state: string; accepted: number; rejected: number }[];
  entities: EntityReconciliation[];
  money: MoneyLine[];
  exclusions: (Exclusion & { approved: boolean })[];
  dq12: { status: 'PASS' | 'FAIL' | 'MANUAL'; lines: string[] };
  signOffs: { id: DqId; reviewer: string | null; date: string | null }[];
  unexplained: number;
  zt19: 'PASS' | 'FAIL';
  reasons: string[];
}

const blank = (entity: string, sourceRows: number, excluded: number, expected: number): EntityReconciliation => ({
  entity,
  sourceRows,
  excluded,
  expected,
  matched: 0,
  missing: [],
  mismatched: [],
  extra: [],
  duplicates: [],
  orphans: [],
  followUps: [],
});

export async function reconcile(o: { db: Database; extract: ExtractInput; companyCode: string; operator?: string | undefined; now?: Date }): Promise<ReconcileReport> {
  const m = o.extract.manifest;
  return readOnly(o.db, async (tx) => {
    const facts = await readTargetFacts(tx, o.companyCode, m.migrationId);
    const a: Analysis = analyse(o.extract, facts);
    const c = facts.companyId;
    const prefix = likePrefix(jobKeyPrefix(m.migrationId));
    const sourceRows = (entity: string) => a.sources.filter((s) => s.entity === entity).reduce((n, s) => n + s.rows, 0);
    const excludedOf = (entity: string) => a.exclusions.filter((x) => x.entity === entity).length;
    const entities: EntityReconciliation[] = [];
    const money: MoneyLine[] = [];

    const jobs = (
      await tx.query<{ id: string; kind: string; template_code: string; state: string; accepted_count: number; rejected_count: number }>(
        `select id, kind, template_code, state, accepted_count, rejected_count from import_job where company_id = $1 and idempotency_key like $2 order by created_at, id`,
        [c, prefix],
      )
    ).rows;
    const migratedCodes = new Set(
      (
        await tx.query<{ code: string }>(
          `select distinct r.business_key as code from import_row r join import_job j on j.company_id = r.company_id and j.id = r.job_id
            where r.company_id = $1 and j.idempotency_key like $2 and j.kind = 'employee' and j.state = 'COMMITTED' and r.state = 'ACCEPTED'`,
          [c, prefix],
        )
      ).rows.map((r) => r.code),
    );
    const planned = new Map(a.plan.employees.map((e) => [e.code, e]));
    const codes = [...new Set([...planned.keys(), ...migratedCodes])];

    // ------------------------------------------------------------------------------------------ masters
    const mastersRec = blank('masters', MASTER_KINDS.reduce((n, k) => n + sourceRows(k), 0), MASTER_KINDS.reduce((n, k) => n + excludedOf(k), 0), MASTER_KINDS.reduce((n, k) => n + a.plan.masters[k].length, 0));
    for (const kind of MASTER_KINDS) {
      for (const x of a.plan.masters[kind]) {
        const t = (await tx.query<{ name: string; active: boolean }>(`select name, active from ${kind} where company_id = $1 and code = $2`, [c, x.code])).rows[0];
        if (!t) mastersRec.missing.push({ key: `${kind}:${x.code}`, source: x.ref, reason: 'not in the company' });
        else if (!t.active) mastersRec.mismatched.push({ key: `${kind}:${x.code}`, source: x.ref, reason: 'inactive in the company' });
        else {
          mastersRec.matched++;
          if (t.name !== x.name) mastersRec.followUps.push({ key: `${kind}:${x.code}`, source: x.ref, reason: 'the company already had this master under another name, which it keeps' });
        }
      }
    }
    entities.push(mastersRec);

    // ------------------------------------------------------------------------------------------ employees
    const emp = blank('employee', sourceRows('employee'), excludedOf('employee'), a.plan.employees.length);
    type T = { code: string; display_name: string; work_email: string | null; joining_date: string; employment_type: string; status: string; manager: string | null; manager_from: string | null; manager_status: string | null; shift: string | null; shift_from: string | null; open_assignments: number };
    const target = new Map(
      (
        await tx.query<T>(
          `select e.employee_code as code, e.display_name, e.work_email, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, et.code as employment_type, st.code as status,
                  m.manager, m.manager_from, m.manager_status, s.shift, s.shift_from,
                  (select count(*)::int from employment_assignment a where a.company_id = e.company_id and a.employee_id = e.id and a.effective_to is null) as open_assignments
             from employee e
             join reference_value et on et.company_id = e.company_id and et.id = e.employment_type_id
             join reference_value st on st.company_id = e.company_id and st.id = e.status_id
             left join lateral (select me.employee_code as manager, to_char(ma.effective_from, 'YYYY-MM-DD') as manager_from, ms.code as manager_status
                                  from manager_assignment ma join employee me on me.company_id = ma.company_id and me.id = ma.manager_employee_id
                                  join reference_value ms on ms.company_id = me.company_id and ms.id = me.status_id
                                 where ma.company_id = e.company_id and ma.employee_id = e.id and ma.effective_to is null) m on true
             left join lateral (select sh.code as shift, to_char(sa.effective_from, 'YYYY-MM-DD') as shift_from from shift_assignment sa join shift sh on sh.company_id = sa.company_id and sh.id = sa.shift_id
                                 where sa.company_id = e.company_id and sa.employee_id = e.id and sa.effective_to is null) s on true
            where e.company_id = $1 and e.employee_code = any($2::text[])`,
          [c, codes],
        )
      ).rows.map((r) => [r.code, r]),
    );
    const history = new Map<string, { from: string; dept: string; loc: string; desig: string; grade: string }[]>();
    for (const r of (
      await tx.query<{ code: string; from: string; dept: string; loc: string; desig: string; grade: string | null }>(
        `select e.employee_code as code, to_char(a.effective_from, 'YYYY-MM-DD') as from, d.code as dept, l.code as loc, g.code as desig, gr.code as grade
           from employment_assignment a join employee e on e.company_id = a.company_id and e.id = a.employee_id
           join department d on d.company_id = a.company_id and d.id = a.department_id
           join location l on l.company_id = a.company_id and l.id = a.location_id
           join designation g on g.company_id = a.company_id and g.id = a.designation_id
           left join grade gr on gr.company_id = a.company_id and gr.id = a.grade_id
          where a.company_id = $1 and e.employee_code = any($2::text[]) order by a.effective_from`,
        [c, codes],
      )
    ).rows) {
      history.set(r.code, [...(history.get(r.code) ?? []), { from: r.from, dept: r.dept, loc: r.loc, desig: r.desig, grade: r.grade ?? '' }]);
    }
    const compareEmployee = (e: PlannedEmployee, t: T): string[] => {
      const diffs: string[] = [];
      if (t.display_name !== e.displayName) diffs.push('display name differs');
      if ((t.work_email ?? '') !== e.workEmail) diffs.push('work email differs');
      if (t.joining_date !== e.joiningDate) diffs.push(`joining date ${t.joining_date} (source ${e.joiningDate})`);
      if (t.employment_type !== e.employmentType) diffs.push(`employment type ${t.employment_type} (source ${e.employmentType})`);
      const want = [{ from: e.joiningDate, ...e.joining }, ...e.changes.map((x) => ({ ...x, from: x.effectiveFrom }))].map((p) => `${p.from} ${p.departmentCode}/${p.locationCode}/${p.designationCode}/${p.gradeCode}`);
      const got = (history.get(e.code) ?? []).map((p) => `${p.from} ${p.dept}/${p.loc}/${p.desig}/${p.grade}`);
      if (want.join('|') !== got.join('|')) diffs.push(`assignment history ${got.join(', ') || 'none'} (source ${want.join(', ')})`);
      if ((t.manager ?? null) !== e.managerCode) diffs.push(`manager ${t.manager ?? 'none'} (source ${e.managerCode ?? 'none'})`);
      else if (e.managerCode && t.manager_from !== e.managerFrom) diffs.push(`manager from ${t.manager_from} (source ${e.managerFrom})`);
      if ((t.shift ?? null) !== e.shiftCode) diffs.push(`shift ${t.shift ?? 'none'} (source ${e.shiftCode ?? 'none'})`);
      else if (e.shiftCode && t.shift_from !== e.shiftFrom) diffs.push(`shift from ${t.shift_from} (source ${e.shiftFrom})`);
      const loadedAs = e.activate ? 'ACTIVE_PROBATION' : 'DRAFT';
      if (t.status !== loadedAs && t.status !== e.targetStatus) diffs.push(`status ${t.status} (loaded as ${loadedAs}; source ${e.sourceStatus} = ${e.targetStatus})`);
      return diffs;
    };
    for (const e of a.plan.employees) {
      const t = target.get(e.code);
      if (!t) {
        emp.missing.push({ key: e.code, source: e.ref, reason: 'not in the company' });
        continue;
      }
      if (!migratedCodes.has(e.code)) {
        emp.extra.push({ key: e.code, source: e.ref, reason: 'in the company but not created by this migration\'s onboarding batch' });
        continue;
      }
      const diffs = compareEmployee(e, t);
      if (diffs.length) emp.mismatched.push({ key: e.code, source: e.ref, reason: diffs.join('; ') });
      else emp.matched++;
      if (t.status === 'ACTIVE_PROBATION' && e.targetStatus === 'ACTIVE_CONFIRMED') emp.followUps.push({ key: e.code, source: e.ref, reason: `confirmed in ${m.sourceSystem}: record the confirmation through the confirmation workflow (FR-081)` });
      if (t.status === 'ACTIVE_PROBATION' && e.targetStatus === 'NOTICE') emp.followUps.push({ key: e.code, source: e.ref, reason: `serving notice in ${m.sourceSystem}: record the exit through the exit workflow (FR-051)` });
      if (t.open_assignments !== 1) emp.orphans.push({ key: e.code, source: e.ref, reason: `${t.open_assignments} current employment assignments (one expected)` });
      if (t.manager && t.manager_status && !['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'].includes(t.manager_status)) emp.orphans.push({ key: e.code, source: e.ref, reason: `reports to ${t.manager}, who is ${t.manager_status}` });
    }
    for (const code of migratedCodes) if (!planned.has(code)) emp.extra.push({ key: code, reason: 'created by this migration but not a loadable row of the extract' });
    const emails = new Map<string, number>();
    for (const code of migratedCodes) {
      const t = target.get(code);
      if (t?.work_email) emails.set(t.work_email.toLowerCase(), (emails.get(t.work_email.toLowerCase()) ?? 0) + 1);
    }
    for (const [, n] of emails) if (n > 1) emp.duplicates.push({ key: 'work email', reason: `${n} migrated employees share one work email` });
    // Accepted import rows that no longer resolve to an employee of the company.
    for (const r of (
      await tx.query<{ kind: string; key: string }>(
        `select j.kind, r.business_key as key from import_row r join import_job j on j.company_id = r.company_id and j.id = r.job_id
          where r.company_id = $1 and j.idempotency_key like $2 and r.state = 'ACCEPTED'
            and not exists (select 1 from employee e where e.company_id = r.company_id and e.employee_code = split_part(r.business_key, '@', 1))`,
        [c, prefix],
      )
    ).rows) {
      emp.orphans.push({ key: r.key, reason: `accepted ${r.kind} import row names no employee of the company` });
    }
    entities.push(emp);

    // ------------------------------------------------------------------------------------------ salary
    const sal = blank('salary', sourceRows('salary'), excludedOf('salary'), a.plan.salaries.length);
    const arrangements = (
      await tx.query<{ code: string; from: string; annual_ctc: string; monthly_gross: string; currency: string }>(
        `select e.employee_code as code, to_char(sa.effective_from, 'YYYY-MM-DD') as from, sa.annual_ctc::text, sa.monthly_gross::text, sa.currency_code as currency
           from salary_arrangement sa join employee e on e.company_id = sa.company_id and e.id = sa.employee_id
          where sa.company_id = $1 and sa.superseded_at is null and e.employee_code = any($2::text[]) order by sa.effective_from`,
        [c, codes],
      )
    ).rows;
    const sums = new Map<string, { source: bigint; target: bigint }>();
    const sum = (key: string, side: 'source' | 'target', v: bigint) => {
      const s = sums.get(key) ?? { source: 0n, target: 0n };
      s[side] += v;
      sums.set(key, s);
    };
    const salaryCodes = new Set(a.plan.salaries.map((s) => s.employeeCode));
    for (const s of a.plan.salaries) {
      sum(`salary|annualCtc|${s.currency}`, 'source', scaledOf(s.annualCtc));
      sum(`salary|monthlyGross|${s.currency}`, 'source', scaledOf(s.monthlyGross));
      const found = arrangements.filter((t) => t.code === s.employeeCode && t.from === s.effectiveFrom);
      if (found.length > 1) sal.duplicates.push({ key: s.employeeCode, source: s.ref, reason: `${found.length} arrangements start on ${s.effectiveFrom}` });
      const t = found[0];
      if (!t) {
        sal.missing.push({ key: s.employeeCode, source: s.ref, reason: `no salary arrangement from ${s.effectiveFrom}` });
        continue;
      }
      sum(`salary|annualCtc|${t.currency}`, 'target', scaledOf(t.annual_ctc));
      sum(`salary|monthlyGross|${t.currency}`, 'target', scaledOf(t.monthly_gross));
      const diffs = [scaledOf(t.annual_ctc) !== scaledOf(s.annualCtc) ? 'annual CTC differs' : '', scaledOf(t.monthly_gross) !== scaledOf(s.monthlyGross) ? 'monthly gross differs' : '', t.currency !== s.currency ? `currency ${t.currency} (source ${s.currency})` : ''].filter(Boolean);
      if (diffs.length) sal.mismatched.push({ key: s.employeeCode, source: s.ref, reason: diffs.join('; ') });
      else sal.matched++;
    }
    for (const t of arrangements) {
      if (!migratedCodes.has(t.code) && !planned.has(t.code)) continue;
      const own = a.plan.salaries.find((s) => s.employeeCode === t.code);
      if (own && t.from > own.effectiveFrom) continue; // a later change made in the system after the migration
      if (!own || t.from !== own.effectiveFrom) {
        sal.extra.push({ key: t.code, reason: `salary arrangement from ${t.from} is not in the extract${salaryCodes.has(t.code) ? '' : ' (no salary row for this employee)'}` });
        sum(`salary|annualCtc|${t.currency}`, 'target', scaledOf(t.annual_ctc));
        sum(`salary|monthlyGross|${t.currency}`, 'target', scaledOf(t.monthly_gross));
      }
    }
    entities.push(sal);

    // ------------------------------------------------------------------------------------------ leave openings
    const leave = blank('leave_opening', sourceRows('leave_opening'), excludedOf('leave_opening'), a.plan.leaveOpenings.length);
    const reason = openingReason(m.migrationId, m.sourceSystem);
    const openings = (
      await tx.query<{ code: string; type: string; units: string; effective_date: string; reason: string }>(
        `select e.employee_code as code, t.code as type, lm.units::text, to_char(lm.effective_date, 'YYYY-MM-DD') as effective_date, lm.reason
           from leave_movement lm join employee e on e.company_id = lm.company_id and e.id = lm.employee_id
           join leave_type t on t.company_id = lm.company_id and t.id = lm.leave_type_id
          where lm.company_id = $1 and lm.movement_kind = 'OPENING' and e.employee_code = any($2::text[])`,
        [c, codes],
      )
    ).rows;
    for (const l of a.plan.leaveOpenings) {
      sum(`leave_opening|units|${l.leaveType}`, 'source', scaledOf(l.units));
      const found = openings.filter((t) => t.code === l.employeeCode && t.type === l.leaveType);
      if (found.length > 1) leave.duplicates.push({ key: `${l.employeeCode}@${l.leaveType}`, source: l.ref, reason: `${found.length} opening balances` });
      const t = found[0];
      if (!t) {
        leave.missing.push({ key: `${l.employeeCode}@${l.leaveType}`, source: l.ref, reason: 'no opening balance' });
        continue;
      }
      sum(`leave_opening|units|${t.type}`, 'target', scaledOf(t.units));
      const diffs = [scaledOf(t.units) !== scaledOf(l.units) ? `units ${formatScaled(scaledOf(t.units))} (source ${l.units})` : '', t.effective_date !== l.effectiveDate ? `dated ${t.effective_date} (source ${l.effectiveDate})` : '', t.reason !== reason ? 'not recorded by this migration' : ''].filter(Boolean);
      if (diffs.length) leave.mismatched.push({ key: `${l.employeeCode}@${l.leaveType}`, source: l.ref, reason: diffs.join('; ') });
      else leave.matched++;
    }
    for (const t of openings) {
      if (t.reason !== reason || a.plan.leaveOpenings.some((l) => l.employeeCode === t.code && l.leaveType === t.type)) continue;
      leave.extra.push({ key: `${t.code}@${t.type}`, reason: 'opening balance recorded by this migration but not in the extract' });
      sum(`leave_opening|units|${t.type}`, 'target', scaledOf(t.units));
    }
    entities.push(leave);

    // ------------------------------------------------------------------------------------------ loans
    const loans = blank('loan', sourceRows('loan'), excludedOf('loan'), a.plan.loans.length);
    const migratedLoans = (
      await tx.query<{ code: string; loan_kind: string; currency: string; principal: string; purpose: string; state: string }>(
        `select e.employee_code as code, pl.loan_kind, pl.currency_code as currency, pl.principal::text, pl.purpose, pl.state
           from payroll_loan pl join employee e on e.company_id = pl.company_id and e.id = pl.employee_id
          where pl.company_id = $1 and pl.purpose like $2`,
        [c, `%[migration ${m.migrationId.replace(/[\\%_]/g, '\\$&')} loan %`],
      )
    ).rows.map((l) => ({ ...l, reference: LOAN_MARKER.exec(l.purpose)?.[2] ?? '' }));
    for (const l of a.plan.loans) {
      sum(`loan|${l.loanKind}|${l.currency}`, 'source', scaledOf(l.amount));
      const found = migratedLoans.filter((t) => t.reference === l.loanReference);
      if (found.length > 1) loans.duplicates.push({ key: l.loanReference, source: l.ref, reason: `${found.length} loans carry this reference` });
      const t = found[0];
      if (!t) {
        loans.missing.push({ key: l.loanReference, source: l.ref, reason: 'no loan carries this reference' });
        continue;
      }
      sum(`loan|${t.loan_kind}|${t.currency}`, 'target', scaledOf(t.principal));
      const diffs = [t.code !== l.employeeCode ? `employee ${t.code} (source ${l.employeeCode})` : '', t.loan_kind !== l.loanKind ? `kind ${t.loan_kind} (source ${l.loanKind})` : '', t.currency !== l.currency ? `currency ${t.currency} (source ${l.currency})` : '', scaledOf(t.principal) !== scaledOf(l.amount) ? 'amount differs' : ''].filter(Boolean);
      if (diffs.length) loans.mismatched.push({ key: l.loanReference, source: l.ref, reason: diffs.join('; ') });
      else loans.matched++;
      if (t.state === 'REQUESTED' && l.targetStatus !== 'REQUESTED') loans.followUps.push({ key: l.loanReference, source: l.ref, reason: `${l.sourceStatus} in ${m.sourceSystem}: awaits its independent decision${l.targetStatus === 'DISBURSED' ? ' and disbursement evidence' : ''} in the system` });
    }
    for (const t of migratedLoans) {
      if (a.plan.loans.some((l) => l.loanReference === t.reference)) continue;
      loans.extra.push({ key: t.reference, reason: 'loan recorded by this migration but not a loadable row of the extract' });
      sum(`loan|${t.loan_kind}|${t.currency}`, 'target', scaledOf(t.principal));
    }
    entities.push(loans);

    for (const [key, s] of [...sums.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const [entity, field, category] = key.split('|') as [string, string, string];
      money.push({ entity, field: entity === 'loan' ? `amount (${field})` : field, category, source: formatScaled(s.source), target: formatScaled(s.target), difference: formatScaled(s.target - s.source), matches: s.source === s.target });
    }

    // ------------------------------------------------------------------------------------------ DQ-12: the salary master report against the records
    const dq12: ReconcileReport['dq12'] = { status: 'MANUAL', lines: [] };
    const inForce = a.plan.salaries.filter((s) => s.effectiveFrom <= m.cutoverDate);
    if (o.operator) {
      try {
        const op = await resolveOperator(tx, o.companyCode, o.operator);
        const grant = await grantFor(tx, op, [{ resource: 'salary', action: 'read', groups: ['salary'] }]);
        const p = new SqlParams();
        const select = salaryMasterSelect(grant, { from: m.cutoverDate, to: m.cutoverDate }, p);
        const rows = (await tx.query<{ employee_code: string; currency: string; annual_ctc: string; monthly_gross: string }>(`select employee_code, currency, annual_ctc::text, monthly_gross::text from (${select}) x where employee_code = any(${p.add([...migratedCodes])}::text[])`, p.values)).rows;
        const reportTotals = new Map<string, bigint>();
        const sourceTotals = new Map<string, bigint>();
        for (const r of rows) for (const [f, v] of [['annualCtc', r.annual_ctc], ['monthlyGross', r.monthly_gross]] as const) reportTotals.set(`${f} ${r.currency}`, (reportTotals.get(`${f} ${r.currency}`) ?? 0n) + scaledOf(v));
        for (const s of inForce) for (const [f, v] of [['annualCtc', s.annualCtc], ['monthlyGross', s.monthlyGross]] as const) sourceTotals.set(`${f} ${s.currency}`, (sourceTotals.get(`${f} ${s.currency}`) ?? 0n) + scaledOf(v));
        let ok = rows.length === inForce.length;
        dq12.lines.push(`Salary master report on ${m.cutoverDate} (the HR screen's own query, as ${op.accountKey}): ${rows.length} migrated employee row(s); the extract has ${inForce.length} arrangement(s) in force on that date`);
        for (const k of [...new Set([...reportTotals.keys(), ...sourceTotals.keys()])].sort()) {
          const r = reportTotals.get(k) ?? 0n;
          const s = sourceTotals.get(k) ?? 0n;
          ok &&= r === s;
          dq12.lines.push(`${k}: report ${formatScaled(r)}, extract ${formatScaled(s)}${r === s ? '' : ' - DIFFERS'}`);
        }
        dq12.status = ok ? 'PASS' : 'FAIL';
      } catch (err) {
        if (!(err instanceof OperatorError)) throw err;
        dq12.lines.push(`The salary master report could not be run as the operator: ${err.message}`);
      }
    } else dq12.lines.push('Pass --operator (an account holding salary.read) to compare the salary master report with the loaded records');
    const byDepartment = new Map<string, number>();
    for (const e of a.plan.employees) {
      const now = e.changes.length ? e.changes[e.changes.length - 1]! : e.joining;
      byDepartment.set(now.departmentCode, (byDepartment.get(now.departmentCode) ?? 0) + 1);
    }
    const headcount = new Map<string, number>();
    for (const code of migratedCodes) {
      const h = history.get(code);
      const dept = h?.[h.length - 1]?.dept;
      if (dept) headcount.set(dept, (headcount.get(dept) ?? 0) + 1);
    }
    for (const d of [...new Set([...byDepartment.keys(), ...headcount.keys()])].sort()) {
      const same = (byDepartment.get(d) ?? 0) === (headcount.get(d) ?? 0);
      if (!same) dq12.status = 'FAIL';
      dq12.lines.push(`Headcount ${d}: company ${headcount.get(d) ?? 0}, extract ${byDepartment.get(d) ?? 0}${same ? '' : ' - DIFFERS'}`);
    }

    // ------------------------------------------------------------------------------------------ verdict
    const exclusions = a.exclusions.map((x) => ({ ...x, approved: !!x.approvedBy && !!x.approvedOn }));
    const reasons: string[] = [];
    const failedChecks = a.checks.filter((x) => x.status === 'FAIL').map((x) => x.id);
    if (failedChecks.length) reasons.push(`the extract does not validate against the company: ${failedChecks.join(', ')}`);
    let unexplained = 0;
    for (const e of entities) {
      for (const [label, list] of [['missing', e.missing], ['mismatched', e.mismatched], ['extra', e.extra], ['duplicate', e.duplicates], ['orphan', e.orphans]] as const) {
        if (list.length) reasons.push(`${e.entity}: ${list.length} ${label}`);
        unexplained += list.length;
      }
    }
    const unapproved = exclusions.filter((x) => !x.approved).length;
    if (unapproved) reasons.push(`${unapproved} excluded row(s) without an owner-approved disposition`);
    unexplained += unapproved;
    const moneyOff = money.filter((x) => !x.matches);
    if (moneyOff.length) reasons.push(`${moneyOff.length} money total(s) differ`);
    if (dq12.status === 'FAIL') reasons.push('DQ-12: the report totals differ from the records');
    const zt19 = reasons.length === 0 ? 'PASS' : 'FAIL';
    return {
      migrationId: m.migrationId,
      sourceSystem: m.sourceSystem,
      companyCode: facts.companyCode,
      cutoverDate: m.cutoverDate,
      generatedAt: (o.now ?? new Date()).toISOString(),
      validation: { failed: a.failed, failedChecks },
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, template: j.template_code, state: j.state, accepted: j.accepted_count, rejected: j.rejected_count })),
      entities,
      money,
      exclusions,
      dq12,
      signOffs: a.checks.filter((x) => x.status === 'MANUAL').map((x) => ({ id: x.id, reviewer: x.signOff?.reviewer ?? null, date: x.signOff?.date ?? null })),
      unexplained,
      zt19,
      reasons,
    };
  });
}
