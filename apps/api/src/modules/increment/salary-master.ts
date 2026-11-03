// FR-029 Employee salary master (E08; CL-075, CL-110, CL-204-CL-210; DB034; BR-011; DF02; DF09; FR-056; FR-064; I-13;
// I-21): the salary master list with the filters E08 names, and the salary master upload. The salary and annual
// salary exports are report catalogue entries (report/catalogue.ts SALARY_MASTER, ANNUAL_SALARY) built on the same row
// predicate as the list (salaryMasterSelect), so an export holds exactly the rows its list shows.
//
// List (GET /salary-master), under the salary read grant and the salary field group like GET /employees/:id/salary:
// the salary arrangements of the employees in the caller's row scope in force on one day (`date`, by default the
// company's business date) or at any time in one calendar month (`month`: an employee whose salary changed in that
// month has one row per arrangement), with E08's employee search and status filters; paged 25/50/100 with the total
// (FR-056). E08's company filter is the selected assignment's company. Columns follow the E08 grid: annual CTC, monthly
// gross, grade and effective date. Not built: estimated in-hand (BR-011 leaves its calculation open, so it is never
// computed) and the CTC category filter (E08 names it, the BRD defines no category).
//
// Upload (template SALARY_MASTER_V1: employeeCode,effectiveFrom,annualCtc,monthlyGross,currency): each row records an
// employee's initial salary arrangement through the service function of POST /employees/:id/salary, under the same
// salary.manage grant and salary field group, so a row passes exactly when that request would: the same cell patterns,
// the employee within the caller's row scope, and no arrangement on record yet (SALARY_EXISTS: a recorded salary
// changes only through an increment case decided by an independent Admin, DF15). Like that route, a row applies
// without a separate approval. One row per employee; the batch is all-or-nothing (I-13) and follows the shared import
// lifecycle (preview, commit or cancel, the submitter's own batches, the malware-scan hold, the published template).
// Amounts are never stored on the import rows; only the employee code is (the row's business key).
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/queryable.js';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { employeeFilterConditions } from '../employee/service.js';
import { isCalendarDate, markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { createInitialSalary, CURRENCY_PATTERN, MONEY_PATTERN } from './service.js';

// ---------------------------------------------------------------------------------------------------------------
// Rows: the list and the exports
// ---------------------------------------------------------------------------------------------------------------

/** The rows' effective period (inclusive dates) and E08's employee search and status filters. */
export interface SalaryMasterFilters {
  from: string;
  to: string;
  search?: string | undefined;
  status?: string | undefined;
}

/** One calendar month (YYYY-MM) as its first and last day. */
export function monthPeriod(month: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** FR-029 "export reflects the selected effective month": a salary export covers one day or one calendar month exactly. */
export function requireDayOrMonth(f: { from?: string | undefined; to?: string | undefined }): void {
  if (!f.from || !f.to || f.from === f.to) return;
  const month = monthPeriod(f.from.slice(0, 7));
  if (f.from === month.from && f.to === month.to) return;
  throw new HttpError(422, 'DAY_OR_MONTH_REQUIRED', 'This export covers one day or one calendar month (its first to its last day)');
}

/**
 * The salary master rows: every salary arrangement in force at any time from `from` to `to` of an employee in the
 * caller's row scope, narrowed by the employee list's own search and status predicates (FR-007). An arrangement is in
 * force from its effective date until the day the next one starts (effective_to is exclusive). The grade is the
 * employee's grade on the last day of the period that arrangement was in force. Amounts are returned as stored.
 */
export function salaryMasterSelect(grant: AccessGrant, f: SalaryMasterFilters, p: SqlParams): string {
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const filters = employeeFilterConditions(p, { search: f.search, status: f.status })
    .map((c) => ` and ${c}`)
    .join('');
  const from = `${p.add(f.from)}::date`;
  const to = `${p.add(f.to)}::date`;
  const lastDay = `least(${to}, coalesce(sa.effective_to - 1, ${to}))`;
  return `select e.id as employee_id, e.employee_code, e.display_name, st.code as status, gr.name as grade,
                 to_char(sa.effective_from, 'YYYY-MM-DD') as effective_from, to_char(sa.effective_to, 'YYYY-MM-DD') as effective_to,
                 sa.currency_code as currency, sa.annual_ctc, sa.monthly_gross
            from salary_arrangement sa
            join employee e on e.company_id = sa.company_id and e.id = sa.employee_id
            join reference_value st on st.company_id = e.company_id and st.id = e.status_id
            left join lateral (select g.name from employment_assignment ea join grade g on g.company_id = ea.company_id and g.id = ea.grade_id
                                where ea.company_id = e.company_id and ea.employee_id = e.id
                                  and ea.effective_from <= ${lastDay} and (ea.effective_to is null or ea.effective_to > ${lastDay})) gr on true
           where ${scope} and sa.effective_from <= ${to} and (sa.effective_to is null or sa.effective_to > ${from})${filters}`;
}

/** The order of salary master rows, in the list and the exports alike. */
export const SALARY_MASTER_ORDER = 'employee_code, effective_from';

export interface SalaryMasterQuery {
  date?: string | undefined;
  month?: string | undefined;
  search?: string | undefined;
  status?: string | undefined;
  page: number;
  pageSize: number;
}

interface SalaryMasterRow {
  employee_id: string;
  employee_code: string;
  display_name: string;
  status: string;
  grade: string | null;
  effective_from: string;
  effective_to: string | null;
  currency: string;
  annual_ctc: string;
  monthly_gross: string;
}

/** GET /salary-master: one page of the salary master on a day or in a month, with the total of the same filtered rows. */
export async function listSalaryMaster(db: Queryable, grant: AccessGrant, q: SalaryMasterQuery) {
  if (q.date && q.month) throw new HttpError(422, 'FILTER_CONFLICT', 'Choose a day or a month, not both');
  const period = q.month ? monthPeriod(q.month) : { from: q.date ?? grant.businessDate, to: q.date ?? grant.businessDate };
  const p = new SqlParams();
  const select = salaryMasterSelect(grant, { ...period, search: q.search, status: q.status }, p);
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from (${select}) x`, p.values)).rows[0]?.n ?? 0);
  const limit = p.add(q.pageSize);
  const offset = p.add((q.page - 1) * q.pageSize);
  const rows = (await db.query<SalaryMasterRow>(`select * from (${select}) x order by ${SALARY_MASTER_ORDER} limit ${limit} offset ${offset}`, p.values)).rows;
  return {
    period: q.month ? { month: q.month, ...period } : { date: period.from, ...period },
    items: rows.map((r) => ({
      employeeId: r.employee_id,
      employeeCode: r.employee_code,
      displayName: r.display_name,
      status: r.status,
      grade: r.grade,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      currency: r.currency,
      annualCtc: r.annual_ctc,
      monthlyGross: r.monthly_gross,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Upload: SALARY_MASTER_V1
// ---------------------------------------------------------------------------------------------------------------

export const SALARY_MASTER_COLUMNS = ['employeeCode', 'effectiveFrom', 'annualCtc', 'monthlyGross', 'currency'] as const;
type Column = (typeof SALARY_MASTER_COLUMNS)[number];
export const SALARY_MASTER_TEMPLATE: Template<Column> = { code: 'SALARY_MASTER_V1', columns: SALARY_MASTER_COLUMNS };

const MONEY = new RegExp(MONEY_PATTERN);
const CURRENCY = new RegExp(CURRENCY_PATTERN);

export const SALARY_MASTER_SPEC: BatchSpec<Column> = {
  kind: 'salary_master',
  template: SALARY_MASTER_TEMPLATE,
  // One row per employee: an employee has one initial arrangement.
  parse: (bytes) => markRepeats(parseTemplate(bytes, SALARY_MASTER_TEMPLATE), (row) => row.employeeCode.toUpperCase(), 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => row.employeeCode.toUpperCase() || `ROW-${n}`,
  async apply(client, grant, row) {
    // The body rules of POST /employees/:id/salary, cell by cell.
    if (!isCalendarDate(row.effectiveFrom)) throw new RowError('INVALID_DATE');
    if (!MONEY.test(row.annualCtc)) throw new RowError('INVALID_ANNUAL_CTC');
    if (!MONEY.test(row.monthlyGross)) throw new RowError('INVALID_MONTHLY_GROSS');
    if (!CURRENCY.test(row.currency)) throw new RowError('INVALID_CURRENCY');
    // Employee codes are stored upper-case (0001 check constraint), as the batch's duplicate key compares them.
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    // Row scope (OUT_OF_SCOPE), the own-record refusal, the grant rechecked after the salary lock, SALARY_EXISTS, the insert and its audit.
    try {
      await createInitialSalary(client, grant, employee.id, { effectiveFrom: row.effectiveFrom, annualCtc: row.annualCtc, monthlyGross: row.monthlyGross, currency: row.currency });
    } catch (err) {
      // The caller's own record is refused in the single request's words, not as out of scope.
      if (err instanceof HttpError && err.code === 'SELF_ACTION_NOT_ALLOWED') throw new RowError(err.code);
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const IMPORTS = '/salary-master/imports';

export async function salaryMasterRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  // Every salary master upload route needs what POST /employees/:id/salary needs: salary.manage with the salary group.
  const manage = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'salary', 'manage', ['salary'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.get(
    '/salary-master',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            date: { type: 'string', format: 'date' },
            month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
            search: { type: 'string', maxLength: 100 },
            status: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
          },
        },
      },
    },
    async (request) => {
      // Amounts are confidential (DF02): the list needs the salary read grant, like GET /employees/:id/salary.
      const grant = await requireAccess(db, request, 'salary', 'read', ['salary'], { requireAll: true });
      return listSalaryMaster(db, grant, request.query as SalaryMasterQuery);
    },
  );

  app.post(
    IMPORTS,
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: {
            fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
            contentBase64: { type: 'string', minLength: 4 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await manage(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, SALARY_MASTER_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await manage(request, id), SALARY_MASTER_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches, the published template and resuming a batch held for the malware scan (imports/routes.ts).
  batchFollowUpRoutes(app, { db, files, scanner, path: IMPORTS, spec: SALARY_MASTER_SPEC, readGrant: (request) => manage(request), submitGrant: (request, id) => manage(request, id) });

  app.post(`${IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await manage(request, id), SALARY_MASTER_SPEC, id);
  });

  app.post(`${IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await manage(request, id), SALARY_MASTER_SPEC.kind, id);
  });
}
