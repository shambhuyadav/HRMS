// F2 Appraisal Reviewer dashboard metrics ("Assigned appraisal tasks; Submitted/reviewed counts; Overdue review tasks;
// Returned appraisal counts"), ready for the dashboard's metric catalogue. Task counts use the appraisal task list's
// predicate (GET /appraisal-tasks/mine); appraisal counts use the appraisal list's row-scope predicate
// (GET /appraisals?state=...), so both reconcile with the drill-down pages (BR-045). Counts and states only: never
// goals, scores, results, comments or reasons (DF02; BRD role table "assigned task status only").
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf, myPendingTasks, notAvailable } from '../dashboard/tasks.js';
import { TASK_KINDS } from './common.js';

/** Appraisals in the caller's row scope (alias a), as the appraisal list selects them. */
const inScope = (g: AccessGrant, p: SqlParams) => employeeScopePredicate(g, { company: 'a.company_id', employee: 'a.employee_id' }, p);

export const APPRAISAL_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /** The caller's open manager-rating and reviewer tasks (both review levels). */
  APPRAISAL_ASSIGNED_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${myPendingTasks(g, p, TASK_KINDS)}`, p);
  },
  /**
   * '<submitted>/<reviewed>': in-scope appraisals submitted and waiting for a decision (SUBMITTED for the manager's
   * rating, IN_REVIEW for the reviewer) / reviewed and confirmed (APPROVED).
   */
  APPRAISAL_SUBMITTED_REVIEWED: async (db, g) => {
    const p = new SqlParams();
    const row = (
      await db.query<{ submitted: number; reviewed: number }>(
        `select count(*) filter (where a.state in ('SUBMITTED', 'IN_REVIEW'))::int as submitted, count(*) filter (where a.state = 'APPROVED')::int as reviewed
           from appraisal a where ${inScope(g, p)}`,
        p.values,
      )
    ).rows[0]!;
    return { status: 'OK', value: `${row.submitted}/${row.reviewed}` };
  },
  /**
   * Reviewer tasks carry no due date: the approval engine sets none (approval_task.due_at stays empty; DF03 defines
   * reminders and escalation only) and the cycle windows bound self-entry and the manager's rating, not the
   * reviewer's confirmation. An overdue count would be a structural zero, so it is reported as unavailable.
   */
  APPRAISAL_REVIEW_TASKS_OVERDUE: notAvailable,
  /** In-scope appraisals returned for correction (waiting for the employee's resubmission). */
  APPRAISAL_RETURNED: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n from appraisal a where ${inScope(g, p)} and a.state = 'RETURNED'`, p);
  },
};
