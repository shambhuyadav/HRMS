// My Team member detail (FR-095; DF16; DF02; BR-044). Every category needs its own permission inside the selected
// assignment, on top of the member check: a denied tab or section is absent from the answer, an empty permitted one has
// no rows, and a category with no source in this build says so in plain words (never an empty list that reads as "no
// records"). Only operational columns leave the operational tabs: leave and attendance reasons, participation reasons,
// feedback, plan cost, goal targets, ratings and appraisal narratives stay out. DF16 "history masks protected
// before/after data": the History tab masks everything outside its allowlist, whatever else the caller may hold.
import type { Queryable } from '../../db/queryable.js';
import { notFound } from '../../http/errors.js';
import { type AccessGrant, resolveAccess, SqlParams } from '../access/authorize.js';
import { taskStatusOf } from '../appraisal/appraisals.js';
import type { AppraisalRow } from '../appraisal/common.js';
import { balances } from '../leave/service.js';
import { teamMemberPredicate } from './service.js';

export type TabSection = { available: true; items: unknown[] } | { available: false; message: string };
export type Tab = { available: true; items: unknown[] } | { available: true; data: unknown } | { available: true; sections: Record<string, TabSection> };

/** DF02 lists "approved skills/training" as operational; no skills master or employee skill record exists in this build. */
export const NO_SKILLS_SOURCE = 'This system does not keep a skills record, so no skills can be shown.';

/** The shown text of a protected value in the History tab; the value itself is never read into the answer. */
export const PROTECTED_VALUE = 'Protected';

/** DF02 operational employee-record fields whose earlier and later values the History tab may show (BR-043: anything else is protected). */
const HISTORY_OPERATIONAL_FIELDS: ReadonlySet<string> = new Set(['employeeCode', 'displayName', 'workEmail', 'joiningDate', 'confirmationDate', 'employmentType']);

interface AuditValues {
  action: string;
  occurred_at: Date;
  before_values: Record<string, Record<string, unknown>> | null;
  after_values: Record<string, Record<string, unknown>> | null;
}

/**
 * The changed fields of one audited change to the employee record. A value is shown only when it is in the operational
 * group and on the allowlist; any other field, a stated reason included, is named with its value masked. Left out: status
 * (the status history lists it) and record references (`...Id`), which say nothing to the reader.
 */
function changesOf(e: AuditValues): { field: string; before: unknown; after: unknown; masked: boolean }[] {
  const out: { field: string; before: unknown; after: unknown; masked: boolean }[] = [];
  const groups = new Set([...Object.keys(e.before_values ?? {}), ...Object.keys(e.after_values ?? {})]);
  for (const group of groups) {
    const before = e.before_values?.[group] ?? {};
    const after = e.after_values?.[group] ?? {};
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (group === 'operational' && HISTORY_OPERATIONAL_FIELDS.has(field)) out.push({ field, before: before[field] ?? null, after: after[field] ?? null, masked: false });
      else if (field !== 'status' && !field.endsWith('Id')) out.push({ field, before: PROTECTED_VALUE, after: PROTECTED_VALUE, masked: true });
    }
  }
  return out;
}

/** DF16 History: employment status changes and audited changes to the employee record, newest first, values masked per changesOf. */
async function memberHistory(db: Queryable, grant: AccessGrant, employeeId: string) {
  const statuses = (
    await db.query<{ occurred_at: Date; effective_date: string; status: string; prior: string | null; source: string }>(
      `select h.recorded_at as occurred_at, h.effective_date, st.code as status, ps.code as prior, h.source_kind as source
         from employee_status_history h
         join reference_value st on st.company_id = h.company_id and st.id = h.status_id
         left join reference_value ps on ps.company_id = h.company_id and ps.id = h.prior_status_id
        where h.company_id = $1 and h.employee_id = $2`,
      [grant.companyId, employeeId],
    )
  ).rows.map((s) => ({
    occurredAt: s.occurred_at,
    effectiveDate: s.effective_date,
    action: `STATUS_${s.source}`,
    changes: [{ field: 'status', before: s.prior, after: s.status, masked: false }],
  }));
  const audited = (
    await db.query<AuditValues>(
      `select a.action, a.occurred_at, a.before_values, a.after_values from audit_event a
        where a.company_id = $1 and a.resource_code = 'employee' and a.record_key = $2::uuid and a.action <> 'ACCESS_DENIED'
        order by a.occurred_at desc limit 200`,
      [grant.companyId, employeeId],
    )
  ).rows.flatMap((e) => {
    const changes = changesOf(e);
    return changes.length > 0 ? [{ occurredAt: e.occurred_at, effectiveDate: null, action: e.action, changes }] : [];
  });
  return [...statuses, ...audited].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
}

/** DF02 "approved skills/training": each participation's plan identity, dates, state and attendance facts. */
async function trainingItems(db: Queryable, grant: AccessGrant, employeeId: string): Promise<TabSection> {
  const rows = await db.query(
    `select p.code as "planCode", p.title as "planTitle", to_char(p.start_date, 'YYYY-MM-DD') as "startDate", to_char(p.end_date, 'YYYY-MM-DD') as "endDate",
            t.participation_state as state, t.completed_at as "completedAt"
       from training_participant t join training_plan p on p.company_id = t.company_id and p.id = t.plan_id
      where t.company_id = $1 and t.employee_id = $2
      order by p.start_date desc, p.code limit 200`,
    [grant.companyId, employeeId],
  );
  return { available: true, items: rows.rows };
}

/** DF02 "goal names and completion flags": each appraisal's cycle, task status and goals; targets, scores and comments stay out. */
async function goalItems(db: Queryable, grant: AccessGrant, employeeId: string): Promise<TabSection> {
  const rows = (
    await db.query<{ id: string; state: AppraisalRow['state']; cycleCode: string; cycleName: string; goals: { weight: number }[] }>(
      `select a.id, a.state, c.code as "cycleCode", c.name as "cycleName",
              coalesce((select json_agg(json_build_object('sequence', i.sequence, 'name', i.description, 'weight', i.weight,
                                                          'selfEntryComplete', coalesce(en.self_score is not null, false),
                                                          'managerRatingComplete', coalesce(en.manager_score is not null, false)) order by i.sequence)
                          from appraisal_item i
                          left join appraisal_revision r on r.company_id = a.company_id and r.appraisal_id = a.id and r.revision = a.revision
                          left join appraisal_entry en on en.company_id = i.company_id and en.revision_id = r.id and en.item_id = i.id
                         where i.company_id = a.company_id and i.appraisal_id = a.id and i.active), '[]'::json) as goals
         from appraisal a join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
        where a.company_id = $1 and a.employee_id = $2 and a.state <> 'CANCELLED'
        order by c.start_date desc, a.created_at desc limit 50`,
      [grant.companyId, employeeId],
    )
  ).rows;
  return {
    available: true,
    items: rows.map(({ id: _id, ...r }) => ({ ...r, taskStatus: taskStatusOf(r.state, r.goals.length > 0 && r.goals.reduce((s, g) => s + g.weight, 0) === 100) })),
  };
}

/** Salary arrangements of the member. */
async function salaryItems(db: Queryable, grant: AccessGrant, employeeId: string, withHistory: boolean): Promise<TabSection> {
  const rows = await db.query(
    `select effective_from as "effectiveFrom", effective_to as "effectiveTo", monthly_gross::text as "monthlyGross", annual_ctc::text as "annualCtc", currency_code as currency
       from salary_arrangement where company_id = $1 and employee_id = $2 and superseded_at is null
        and ($3::boolean or effective_to is null or effective_to > $4::date) order by effective_from`,
    [grant.companyId, employeeId, withHistory, grant.businessDate],
  );
  return { available: true, items: rows.rows };
}

/** Applied increments: dates, basis, amounts and the change; the approver's reason is its own grant and is not part of this tab. */
async function incrementItems(db: Queryable, grant: AccessGrant, employeeId: string): Promise<TabSection> {
  const rows = await db.query(
    `select effective_date as "effectiveDate", compensation_basis as basis, currency_code as currency, before_amount::text as "beforeAmount", after_amount::text as "afterAmount",
            change_amount::text as "changeAmount", to_char(change_percent, 'FM999999990.00') as "changePercent", percent_na_reason as "percentNaReason"
       from increment_history_in_force where company_id = $1 and employee_id = $2 order by effective_date, applied_at`,
    [grant.companyId, employeeId],
  );
  return { available: true, items: rows.rows };
}

/** Released documents only (FR-106: a file not scanned clean is not offered); the reviewer's note stays out. */
async function documentItems(db: Queryable, grant: AccessGrant, employeeId: string): Promise<TabSection> {
  const rows = await db.query(
    `select d.id, t.code as "documentType", a.file_name as "fileName", d.expires_on as "expiresOn",
            coalesce(d.expires_on < hrms_business_date(d.company_id, now()), false) as expired, d.created_at as "uploadedAt", d.verification_state as "verificationState"
       from employee_document d
       join reference_value t on t.company_id = d.company_id and t.id = d.document_type_id
       join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
      where d.company_id = $1 and d.employee_id = $2 and a.scan_state = 'CLEAN'
      order by d.created_at desc limit 200`,
    [grant.companyId, employeeId],
  );
  return { available: true, items: rows.rows };
}

/** FR-095 member detail; each tab and section needs its own permission inside the same selected assignment. */
export async function teamMemberDetail(db: Queryable, grant: AccessGrant, employeeId: string) {
  const params = new SqlParams([employeeId]);
  const member = (await db.query(`select e.id from employee e where e.id = $1 and ${teamMemberPredicate(grant, params)}`, params.values)).rows[0];
  if (!member) throw notFound(); // not a current member of this manager in this assignment's scope

  const can = async (resource: string, action: string, fieldGroup: string) => {
    const d = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [fieldGroup] });
    return d.allowed ? d : null;
  };
  const tabs: Record<string, Tab> = {};

  const profile = (
    await db.query(
      `select e.employee_code as "employeeCode", e.display_name as "displayName", e.work_email as "workEmail", e.joining_date as "joiningDate",
              e.confirmation_date as "confirmationDate", st.code as status, et.code as "employmentType"
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
         join reference_value et on et.company_id = e.company_id and et.id = e.employment_type_id
        where e.company_id = $1 and e.id = $2`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  tabs.workProfile = { available: true, data: profile };

  if (await can('team', 'read_history', 'operational')) {
    const reporting = await db.query(
      `select 'ASSIGNMENT' as kind, ea.effective_from as "effectiveFrom", ea.effective_to as "effectiveTo", d.name as detail
         from employment_assignment ea join department d on d.company_id = ea.company_id and d.id = ea.department_id
        where ea.company_id = $1 and ea.employee_id = $2
       union all
       select 'MANAGER', ma.effective_from, ma.effective_to, m.display_name
         from manager_assignment ma join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
        where ma.company_id = $1 and ma.employee_id = $2
       order by 2`,
      [grant.companyId, employeeId],
    );
    tabs.employmentAndReporting = { available: true, items: reporting.rows };
  }
  if (await can('attendance', 'read', 'operational')) {
    const att = await db.query(
      `select r.work_date as "workDate", rv.code as status, r.worked_minutes as "workedMinutes", r.late
         from attendance_record r join reference_value rv on rv.company_id = r.company_id and rv.id = r.status_id
        where r.company_id = $1 and r.employee_id = $2 and r.work_date > $3::date - 30 order by r.work_date desc`,
      [grant.companyId, employeeId, grant.businessDate],
    );
    tabs.attendance = { available: true, items: att.rows };
  }
  const leaveGrant = await can('leave', 'read', 'operational');
  if (leaveGrant) {
    // Operational leave facts only; reasons are confidential and not part of this tab.
    tabs.leave = { available: true, data: await balances(db, leaveGrant, employeeId) };
  }
  if (await can('training_participant', 'read', 'operational')) {
    tabs.skillsAndTraining = { available: true, sections: { training: await trainingItems(db, grant, employeeId), skills: { available: false, message: NO_SKILLS_SOURCE } } };
  }
  if (await can('appraisal', 'read', 'operational')) {
    tabs.goalsAndTasks = { available: true, sections: { goals: await goalItems(db, grant, employeeId) } };
  }
  if (await can('team', 'read_history', 'operational')) tabs.history = { available: true, items: await memberHistory(db, grant, employeeId) };

  // Confidential tabs (DF16): present only with the specific field grant in this assignment, each section under its own.
  const compensation: Record<string, TabSection> = {};
  // C4 "Historical financial views require an explicit history grant": a new manager gets the current salary, not the past.
  if (await can('salary', 'read', 'salary')) compensation.salaryArrangements = await salaryItems(db, grant, employeeId, (await can('salary', 'history_read', 'salary')) !== null);
  if (await can('increment', 'history_read', 'salary')) compensation.incrementHistory = await incrementItems(db, grant, employeeId);
  if (Object.keys(compensation).length > 0) tabs.compensation = { available: true, sections: compensation };

  const privateInformation: Record<string, TabSection> = {};
  if (await can('employee', 'read', 'personal')) {
    const personal = await db.query(`select date_of_birth as "dateOfBirth" from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId]);
    privateInformation.personal = { available: true, items: personal.rows };
  }
  if (await can('document', 'read', 'document')) privateInformation.documents = await documentItems(db, grant, employeeId);
  if (Object.keys(privateInformation).length > 0) tabs.privateInformation = { available: true, sections: privateInformation };

  return { employeeId, tabs };
}
