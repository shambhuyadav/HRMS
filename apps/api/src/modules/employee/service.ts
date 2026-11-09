// Employee records (FR-006/007/008, BR-001/002, DF04). Field groups:
//   operational – code, name, work email and work phone extension, dates, type, status, current assignment and manager
//                 (DF02 operational; the extension is DF16's, I-89 item 5)
//   personal    – birth date, service anniversary base date (confidential by default, BR-043/044)
// Lists only ever return operational fields. Every read and write applies the same row-scope predicate.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { type MasterTable, requireUsableMaster } from '../org/masters.js';

export const PERSONAL_FIELDS = ['dateOfBirth', 'serviceAnniversaryDate'] as const;

export interface EmployeeOperational {
  id: string;
  employeeCode: string;
  displayName: string;
  workEmail: string | null;
  /** DF16 "work email/extension": an optional desk-phone extension, digits only (I-89 item 5; 0240). */
  workPhoneExtension: string | null;
  joiningDate: string;
  confirmationDate: string | null;
  employmentType: string;
  status: string;
  assignment: {
    departmentId: string;
    departmentName: string;
    locationId: string;
    locationName: string;
    designationId: string;
    designationName: string;
    gradeId: string | null;
    /** One record only, with the grade master's read duty (see withRecordFacts). */
    gradeCode?: string | null;
    gradeName?: string | null;
  } | null;
  manager: { id: string; employeeCode: string; displayName: string } | null;
  version: number;
}

export interface EmployeePersonal {
  dateOfBirth: string | null;
  serviceAnniversaryDate: string | null;
}

/** What one record says beyond a list row (see withRecordFacts). */
export interface EmployeeRecordFacts {
  shift: { id: string; code: string; name: string } | null;
  noManagerReason: string | null;
}

export type EmployeeView = EmployeeOperational & Partial<EmployeePersonal> & Partial<EmployeeRecordFacts>;

interface EmployeeRow {
  id: string;
  employee_code: string;
  display_name: string;
  work_email: string | null;
  work_phone_extension: string | null;
  joining_date: string;
  confirmation_date: string | null;
  employment_type: string;
  status: string;
  department_id: string | null;
  department_name: string | null;
  location_id: string | null;
  location_name: string | null;
  designation_id: string | null;
  designation_name: string | null;
  grade_id: string | null;
  manager_id: string | null;
  manager_code: string | null;
  manager_name: string | null;
  version: number;
  date_of_birth: string | null;
  service_anniversary_date: string | null;
  total?: string;
}

// Current assignment and manager are resolved on the company business date carried by the grant.
function selectEmployees(params: SqlParams, grant: AccessGrant, withPersonal: boolean): string {
  const day = `${params.add(grant.businessDate)}::date`;
  return `
    select e.id, e.employee_code, e.display_name, e.work_email, e.work_phone_extension, e.joining_date, e.confirmation_date,
           et.code as employment_type, st.code as status,
           ea.department_id, d.name as department_name, ea.location_id, l.name as location_name,
           ea.designation_id, g.name as designation_name, ea.grade_id,
           m.id as manager_id, m.employee_code as manager_code, m.display_name as manager_name,
           e.version
           ${withPersonal ? ', e.date_of_birth, e.service_anniversary_date' : ', null::date as date_of_birth, null::date as service_anniversary_date'}
      from employee e
      join reference_value et on et.company_id = e.company_id and et.id = e.employment_type_id
      join reference_value st on st.company_id = e.company_id and st.id = e.status_id
      left join employment_assignment ea
             on ea.company_id = e.company_id and ea.employee_id = e.id
            and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
      left join department d on d.company_id = ea.company_id and d.id = ea.department_id
      left join location l on l.company_id = ea.company_id and l.id = ea.location_id
      left join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
      left join manager_assignment ma
             on ma.company_id = e.company_id and ma.employee_id = e.id
            and ma.effective_from <= ${day} and (ma.effective_to is null or ma.effective_to > ${day})
      left join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id`;
}

function toView(row: EmployeeRow, withPersonal: boolean): EmployeeView {
  const view: EmployeeView = {
    id: row.id,
    employeeCode: row.employee_code,
    displayName: row.display_name,
    workEmail: row.work_email,
    workPhoneExtension: row.work_phone_extension,
    joiningDate: row.joining_date,
    confirmationDate: row.confirmation_date,
    employmentType: row.employment_type,
    status: row.status,
    assignment:
      row.department_id && row.location_id && row.designation_id
        ? {
            departmentId: row.department_id,
            departmentName: row.department_name ?? '',
            locationId: row.location_id,
            locationName: row.location_name ?? '',
            designationId: row.designation_id,
            designationName: row.designation_name ?? '',
            gradeId: row.grade_id,
          }
        : null,
    manager: row.manager_id ? { id: row.manager_id, employeeCode: row.manager_code ?? '', displayName: row.manager_name ?? '' } : null,
    version: row.version,
  };
  // Denied groups are absent from the payload, not nulled or masked (FR-095/098).
  if (withPersonal) {
    view.dateOfBirth = row.date_of_birth;
    view.serviceAnniversaryDate = row.service_anniversary_date;
  }
  return view;
}

/** FR-007 list filters, shared by the employee list and the employee register export (identical filters and scope). */
/**
 * Named sets of employee statuses a list can filter by. ACTIVE: DF17 "Employee count excludes draft/separated/archived records".
 *
 * The others are BR-003 / FR-006's reference views (Current, Offered, Offered Rejected, On Probation, On Notice, Left), decided
 * under owner delegation, 6 Nov 2026 (docs/03 I-82 item 3). They are views over DF04's lifecycle states, not stored statuses, and
 * may overlap (BR-003 "not assumed to be one exclusive stored status"): an employee on notice is both Current and On Notice.
 *   CURRENT           employed today: probation, confirmed or notice. On Notice stays Current: the person is employed and paid
 *                     until the approved last working date (DF04), and DF17's active count already includes them.
 *   OFFERED           a pre-joining record (DRAFT): an accepted offer handed over to onboarding (FR-014) or a joiner HR entered,
 *                     not yet activated. A candidate whose offer is still awaiting an answer is not an employee record and stays
 *                     in hiring's offer list (state APPROVED), under the hiring grants.
 *   OFFERED_REJECTED  a pre-joining record closed because the person never joined (close-draft, DRAFT_CLOSED in the status
 *                     history). An offer the candidate declined stays in hiring's offer list (state DECLINED).
 *   ON_PROBATION, ON_NOTICE  the one lifecycle state each.
 *   LEFT              separated, or archived after leaving (never a record closed before joining).
 */
export const EMPLOYEE_STATUS_GROUPS = {
  ACTIVE: ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'],
  CURRENT: ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'],
  OFFERED: ['DRAFT'],
  OFFERED_REJECTED: ['ARCHIVED'],
  ON_PROBATION: ['ACTIVE_PROBATION'],
  ON_NOTICE: ['NOTICE'],
  LEFT: ['INACTIVE_SEPARATED', 'ARCHIVED'],
} as const;
export type EmployeeStatusGroup = keyof typeof EMPLOYEE_STATUS_GROUPS;

/** Whether the employee `e` was closed before joining (the close-draft status change, employee/changes.ts closeDraftEmployee). */
const CLOSED_BEFORE_JOINING = `exists (select 1 from employee_status_history sh where sh.company_id = e.company_id and sh.employee_id = e.id and sh.source_kind = 'DRAFT_CLOSED')`;

/** The predicate of one status group over `e` and its status `st`. */
function statusGroupCondition(params: SqlParams, group: EmployeeStatusGroup): string {
  const statuses = `st.code = any(${params.add(EMPLOYEE_STATUS_GROUPS[group])}::text[])`;
  // An archived record is Offered Rejected when it was closed before joining, and Left otherwise.
  if (group === 'OFFERED_REJECTED') return `(${statuses} and ${CLOSED_BEFORE_JOINING})`;
  if (group === 'LEFT') return `(${statuses} and (st.code <> 'ARCHIVED' or not ${CLOSED_BEFORE_JOINING}))`;
  return statuses;
}

export interface EmployeeFilters {
  search?: string | undefined;
  status?: string | undefined;
  /** One of EMPLOYEE_STATUS_GROUPS: the list's own filter, which the dashboard's "Active employees" links with. */
  statusGroup?: EmployeeStatusGroup | undefined;
  departmentId?: string | undefined;
  /** Joining date range, inclusive (company-local dates). */
  joinedFrom?: string | undefined;
  joinedTo?: string | undefined;
  /** FR-007 sortable list columns; the employee register applies the same order. */
  sort?: EmployeeSort | undefined;
  direction?: SortDirection | undefined;
}

/** The sortable columns (allowlist: the value picks a column name here, it never reaches SQL). */
export const EMPLOYEE_SORTS = ['employeeCode', 'displayName', 'joiningDate', 'status', 'department', 'location', 'designation'] as const;
export type EmployeeSort = (typeof EMPLOYEE_SORTS)[number];
export const SORT_DIRECTIONS = ['ASC', 'DESC'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * The stable order of the list and the register (FR-007, I-37): the chosen column, blanks last in either direction, then
 * employee code and id, which are unique. `columns` names the same values in each caller's query.
 */
export function employeeOrderBy(f: Pick<EmployeeFilters, 'sort' | 'direction'>, columns: Readonly<Record<EmployeeSort | 'id', string>>): string {
  const direction = f.direction === 'DESC' ? 'desc' : 'asc';
  const sort = f.sort ?? 'employeeCode';
  // The code is the tie-breaker for every other column and follows the chosen direction only when it is the column chosen.
  const tieBreak = sort === 'employeeCode' ? direction : 'asc';
  const primary = sort === 'employeeCode' ? '' : `${columns[sort]} ${direction} nulls last, `;
  return `${primary}${columns.employeeCode} ${tieBreak}, ${columns.id} ${tieBreak}`;
}

export interface ListQuery extends EmployeeFilters {
  page: number;
  pageSize: number;
}

/** FR-007 "date ranges are validated": an end before its start is refused, never silently swapped or emptied. */
export function assertEmployeeFilters(f: EmployeeFilters): void {
  if (f.joinedFrom && f.joinedTo && f.joinedTo < f.joinedFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The joining date range ends before it starts');
}

/**
 * The filter predicates over `e` (employee), `st` (its status) and `ea` (its assignment on the grant's business date),
 * added to the caller's row-scope predicate; the employee list and the employee register both use exactly these.
 */
export function employeeFilterConditions(params: SqlParams, f: EmployeeFilters): string[] {
  assertEmployeeFilters(f);
  const conditions: string[] = [];
  if (f.search) {
    const pattern = params.add(`%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    // DF16 "Search includes permitted work email/extension": both are operational (I-89 item 5).
    conditions.push(`(e.employee_code ilike ${pattern} or e.display_name ilike ${pattern} or e.work_email ilike ${pattern} or e.work_phone_extension like ${pattern})`);
  }
  if (f.status) conditions.push(`st.code = ${params.add(f.status)}`);
  if (f.statusGroup) conditions.push(statusGroupCondition(params, f.statusGroup));
  if (f.departmentId) conditions.push(`ea.department_id = ${params.add(f.departmentId)}::uuid`);
  if (f.joinedFrom) conditions.push(`e.joining_date >= ${params.add(f.joinedFrom)}::date`);
  if (f.joinedTo) conditions.push(`e.joining_date <= ${params.add(f.joinedTo)}::date`);
  return conditions;
}

export async function listEmployees(db: Queryable, grant: AccessGrant, q: ListQuery) {
  const params = new SqlParams();
  const conditions = [employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params)];
  const base = selectEmployees(params, grant, false);
  conditions.push(...employeeFilterConditions(params, q));
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);

  // Count and page come from the same filtered set in one statement (BR-026).
  const rows = (
    await db.query<EmployeeRow>(
      `select *, count(*) over () as total from (${base} where ${conditions.join(' and ')}) x
        order by ${employeeOrderBy(q, { employeeCode: 'employee_code', displayName: 'display_name', joiningDate: 'joining_date', status: 'status', department: 'department_name', location: 'location_name', designation: 'designation_name', id: 'id' })}
        limit ${limit} offset ${offset}`,
      params.values,
    )
  ).rows;
  return {
    items: rows.map((r) => toView(r, false)),
    total: rows[0]?.total ? Number(rows[0].total) : await countOnly(db, grant, q),
    page: q.page,
    pageSize: q.pageSize,
  };
}

// When the requested page is past the end, window counts are unavailable; count separately with identical filters.
async function countOnly(db: Queryable, grant: AccessGrant, q: ListQuery): Promise<number> {
  if (q.page === 1) return 0;
  const { total } = await listEmployees(db, grant, { ...q, page: 1, pageSize: 1 });
  return total;
}

export async function getEmployee(db: Queryable, grant: AccessGrant, id: string): Promise<EmployeeView | null> {
  if (!(await canAccessEmployee(db, grant, id))) return null;
  const withPersonal = grant.allowedFieldGroups.includes('personal');
  const params = new SqlParams();
  const sql = `${selectEmployees(params, grant, withPersonal)} where e.company_id = ${params.add(grant.companyId)}::uuid and e.id = ${params.add(id)}::uuid`;
  const row = (await db.query<EmployeeRow>(sql, params.values)).rows[0];
  return row ? withRecordFacts(db, grant, toView(row, withPersonal)) : null;
}

/**
 * DF04's assigned shift, in force on the business date, is an operational fact of the record (DF02 "work attendance times").
 * The other two stay with the grants that already reached them, in this same assignment, so nobody reads more than before:
 * DF02 lists grade neither way and BR-043 defaults the unlisted to confidential, so its words need the grade master's read
 * duty; a no-manager reason is a private reason (DF02) that the My Team history masks, and it needs the history duty that shows
 * manager reasons on the timeline (I-64). A key left out means the assignment does not reach it (FR-095/098).
 */
async function withRecordFacts(db: Queryable, grant: AccessGrant, view: EmployeeView): Promise<EmployeeView> {
  const may = async (resource: string, action: string) =>
    (await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: ['operational'], at: grant.at })).allowed;
  const key = [grant.companyId, view.id];
  view.shift =
    (
      await db.query<{ id: string; code: string; name: string }>(
        `select s.id, s.code, s.name
           from shift_assignment sa join shift s on s.company_id = sa.company_id and s.id = sa.shift_id
          where sa.company_id = $1 and sa.employee_id = $2 and sa.effective_from <= $3::date and (sa.effective_to is null or sa.effective_to > $3::date)`,
        [...key, grant.businessDate],
      )
    ).rows[0] ?? null;
  if (view.assignment && (await may('org_master', 'read'))) {
    const grade = view.assignment.gradeId ? (await db.query<{ code: string; name: string }>(`select code, name from grade where company_id = $1 and id = $2`, [grant.companyId, view.assignment.gradeId])).rows[0] : undefined;
    view.assignment.gradeCode = grade?.code ?? null;
    view.assignment.gradeName = grade?.name ?? null;
  }
  if (await may('employee', 'read_history')) {
    // Only while nobody manages the employee: a reason given earlier stays on the timeline, not on the record.
    view.noManagerReason = view.manager ? null : ((await db.query<{ no_manager_reason: string | null }>(`select no_manager_reason from employee where company_id = $1 and id = $2`, key)).rows[0]?.no_manager_reason ?? null);
  }
  return view;
}

export interface CreateEmployeeInput {
  employeeCode: string;
  displayName: string;
  workEmail?: string | undefined;
  workPhoneExtension?: string | undefined;
  joiningDate: string;
  employmentType: string;
  departmentId: string;
  locationId: string;
  designationId: string;
  gradeId?: string | undefined;
  dateOfBirth?: string | undefined;
  serviceAnniversaryDate?: string | undefined;
  /** DF04: the ended employment in this company that this one follows. */
  priorEmployeeId?: string | undefined;
}

/** Creation needs company scope; assignment filters must admit the target department/location. */
function assertCreateWithinScope(grant: AccessGrant, input: CreateEmployeeInput): void {
  const { departments, locations, employees } = grant.filters;
  const outside =
    grant.scopeKind !== 'COMPANY' ||
    employees.length > 0 ||
    (departments.length > 0 && !departments.includes(input.departmentId)) ||
    (locations.length > 0 && !locations.includes(input.locationId));
  if (outside) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

/**
 * DF04 "a new employment links to the prior one": an employment of this company, in the caller's scope, that has ended, and
 * the new joining after its approved last working date (BR-002). The unique index gives an employment one successor.
 */
async function assertPriorEmployment(db: Queryable, grant: AccessGrant, priorEmployeeId: string, joiningDate: string): Promise<void> {
  if (!(await canAccessEmployee(db, grant, priorEmployeeId))) throw new HttpError(422, 'INVALID_REFERENCE', 'Prior employment not found');
  const prior = (
    await db.query<{ status: string; leaving_date: string | null }>(
      `select st.code as status,
              (select x.leaving_date from exit_case x where x.company_id = e.company_id and x.employee_id = e.id and x.state in ('APPROVED', 'SEPARATED')
                order by x.approved_at desc nulls last limit 1) as leaving_date
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2`,
      [grant.companyId, priorEmployeeId],
    )
  ).rows[0];
  if (prior?.status !== 'INACTIVE_SEPARATED') throw new HttpError(422, 'PRIOR_EMPLOYMENT_NOT_ENDED', 'The prior employment must have ended');
  if (prior.leaving_date !== null && joiningDate <= prior.leaving_date) {
    throw new HttpError(422, 'CHRONOLOGY_CONFLICT', 'The new employment must start after the last working date of the prior one', { conflict: 'PRIOR_EMPLOYMENT', lastWorkingDate: prior.leaving_date });
  }
}

async function referenceId(db: Queryable, companyId: string, category: string, code: string): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `select id from reference_value where company_id = $1 and category = $2 and code = $3 and active`,
      [companyId, category, code],
    )
  ).rows[0];
  if (!row) throw new HttpError(422, 'INVALID_REFERENCE', `${category} ${code} is not an active value`);
  return row.id;
}

/** Returns the new employee id. The caller re-reads it under a read grant, so the response shows only readable fields. */
export async function createEmployee(tx: Queryable, grant: AccessGrant, input: CreateEmployeeInput): Promise<string> {
  assertCreateWithinScope(grant, input);
  await reassertAccess(tx, grant, 'employee', 'create', PERSONAL_FIELDS.some((f) => input[f] !== undefined) ? ['operational', 'personal'] : ['operational']);
  const companyId = grant.companyId;
  const masters: [MasterTable, string | undefined][] = [
    ['department', input.departmentId],
    ['location', input.locationId],
    ['designation', input.designationId],
    ['grade', input.gradeId],
  ];
  // FR-004: usable on the joining date; a back-dated joining before a master closed is still accepted.
  for (const [table, id] of masters) if (id) await requireUsableMaster(tx, table, companyId, id, input.joiningDate);
  if (input.priorEmployeeId) await assertPriorEmployment(tx, grant, input.priorEmployeeId, input.joiningDate);
  const employmentTypeId = await referenceId(tx, companyId, 'EMPLOYMENT_TYPE', input.employmentType);
  const draftStatusId = await referenceId(tx, companyId, 'EMPLOYEE_STATUS', 'DRAFT');

  const employeeCode = input.employeeCode.trim().toUpperCase();
  const workEmail = input.workEmail?.trim().toLowerCase() ?? null;
  const workPhoneExtension = workExtension(input.workPhoneExtension);
  const created = (
    await tx.query<{ id: string; version: number }>(
      `insert into employee (company_id, employee_code, display_name, work_email, joining_date, employment_type_id, status_id,
                             date_of_birth, service_anniversary_date, prior_employee_id, created_by, updated_by, work_phone_extension)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12) returning id, version`,
      [
        companyId,
        employeeCode,
        input.displayName.trim(),
        workEmail,
        input.joiningDate,
        employmentTypeId,
        draftStatusId,
        input.dateOfBirth ?? null,
        input.serviceAnniversaryDate ?? null,
        input.priorEmployeeId ?? null,
        grant.userId,
        workPhoneExtension,
      ],
    )
  ).rows[0]!;

  await tx.query(
    `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id,
                                        effective_from, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [companyId, created.id, input.departmentId, input.locationId, input.designationId, input.gradeId ?? null, input.joiningDate, grant.userId],
  );

  const operational = {
    employeeCode,
    displayName: input.displayName.trim(),
    workEmail,
    ...(workPhoneExtension !== null ? { workPhoneExtension } : {}),
    joiningDate: input.joiningDate,
    employmentType: input.employmentType,
    status: 'DRAFT',
    departmentId: input.departmentId,
    locationId: input.locationId,
    designationId: input.designationId,
    gradeId: input.gradeId ?? null,
    priorEmployeeId: input.priorEmployeeId ?? null,
  };
  const personal = pickDefined({ dateOfBirth: input.dateOfBirth, serviceAnniversaryDate: input.serviceAnniversaryDate });
  await writeAudit(tx, {
    companyId,
    resource: 'employee',
    recordKey: created.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: created.version,
    // Audit values are grouped by field group so audit readers can be redacted per classification.
    after: Object.keys(personal).length ? { operational, personal } : { operational },
  });
  await enqueueEvent(tx, {
    companyId,
    topic: 'employee.created',
    aggregateId: created.id,
    dedupeKey: `employee.created:${created.id}`,
    payload: { employeeId: created.id, version: created.version },
  });
  return created.id;
}

export interface UpdateEmployeeInput {
  expectedVersion: number;
  displayName?: string | undefined;
  workEmail?: string | null | undefined;
  workPhoneExtension?: string | null | undefined;
  dateOfBirth?: string | null | undefined;
  serviceAnniversaryDate?: string | null | undefined;
}

/**
 * DF16 work phone extension (I-89 item 5; 0240): optional, digits only, at most 8, spaces around it ignored; an empty value
 * clears it. The route schema already refuses anything else; the database check holds the same rule for every writer.
 */
export const WORK_PHONE_EXTENSION_PATTERN = '^\\s*[0-9]{1,8}\\s*$';
function workExtension(value: string | null | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v === '') return null;
  if (!/^[0-9]{1,8}$/.test(v)) throw new HttpError(422, 'INVALID_WORK_PHONE_EXTENSION', 'A work phone extension is 1 to 8 digits', { field: 'workPhoneExtension' });
  return v;
}

const COLUMN: Record<string, { column: string; group: 'operational' | 'personal' }> = {
  displayName: { column: 'display_name', group: 'operational' },
  workEmail: { column: 'work_email', group: 'operational' },
  workPhoneExtension: { column: 'work_phone_extension', group: 'operational' },
  dateOfBirth: { column: 'date_of_birth', group: 'personal' },
  serviceAnniversaryDate: { column: 'service_anniversary_date', group: 'personal' },
};

export function fieldGroupsForUpdate(input: UpdateEmployeeInput): string[] {
  const groups = new Set<string>();
  for (const key of Object.keys(input)) {
    const def = COLUMN[key];
    if (def) groups.add(def.group);
  }
  return [...groups];
}

export async function updateEmployee(tx: Queryable, grant: AccessGrant, id: string, input: UpdateEmployeeInput): Promise<void> {
  if (!(await canAccessEmployee(tx, grant, id))) throw notFound();

  const current = (
    await tx.query<Record<string, unknown> & { version: number }>(
      `select display_name, work_email, work_phone_extension, date_of_birth, service_anniversary_date, version
         from employee where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!current) throw notFound();
  // The groups this change writes, under the authority current after the record's lock, not the one the route guard saw.
  await reassertAccess(tx, grant, 'employee', 'update', fieldGroupsForUpdate(input));
  if (current.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');

  const normalise = (key: string, value: unknown) =>
    key === 'workEmail' && typeof value === 'string'
      ? value.trim().toLowerCase()
      : key === 'displayName' && typeof value === 'string'
        ? value.trim()
        : key === 'workPhoneExtension'
          ? workExtension(value as string | null)
          : value;

  const sets: string[] = [];
  const values: unknown[] = [grant.companyId, id, grant.userId];
  const before: Record<string, Record<string, unknown>> = {};
  const after: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of Object.entries(input)) {
    const def = COLUMN[key];
    if (!def || raw === undefined) continue;
    const value = normalise(key, raw);
    if (current[def.column] === value) continue;
    values.push(value);
    sets.push(`${def.column} = $${values.length}`);
    (before[def.group] ??= {})[key] = current[def.column];
    (after[def.group] ??= {})[key] = value;
  }

  if (sets.length > 0) {
    const updated = (
      await tx.query<{ version: number }>(
        `update employee set ${sets.join(', ')}, updated_by = $3 where company_id = $1 and id = $2 returning version`,
        values,
      )
    ).rows[0]!;
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'employee',
      recordKey: id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'UPDATE',
      priorVersion: current.version,
      newVersion: updated.version,
      before,
      after,
    });
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'employee.updated',
      aggregateId: id,
      dedupeKey: `employee.updated:${id}:${updated.version}`,
      payload: { employeeId: id, version: updated.version },
    });
  }
}

function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
