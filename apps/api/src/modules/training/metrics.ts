// F2 dashboard metrics of the training module, ready for the dashboard's metric catalogue:
//   Employee "Own training/tasks due" (OWN_TRAINING_DUE, today NOT_AVAILABLE in dashboard/service.ts);
//   Training Coordinator "Current/future training sessions; Confirmed participation count; Completion/no-show counts;
//   Feedback pending count without contents".
// Participation counts use the same row-scope predicate as the participant lists, so they reconcile with the
// drill-down pages (BR-045); plan counts cover the company's plan register (plans are not employee-scoped). Counts
// only: no feedback content, no cost.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';

const count = async (db: Queryable, sql: string, params: unknown[]): Promise<MetricResult> => ({
  status: 'OK',
  value: Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0),
});

/** Participations of non-cancelled plans within the caller's row scope (alias t, plan p). */
export function participationsInScope(grant: AccessGrant, p: SqlParams): string {
  return `${employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, p)} and p.state = 'ACTIVE'`;
}
const inScope = participationsInScope;

const PARTICIPATIONS = `from training_participant t join training_plan p on p.company_id = t.company_id and p.id = t.plan_id`;
const NO_FEEDBACK = `not exists (select 1 from training_feedback f where f.company_id = t.company_id and f.participant_id = t.id)`;
/** Completed, and its feedback not given yet ("Feedback pending"). */
export const FEEDBACK_PENDING = `t.participation_state = 'COMPLETED' and ${NO_FEEDBACK}`;
/** "Own training/tasks due": a session of an active plan nominated or confirmed that has not ended, or a completed one awaiting feedback (`day`: a date parameter). */
export const ownTrainingDue = (day: string) =>
  `(p.state = 'ACTIVE' and ((t.participation_state in ('NOMINATED', 'CONFIRMED') and p.end_date >= ${day}::date) or (${FEEDBACK_PENDING})))`;

export const TRAINING_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /**
   * The employee's own training due: sessions they are nominated for or confirmed in that have not ended, plus
   * completed sessions whose feedback they have not given yet.
   */
  OWN_TRAINING_DUE: async (db, g) => {
    if (!g.linkedEmployeeId) return { status: 'NOT_CONFIGURED', message: 'No employee record is linked to this account' };
    return count(
      db,
      `select count(*) as n ${PARTICIPATIONS} where t.company_id = $1 and t.employee_id = $2 and ${ownTrainingDue('$3')}`,
      [g.companyId, g.linkedEmployeeId, g.businessDate],
    );
  },
  /** Plans not cancelled whose end date is today or later (F1 CURRENT or FUTURE). */
  TRAINING_SESSIONS_CURRENT_FUTURE: (db, g) =>
    count(db, `select count(*) as n from training_plan p where p.company_id = $1 and p.state = 'ACTIVE' and p.end_date >= $2::date`, [g.companyId, g.businessDate]),
  /** Confirmed participations (seat taken, attendance not yet recorded) in scope. */
  TRAINING_CONFIRMED_PARTICIPATIONS: (db, g) => {
    const p = new SqlParams();
    return count(db, `select count(*) as n ${PARTICIPATIONS} where ${inScope(g, p)} and t.participation_state = 'CONFIRMED'`, p.values);
  },
  /** Completed and no-show participations in scope, as "<completed>/<no-show>". */
  TRAINING_COMPLETION_NO_SHOW: async (db, g) => {
    const p = new SqlParams();
    const row = (
      await db.query<{ completed: number; no_show: number }>(
        `select (count(*) filter (where t.participation_state = 'COMPLETED'))::int as completed, (count(*) filter (where t.participation_state = 'NO_SHOW'))::int as no_show
           ${PARTICIPATIONS} where ${inScope(g, p)}`,
        p.values,
      )
    ).rows[0]!;
    return { status: 'OK', value: `${row.completed}/${row.no_show}` };
  },
  /** Completed participations in scope whose feedback is not given yet (a count, never the contents). */
  TRAINING_FEEDBACK_PENDING: (db, g) => {
    const p = new SqlParams();
    return count(db, `select count(*) as n ${PARTICIPATIONS} where ${inScope(g, p)} and ${FEEDBACK_PENDING}`, p.values);
  },
};
