// FR-046 resource allocation (DB069; F1): an employee on a job for an inclusive date interval and a percentage of
// the capacity that their shift and calendar give. The interval must lie within the employment and within the job's
// and project's periods, and both must be active. The same employee, job and overlapping interval is a duplicate.
// F1: a total above 100% on any day is blocked unless the employee's direct manager records an approved exception
// with a reason (the exception is kept on the allocation). Changes are serialised per employee, so two concurrent
// allocations cannot each pass the capacity check. Batch imports (DF09) run every row through the same rules.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { isCalendarDate, parseTemplate, RowError, type Template } from '../imports/batch.js';
import type { BatchSpec } from '../imports/jobs.js';
import { actorOf, audit, employmentOf, isActiveStatus, lockAllocations, ownEmployee, requireDate } from './common.js';

export interface AllocationInput {
  employeeId: string;
  jobId: string;
  startDate: string;
  endDate: string;
  /** Exact decimal string, more than 0 and at most 100 (two decimals). */
  allocationPercent: string;
  /** F1: the direct manager's reason for a total above 100%. */
  overAllocationReason?: string | undefined;
}

export interface AllocationPatch {
  expectedVersion: number;
  endDate?: string | undefined;
  allocationPercent?: string | undefined;
  overAllocationReason?: string | undefined;
}

const PERCENT = /^(\d{1,3})(\.\d{1,2})?$/;

function checkPercent(value: string): string {
  const m = PERCENT.exec(value);
  // Compared as exact decimals: whole part and two-digit fraction as integers (never floating point).
  const hundredths = m ? Number(m[1]) * 100 + Number((m[2] ?? '.00').slice(1).padEnd(2, '0')) : NaN;
  if (!m || !(hundredths > 0 && hundredths <= 10_000)) throw new HttpError(422, 'INVALID_PERCENT', 'The allocation percentage must be more than 0 and at most 100', { field: 'allocationPercent' });
  return value;
}

/** F1: the job and its project must be active and the interval inside both periods (FR-046 "invalid project dates"). */
async function allocatableJob(tx: Queryable, companyId: string, jobId: string, startDate: string, endDate: string): Promise<{ projectId: string }> {
  const j = (
    await tx.query<{ project_id: string; active: boolean; in_period: boolean }>(
      `select j.project_id, j.active and p.active as active,
              (j.start_date <= $3::date and (j.end_date is null or j.end_date >= $4::date)
               and p.start_date <= $3::date and (p.end_date is null or p.end_date >= $4::date)) as in_period
         from timesheet_job j join timesheet_project p on p.company_id = j.company_id and p.id = j.project_id
        where j.company_id = $1 and j.id = $2`,
      [companyId, jobId, startDate, endDate],
    )
  ).rows[0];
  if (!j) throw new HttpError(422, 'UNKNOWN_JOB', 'The job does not exist in this company', { field: 'jobId' });
  if (!j.active) throw new HttpError(422, 'INACTIVE_MASTER', 'The job or its project is not active');
  if (!j.in_period) throw new HttpError(422, 'INVALID_PROJECT_DATES', "The allocation must lie within the job's and the project's periods");
  return { projectId: j.project_id };
}

interface Peak {
  day: string;
  total: string;
  over: boolean;
}

/**
 * The highest daily total of the employee's active allocations over [start, end] with `percent` added (exact
 * numeric). The daily total only rises where an allocation starts, so the interval start and the start dates of the
 * overlapping allocations are the days to check.
 */
async function peakTotal(tx: Queryable, companyId: string, employeeId: string, startDate: string, endDate: string, percent: string, excludeId: string | null): Promise<Peak> {
  return (
    await tx.query<Peak>(
      `with days as (
         select $3::date as d
         union
         select a.start_date from resource_allocation a
          where a.company_id = $1 and a.employee_id = $2 and a.state = 'ACTIVE' and ($6::uuid is null or a.id <> $6::uuid)
            and a.start_date > $3::date and a.start_date <= $4::date
       ), totals as (
         select d.d, $5::numeric + coalesce((select sum(a.allocation_percent) from resource_allocation a
                                              where a.company_id = $1 and a.employee_id = $2 and a.state = 'ACTIVE' and ($6::uuid is null or a.id <> $6::uuid)
                                                and a.start_date <= d.d and a.end_date >= d.d), 0) as percent_sum
           from days d
       )
       -- Ordered by the numeric sum (never by its text form).
       select to_char(t.d, 'YYYY-MM-DD') as day, t.percent_sum::text as total, t.percent_sum > 100 as over
         from totals t order by t.percent_sum desc, t.d limit 1`,
      [companyId, employeeId, startDate, endDate, percent, excludeId],
    )
  ).rows[0]!;
}

async function directManagerOf(tx: Queryable, companyId: string, employeeId: string, day: string): Promise<string | null> {
  const r = (
    await tx.query<{ manager: string }>(
      `select manager_employee_id as manager from manager_assignment
        where company_id = $1 and employee_id = $2 and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`,
      [companyId, employeeId, day],
    )
  ).rows[0];
  return r?.manager ?? null;
}

interface OverAllocation {
  reason: string;
  peak: string;
  managerEmployeeId: string;
}

/** F1: a total above 100% needs the direct manager's recorded exception with a reason; anything else is blocked. */
async function overAllocationFor(tx: Queryable, grant: AccessGrant, employeeId: string, peak: Peak, reason: string | undefined): Promise<OverAllocation | null> {
  const given = reason?.trim() ?? '';
  if (!peak.over) {
    if (given) throw new HttpError(422, 'EXCEPTION_NOT_NEEDED', 'The allocation stays within 100%; no exception is recorded', { peakPercent: peak.total });
    return null;
  }
  if (!given) {
    throw new HttpError(409, 'OVER_ALLOCATED', `The employee would be allocated ${peak.total}% on ${peak.day}; above 100% needs an exception recorded by the direct manager`, {
      peakPercent: peak.total,
      date: peak.day,
    });
  }
  const manager = await directManagerOf(tx, grant.companyId, employeeId, grant.businessDate);
  if (!manager || grant.linkedEmployeeId !== manager) {
    throw new HttpError(403, 'MANAGER_EXCEPTION_REQUIRED', "Only the employee's current direct manager can record an over-allocation exception");
  }
  // I-25: the exception is the manager's decision outside decideTask; callers hold the employee's allocation lock.
  await reassertAccess(tx, grant, 'timesheet_allocation', 'manage', ['operational']);
  return { reason: given, peak: peak.total, managerEmployeeId: manager };
}

async function checkEmployment(tx: Queryable, companyId: string, employeeId: string, startDate: string, endDate: string): Promise<void> {
  const e = await employmentOf(tx, companyId, employeeId);
  if (!e) throw notFound();
  if (!isActiveStatus(e.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee can be allocated');
  if (startDate < e.joiningDate || (e.lastWorkingDate !== null && endDate > e.lastWorkingDate)) {
    throw new HttpError(422, 'OUTSIDE_EMPLOYMENT', 'The allocation must lie within the employment (joining date to last working date)');
  }
}

async function assertNoDuplicate(tx: Queryable, companyId: string, employeeId: string, jobId: string, startDate: string, endDate: string, excludeId: string | null): Promise<void> {
  const dup = await tx.query(
    `select 1 from resource_allocation where company_id = $1 and employee_id = $2 and job_id = $3 and state = 'ACTIVE'
        and start_date <= $5::date and end_date >= $4::date and ($6::uuid is null or id <> $6::uuid)`,
    [companyId, employeeId, jobId, startDate, endDate, excludeId],
  );
  if ((dup.rowCount ?? 0) > 0) throw new HttpError(409, 'DUPLICATE_ALLOCATION', 'The employee is already allocated to this job for an overlapping interval');
}

export async function createAllocation(tx: Queryable, grant: AccessGrant, input: AllocationInput, source: 'MANUAL' | 'IMPORT' = 'MANUAL') {
  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  requireDate(input.startDate, 'startDate');
  requireDate(input.endDate, 'endDate');
  if (input.endDate < input.startDate) throw new HttpError(422, 'INVALID_PERIOD', 'The end date is before the start date');
  const percent = checkPercent(input.allocationPercent);
  await lockAllocations(tx, grant.companyId, input.employeeId);
  await checkEmployment(tx, grant.companyId, input.employeeId, input.startDate, input.endDate);
  const { projectId } = await allocatableJob(tx, grant.companyId, input.jobId, input.startDate, input.endDate);
  await assertNoDuplicate(tx, grant.companyId, input.employeeId, input.jobId, input.startDate, input.endDate, null);
  const peak = await peakTotal(tx, grant.companyId, input.employeeId, input.startDate, input.endDate, percent, null);
  const exception = await overAllocationFor(tx, grant, input.employeeId, peak, input.overAllocationReason);
  const id = (
    await tx.query<{ id: string }>(
      `insert into resource_allocation (company_id, employee_id, project_id, job_id, start_date, end_date, allocation_percent, state, source,
                                        over_allocation_reason, over_allocation_peak_percent, over_allocation_manager_employee_id, over_allocation_recorded_by,
                                        over_allocation_recorded_at, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, 'ACTIVE', $8, $9, $10::numeric, $11, $12, case when $9::text is null then null else now() end, $13, $13) returning id`,
      [
        grant.companyId,
        input.employeeId,
        projectId,
        input.jobId,
        input.startDate,
        input.endDate,
        percent,
        source,
        exception?.reason ?? null,
        exception?.peak ?? null,
        exception?.managerEmployeeId ?? null,
        exception ? grant.userId : null,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(
    tx,
    actorOf(grant),
    'resource_allocation',
    id,
    'CREATE',
    null,
    {
      employeeId: input.employeeId,
      projectId,
      jobId: input.jobId,
      startDate: input.startDate,
      endDate: input.endDate,
      allocationPercent: percent,
      source,
      overAllocation: exception ? { peakPercent: exception.peak, managerEmployeeId: exception.managerEmployeeId } : null,
    },
    { newVersion: 1, reason: exception?.reason ?? null },
  );
  return allocationView(tx, grant, id);
}

interface AllocationRow {
  id: string;
  employee_id: string;
  job_id: string;
  start_date: string;
  end_date: string;
  allocation_percent: string;
  state: string;
  version: number;
}

async function lockAllocation(tx: Queryable, grant: AccessGrant, id: string): Promise<AllocationRow> {
  const pre = (await tx.query<{ employee_id: string }>(`select employee_id from resource_allocation where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!pre || !(await canAccessEmployee(tx, grant, pre.employee_id))) throw notFound();
  await lockAllocations(tx, grant.companyId, pre.employee_id);
  return (
    await tx.query<AllocationRow>(
      `select id, employee_id, job_id, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date,
              allocation_percent::text as allocation_percent, state, version
         from resource_allocation where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0]!;
}

/** Changes the end date or percentage of an active allocation; the same rules apply to the result. */
export async function updateAllocation(tx: Queryable, grant: AccessGrant, id: string, patch: AllocationPatch) {
  const a = await lockAllocation(tx, grant, id);
  if (a.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'A cancelled allocation is final');
  if (a.version !== patch.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const endDate = patch.endDate ?? a.end_date;
  requireDate(endDate, 'endDate');
  if (endDate < a.start_date) throw new HttpError(422, 'INVALID_PERIOD', 'The end date is before the start date');
  const percent = checkPercent(patch.allocationPercent ?? a.allocation_percent);
  if (endDate !== a.end_date) {
    await checkEmployment(tx, grant.companyId, a.employee_id, a.start_date, endDate);
    await allocatableJob(tx, grant.companyId, a.job_id, a.start_date, endDate);
    await assertNoDuplicate(tx, grant.companyId, a.employee_id, a.job_id, a.start_date, endDate, a.id);
  }
  const peak = await peakTotal(tx, grant.companyId, a.employee_id, a.start_date, endDate, percent, a.id);
  const exception = await overAllocationFor(tx, grant, a.employee_id, peak, patch.overAllocationReason);
  const version = (
    await tx.query<{ version: number }>(
      `update resource_allocation set end_date = $3, allocation_percent = $4::numeric, over_allocation_reason = $5, over_allocation_peak_percent = $6::numeric,
              over_allocation_manager_employee_id = $7, over_allocation_recorded_by = $8, over_allocation_recorded_at = case when $5::text is null then null else now() end,
              updated_by = $9
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, a.id, endDate, percent, exception?.reason ?? null, exception?.peak ?? null, exception?.managerEmployeeId ?? null, exception ? grant.userId : null, grant.userId],
    )
  ).rows[0]!.version;
  await audit(
    tx,
    actorOf(grant),
    'resource_allocation',
    a.id,
    'UPDATE',
    { endDate: a.end_date, allocationPercent: a.allocation_percent },
    { endDate, allocationPercent: percent, overAllocation: exception ? { peakPercent: exception.peak, managerEmployeeId: exception.managerEmployeeId } : null },
    { priorVersion: a.version, newVersion: version, reason: exception?.reason ?? null },
  );
  return allocationView(tx, grant, a.id);
}

export async function cancelAllocation(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }) {
  const a = await lockAllocation(tx, grant, id);
  if (a.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'The allocation is already cancelled');
  if (a.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const version = (
    await tx.query<{ version: number }>(
      `update resource_allocation set state = 'CANCELLED', cancel_reason = $3, cancelled_at = now(), cancelled_by = $4, updated_by = $4
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, a.id, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.version;
  await audit(tx, actorOf(grant), 'resource_allocation', a.id, 'CANCEL', { state: 'ACTIVE' }, { state: 'CANCELLED' }, { priorVersion: a.version, newVersion: version, reason: input.reason.trim() });
  return allocationView(tx, grant, a.id);
}

const VIEW_COLUMNS = `a.id, a.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  a.project_id as "projectId", p.code as "projectCode", p.name as "projectName", a.job_id as "jobId", j.code as "jobCode", j.name as "jobName",
  to_char(a.start_date, 'YYYY-MM-DD') as "startDate", to_char(a.end_date, 'YYYY-MM-DD') as "endDate", a.allocation_percent::text as "allocationPercent",
  a.state, a.source,
  case when a.over_allocation_reason is null then null
       else json_build_object('reason', a.over_allocation_reason, 'peakPercent', a.over_allocation_peak_percent::text,
                              'managerEmployeeId', a.over_allocation_manager_employee_id, 'recordedAt', a.over_allocation_recorded_at) end as "overAllocation",
  a.cancel_reason as "cancelReason", a.cancelled_at as "cancelledAt", a.version, a.created_at as "createdAt"`;

const VIEW_FROM = `resource_allocation a
  join employee e on e.company_id = a.company_id and e.id = a.employee_id
  join timesheet_job j on j.company_id = a.company_id and j.id = a.job_id
  join timesheet_project p on p.company_id = a.company_id and p.id = a.project_id`;

export async function allocationView(db: Queryable, grant: AccessGrant, id: string) {
  const row = (await db.query<{ employeeId: string }>(`select ${VIEW_COLUMNS} from ${VIEW_FROM} where a.company_id = $1 and a.id = $2`, [grant.companyId, id])).rows[0];
  if (!row || !(await canAccessEmployee(db, grant, row.employeeId))) throw notFound();
  return row;
}

export const ALLOCATION_STATES = ['ACTIVE', 'CANCELLED'] as const;

export interface AllocationQuery extends Paging {
  employeeId?: string | undefined;
  projectId?: string | undefined;
  jobId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  state?: string | undefined;
}

/** Lists answered without page/pageSize (each list's first answer before it could page). */
export const ALLOCATION_LIST_CAP = 1000;
export const OWN_ALLOCATION_LIST_CAP = 500;

/** The list's order, over its output columns. */
const ALLOCATION_ORDER = '"employeeCode", "startDate", "jobCode", id';

/** The search's conditions within the assignment's row scope (shared by the list and its export). */
function allocationWhere(grant: AccessGrant, q: Omit<AllocationQuery, keyof Paging>, params: SqlParams): string {
  const scope = employeeScopePredicate(grant, { company: 'a.company_id', employee: 'a.employee_id' }, params);
  const where = [scope];
  if (q.employeeId) where.push(`a.employee_id = ${params.add(q.employeeId)}::uuid`);
  if (q.projectId) where.push(`a.project_id = ${params.add(q.projectId)}::uuid`);
  if (q.jobId) where.push(`a.job_id = ${params.add(q.jobId)}::uuid`);
  if (q.from) where.push(`a.end_date >= ${params.add(q.from)}::date`);
  if (q.to) where.push(`a.start_date <= ${params.add(q.to)}::date`);
  if (q.state) where.push(`a.state = ${params.add(q.state)}`);
  return where.join(' and ');
}

/**
 * FR-046 search, limited by the assignment's row scope, by employee code, start date and job: one page (FR-056), or
 * the first 1,000 without page/pageSize; `total` counts every match.
 */
export async function listAllocations(db: Queryable, grant: AccessGrant, q: AllocationQuery) {
  const params = new SqlParams();
  const where = allocationWhere(grant, q, params);
  return pageOf(db, `select ${VIEW_COLUMNS} from ${VIEW_FROM} where ${where}`, params.values, ALLOCATION_ORDER, q, ALLOCATION_LIST_CAP);
}

/**
 * FR-046 "Export" (report catalogue RESOURCE_ALLOCATION): every allocation the search finds, under the same scope,
 * conditions and order, one row each with codes and names instead of ids and times in company time.
 */
export async function allocationExportRows(db: Queryable, grant: AccessGrant, q: Omit<AllocationQuery, keyof Paging>): Promise<Record<string, unknown>[]> {
  const params = new SqlParams();
  const where = allocationWhere(grant, q, params);
  const local = (column: string) => `to_char(${column} at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI:SS')`;
  return (
    await db.query(
      `select x.* from (
         select a.id, e.employee_code as "employeeCode", e.display_name as "employeeName", p.code as "projectCode", p.name as "projectName",
                j.code as "jobCode", j.name as "jobName", to_char(a.start_date, 'YYYY-MM-DD') as "startDate", to_char(a.end_date, 'YYYY-MM-DD') as "endDate",
                a.allocation_percent::text as "allocationPercent", a.state, a.source,
                a.over_allocation_peak_percent::text as "overAllocationPeakPercent", a.over_allocation_reason as "overAllocationReason",
                m.employee_code as "overAllocationManagerCode", ${local('a.over_allocation_recorded_at')} as "overAllocationRecordedAt",
                a.cancel_reason as "cancelReason", ${local('a.cancelled_at')} as "cancelledAt"
           from ${VIEW_FROM}
           join company c on c.id = a.company_id
           left join employee m on m.company_id = a.company_id and m.id = a.over_allocation_manager_employee_id
          where ${where}) x
        order by ${ALLOCATION_ORDER}`,
      params.values,
    )
  ).rows;
}

/**
 * The employee's own active allocations with the activities each job permits now (what they can book, TN13): one
 * page (FR-056), or the first 500 without page/pageSize; `total` counts all.
 */
export async function ownAllocations(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const employeeId = ownEmployee(grant);
  return pageOf(
    db,
    `select a.id, a.project_id as "projectId", p.code as "projectCode", p.name as "projectName", a.job_id as "jobId", j.code as "jobCode", j.name as "jobName",
            to_char(a.start_date, 'YYYY-MM-DD') as "startDate", to_char(a.end_date, 'YYYY-MM-DD') as "endDate", a.allocation_percent::text as "allocationPercent",
            coalesce((select json_agg(json_build_object('activityId', t.id, 'code', t.code, 'name', t.name) order by t.code)
                        from timesheet_job_activity ja join timesheet_activity t on t.company_id = ja.company_id and t.id = ja.activity_id and t.active
                       where ja.company_id = a.company_id and ja.job_id = a.job_id and ja.active), '[]'::json) as activities
       from resource_allocation a
       join timesheet_job j on j.company_id = a.company_id and j.id = a.job_id
       join timesheet_project p on p.company_id = a.company_id and p.id = a.project_id
      where a.company_id = $1 and a.employee_id = $2 and a.state = 'ACTIVE'`,
    [grant.companyId, employeeId],
    '"startDate" desc, "jobCode", id',
    paging,
    OWN_ALLOCATION_LIST_CAP,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// DF09 / FR-046 bulk upload: template RESOURCE_ALLOCATION_V1, all-or-nothing, every row through createAllocation
// ---------------------------------------------------------------------------------------------------------------

const COLUMNS = ['employeeCode', 'projectCode', 'jobCode', 'startDate', 'endDate', 'allocationPercent'] as const;
type Column = (typeof COLUMNS)[number];
export const ALLOCATION_TEMPLATE: Template<Column> = { code: 'RESOURCE_ALLOCATION_V1', columns: COLUMNS };

export const ALLOCATION_IMPORT_SPEC: BatchSpec<Column> = {
  kind: 'timesheet_allocation',
  template: ALLOCATION_TEMPLATE,
  parse: (bytes) => parseTemplate(bytes, ALLOCATION_TEMPLATE),
  keyOf: (row, n) => (row.employeeCode ? `${row.employeeCode.toUpperCase()}@${row.projectCode.toUpperCase()}/${row.jobCode.toUpperCase()}@${row.startDate}` : `ROW-${n}`),
  async apply(client, grant, row) {
    if (!isCalendarDate(row.startDate) || !isCalendarDate(row.endDate)) throw new RowError('INVALID_DATE');
    // FR-046 acceptance: unknown employees and invalid project dates are reported per row.
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    const job = (
      await client.query<{ id: string }>(
        `select j.id from timesheet_job j join timesheet_project p on p.company_id = j.company_id and p.id = j.project_id
          where j.company_id = $1 and p.code = $2 and j.code = $3`,
        [grant.companyId, row.projectCode.toUpperCase(), row.jobCode.toUpperCase()],
      )
    ).rows[0];
    if (!job) {
      const project = await client.query(`select 1 from timesheet_project where company_id = $1 and code = $2`, [grant.companyId, row.projectCode.toUpperCase()]);
      throw new RowError((project.rowCount ?? 0) > 0 ? 'UNKNOWN_JOB' : 'UNKNOWN_PROJECT');
    }
    await createAllocation(
      client,
      grant,
      { employeeId: employee.id, jobId: job.id, startDate: row.startDate, endDate: row.endDate, allocationPercent: row.allocationPercent },
      'IMPORT',
    );
  },
};
