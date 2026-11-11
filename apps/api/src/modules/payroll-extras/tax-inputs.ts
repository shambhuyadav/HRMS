// Perquisites (CL-085 "Upload Perquisites") and past salary (CL-084 "Upload Past Salary", CL-119), recorded inputs for the income-tax
// projection (FR-039, I-90). Built 11 Nov 2026 from the reference system's upload screens; decided under owner delegation, 6 Nov 2026.
//
// PERQUISITES_V1 (employeeCode, month, perquisiteType, value): the taxable value of a perquisite of the employee for a month (YYYY-MM),
// by a type code the company uses (for example RENT_FREE_ACCOMMODATION); no list of types is configured, so any code is accepted.
// PAST_SALARY_V1 (employeeCode, financialYear, source, fromMonth, toMonth, taxableSalary, tdsDeducted): salary and tax deducted this
// financial year before this payroll ran here (BEFORE_GO_LIVE) or by an earlier employer (PREVIOUS_EMPLOYER), over the months given.
//
// Both are append-only (0270): the same key uploaded again (employee, month and type; employee, year and source) is a new revision that
// supersedes the earlier one, which stays on record; the preview shows the value it replaces. Rows are applied under the caller's row
// scope, never for their own record, only for employees who joined by the month (or, for an earlier employer, whose months end by the
// month of joining), and never for a month that has not started. A BEFORE_GO_LIVE period may not overlap the employee's processed
// (PROCESSED_LOCKED) payroll, which the projection already counts.
//
// What they do not do (yet): the TDS projection (statutory/evaluate.ts tdsValuations, and its settlement and Form 16 counterparts)
// reads the employee's processed payroll, the salary arrangement and the accepted tax declaration (Form 12B categories
// PREV_EMPLOYER_SALARY / PREV_EMPLOYER_TDS) only. It has no input hook for recorded perquisites or past salary, so these are stored and
// shown with tdsProjection NOT_FED and change no tax. Feeding them needs a change to the projection's inputs (not its arithmetic),
// reported to the owner with this batch.
import type pg from 'pg';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { markRepeats, parseTemplate, RowError, type Template } from '../imports/batch.js';
import type { BatchSpec } from '../imports/jobs.js';
import { AMOUNT, fiscalYearBounds, fiscalYearOfMonth, MONTH, requireFiscalYear } from './common.js';

export const TDS_PROJECTION_NOTICE = {
  status: 'NOT_FED',
  reason:
    'Recorded for the tax computation, which does not read them yet: the TDS projection counts processed payroll, the salary arrangement and the accepted tax declaration (Form 12B) only. These values change no tax until it does.',
} as const;

const TYPE = /^[A-Z][A-Z0-9_]{0,39}$/;
export const PAST_SALARY_SOURCES = ['BEFORE_GO_LIVE', 'PREVIOUS_EMPLOYER'] as const;

/** The employee a row names, in the caller's scope and never their own; the month of joining is returned for the row checks. */
async function rowEmployee(client: Queryable, grant: AccessGrant, code: string): Promise<{ id: string; joiningMonth: string }> {
  const e = (
    await client.query<{ id: string; joining_month: string; draft: boolean }>(
      `select e.id, to_char(e.joining_date, 'YYYY-MM') as joining_month, st.code = 'DRAFT' as draft
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.employee_code = $2`,
      [grant.companyId, code.toUpperCase()],
    )
  ).rows[0];
  if (!e || e.draft) throw new RowError('UNKNOWN_EMPLOYEE');
  // Nothing about an employee outside the row scope is read; nobody records their own tax inputs.
  if (!(await canAccessEmployee(client, grant, e.id))) throw new RowError('OUT_OF_SCOPE');
  const own =
    grant.linkedEmployeeId === e.id ||
    ((await client.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [grant.companyId, grant.userId, e.id])).rowCount ?? 0) > 0;
  if (own) throw new RowError('OWN_RECORD');
  return { id: e.id, joiningMonth: e.joining_month };
}

// ---------------------------------------------------------------------------------------------------------------
// PERQUISITES_V1
// ---------------------------------------------------------------------------------------------------------------
const PERQ_COLUMNS = ['employeeCode', 'month', 'perquisiteType', 'value'] as const;
type PerqColumn = (typeof PERQ_COLUMNS)[number];
export const PERQUISITES_TEMPLATE: Template<PerqColumn> = { code: 'PERQUISITES_V1', columns: PERQ_COLUMNS };
const perqKey = (row: Record<PerqColumn, string>) => `${row.employeeCode.toUpperCase()}@${row.month}@${row.perquisiteType.toUpperCase()}`;

export function perquisiteSpec(jobId: string | null): BatchSpec<PerqColumn> {
  return {
    kind: 'payroll_perquisite',
    template: PERQUISITES_TEMPLATE,
    parse: (bytes) => markRepeats(parseTemplate(bytes, PERQUISITES_TEMPLATE), perqKey, 'DUPLICATE_IN_BATCH'),
    keyOf: (row, n) => (row.employeeCode ? perqKey(row) : `ROW-${n}`),
    async apply(client: pg.PoolClient, grant: AccessGrant, row) {
      if (!MONTH.test(row.month)) throw new RowError('INVALID_MONTH');
      if (row.month > grant.businessDate.slice(0, 7)) throw new RowError('FUTURE_MONTH');
      const type = row.perquisiteType.toUpperCase();
      if (!TYPE.test(type)) throw new RowError('INVALID_PERQUISITE_TYPE');
      if (!AMOUNT.test(row.value)) throw new RowError('INVALID_VALUE');
      const e = await rowEmployee(client, grant, row.employeeCode);
      if (row.month < e.joiningMonth) throw new RowError('NOT_EMPLOYED_IN_MONTH');
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_perquisite:${grant.companyId}:${e.id}:${row.month}:${type}`]);
      const prior = (
        await client.query<{ revision: number; value: string }>(
          `select revision, value::text as value from payroll_perquisite where company_id = $1 and employee_id = $2 and month = ($3 || '-01')::date and perquisite_type = $4
            order by revision desc limit 1`,
          [grant.companyId, e.id, row.month, type],
        )
      ).rows[0];
      await client.query(
        `insert into payroll_perquisite (company_id, employee_id, month, perquisite_type, value, revision, import_job_id, created_by, acting_assignment_id)
         values ($1, $2, ($3 || '-01')::date, $4, $5, $6, $7, $8, $9)`,
        [grant.companyId, e.id, row.month, type, row.value, (prior?.revision ?? 0) + 1, jobId, grant.userId, grant.assignmentId],
      );
      return { value: { from: prior?.value ?? null, to: Number(row.value).toFixed(2) } };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// PAST_SALARY_V1
// ---------------------------------------------------------------------------------------------------------------
const PAST_COLUMNS = ['employeeCode', 'financialYear', 'source', 'fromMonth', 'toMonth', 'taxableSalary', 'tdsDeducted'] as const;
type PastColumn = (typeof PAST_COLUMNS)[number];
export const PAST_SALARY_TEMPLATE: Template<PastColumn> = { code: 'PAST_SALARY_V1', columns: PAST_COLUMNS };
const pastKey = (row: Record<PastColumn, string>) => `${row.employeeCode.toUpperCase()}@${row.financialYear}@${row.source.toUpperCase()}`;

export function pastSalarySpec(jobId: string | null): BatchSpec<PastColumn> {
  return {
    kind: 'payroll_past_salary',
    template: PAST_SALARY_TEMPLATE,
    parse: (bytes) => markRepeats(parseTemplate(bytes, PAST_SALARY_TEMPLATE), pastKey, 'DUPLICATE_IN_BATCH'),
    keyOf: (row, n) => (row.employeeCode ? pastKey(row) : `ROW-${n}`),
    async apply(client: pg.PoolClient, grant: AccessGrant, row) {
      const fy = fiscalYearBounds(row.financialYear);
      if (!fy) throw new RowError('INVALID_FISCAL_YEAR');
      const source = row.source.toUpperCase() as (typeof PAST_SALARY_SOURCES)[number];
      if (!PAST_SALARY_SOURCES.includes(source)) throw new RowError('INVALID_SOURCE');
      if (!MONTH.test(row.fromMonth) || !MONTH.test(row.toMonth) || row.fromMonth > row.toMonth) throw new RowError('INVALID_MONTHS');
      if (fiscalYearOfMonth(row.fromMonth) !== row.financialYear || fiscalYearOfMonth(row.toMonth) !== row.financialYear) throw new RowError('MONTHS_OUTSIDE_YEAR');
      if (row.toMonth > grant.businessDate.slice(0, 7)) throw new RowError('FUTURE_MONTH');
      if (!AMOUNT.test(row.taxableSalary) || !AMOUNT.test(row.tdsDeducted)) throw new RowError('INVALID_AMOUNT');
      const e = await rowEmployee(client, grant, row.employeeCode);
      if (source === 'BEFORE_GO_LIVE') {
        if (row.fromMonth < e.joiningMonth) throw new RowError('NOT_EMPLOYED_IN_MONTH');
        // The projection already counts processed payroll: a pre-go-live period may not overlap it.
        const overlap = await client.query(
          `select 1 from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id and ru.state = 'PROCESSED_LOCKED'
            where r.company_id = $1 and r.employee_id = $2 and r.calculation_status = 'CALCULATED'
              and ru.service_start <= ($4 || '-01')::date + interval '1 month' - interval '1 day' and ru.service_end >= ($3 || '-01')::date limit 1`,
          [grant.companyId, e.id, row.fromMonth, row.toMonth],
        );
        if (overlap.rowCount) throw new RowError('OVERLAPS_PROCESSED_PAYROLL');
      } else if (row.toMonth > e.joiningMonth) {
        // An earlier employer's months end by the month this employment began.
        throw new RowError('AFTER_JOINING');
      }
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_past_salary:${grant.companyId}:${e.id}:${row.financialYear}:${source}`]);
      const prior = (
        await client.query<{ revision: number; taxable: string; tds: string }>(
          `select revision, taxable_salary::text as taxable, tds_deducted::text as tds from payroll_past_salary
            where company_id = $1 and employee_id = $2 and fiscal_year = $3 and source = $4 order by revision desc limit 1`,
          [grant.companyId, e.id, row.financialYear, source],
        )
      ).rows[0];
      await client.query(
        `insert into payroll_past_salary (company_id, employee_id, fiscal_year, source, from_month, to_month, taxable_salary, tds_deducted, revision, import_job_id, created_by, acting_assignment_id)
         values ($1, $2, $3, $4, ($5 || '-01')::date, ($6 || '-01')::date, $7, $8, $9, $10, $11, $12)`,
        [grant.companyId, e.id, row.financialYear, source, row.fromMonth, row.toMonth, row.taxableSalary, row.tdsDeducted, (prior?.revision ?? 0) + 1, jobId, grant.userId, grant.assignmentId],
      );
      return {
        taxableSalary: { from: prior?.taxable ?? null, to: Number(row.taxableSalary).toFixed(2) },
        tdsDeducted: { from: prior?.tds ?? null, to: Number(row.tdsDeducted).toFixed(2) },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The view: what is recorded for a financial year
// ---------------------------------------------------------------------------------------------------------------
/**
 * The recorded perquisites (current revision per employee, month and type) and past salary (current revision per employee and source)
 * of a financial year, for the employees in the caller's row scope (never their own), by employee code; `search` narrows by code or name.
 */
export async function listTaxInputs(db: Queryable, grant: AccessGrant, q: { fiscalYear: string; search?: string | undefined; employeeId?: string | undefined }) {
  const fy = requireFiscalYear(q.fiscalYear);
  const p = new SqlParams([grant.companyId, fy.from, fy.to, q.fiscalYear]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const own = `not exists (select 1 from user_employee_link u where u.company_id = e.company_id and u.user_id = ${p.add(grant.userId)}::uuid and u.employee_id = e.id)`;
  let search = '';
  if (q.search?.trim()) {
    const pattern = p.add(`%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    search = `and (e.employee_code ilike ${pattern} or e.display_name ilike ${pattern})`;
  }
  const one = q.employeeId ? `and e.id = ${p.add(q.employeeId)}::uuid` : '';
  // Both queries share the parameters; each names the year's bounds and label, typed, so no parameter is left without a type.
  const where = `e.company_id = $1 and ${scope} and ${own} ${search} ${one} and $2::date <= $3::date and $4::text is not null`;
  const perquisites = (
    await db.query<{ employee_id: string; employee_code: string; display_name: string; month: string; type: string; value: string; revision: number; recorded_at: Date }>(
      `select e.id as employee_id, e.employee_code, e.display_name, to_char(x.month, 'YYYY-MM') as month, x.perquisite_type as type, x.value::text as value, x.revision, x.created_at as recorded_at
         from employee e
         join lateral (select distinct on (q.month, q.perquisite_type) q.* from payroll_perquisite q
                        where q.company_id = e.company_id and q.employee_id = e.id and q.month between $2::date and $3::date
                        order by q.month, q.perquisite_type, q.revision desc) x on true
        where ${where}
        order by e.employee_code, x.month, x.perquisite_type`,
      p.values,
    )
  ).rows;
  const past = (
    await db.query<{ employee_id: string; employee_code: string; display_name: string; source: string; from_month: string; to_month: string; taxable: string; tds: string; revision: number; recorded_at: Date }>(
      `select e.id as employee_id, e.employee_code, e.display_name, x.source, to_char(x.from_month, 'YYYY-MM') as from_month, to_char(x.to_month, 'YYYY-MM') as to_month,
              x.taxable_salary::text as taxable, x.tds_deducted::text as tds, x.revision, x.created_at as recorded_at
         from employee e
         join lateral (select distinct on (s.source) s.* from payroll_past_salary s
                        where s.company_id = e.company_id and s.employee_id = e.id and s.fiscal_year = $4
                        order by s.source, s.revision desc) x on true
        where ${where}
        order by e.employee_code, x.source`,
      p.values,
    )
  ).rows;
  const byEmployee = new Map<string, { employeeId: string; employeeCode: string; employeeName: string; perquisites: unknown[]; pastSalary: unknown[] }>();
  const entry = (r: { employee_id: string; employee_code: string; display_name: string }) => {
    let item = byEmployee.get(r.employee_id);
    if (!item) {
      item = { employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.display_name, perquisites: [], pastSalary: [] };
      byEmployee.set(r.employee_id, item);
    }
    return item;
  };
  for (const r of perquisites) entry(r).perquisites.push({ month: r.month, perquisiteType: r.type, value: r.value, revision: r.revision, recordedAt: r.recorded_at });
  for (const r of past) entry(r).pastSalary.push({ source: r.source, fromMonth: r.from_month, toMonth: r.to_month, taxableSalary: r.taxable, tdsDeducted: r.tds, revision: r.revision, recordedAt: r.recorded_at });
  return {
    fiscalYear: q.fiscalYear,
    tdsProjection: TDS_PROJECTION_NOTICE,
    items: [...byEmployee.values()].sort((a, b) => a.employeeCode.localeCompare(b.employeeCode)),
  };
}

/** A 422 for a financial year label that is not one (the routes' query check). */
export function assertFiscalYear(label: string): void {
  if (!fiscalYearBounds(label)) throw new HttpError(422, 'INVALID_FISCAL_YEAR', 'A financial year looks like 2026-27');
}
