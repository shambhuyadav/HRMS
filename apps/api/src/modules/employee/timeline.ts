// The effective-dated employee timeline (FR-089; BR-038; DF14 "Timeline preserves employee joining, transfers, reporting/
// grade/location changes, confirmations/extensions, salary revisions and separation; each event links its source decision").
//
// Read from the records each module already keeps, so nothing is copied and nothing can disagree: a correction or reversal
// is a further event, never a rewritten one. Operational categories follow row scope. DF14: salary amounts, percentages and
// confidential before/after facts are for eligible Admin or Manager grants, and C4 makes the financial past a grant of its own,
// so without the history grant the salary and increment events are left out altogether, a free-text decision reason needs its
// own module's reason grant, and an employee master change names its fields, never their values. The as-of view gives the
// approved assignment, manager, status and, with the salary history grant, salary on a chosen date (FR-089 acceptance).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, canAccessEmployee, resolveAccess } from '../access/authorize.js';
import { decidedOnBehalfOfUser } from '../workflow/engine.js';

export type TimelineCategory = 'JOINING' | 'STATUS' | 'CONFIRMATION' | 'ORGANISATION' | 'MANAGER' | 'MASTER' | 'SALARY' | 'INCREMENT' | 'EXIT';

export interface TimelineEvent {
  category: TimelineCategory;
  type: string;
  effectiveDate: string;
  recordedAt: Date;
  actor: string | null;
  /**
   * access-4 follow-up (C4; I-57 item 7): the account an approval decision was taken for, when the event's actor took it as a delegate
   * under a delegation (the event links that decision as its `source.decisionId`); null otherwise. Always present in the answer.
   */
  onBehalfOf?: string | null;
  reason: string | null;
  source: { kind: string; id: string; decisionId?: string | null } | null;
  details: Record<string, unknown>;
}

/** The status changes shown as events of their own; the others are told by the joining, confirmation and exit events. */
const STATUS_ONLY_KINDS = ['ACTIVATION', 'DRAFT_CLOSED', 'DIRECT'];
const EXIT_KINDS = ['EXIT_APPROVED', 'EXIT_WITHDRAWN', 'SEPARATION'];

const ACTOR = (user: string) => `(select u.account_key from user_account u where u.id = ${user})`;

interface ChangeAudit {
  id: string;
  actor: string | null;
  reason: string | null;
}

/** The audit records of an effective-dated change, by the date it took effect (the latest for a date): who and why. */
async function changeAudits(db: Queryable, companyId: string, resource: string, employeeId: string): Promise<Map<string, ChangeAudit>> {
  const rows = (
    await db.query<ChangeAudit & { effective: string | null }>(
      `select a.id, ${ACTOR('a.actor_user_id')} as actor, a.reason, a.after_values->'operational'->>'effectiveFrom' as effective
         from audit_event a where a.company_id = $1 and a.resource_code = $2 and a.record_key = $3 and a.action = 'UPDATE' order by a.occurred_at`,
      [companyId, resource, employeeId],
    )
  ).rows;
  return new Map(rows.filter((r) => r.effective).map((r) => [r.effective!, r]));
}

interface OrgRow {
  effective_from: string;
  actor: string | null;
  recorded_at: Date;
  department: string;
  location: string;
  designation: string;
  grade: string | null;
}
const orgOf = (r: OrgRow) => ({ department: r.department, location: r.location, designation: r.designation, grade: r.grade });

async function joiningEvents(db: Queryable, companyId: string, employeeId: string): Promise<TimelineEvent[]> {
  const e = (
    await db.query<{ joining_date: string; created_at: Date; actor: string | null; handover_id: string | null; prior_code: string | null }>(
      `select e.joining_date, e.created_at, ${ACTOR('e.created_by')} as actor, h.id as handover_id, p.employee_code as prior_code
         from employee e
         left join hiring_handover h on h.company_id = e.company_id and h.employee_id = e.id
         left join employee p on p.company_id = e.company_id and p.id = e.prior_employee_id
        where e.company_id = $1 and e.id = $2`,
      [companyId, employeeId],
    )
  ).rows[0]!;
  const corrections = (
    await db.query<{ id: string; prior_date: string; new_date: string; recorded_at: Date; actor: string | null; reason: string | null }>(
      `select c.id, c.prior_date, c.new_date, c.recorded_at, ${ACTOR('c.actor_user_id')} as actor,
              (select a.reason from audit_event a where a.company_id = c.company_id and a.resource_code = 'employee' and a.record_key = c.employee_id and a.action = 'CORRECT_JOINING_DATE'
                  and a.after_values->'operational'->>'joiningDate' = to_char(c.new_date, 'YYYY-MM-DD') order by a.occurred_at desc limit 1) as reason
         from employee_joining_date_change c where c.company_id = $1 and c.employee_id = $2`,
      [companyId, employeeId],
    )
  ).rows;
  return [
    {
      category: 'JOINING',
      type: 'JOINED',
      effectiveDate: e.joining_date,
      recordedAt: e.created_at,
      actor: e.actor,
      reason: null,
      source: e.handover_id ? { kind: 'HIRING_HANDOVER', id: e.handover_id } : { kind: 'EMPLOYEE', id: employeeId },
      details: e.prior_code ? { priorEmployeeCode: e.prior_code } : {},
    },
    ...corrections.map(
      (c): TimelineEvent => ({
        category: 'JOINING',
        type: 'JOINING_DATE_CORRECTED',
        effectiveDate: c.new_date,
        recordedAt: c.recorded_at,
        actor: c.actor,
        reason: c.reason,
        source: { kind: 'EMPLOYEE', id: employeeId },
        details: { priorDate: c.prior_date, newDate: c.new_date },
      }),
    ),
  ];
}

async function organisationEvents(db: Queryable, companyId: string, employeeId: string): Promise<TimelineEvent[]> {
  const audits = await changeAudits(db, companyId, 'employment_assignment', employeeId);
  const rows = (
    await db.query<OrgRow & { id: string }>(
      `select ea.id, ea.effective_from, ea.created_at as recorded_at, ${ACTOR('ea.created_by')} as actor, d.name as department, l.name as location, g.name as designation, gr.code as grade
         from employment_assignment ea
         join department d on d.company_id = ea.company_id and d.id = ea.department_id
         join location l on l.company_id = ea.company_id and l.id = ea.location_id
         join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
         left join grade gr on gr.company_id = ea.company_id and gr.id = ea.grade_id
        where ea.company_id = $1 and ea.employee_id = $2 order by ea.effective_from`,
      [companyId, employeeId],
    )
  ).rows;
  return rows.map((r, i): TimelineEvent => {
    const audit = audits.get(r.effective_from);
    return {
      category: 'ORGANISATION',
      type: i === 0 ? 'ASSIGNED' : 'ASSIGNMENT_CHANGED',
      effectiveDate: r.effective_from,
      recordedAt: r.recorded_at,
      actor: audit?.actor ?? r.actor,
      reason: audit?.reason ?? null,
      source: audit ? { kind: 'AUDIT_EVENT', id: audit.id } : { kind: 'EMPLOYEE', id: employeeId },
      details: { from: i === 0 ? null : orgOf(rows[i - 1]!), to: orgOf(r) },
    };
  });
}

async function managerEvents(db: Queryable, companyId: string, employeeId: string): Promise<TimelineEvent[]> {
  const audits = await changeAudits(db, companyId, 'manager_assignment', employeeId);
  const rows = (
    await db.query<{ effective_from: string; effective_to: string | null; updated_at: Date; created_at: Date; actor: string | null; code: string; name: string }>(
      `select ma.effective_from, ma.effective_to, ma.created_at, ma.updated_at, ${ACTOR('ma.created_by')} as actor, m.employee_code as code, m.display_name as name
         from manager_assignment ma join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
        where ma.company_id = $1 and ma.employee_id = $2 order by ma.effective_from`,
      [companyId, employeeId],
    )
  ).rows;
  const events: TimelineEvent[] = [];
  rows.forEach((r, i) => {
    const prior = rows[i - 1];
    const contiguous = prior?.effective_to === r.effective_from;
    const audit = audits.get(r.effective_from);
    events.push({
      category: 'MANAGER',
      type: i === 0 || !contiguous ? 'MANAGER_SET' : 'MANAGER_CHANGED',
      effectiveDate: r.effective_from,
      recordedAt: r.created_at,
      actor: audit?.actor ?? r.actor,
      reason: audit?.reason ?? null,
      source: audit ? { kind: 'AUDIT_EVENT', id: audit.id } : { kind: 'EMPLOYEE', id: employeeId },
      details: { from: contiguous ? { code: prior!.code, name: prior!.name } : null, to: { code: r.code, name: r.name } },
    });
    // DF04: an interval closed with no successor is an explicit removal, with its recorded reason.
    if (r.effective_to && rows[i + 1]?.effective_from !== r.effective_to) {
      const removal = audits.get(r.effective_to);
      events.push({
        category: 'MANAGER',
        type: 'MANAGER_REMOVED',
        effectiveDate: r.effective_to,
        recordedAt: r.updated_at,
        actor: removal?.actor ?? null,
        reason: removal?.reason ?? null,
        source: removal ? { kind: 'AUDIT_EVENT', id: removal.id } : { kind: 'EMPLOYEE', id: employeeId },
        details: { from: { code: r.code, name: r.name }, to: null },
      });
    }
  });
  return events;
}

/** Status changes and the exit they belong to; the confirmation decision and the joining have events of their own. */
async function statusEvents(db: Queryable, companyId: string, employeeId: string, withExitReason: boolean): Promise<TimelineEvent[]> {
  const rows = (
    await db.query<{ status: string; prior: string | null; effective_date: string; source_kind: string; source_id: string | null; recorded_at: Date; actor: string | null; leaving_date: string | null; exit_reason: string | null; decision_id: string | null }>(
      `select st.code as status, ps.code as prior, h.effective_date, h.source_kind, h.source_id, h.recorded_at, ${ACTOR('h.actor_user_id')} as actor,
              x.leaving_date, x.reason as exit_reason,
              (select d.id from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
                  join approval_decision d on d.company_id = t.company_id and d.task_id = t.id and d.decision = 'APPROVE'
                where i.company_id = x.company_id and i.transaction_id = x.transaction_id order by d.occurred_at desc limit 1) as decision_id
         from employee_status_history h
         join reference_value st on st.company_id = h.company_id and st.id = h.status_id
         left join reference_value ps on ps.company_id = h.company_id and ps.id = h.prior_status_id
         left join exit_case x on x.company_id = h.company_id and x.id = h.source_id and h.source_kind = any($3::text[])
        where h.company_id = $1 and h.employee_id = $2 and h.source_kind = any($4::text[])`,
      [companyId, employeeId, EXIT_KINDS, [...EXIT_KINDS, ...STATUS_ONLY_KINDS]],
    )
  ).rows;
  return rows.map((r): TimelineEvent => {
    const exit = EXIT_KINDS.includes(r.source_kind);
    return {
      category: exit ? 'EXIT' : 'STATUS',
      type: r.source_kind,
      effectiveDate: r.effective_date,
      recordedAt: r.recorded_at,
      actor: r.actor,
      reason: withExitReason && r.source_kind === 'EXIT_APPROVED' ? r.exit_reason : null,
      source: exit && r.source_id ? { kind: 'EXIT_CASE', id: r.source_id, decisionId: r.source_kind === 'EXIT_APPROVED' ? r.decision_id : null } : null,
      details: { status: r.status, priorStatus: r.prior, ...(exit && r.leaving_date ? { lastWorkingDate: r.leaving_date } : {}) },
    };
  });
}

async function confirmationEvents(db: Queryable, companyId: string, employeeId: string, withReason: boolean): Promise<TimelineEvent[]> {
  const rows = (
    await db.query<{ id: string; confirmation_id: string; approval_decision_id: string; action: string; prior_due_date: string; new_due_date: string; effective: string; occurred_at: Date; actor: string | null; reason: string }>(
      `select ca.id, ca.confirmation_id, ca.approval_decision_id, ca.action, ca.prior_due_date, ca.new_due_date, ca.occurred_at, ca.reason,
              to_char(coalesce(ca.actual_confirmation_date, hrms_business_date(ca.company_id, ca.occurred_at)), 'YYYY-MM-DD') as effective,
              (select ${ACTOR('d.actor_user_id')} from approval_decision d where d.company_id = ca.company_id and d.id = ca.approval_decision_id) as actor
         from confirmation_action ca
        where ca.company_id = $1 and ca.employee_id = $2 and ca.action in ('CONFIRMED', 'EXTENDED')`,
      [companyId, employeeId],
    )
  ).rows;
  return rows.map(
    (r): TimelineEvent => ({
      category: 'CONFIRMATION',
      type: r.action,
      effectiveDate: r.effective,
      recordedAt: r.occurred_at,
      actor: r.actor,
      reason: withReason ? r.reason : null,
      source: { kind: 'CONFIRMATION_CASE', id: r.confirmation_id, decisionId: r.approval_decision_id },
      details: r.action === 'EXTENDED' ? { priorDueDate: r.prior_due_date, newDueDate: r.new_due_date } : {},
    }),
  );
}

/** FR-089 "Changing an employee master creates a dated attributable history event": which fields, never their values. */
async function masterEvents(db: Queryable, companyId: string, employeeId: string): Promise<TimelineEvent[]> {
  const rows = (
    await db.query<{ id: string; occurred_at: Date; effective: string; actor: string | null; reason: string | null; after_values: Record<string, Record<string, unknown>> | null }>(
      `select a.id, a.occurred_at, to_char(hrms_business_date(a.company_id, a.occurred_at), 'YYYY-MM-DD') as effective, ${ACTOR('a.actor_user_id')} as actor, a.reason, a.after_values
         from audit_event a where a.company_id = $1 and a.resource_code = 'employee' and a.record_key = $2 and a.action = 'UPDATE'`,
      [companyId, employeeId],
    )
  ).rows;
  return rows.map(
    (r): TimelineEvent => ({
      category: 'MASTER',
      type: 'MASTER_UPDATED',
      effectiveDate: r.effective,
      recordedAt: r.occurred_at,
      actor: r.actor,
      reason: r.reason,
      source: { kind: 'AUDIT_EVENT', id: r.id },
      details: { fields: Object.values(r.after_values ?? {}).flatMap((group) => Object.keys(group ?? {})) },
    }),
  );
}

async function salaryEvents(db: Queryable, companyId: string, employeeId: string, grants: { salary: boolean; increment: boolean; incrementReason: boolean }): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];
  if (grants.increment) {
    const rows = (
      await db.query<{ case_id: string; approval_decision_id: string; effective_date: string; compensation_basis: string; currency_code: string; before_amount: string; after_amount: string; change_amount: string; change_percent: string | null; percent_na_reason: string | null; reason: string; applied_at: Date; actor: string | null; corrects_case_id: string | null; superseded_by_case_id: string | null }>(
        `select ih.case_id, ih.approval_decision_id, ih.effective_date, ih.compensation_basis, ih.currency_code, ih.before_amount::text, ih.after_amount::text, ih.change_amount::text,
                to_char(ih.change_percent, 'FM999999990.00') as change_percent, ih.percent_na_reason, ih.reason, ih.applied_at, ${ACTOR('ih.applied_by')} as actor,
                (select o.case_id from increment_history o where o.company_id = ih.company_id and o.id = ih.corrects_history_id) as corrects_case_id,
                (select n.case_id from increment_history n where n.company_id = ih.company_id and n.corrects_history_id = ih.id) as superseded_by_case_id
           from increment_history ih where ih.company_id = $1 and ih.employee_id = $2`,
        [companyId, employeeId],
      )
    ).rows;
    for (const r of rows) {
      events.push({
        category: 'INCREMENT',
        // FR-089 "Reversal/correction is a new linked event": a correction is an event of its own, and the record it corrects stays.
        type: r.corrects_case_id ? 'INCREMENT_CORRECTED' : 'INCREMENT_APPLIED',
        effectiveDate: r.effective_date,
        recordedAt: r.applied_at,
        actor: r.actor,
        reason: grants.incrementReason ? r.reason : null,
        source: { kind: 'INCREMENT_CASE', id: r.case_id, decisionId: r.approval_decision_id },
        details: {
          basis: r.compensation_basis,
          currency: r.currency_code,
          beforeAmount: r.before_amount,
          afterAmount: r.after_amount,
          changeAmount: r.change_amount,
          changePercent: r.change_percent,
          percentNaReason: r.percent_na_reason,
          correctsCaseId: r.corrects_case_id,
          supersededByCaseId: r.superseded_by_case_id,
        },
      });
    }
  }
  if (grants.salary) {
    // An arrangement an increment made is that increment's event when the reader may see increments too.
    const rows = (
      await db.query<{ id: string; effective_from: string; annual_ctc: string; monthly_gross: string; currency_code: string; created_at: Date; actor: string | null; made_by_increment: boolean; superseded: boolean }>(
        `select sa.id, sa.effective_from, sa.annual_ctc::text, sa.monthly_gross::text, sa.currency_code, sa.created_at, ${ACTOR('sa.created_by')} as actor, sa.superseded_at is not null as superseded,
                exists (select 1 from increment_history ih where ih.company_id = sa.company_id and ih.new_salary_id = sa.id) as made_by_increment
           from salary_arrangement sa where sa.company_id = $1 and sa.employee_id = $2`,
        [companyId, employeeId],
      )
    ).rows;
    for (const r of rows) {
      if (r.made_by_increment && grants.increment) continue;
      events.push({
        category: 'SALARY',
        type: 'SALARY_SET',
        effectiveDate: r.effective_from,
        recordedAt: r.created_at,
        actor: r.actor,
        reason: null,
        source: { kind: 'SALARY_ARRANGEMENT', id: r.id },
        details: { annualCtc: r.annual_ctc, monthlyGross: r.monthly_gross, currency: r.currency_code, superseded: r.superseded },
      });
    }
  }
  return events;
}

/**
 * access-4 follow-up (C4 "Preserve delegator, delegate and actual actor in history"; I-57 item 7): the approval decisions among
 * `decisionIds` that were taken under a delegation, with their actor's account and the delegator's account they were taken for.
 */
async function delegatedDecisions(db: Queryable, companyId: string, decisionIds: readonly string[]): Promise<Map<string, { actor: string | null; onBehalfOf: string }>> {
  if (decisionIds.length === 0) return new Map();
  const rows = (
    await db.query<{ id: string; actor: string | null; on_behalf_of: string }>(
      `select d.id, ${ACTOR('d.actor_user_id')} as actor, ${ACTOR(decidedOnBehalfOfUser('t'))} as on_behalf_of
         from approval_decision d join approval_task t on t.company_id = d.company_id and t.id = d.task_id
        where d.company_id = $1 and d.id = any($2::uuid[]) and t.delegation_id is not null`,
      [companyId, [...new Set(decisionIds)]],
    )
  ).rows;
  return new Map(rows.filter((r) => r.on_behalf_of !== null).map((r) => [r.id, { actor: r.actor, onBehalfOf: r.on_behalf_of }]));
}

/** FR-089 acceptance "reconstructs the approved assignment and salary at a chosen date". */
async function asOfView(db: Queryable, companyId: string, employeeId: string, day: string, withSalary: boolean) {
  const inForce = `effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`;
  const values = [companyId, employeeId, day];
  const status = (
    await db.query<{ code: string }>(
      `select st.code from employee_status_history h join reference_value st on st.company_id = h.company_id and st.id = h.status_id
        where h.company_id = $1 and h.employee_id = $2 and h.effective_date <= $3::date order by h.effective_date desc, h.recorded_at desc limit 1`,
      values,
    )
  ).rows[0];
  const assignment = (
    await db.query(
      `select d.name as department, l.name as location, g.name as designation, gr.code as grade, ea.effective_from as "effectiveFrom", ea.effective_to as "effectiveTo"
         from employment_assignment ea
         join department d on d.company_id = ea.company_id and d.id = ea.department_id
         join location l on l.company_id = ea.company_id and l.id = ea.location_id
         join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
         left join grade gr on gr.company_id = ea.company_id and gr.id = ea.grade_id
        where ea.company_id = $1 and ea.employee_id = $2 and ea.${inForce}`,
      values,
    )
  ).rows[0];
  const manager = (
    await db.query(
      `select m.employee_code as code, m.display_name as name, ma.effective_from as "effectiveFrom", ma.effective_to as "effectiveTo"
         from manager_assignment ma join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
        where ma.company_id = $1 and ma.employee_id = $2 and ma.${inForce}`,
      values,
    )
  ).rows[0];
  const salary = withSalary
    ? (
        await db.query(
          `select annual_ctc::text as "annualCtc", monthly_gross::text as "monthlyGross", currency_code as currency, effective_from as "effectiveFrom", effective_to as "effectiveTo"
             from salary_arrangement where company_id = $1 and employee_id = $2 and ${inForce}`,
          values,
        )
      ).rows[0]
    : undefined;
  return { date: day, status: status?.code ?? null, assignment: assignment ?? null, manager: manager ?? null, ...(withSalary ? { salary: salary ?? null } : {}) };
}

/** Newest first; null when the employee is outside the assignment's row scope. */
export async function employeeTimeline(db: Queryable, grant: AccessGrant, employeeId: string, q: { asOf?: string | undefined }) {
  if (!(await canAccessEmployee(db, grant, employeeId))) return null;
  const companyId = grant.companyId;
  const may = async (resource: string, action: string, group: string) =>
    (await resolveAccess(db, { userId: grant.userId, companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [group], at: grant.at })).allowed;
  // C4; C6; 0126: these are the financial past, so the plain read grants do not open them.
  const salary = await may('salary', 'history_read', 'salary');
  const increment = await may('increment', 'history_read', 'salary');
  const incrementReason = increment && (await may('increment', 'read', 'reason'));
  const confirmationReason = await may('confirmation', 'read', 'reason');
  const exitReason = await may('exit', 'read', 'reason');
  const who = (await db.query<{ employee_code: string; display_name: string }>(`select employee_code, display_name from employee where company_id = $1 and id = $2`, [companyId, employeeId])).rows[0];
  if (!who) return null;
  const events = [
    ...(await joiningEvents(db, companyId, employeeId)),
    ...(await organisationEvents(db, companyId, employeeId)),
    ...(await managerEvents(db, companyId, employeeId)),
    ...(await statusEvents(db, companyId, employeeId, exitReason)),
    ...(await confirmationEvents(db, companyId, employeeId, confirmationReason)),
    ...(await masterEvents(db, companyId, employeeId)),
    ...(await salaryEvents(db, companyId, employeeId, { salary, increment, incrementReason })),
  ].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.recordedAt.getTime() - a.recordedAt.getTime());
  // A decision the event's actor took as a delegate names the person it was taken for (the confirmation decision, the exit approval
  // and the increment it applied are recorded by the deciding user).
  const delegated = await delegatedDecisions(db, companyId, events.flatMap((e) => (e.source?.decisionId ? [e.source.decisionId] : [])));
  for (const e of events) {
    const d = e.source?.decisionId ? delegated.get(e.source.decisionId) : undefined;
    e.onBehalfOf = d && d.actor === e.actor ? d.onBehalfOf : null;
  }
  return {
    employeeId,
    employeeCode: who.employee_code,
    employeeName: who.display_name,
    // So a screen can say salary events are withheld rather than absent.
    salaryShown: salary || increment,
    events,
    ...(q.asOf ? { asOf: await asOfView(db, companyId, employeeId, q.asOf, salary) } : {}),
  };
}
