// Report catalogue (FR-056, FR-079, FR-093; BR-026). Each report declares the permission it needs and its
// columns; its rows come from the same scope predicate as the matching list, so counts reconcile (ZT17).
// Confidential values (leave reasons, receipts, private data) are never columns unless the report's own
// permission is in a confidential field group (e.g. increment history needs increment.export.salary).
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { assertMinuteFilter, ATTENDANCE_CONTROL_FROM, attendanceControlConditions, type AttendanceControlFilters } from '../attendance/service.js';
import { auditEventQuery } from '../audit-trail/service.js';
import { BIOMETRIC_REPORTS } from '../biometric/reports.js';
import { CONFIRMATION_VIEWS, type ConfirmationView, listConfirmations } from '../confirmation/service.js';
import { type EmployeeFilters, employeeFilterConditions, employeeOrderBy } from '../employee/service.js';
import { claimsInScope, EXPENSE_REPORTS } from '../expense/reports.js';
import { requireDayOrMonth, SALARY_MASTER_ORDER, salaryMasterSelect } from '../increment/salary-master.js';
import { comparisonRows, disbursementRows, payrollRegisterRows, payrollRunRevision, requirePayrollRun, requireWholePayrollRun } from '../payroll-outputs/reports.js';
import { NOTIFICATION_REPORTS } from '../notification/reports.js';
import { isModuleActive } from '../registry.js';
import { CURRENT_MEMBER_STATUSES, TEAM_SORTS, teamExportRows } from '../team/service.js';
import { ALLOCATION_STATES, allocationExportRows } from '../timesheet/allocations.js';
import { hoursExportRows, MAX_REPORT_DAYS } from '../timesheet/reports.js';
import { cellText, contextCsvLines, csvCell, oneLine, type ReportContext } from './context.js';
import { PLAIN_DECIMAL, type SheetCell, xlsxWorkbook } from './xlsx.js';

/** DF14 comparable compensation bases (increment/service.ts). */
export const COMPENSATION_BASES = ['MONTHLY_GROSS', 'ANNUAL_CTC'] as const;

/** The output formats of a report: CSV always; XLSX only for reports that declare `xlsx`. */
export const REPORT_FORMATS = ['CSV', 'XLSX'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * A list's record filters (one employee, project, job or activity, or the payroll run of a run report, by id); only
 * reports that declare them accept them.
 */
export const RECORD_FILTERS = ['employeeId', 'projectId', 'jobId', 'activityId', 'runId', 'locationId', 'shiftId', 'minuteField', 'minuteOp', 'minuteValue', 'leaveType', 'resource', 'recordKey', 'actorUserId', 'action', 'reviewDueFrom', 'reviewDueTo', 'todayAttendance', 'confirmationDueTo', 'view', 'category', 'profileId'] as const;
export type RecordFilter = (typeof RECORD_FILTERS)[number];

export interface ReportFilters extends EmployeeFilters {
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
  /** DF14 comparable basis; only reports that declare `basisFilter` accept it. */
  basis?: (typeof COMPENSATION_BASES)[number] | undefined;
  employeeId?: string | undefined;
  projectId?: string | undefined;
  jobId?: string | undefined;
  activityId?: string | undefined;
  runId?: string | undefined;
  /** FR-021 / E07 attendance control's filters (attendance/service.ts). */
  locationId?: string | undefined;
  shiftId?: string | undefined;
  minuteField?: AttendanceControlFilters['minuteField'];
  minuteOp?: AttendanceControlFilters['minuteOp'];
  minuteValue?: number | undefined;
  /** FR-024 / E06 mapped-policy export: one leave type, by code. */
  leaveType?: string | undefined;
  /** BR-026 the audit viewer's record filters (audit-trail/service.ts AuditQuery). */
  resource?: string | undefined;
  recordKey?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  /** DF16 the My Team list's own filters (team/service.ts TeamFilters). */
  reviewDueFrom?: string | undefined;
  reviewDueTo?: string | undefined;
  todayAttendance?: string | undefined;
  confirmationDueTo?: string | undefined;
  /** FR-082 / FR-093 the confirmation list's view. */
  view?: string | undefined;
  /** FR-085 / section 11.2 the delivery log's event type. */
  category?: string | undefined;
  /** FR-087 / section 11.2 one biometric profile. */
  profileId?: string | undefined;
}

/** The employee list filters beyond status (FR-007); only reports that declare `employeeFilters` accept them. */
export const EMPLOYEE_LIST_FILTERS = ['search', 'statusGroup', 'departmentId', 'joinedFrom', 'joinedTo', 'sort', 'direction'] as const;
export type EmployeeListFilter = (typeof EMPLOYEE_LIST_FILTERS)[number];

/** The employee list filters a report accepts: every one (`employeeFilters: true`), the listed ones, or none. */
export function acceptedEmployeeFilters(def: Pick<ReportDefinition, 'employeeFilters'>): readonly EmployeeListFilter[] {
  return def.employeeFilters === true ? EMPLOYEE_LIST_FILTERS : def.employeeFilters || [];
}

export interface ReportDefinition {
  code: string;
  title: string;
  resource: string;
  fieldGroup: string;
  requiresPeriod: boolean;
  /** The business module that owns the report: listed and generated only while that module is active (modules/registry.ts). */
  module?: string | undefined;
  /** Records not tied to employees (the audit trail): only an unrestricted company-scope assignment. */
  companyScopeOnly?: boolean | undefined;
  /** Technical cap on the requested period in calendar days (inclusive), not a business rule. */
  maxPeriodDays?: number | undefined;
  /**
   * FR-007: accepts the employee list's filters, applied by the same predicates as GET /employees: all of them (true)
   * or only the ones listed (the salary master's employee search, FR-029); every other report refuses them.
   */
  employeeFilters?: boolean | readonly EmployeeListFilter[] | undefined;
  /** The `sort` values of a report whose list has its own columns; any other report that takes `sort` has the employee list's. */
  sorts?: readonly string[] | undefined;
  /** FR-093: accepts a DF14 comparable basis (`basis`); every other report refuses it. */
  basisFilter?: boolean | undefined;
  /**
   * Applies `status`: the employee status (the employee register and the salary exports, as their lists apply it), the
   * case state (increment due and decisions) or the allocation state (resource allocations); every other report refuses
   * it rather than ignoring it.
   */
  statusFilter?: boolean | undefined;
  /** The record filters its list applies (the same names and predicates); every other report refuses them. */
  recordFilters?: readonly RecordFilter[] | undefined;
  /** FR-046 "Export XLSX": also generated as an XLSX workbook on request (`format`); every other report refuses it. */
  xlsx?: boolean | undefined;
  /** The report's own rule for its filters, checked when it is requested (422 with the reason). */
  checkFilters?: ((f: ReportFilters) => void) | undefined;
  /**
   * The report's own checks of the records its filters name, under the requester's grant when it is requested (the
   * payroll run exists; company figures need the whole run in scope), with the status the matching JSON route answers.
   */
  checkRequest?: ((db: Queryable, grant: AccessGrant, f: ReportFilters) => Promise<void>) | undefined;
  /** FR-065 "record the filter/run version": the record revision a file of this report comes from, shown in its context (DF09). */
  sourceRevision?: ((db: Queryable, grant: AccessGrant, f: ReportFilters) => Promise<string>) | undefined;
  /** C4 "Historical financial views require an explicit history grant": also needed, always or when `when` says the filters reach back. */
  historyGrant?: { resource: string; fieldGroup: string; when?: (f: ReportFilters, today: string) => boolean } | undefined;
  /** `numeric`: an XLSX number cell when the value is a plain decimal (CSV is unchanged). */
  columns: { key: string; header: string; numeric?: boolean }[];
  rows(db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]>;
}

const scoped = (grant: AccessGrant, params: SqlParams, company: string, employee: string) => employeeScopePredicate(grant, { company, employee }, params);

/**
 * DF14: annual reporting is a financial year (1 April to 31 March) by default, with an optional calendar year. The
 * period is one or the other exactly, so the opening (the day before it starts) and the closing (its last day) are
 * the as-of dates of that year, never arbitrary request dates (CI21).
 */
function requireAnnualPeriod(f: ReportFilters): void {
  const year = Number((f.from ?? '').slice(0, 4));
  const y = (n: number) => String(n).padStart(4, '0');
  const financial = f.from === `${y(year)}-04-01` && f.to === `${y(year + 1)}-03-31`;
  const calendar = f.from === `${y(year)}-01-01` && f.to === `${y(year)}-12-31`;
  if (!financial && !calendar) {
    throw new HttpError(422, 'ANNUAL_PERIOD_REQUIRED', 'This report covers one financial year (1 April to 31 March) or one calendar year (1 January to 31 December)');
  }
}

/** FR-029 / E08 salary master columns (the salary and annual salary exports); amounts at 2 decimals as in every report. */
const SALARY_COLUMNS: ReportDefinition['columns'] = [
  { key: 'employee_code', header: 'Employee code' },
  { key: 'display_name', header: 'Name' },
  { key: 'status', header: 'Status' },
  { key: 'grade', header: 'Grade' },
  { key: 'effective_from', header: 'Effective from' },
  { key: 'effective_to', header: 'Effective to (exclusive)' },
  { key: 'currency', header: 'Currency' },
  { key: 'annual_ctc', header: 'Annual CTC' },
  { key: 'monthly_gross', header: 'Monthly gross' },
];

/** The salary master rows of the requested period (increment/salary-master.ts), exactly as GET /salary-master selects them. */
async function salaryRows(db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]> {
  const p = new SqlParams();
  const select = salaryMasterSelect(grant, { from: f.from!, to: f.to!, search: f.search, status: f.status }, p);
  return (
    await db.query(
      `select ${p.add(f.from)}::text as period_start, ${p.add(f.to)}::text as period_end, employee_code, display_name, status, grade, effective_from, effective_to,
              currency, annual_ctc::numeric(19,2)::text as annual_ctc, monthly_gross::numeric(19,2)::text as monthly_gross
         from (${select}) x order by ${SALARY_MASTER_ORDER}`,
      p.values,
    )
  ).rows;
}

/** A payroll run report covers exactly one run (`runId`), never a period. */
function requireRunOnly(f: ReportFilters): void {
  if (!f.runId) throw new HttpError(422, 'RUN_REQUIRED', 'This report covers one payroll run: give its runId');
  if (f.from !== undefined || f.to !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report covers one payroll run and takes no period');
}

/** The register's amounts, positions and paid units: XLSX number cells. */
const PAYROLL_MONEY = { numeric: true } as const;

/** Allocation states (the allocation list's `state`), applied as the report's `status`. */
function requireAllocationState(f: ReportFilters): void {
  if (f.status !== undefined && !(ALLOCATION_STATES as readonly string[]).includes(f.status)) {
    throw new HttpError(422, 'INVALID_FILTER', `The allocation status is one of ${ALLOCATION_STATES.join(', ')}`, { field: 'status' });
  }
}

const ALL_REPORTS: Record<string, ReportDefinition> = {
  EMPLOYEE_REGISTER: {
    code: 'EMPLOYEE_REGISTER',
    title: 'Employee register',
    resource: 'employee',
    fieldGroup: 'operational',
    requiresPeriod: false,
    employeeFilters: true,
    statusFilter: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'display_name', header: 'Name' },
      { key: 'work_email', header: 'Work email' },
      { key: 'joining_date', header: 'Joining date' },
      { key: 'status', header: 'Status' },
      { key: 'department', header: 'Department' },
      { key: 'location', header: 'Location' },
      { key: 'designation', header: 'Designation' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = scoped(grant, p, 'e.company_id', 'e.id');
      const day = `${p.add(grant.businessDate)}::date`;
      // The employee list's own predicates over the same aliases and business date (FR-007, BR-026).
      const filters = employeeFilterConditions(p, f)
        .map((c) => `and ${c}`)
        .join(' ');
      return (
        await db.query(
          `select e.employee_code, e.display_name, e.work_email, e.joining_date, st.code as status, d.name as department, l.name as location, g.name as designation
             from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
             left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
                  and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
             left join department d on d.company_id = ea.company_id and d.id = ea.department_id
             left join location l on l.company_id = ea.company_id and l.id = ea.location_id
             left join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
            where ${scope} ${filters}
            order by ${employeeOrderBy(f, { employeeCode: 'e.employee_code', displayName: 'e.display_name', joiningDate: 'e.joining_date', status: 'st.code', department: 'd.name', location: 'l.name', designation: 'g.name', id: 'e.id' })}`,
          p.values,
        )
      ).rows;
    },
  },

  // DF16 "Counts and export reflect identical membership and filters"; ZT27. Its own permission (team.export, a ceiling of
  // the Reporting Manager, not a default duty), the list's predicate and filters under the access current at generation.
  // Operational columns only (DF02), whatever else the assignment holds, so no confidential value can reach the output.
  // Columns are DF16's list and await the owner's sample (§11, I-40 item 12).
  MY_TEAM: {
    code: 'MY_TEAM',
    title: 'My team',
    resource: 'team',
    fieldGroup: 'operational',
    requiresPeriod: false,
    employeeFilters: ['search', 'departmentId', 'sort', 'direction'],
    sorts: TEAM_SORTS,
    statusFilter: true,
    recordFilters: ['locationId', 'reviewDueFrom', 'reviewDueTo', 'todayAttendance', 'confirmationDueTo'],
    checkFilters(f) {
      if (f.status !== undefined && !(CURRENT_MEMBER_STATUSES as readonly string[]).includes(f.status)) {
        throw new HttpError(422, 'INVALID_FILTER', `The team status is one of ${CURRENT_MEMBER_STATUSES.join(', ')}`, { field: 'status' });
      }
    },
    columns: [
      { key: 'employeeCode', header: 'Employee code' },
      { key: 'displayName', header: 'Name' },
      { key: 'department', header: 'Department' },
      { key: 'designation', header: 'Designation' },
      { key: 'location', header: 'Location' },
      { key: 'manager', header: 'Manager' },
      { key: 'joiningDate', header: 'Joining date' },
      { key: 'status', header: 'Status' },
      { key: 'todayAttendance', header: 'Attendance today' },
      { key: 'nextReviewDate', header: 'Next review date' },
    ],
    rows: (db, grant, f) => teamExportRows(db, grant, f),
  },

  LEAVE_REGISTER: {
    code: 'LEAVE_REGISTER',
    title: 'Leave register',
    resource: 'leave',
    fieldGroup: 'operational',
    requiresPeriod: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'leave_type', header: 'Leave type' },
      { key: 'start_date', header: 'Start date' },
      { key: 'end_date', header: 'End date' },
      { key: 'units', header: 'Days' },
      { key: 'state', header: 'State' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = scoped(grant, p, 'lr.company_id', 'lr.employee_id');
      return (
        await db.query(
          `select e.employee_code, t.code as leave_type, lr.start_date, lr.end_date, lr.requested_units::text as units, lr.state
             from leave_request lr join employee e on e.company_id = lr.company_id and e.id = lr.employee_id
             join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id
            where ${scope} and lr.start_date <= ${p.add(f.to)}::date and lr.end_date >= ${p.add(f.from)}::date
            order by e.employee_code, lr.start_date`,
          p.values,
        )
      ).rows;
    },
  },

  ATTENDANCE_REGISTER: {
    code: 'ATTENDANCE_REGISTER',
    title: 'Attendance register',
    resource: 'attendance',
    fieldGroup: 'operational',
    requiresPeriod: true,
    // FR-021 / E07: the attendance control list's filters, by the same predicates (ZT17).
    employeeFilters: ['search', 'departmentId'],
    statusFilter: true,
    recordFilters: ['employeeId', 'locationId', 'shiftId', 'minuteField', 'minuteOp', 'minuteValue'],
    checkFilters: assertMinuteFilter,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'work_date', header: 'Work date' },
      { key: 'status', header: 'Status' },
      { key: 'worked_minutes', header: 'Worked minutes' },
      { key: 'late', header: 'Late' },
      { key: 'exception_code', header: 'Exception' },
      { key: 'amended', header: 'Amended' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const where = attendanceControlConditions(
        grant,
        { ...f, from: f.from!, to: f.to! },
        p,
      );
      return (
        await db.query(
          `select e.employee_code, r.work_date, st.code as status, r.worked_minutes, r.late, r.exception_code, r.amended
             ${ATTENDANCE_CONTROL_FROM}
            where ${where}
            order by e.employee_code, r.work_date`,
          p.values,
        )
      ).rows;
    },
  },

  // FR-024 / E06 "mapped-policy export": a row per mapping, an unmapped revision as one row saying so in words. Company
  // configuration, not tied to employees. `from`/`to` bound the effective-from date, `status` is the revision's state.
  LEAVE_POLICY_MAPPING: {
    code: 'LEAVE_POLICY_MAPPING',
    title: 'Leave policies and mappings',
    resource: 'leave_policy',
    fieldGroup: 'operational',
    requiresPeriod: false,
    companyScopeOnly: true,
    statusFilter: true,
    recordFilters: ['leaveType'],
    columns: [
      { key: 'leave_type', header: 'Leave type' },
      { key: 'revision', header: 'Revision' },
      { key: 'state', header: 'State' },
      { key: 'effective_from', header: 'Effective from' },
      { key: 'effective_to', header: 'Effective to (exclusive)' },
      { key: 'eligibility_code', header: 'Eligibility' },
      { key: 'accrual_rule_code', header: 'Accrual rule' },
      { key: 'annual_entitlement', header: 'Annual entitlement' },
      { key: 'min_service_days', header: 'Minimum service days' },
      { key: 'carry_cap', header: 'Carry cap' },
      { key: 'employment_type', header: 'Employment type' },
      { key: 'grade', header: 'Grade' },
      { key: 'location', header: 'Location' },
      { key: 'mapping', header: 'Mapping' },
    ],
    async rows(db, grant, f) {
      return (
        await db.query(
          `select t.code as leave_type, p.revision, p.state, p.effective_from, p.effective_to, p.eligibility_code, p.accrual_rule_code,
                  p.annual_entitlement::text as annual_entitlement, p.min_service_days, p.carry_cap::text as carry_cap,
                  et.code as employment_type, g.code as grade, l.code as location, case when m.id is null then 'UNMAPPED' else 'MAPPED' end as mapping
             from leave_policy p
             join leave_type t on t.company_id = p.company_id and t.id = p.leave_type_id
             left join leave_policy_mapping m on m.company_id = p.company_id and m.policy_id = p.id
             left join reference_value et on et.company_id = m.company_id and et.id = m.employment_type_id
             left join grade g on g.company_id = m.company_id and g.id = m.grade_id
             left join location l on l.company_id = m.company_id and l.id = m.location_id
            where p.company_id = $1 and ($2::text is null or t.code = $2) and ($3::text is null or p.state = $3)
              and ($4::date is null or p.effective_from >= $4::date) and ($5::date is null or p.effective_from <= $5::date)
            order by t.code, p.revision, et.code, g.code, l.code`,
          [grant.companyId, f.leaveType ?? null, f.status ?? null, f.from ?? null, f.to ?? null],
        )
      ).rows;
    },
  },

  // FR-093; section 11.2 "Upcoming/due/overdue/extended/confirmed filtered list; planned versus actual dates and decisions": the
  // rows of GET /confirmations for the same `view`, under the same scope and order, so an export's count is the list's. Each
  // decision of the case's append-only history (CI17) with its date in company time; its reason is confidential (DF02) and stays out.
  CONFIRMATION_DUE: {
    code: 'CONFIRMATION_DUE',
    title: 'Confirmation due and history',
    resource: 'confirmation',
    fieldGroup: 'operational',
    requiresPeriod: false,
    recordFilters: ['view'],
    checkFilters(f) {
      if (f.view !== undefined && !(CONFIRMATION_VIEWS as readonly string[]).includes(f.view)) throw new HttpError(422, 'INVALID_FILTER', `The view is one of ${CONFIRMATION_VIEWS.join(', ')}`, { field: 'view' });
    },
    columns: [
      { key: 'employeeCode', header: 'Employee code' },
      { key: 'startDate', header: 'Start date' },
      { key: 'initialDueDate', header: 'Initial due date' },
      { key: 'dueDate', header: 'Current due date' },
      { key: 'extensionCount', header: 'Extensions' },
      { key: 'actualConfirmationDate', header: 'Confirmed on' },
      { key: 'state', header: 'State' },
      { key: 'view', header: 'View' },
      { key: 'decisions', header: 'Decisions' },
    ],
    async rows(db, grant, f) {
      const { items } = await listConfirmations(db, grant, (f.view as ConfirmationView | undefined) ?? 'ALL');
      const decisions = (
        await db.query<{ confirmation_id: string; decisions: string }>(
          `select a.confirmation_id, string_agg(a.action || ' ' || to_char(hrms_business_date(a.company_id, a.occurred_at), 'YYYY-MM-DD'), '; ' order by a.occurred_at, a.id) as decisions
             from confirmation_action a where a.company_id = $1 and a.confirmation_id = any($2::uuid[]) group by a.confirmation_id`,
          [grant.companyId, (items as { id: string }[]).map((c) => c.id)],
        )
      ).rows;
      const byCase = new Map(decisions.map((d) => [d.confirmation_id, d.decisions]));
      return (items as ({ id: string } & Record<string, unknown>)[]).map((c) => ({ ...c, decisions: byCase.get(c.id) ?? '' }));
    },
  },

  EXPENSE_REGISTER: {
    code: 'EXPENSE_REGISTER',
    title: 'Expense claim register',
    resource: 'expense',
    fieldGroup: 'operational',
    requiresPeriod: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'claim_id', header: 'Claim' },
      { key: 'state', header: 'State' },
      { key: 'submitted_at', header: 'Submitted at' },
      { key: 'claimed_total', header: 'Claimed total' },
      { key: 'approved_amount', header: 'Approved amount' },
      { key: 'net_paid', header: 'Net paid' },
      { key: 'outstanding', header: 'Outstanding' },
      { key: 'payment_state', header: 'Payment state' },
      { key: 'currency', header: 'Currency' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      // Paid totals come from confirmed outcomes only; pending reservations are never counted as paid (ZT17).
      return (
        await db.query(
          `select e.employee_code, c.id as claim_id, c.state, hrms_business_date(c.company_id, r.submitted_at) as submitted_at,
                  (select sum(l.claimed_amount) from expense_line l where l.company_id = r.company_id and l.revision_id = r.id)::numeric(19,2)::text as claimed_total,
                  l.approved_amount::numeric(19,2)::text as approved_amount, l.net_paid::numeric(19,2)::text as net_paid,
                  (l.approved_amount - l.net_paid)::numeric(19,2)::text as outstanding, c.payment_state, c.currency_code as currency
             from expense_claim c join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
             left join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
            where ${scope} and r.submitted_at is not null
              and hrms_business_date(c.company_id, r.submitted_at) between ${p.add(f.from)}::date and ${p.add(f.to)}::date
            order by e.employee_code, r.submitted_at`,
          p.values,
        )
      ).rows;
    },
  },

  // FR-079, section 11: line register, approval ageing, category spend, payable ageing and payment reconciliation.
  ...EXPENSE_REPORTS,

  // FR-093, section 11.2: the notification delivery log, upcoming celebrations, and the biometric sync and exception reports.
  ...NOTIFICATION_REPORTS,
  ...BIOMETRIC_REPORTS,

  INCREMENT_HISTORY: {
    code: 'INCREMENT_HISTORY',
    title: 'Increment history',
    resource: 'increment',
    fieldGroup: 'salary',
    historyGrant: { resource: 'increment', fieldGroup: 'salary' },
    requiresPeriod: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'effective_date', header: 'Effective date' },
      { key: 'basis', header: 'Basis' },
      { key: 'currency', header: 'Currency' },
      { key: 'before_amount', header: 'Before' },
      { key: 'after_amount', header: 'After' },
      { key: 'change_percent', header: 'Change %' },
      { key: 'percent_na_reason', header: 'N/A reason' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = scoped(grant, p, 'h.company_id', 'h.employee_id');
      return (
        await db.query(
          `select e.employee_code, h.effective_date, h.compensation_basis as basis, h.currency_code as currency,
                  h.before_amount::numeric(19,2)::text as before_amount, h.after_amount::numeric(19,2)::text as after_amount,
                  to_char(h.change_percent, 'FM999999990.00') as change_percent, h.percent_na_reason
             from increment_history_in_force h join employee e on e.company_id = h.company_id and e.id = h.employee_id
            where ${scope} and h.effective_date between ${p.add(f.from)}::date and ${p.add(f.to)}::date
            order by e.employee_code, h.effective_date`,
          p.values,
        )
      ).rows;
    },
  },

  // FR-093 / §11.2 "increment due/decision": every increment case (cycle or off-cycle) whose planned effective date falls
  // in the period, with its review window, state and outcome, as GET /increment-cases lists it under the same scope;
  // `status` narrows it to one case state. Amounts are columns, so the report needs increment.export.salary (BR-044:
  // manager status alone is not enough). The free-text reasons stay out (reason group).
  INCREMENT_DUE_DECISION: {
    code: 'INCREMENT_DUE_DECISION',
    title: 'Increment due and decisions',
    resource: 'increment',
    fieldGroup: 'salary',
    requiresPeriod: true,
    statusFilter: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'occurrence', header: 'Occurrence' },
      { key: 'off_cycle', header: 'Off-cycle' },
      { key: 'review_opens_on', header: 'Review opens' },
      { key: 'decision_due_on', header: 'Decision due' },
      { key: 'planned_effective_date', header: 'Planned effective date' },
      { key: 'state', header: 'State' },
      { key: 'proposed_outcome', header: 'Proposed outcome' },
      { key: 'basis', header: 'Basis' },
      { key: 'currency', header: 'Currency' },
      { key: 'baseline_amount', header: 'Baseline' },
      { key: 'proposed_amount', header: 'Proposed' },
      { key: 'approved_amount', header: 'Approved' },
      { key: 'approved_effective_date', header: 'Approved effective date' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = scoped(grant, p, 'c.company_id', 'c.employee_id');
      const state = f.status ? `and c.state = ${p.add(f.status)}` : '';
      return (
        await db.query(
          `select e.employee_code, c.cycle_occurrence_key as occurrence, c.off_cycle, to_char(c.review_opens_on, 'YYYY-MM-DD') as review_opens_on,
                  to_char(c.decision_due_on, 'YYYY-MM-DD') as decision_due_on, to_char(c.proposed_effective_date, 'YYYY-MM-DD') as planned_effective_date,
                  c.state, c.proposed_outcome, c.compensation_basis as basis, c.currency_code as currency,
                  c.baseline_amount::numeric(19,2)::text as baseline_amount, c.proposed_amount::numeric(19,2)::text as proposed_amount,
                  c.approved_amount::numeric(19,2)::text as approved_amount, to_char(c.approved_effective_date, 'YYYY-MM-DD') as approved_effective_date
             from increment_case c join employee e on e.company_id = c.company_id and e.id = c.employee_id
            where ${scope} and c.proposed_effective_date between ${p.add(f.from)}::date and ${p.add(f.to)}::date ${state}
            order by c.proposed_effective_date, e.employee_code, c.created_at`,
          p.values,
        )
      ).rows;
    },
  },

  // FR-090 / FR-093 / DF14 / CI21 "employee annual increment": one row per employee in scope with a salary arrangement in
  // force during the year, on one comparable basis (`basis`, MONTHLY_GROSS by default, the DF14 primary basis). Opening
  // is the approved salary in force the day before the year starts, closing the one in force on its last day; growth is
  // (closing - opening) / opening x 100 at 2 decimals, never a sum of change percentages; a missing opening or closing, a
  // currency change or a zero opening is N/A with its reason. The same rule as GET /employees/:id/annual-increment.
  ANNUAL_INCREMENT: {
    code: 'ANNUAL_INCREMENT',
    title: 'Employee annual increment',
    resource: 'increment',
    fieldGroup: 'salary',
    historyGrant: { resource: 'increment', fieldGroup: 'salary' },
    requiresPeriod: true,
    basisFilter: true,
    checkFilters: requireAnnualPeriod,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'period_start', header: 'Period start' },
      { key: 'period_end', header: 'Period end' },
      { key: 'basis', header: 'Basis' },
      { key: 'currency', header: 'Currency' },
      { key: 'opening_amount', header: 'Opening' },
      { key: 'closing_amount', header: 'Closing' },
      { key: 'changes', header: 'Approved changes' },
      { key: 'annual_growth_percent', header: 'Annual growth %' },
      { key: 'percent_na_reason', header: 'N/A reason' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = scoped(grant, p, 'e.company_id', 'e.id');
      const basis = f.basis ?? 'MONTHLY_GROSS';
      const amount = basis === 'MONTHLY_GROSS' ? 'monthly_gross' : 'annual_ctc';
      const [from, to, basisParam] = [`${p.add(f.from)}::date`, `${p.add(f.to)}::date`, p.add(basis)];
      return (
        await db.query(
          `select e.employee_code, to_char(${from}, 'YYYY-MM-DD') as period_start, to_char(${to}, 'YYYY-MM-DD') as period_end, ${basisParam}::text as basis,
                  coalesce(c.currency_code, o.currency_code) as currency,
                  o.amount::numeric(19,2)::text as opening_amount, c.amount::numeric(19,2)::text as closing_amount,
                  (select count(*)::int from increment_history_in_force h where h.company_id = e.company_id and h.employee_id = e.id
                      and h.compensation_basis = ${basisParam} and h.effective_date between ${from} and ${to}) as changes,
                  case when o.amount is not null and c.amount is not null and o.currency_code = c.currency_code and o.amount > 0
                       then to_char(round((c.amount - o.amount) / o.amount * 100, 2), 'FM999999990.00') end as annual_growth_percent,
                  case when o.amount is null or c.amount is null then 'MISSING_OPENING_OR_CLOSING'
                       when o.currency_code <> c.currency_code then 'CURRENCY_CHANGED'
                       when not (o.amount > 0) then 'ZERO_BASELINE' end as percent_na_reason
             from employee e
             left join lateral (select sa.${amount} as amount, sa.currency_code from salary_arrangement sa
                                 where sa.company_id = e.company_id and sa.employee_id = e.id
                                   and sa.effective_from <= ${from} - 1 and (sa.effective_to is null or sa.effective_to > ${from} - 1)) o on true
             left join lateral (select sa.${amount} as amount, sa.currency_code from salary_arrangement sa
                                 where sa.company_id = e.company_id and sa.employee_id = e.id
                                   and sa.effective_from <= ${to} and (sa.effective_to is null or sa.effective_to > ${to})) c on true
            where ${scope}
              and exists (select 1 from salary_arrangement sa where sa.company_id = e.company_id and sa.employee_id = e.id
                             and sa.effective_from <= ${to} and (sa.effective_to is null or sa.effective_to > ${from} - 1))
            order by e.employee_code`,
          p.values,
        )
      ).rows;
    },
  },

  // FR-029 / E08 "salary export" (CL-208): the salary master as GET /salary-master lists it, for one day or one calendar
  // month exactly ("export reflects the selected effective month"): every salary arrangement in force at any time in
  // that period of an employee in the requester's row scope, with the list's employee search and status filters. The
  // amounts are columns, so the report needs salary.export.salary (an eligible Admin's confidential grant, DF02).
  // Estimated in-hand is not a column: BR-011 leaves its calculation open.
  SALARY_MASTER: {
    code: 'SALARY_MASTER',
    title: 'Employee salary master',
    resource: 'salary',
    fieldGroup: 'salary',
    historyGrant: { resource: 'salary', fieldGroup: 'salary', when: (f, today) => (f.from ?? today) < today },
    requiresPeriod: true,
    employeeFilters: ['search'],
    statusFilter: true,
    checkFilters: requireDayOrMonth,
    columns: SALARY_COLUMNS,
    rows: salaryRows,
  },

  // FR-029 / E08 "annual salary export" (CL-209): the same salary master rows over one financial year (1 April to 31
  // March) or one calendar year (DF14's annual periods): every salary arrangement in force at any time in the year,
  // with the period on each row. A listing of the approved arrangements, never an annual amount computed from them.
  ANNUAL_SALARY: {
    code: 'ANNUAL_SALARY',
    title: 'Employee annual salary',
    resource: 'salary',
    fieldGroup: 'salary',
    historyGrant: { resource: 'salary', fieldGroup: 'salary' },
    requiresPeriod: true,
    employeeFilters: ['search'],
    statusFilter: true,
    checkFilters: requireAnnualPeriod,
    columns: [{ key: 'period_start', header: 'Period start' }, { key: 'period_end', header: 'Period end' }, ...SALARY_COLUMNS],
    rows: salaryRows,
  },

  // FR-046 "search, Export and Export XLSX" (I-30): the resource allocations GET /timesheet/allocations lists, under the
  // same row scope, filters (employee, project, job, the period the allocation overlaps and its state as `status`) and
  // order, every match (the list pages them). Its columns are the list's, with the over-allocation exception and the
  // cancellation (operational, as every timesheet field group) and times in company time. Planned hours are not a column
  // (FR-046: they need business agreement).
  RESOURCE_ALLOCATION: {
    code: 'RESOURCE_ALLOCATION',
    title: 'Resource allocations',
    resource: 'timesheet_allocation',
    fieldGroup: 'operational',
    requiresPeriod: false,
    module: 'timesheet',
    statusFilter: true,
    recordFilters: ['employeeId', 'projectId', 'jobId'],
    xlsx: true,
    checkFilters: requireAllocationState,
    columns: [
      { key: 'employeeCode', header: 'Employee code' },
      { key: 'employeeName', header: 'Employee name' },
      { key: 'projectCode', header: 'Project code' },
      { key: 'projectName', header: 'Project name' },
      { key: 'jobCode', header: 'Job code' },
      { key: 'jobName', header: 'Job name' },
      { key: 'startDate', header: 'Start date' },
      { key: 'endDate', header: 'End date' },
      { key: 'allocationPercent', header: 'Allocation %', numeric: true },
      { key: 'state', header: 'State' },
      { key: 'source', header: 'Source' },
      { key: 'overAllocationPeakPercent', header: 'Over-allocation peak %', numeric: true },
      { key: 'overAllocationReason', header: 'Over-allocation reason' },
      { key: 'overAllocationManagerCode', header: 'Over-allocation recorded by manager' },
      { key: 'overAllocationRecordedAt', header: 'Over-allocation recorded at (company time)' },
      { key: 'cancelReason', header: 'Cancellation reason' },
      { key: 'cancelledAt', header: 'Cancelled at (company time)' },
    ],
    rows: (db, grant, f) =>
      allocationExportRows(db, grant, { employeeId: f.employeeId, projectId: f.projectId, jobId: f.jobId, from: f.from, to: f.to, state: f.status }),
  },

  // FR-048 "TMS reports by employee, project, job, activity and period" (I-30): approved hours from the lines of each
  // timesheet's approved revision in force, grouped by all five (GET /timesheet-reports/hours?groupBy=employee,project,
  // job,activity,period under the same scope and filters), every group. Each line is in exactly one row, so the rows add
  // up to the report's totals and to its employee and project totals (FR-048 acceptance). No rate, cost, utilisation or
  // payroll figure (FR-048: optional decisions not to be assumed).
  TMS_HOURS: {
    code: 'TMS_HOURS',
    title: 'TMS hours by employee, project, job, activity and period',
    resource: 'timesheet',
    fieldGroup: 'operational',
    requiresPeriod: true,
    module: 'timesheet',
    maxPeriodDays: MAX_REPORT_DAYS,
    recordFilters: ['employeeId', 'projectId', 'jobId', 'activityId'],
    xlsx: true,
    columns: [
      { key: 'employeeCode', header: 'Employee code' },
      { key: 'employeeName', header: 'Employee name' },
      { key: 'projectCode', header: 'Project code' },
      { key: 'projectName', header: 'Project name' },
      { key: 'jobCode', header: 'Job code' },
      { key: 'jobName', header: 'Job name' },
      { key: 'activityCode', header: 'Activity code' },
      { key: 'activityName', header: 'Activity name' },
      { key: 'periodStart', header: 'Week starting' },
      { key: 'minutes', header: 'Approved minutes', numeric: true },
      { key: 'hours', header: 'Approved hours', numeric: true },
      { key: 'productiveMinutes', header: 'Productive minutes', numeric: true },
      { key: 'lineCount', header: 'Lines', numeric: true },
    ],
    rows: (db, grant, f) => hoursExportRows(db, grant, { from: f.from!, to: f.to!, employeeId: f.employeeId, projectId: f.projectId, jobId: f.jobId, activityId: f.activityId }),
  },

  // FR-038 / H7 payroll reports of one payroll run (`runId`; I-32), served only while the payroll-outputs module is
  // active. Each holds exactly the rows of its JSON report (GET /payroll-outputs/runs/:id/register, /disbursement,
  // /comparison) under the same resource and confidential amount group (payroll_report; the export right is its own
  // permission, payroll_report.export.amount, 0069) and the same scope rules, with the JSON keys as columns and nothing
  // added: the run header and the register totals stay in the JSON (columns await owner-approved samples, I-40 item 12).
  // Payroll freeze register: every record of the run within the requester's row scope, by employee code, with its
  // frozen amounts and held, reserved and paid position (the pages of the JSON register, all of them).
  PAYROLL_REGISTER: {
    code: 'PAYROLL_REGISTER',
    title: 'Payroll register',
    resource: 'payroll_report',
    fieldGroup: 'amount',
    requiresPeriod: false,
    module: 'payroll-outputs',
    recordFilters: ['runId'],
    xlsx: true,
    checkFilters: requireRunOnly,
    checkRequest: (db, grant, f) => requirePayrollRun(db, grant.companyId, f.runId!),
    sourceRevision: (db, grant, f) => payrollRunRevision(db, grant.companyId, f.runId!),
    columns: [
      { key: 'recordId', header: 'Record id' },
      { key: 'employeeId', header: 'Employee id' },
      { key: 'employeeCode', header: 'Employee code' },
      { key: 'employeeName', header: 'Employee name' },
      { key: 'calculationStatus', header: 'Calculation status' },
      { key: 'salaryStopMode', header: 'Salary stop mode' },
      { key: 'paidUnits', header: 'Paid units', ...PAYROLL_MONEY },
      { key: 'earnings', header: 'Earnings', ...PAYROLL_MONEY },
      { key: 'reimbursements', header: 'Reimbursements', ...PAYROLL_MONEY },
      { key: 'deductions', header: 'Deductions', ...PAYROLL_MONEY },
      { key: 'net', header: 'Net', ...PAYROLL_MONEY },
      { key: 'employerContributions', header: 'Employer contributions', ...PAYROLL_MONEY },
      { key: 'bankStatus', header: 'Bank status' },
      { key: 'held', header: 'Held', ...PAYROLL_MONEY },
      { key: 'reserved', header: 'Reserved', ...PAYROLL_MONEY },
      { key: 'paid', header: 'Paid', ...PAYROLL_MONEY },
    ],
    rows: (db, grant, f) => payrollRegisterRows(db, grant, f.runId!),
  },

  // Salary disbursement reconciliation: one row, the JSON report's totals (approved payable = held + reserved + paid +
  // ready). Company figures, so every record of the run must be in the requester's scope (SCOPE_INCOMPLETE). The
  // manifests the JSON lists beside it are H7's bank output manifest, not rows of this report.
  PAYROLL_DISBURSEMENT: {
    code: 'PAYROLL_DISBURSEMENT',
    title: 'Salary disbursement reconciliation',
    resource: 'payroll_report',
    fieldGroup: 'amount',
    requiresPeriod: false,
    module: 'payroll-outputs',
    recordFilters: ['runId'],
    xlsx: true,
    checkFilters: requireRunOnly,
    checkRequest: (db, grant, f) => requireWholePayrollRun(db, grant, f.runId!),
    sourceRevision: (db, grant, f) => payrollRunRevision(db, grant.companyId, f.runId!),
    columns: [
      { key: 'payable', header: 'Approved payable', ...PAYROLL_MONEY },
      { key: 'held', header: 'Held', ...PAYROLL_MONEY },
      { key: 'heldBySalaryStop', header: 'Of held, by salary stop', ...PAYROLL_MONEY },
      { key: 'salaryStopHolds', header: 'Salary stop holds', ...PAYROLL_MONEY },
      { key: 'excludedBySalaryStop', header: 'Excluded by salary stop', ...PAYROLL_MONEY },
      { key: 'reserved', header: 'Reserved', ...PAYROLL_MONEY },
      { key: 'paid', header: 'Paid', ...PAYROLL_MONEY },
      { key: 'ready', header: 'Ready', ...PAYROLL_MONEY },
      { key: 'reconciles', header: 'Reconciles' },
    ],
    rows: (db, grant, f) => disbursementRows(db, grant, f.runId!),
  },

  // Prior-period comparison: the JSON comparison's component rows (current, prior and difference per component and
  // head type), on the run basis when the whole run is in scope, otherwise over the requester's records only.
  PAYROLL_COMPARISON: {
    code: 'PAYROLL_COMPARISON',
    title: 'Payroll prior-period comparison',
    resource: 'payroll_report',
    fieldGroup: 'amount',
    requiresPeriod: false,
    module: 'payroll-outputs',
    recordFilters: ['runId'],
    xlsx: true,
    checkFilters: requireRunOnly,
    checkRequest: (db, grant, f) => requirePayrollRun(db, grant.companyId, f.runId!),
    sourceRevision: (db, grant, f) => payrollRunRevision(db, grant.companyId, f.runId!),
    columns: [
      { key: 'componentCode', header: 'Component code' },
      { key: 'headType', header: 'Head type' },
      { key: 'current', header: 'Current', ...PAYROLL_MONEY },
      { key: 'prior', header: 'Prior', ...PAYROLL_MONEY },
      { key: 'difference', header: 'Difference', ...PAYROLL_MONEY },
    ],
    rows: (db, grant, f) => comparisonRows(db, grant, f.runId!),
  },

  // FR-058: audit export is its own permission (audit.export), separate from ordinary report exports. It shows
  // who did what to which record and when, with field names but never values (see audit-trail/service.ts).
  AUDIT_TRAIL: {
    code: 'AUDIT_TRAIL',
    title: 'Audit trail',
    resource: 'audit',
    fieldGroup: 'operational',
    requiresPeriod: true,
    companyScopeOnly: true,
    maxPeriodDays: 31,
    // BR-026: the viewer's filters, so a filtered view and its export hold the same events.
    recordFilters: ['resource', 'recordKey', 'actorUserId', 'action'],
    columns: [
      { key: 'occurred_at', header: 'Occurred at (company time)' },
      { key: 'resource', header: 'Record kind' },
      { key: 'record_key', header: 'Record id' },
      { key: 'action', header: 'Action' },
      { key: 'actor', header: 'Actor account' },
      { key: 'acting_role', header: 'Acting role' },
      { key: 'prior_version', header: 'Prior version' },
      { key: 'new_version', header: 'New version' },
      { key: 'value_groups', header: 'Value groups recorded' },
      { key: 'changed_fields', header: 'Operational fields' },
      { key: 'reason_recorded', header: 'Reason recorded' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const { select, from } = auditEventQuery(grant, { from: f.from, to: f.to, resource: f.resource, recordKey: f.recordKey, actorUserId: f.actorUserId, action: f.action }, p);
      const rows = (
        await db.query<Record<string, unknown>>(
          `select ${select}, to_char(a.occurred_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI:SS') as occurred_local
             ${from} order by a.occurred_at, a.id`,
          p.values,
        )
      ).rows;
      return rows.map((r) => ({
        occurred_at: r.occurred_local,
        resource: r.resource_code,
        record_key: r.record_key,
        action: r.action,
        actor: r.actor_account_key,
        acting_role: r.acting_role_code ?? '',
        prior_version: r.prior_version,
        new_version: r.new_version,
        value_groups: (r.value_groups as string[]).join(';'),
        changed_fields: (r.changed_fields as string[]).join(';'),
        reason_recorded: r.reason_recorded ? 'yes' : 'no',
      }));
    },
  },
};

/** The catalogue: every report whose module is active (a module's reports are neither listed nor generated otherwise). */
export const REPORTS: Record<string, ReportDefinition> = Object.fromEntries(Object.entries(ALL_REPORTS).filter(([, def]) => !def.module || isModuleActive(def.module)));

export { cellText, csvCell, type ReportContext } from './context.js';

export function toCsv(def: ReportDefinition, rows: Record<string, unknown>[]): string {
  const lines = [def.columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(def.columns.map((c) => csvCell(r[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** An XLSX cell: a number for a numeric column holding a plain decimal (never a formula), otherwise guarded text. */
function xlsxCell(column: ReportDefinition['columns'][number], value: unknown): SheetCell {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : null;
  if (column.numeric && raw !== null && PLAIN_DECIMAL.test(raw)) return { number: raw };
  return cellText(value);
}

/** The CSV file: the context rows (label, value), one blank line, then the report's own header and rows exactly as toCsv writes them. */
export function toCsvOutput(def: ReportDefinition, rows: Record<string, unknown>[], context: ReportContext): string {
  return `${contextCsvLines(context).join('\r\n')}\r\n${toCsv(def, rows)}`;
}

/**
 * FR-046 "Export XLSX": the same header and rows as toCsv, as a worksheet named after the report with its header in row 1, and
 * the context on a second worksheet.
 */
export function toXlsx(def: ReportDefinition, rows: Record<string, unknown>[], context: ReportContext = []): Buffer {
  return xlsxWorkbook(
    def.title,
    [def.columns.map((c) => cellText(c.header)), ...rows.map((r) => def.columns.map((c) => xlsxCell(c, r[c.key])))],
    context.length > 0 ? { name: 'Report context', rows: context.map(([label, value]) => [cellText(label), cellText(oneLine(value))]) } : undefined,
  );
}
